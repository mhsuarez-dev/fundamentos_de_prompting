import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Helper to get GoogleGenAI client with proper API key
function getGeminiClient(customKey) {
  let key = customKey;
  if (!key) {
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
      key = process.env.GEMINI_API_KEY;
    } else {
      const parsed = dotenv.config({ override: true }).parsed;
      key = parsed?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    }
  }

  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

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
    let targetModel = 'gemini-3.1-flash-lite';
    if (model) {
      if (model.includes('pro')) {
        targetModel = 'gemini-3.1-pro-preview';
      } else if (model.includes('3.8')) {
        targetModel = 'gemini-3.8-flash';
      } else {
        targetModel = 'gemini-3.1-flash-lite';
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

    // Call Gemini API using modern SDK with proper client
    const aiClient = getGeminiClient(req.headers['x-goog-api-key'] || req.body.apiKey);
    let response;
    const modelsToTry = [targetModel];
    if (!modelsToTry.includes('gemini-3.1-flash-lite')) modelsToTry.push('gemini-3.1-flash-lite');
    if (!modelsToTry.includes('gemini-flash-latest')) modelsToTry.push('gemini-flash-latest');

    let lastError = null;
    const callConfig = {
      maxOutputTokens: 1500
    };
    if (systemInstructionText) {
      callConfig.systemInstruction = systemInstructionText;
    }

    for (const currentModel of modelsToTry) {
      try {
        response = await aiClient.models.generateContent({
          model: currentModel,
          contents: contents,
          config: callConfig
        });
        if (response && response.text !== undefined) break;
      } catch (err) {
        lastError = err;
        console.warn(`Model ${currentModel} returned: ${err.message}. Trying next candidate...`);
        // Short pause if temporary spike
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!response) {
      throw lastError || new Error('No se pudo obtener respuesta del modelo');
    }

    // Structure output back to format expected by client (candidates/parts structure):
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
    const msg = error.message || '';
    const msgLower = msg.toLowerCase();
    const isQuota = msg.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted') || error.status === 429;

    let statusCode = isQuota ? 429 : 503;
    let errorType = isQuota ? 'quota_exceeded' : 'overloaded';
    let friendlyMessage = isQuota 
      ? 'Se alcanzó el límite de uso del servicio gratuito. Puedes reintentar, esperar unos minutos para que se restablezca la cuota, o conectar tu propia API Key de Google AI Studio para continuar de inmediato.'
      : 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.';

    res.status(statusCode).json({
      error: friendlyMessage,
      errorType: errorType,
      rawMessage: msg,
      status: statusCode
    });
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
