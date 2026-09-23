import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Set up Gemini SDK
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Serve the main HTML file at root, mapping to the user's HTML entry point
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the main HTML file if accessed explicitly as /index.html
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the main HTML file if accessed explicitly as /fundamentos_de_prompting.html
app.get('/fundamentos_de_prompting.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Handler for Gemini requests
async function handleGeminiRequest(req, res) {
  try {
    const { contents, systemInstruction, model } = req.body;
    
    // Validate request
    if (!contents) {
      return res.status(400).json({ error: 'Falta el cuerpo contents en la petición' });
    }

    // Map custom or legacy model names to valid models from the gemini-api SKILL.md list.
    // Prohibited: gemini-1.5-flash, gemini-1.5-pro, gemini-pro, gemini-2.0-flash, gemini-2.0-pro, gemini-2.0-flash-thinking
    // Standard Basic Text Tasks: gemini-3.8-flash
    // Lighter Text Tasks: gemini-3.1-flash-lite
    let targetModel = 'gemini-3.8-flash';
    if (model) {
      if (model.includes('lite') || model.includes('flash-lite')) {
        targetModel = 'gemini-3.1-flash-lite';
      } else if (model.includes('pro')) {
        targetModel = 'gemini-3.1-pro-preview';
      }
    }

    // Extract system instruction text if present
    let systemInstructionText = undefined;
    if (systemInstruction) {
      if (typeof systemInstruction === 'string') {
        systemInstructionText = systemInstruction;
      } else if (systemInstruction.parts && systemInstruction.parts[0]) {
        systemInstructionText = systemInstruction.parts[0].text;
      }
    }

    // Call Gemini API using modern SDK
    const response = await ai.models.generateContent({
      model: targetModel,
      contents: contents,
      config: systemInstructionText ? { systemInstruction: systemInstructionText } : undefined
    });

    // Structure output back to format expected by client (candidates/parts structure):
    // { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
    const responseText = response.text || '';
    const responseData = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: responseText
              }
            ]
          }
        }
      ]
    };

    res.json(responseData);
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    res.status(500).json({ error: error.message || 'Error interno llamando a Gemini' });
  }
}

// Map both endpoints to ensure maximum compatibility
app.post('/api/gemini', handleGeminiRequest);
app.post('/api/gemini.js', handleGeminiRequest);

// Serve other static files in the directory
app.use(express.static(__dirname));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
