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
  let key = undefined;
  if (typeof customKey === 'string' && customKey.trim().length > 10) {
    key = customKey.trim();
  } else if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 5) {
    key = process.env.GEMINI_API_KEY.trim();
  } else if (process.env.API_KEY && process.env.API_KEY.trim().length > 5) {
    key = process.env.API_KEY.trim();
  }

  console.log('Gemini client key available:', key ? `${key.slice(0, 8)}... (len ${key.length})` : 'none');

  const options = {
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  };
  if (key) {
    options.apiKey = key;
  }

  return new GoogleGenAI(options);
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
    const { contents, systemInstruction, generationConfig, model, apiKey: bodyKey } = req.body || {};
    
    // Validate request
    if (!contents) {
      return res.status(400).json({ error: 'Falta el cuerpo contents en la petición' });
    }

    const customKey = (req.headers && (req.headers['x-goog-api-key'] || req.headers['x-api-key'])) || bodyKey;
    const ai = getGeminiClient(customKey);

    console.log(`[handleGeminiRequest] Received request for model: ${model}, customKey: ${Boolean(customKey)}`);

    // Lista estricta de modelos Lite solicitados
    const requestedModel = model || 'gemini-flash-lite-latest';
    const liteFallbackModels = [
      'gemini-flash-lite-latest',
      'gemini-2.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite-preview'
    ];
    const candidateModels = [requestedModel];
    for (const m of liteFallbackModels) {
      if (!candidateModels.includes(m)) {
        candidateModels.push(m);
      }
    }

    // Format contents properly for SDK
    let formattedContents = contents;
    if (Array.isArray(contents)) {
      if (contents[0]?.parts?.[0]?.text) {
        formattedContents = contents[0].parts.map(p => p.text).join('\n');
      }
    }

    // Prepare system instruction
    let sysInst = undefined;
    if (systemInstruction) {
      if (typeof systemInstruction === 'string') {
        sysInst = systemInstruction;
      } else if (systemInstruction.parts && systemInstruction.parts[0]?.text) {
        sysInst = systemInstruction.parts[0].text;
      }
    }

    let responseData = null;
    let lastError = null;
    let lastStatus = 503;

    for (const currentModel of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: formattedContents,
          config: {
            maxOutputTokens: 2048,
            ...(sysInst ? { systemInstruction: sysInst } : {}),
            ...(generationConfig || {})
          }
        });

        if (response && response.text) {
          responseData = {
            text: response.text,
            candidates: [{
              content: {
                parts: [{ text: response.text }]
              }
            }],
            usedModel: currentModel
          };
          console.log(`[Gemini API] Solicitud exitosa con modelo: ${currentModel}`);
          break;
        }
      } catch (genErr) {
        lastError = genErr.message || String(genErr);
        lastStatus = genErr.status || (lastError.includes('429') ? 429 : 503);
        console.warn(`[Gemini API] Error con modelo ${currentModel}: ${lastError}. Probando siguiente modelo...`);
      }
    }

    if (!responseData) {
      const msgLower = String(lastError || '').toLowerCase();
      const isQuota = lastStatus === 429 || msgLower.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted');
      
      const statusCode = isQuota ? 429 : 503;
      const errorType = isQuota ? 'quota_exceeded' : 'overloaded';
      const friendlyMessage = isQuota 
        ? 'Se alcanzó el límite de uso del servicio gratuito. Puedes reintentar, esperar unos minutos para que se restablezca la cuota, o conectar tu propia API Key de Google AI Studio para continuar de inmediato.'
        : 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.';

      return res.status(statusCode).json({
        error: friendlyMessage,
        errorType: errorType,
        rawMessage: lastError,
        status: statusCode
      });
    }

    res.json(responseData);
  } catch (error) {
    console.error('Error in handleGeminiRequest:', error);
    res.status(503).json({
      error: 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.',
      errorType: 'overloaded',
      rawMessage: error.message,
      status: 503
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
