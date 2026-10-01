import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Helper to dynamically resolve server secret from .dev.env.json or process.env
function getServerSecret() {
  try {
    const devEnvPaths = [
      path.join(__dirname, '../.dev.env.json'),
      path.join(__dirname, '.dev.env.json'),
      '/app/.dev.env.json'
    ];
    for (const p of devEnvPaths) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        const secret = parsed.GEMINI_API_KEY || parsed.API_KEY;
        if (typeof secret === 'string' && secret.trim().length > 10 && secret.trim() !== 'MY_GEMINI_API_KEY') {
          return secret.trim();
        }
      }
    }
  } catch (err) {}

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 10 && process.env.GEMINI_API_KEY.trim() !== 'MY_GEMINI_API_KEY') {
    return process.env.GEMINI_API_KEY.trim();
  }
  if (process.env.API_KEY && process.env.API_KEY.trim().length > 10 && process.env.API_KEY.trim() !== 'MY_GEMINI_API_KEY') {
    return process.env.API_KEY.trim();
  }

  return undefined;
}

// Helper to get candidate keys (server secret first, then custom key as fallback)
function getCandidateKeys(customKey) {
  const keys = [];
  const serverKey = getServerSecret();
  if (serverKey) {
    keys.push(serverKey);
  }
  if (typeof customKey === 'string' && customKey.trim().length > 10 && customKey.trim() !== 'MY_GEMINI_API_KEY') {
    const trimmed = customKey.trim();
    if (!keys.includes(trimmed)) {
      keys.push(trimmed);
    }
  }
  return keys;
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
    const candidateKeys = getCandidateKeys(customKey);

    if (candidateKeys.length === 0) {
      return res.status(401).json({
        error: 'No se encontró una API Key configurada. Por favor, asegúrate de ingresar una API Key en la configuración de secretos o en el campo del Laboratorio.',
        errorType: 'missing_key',
        status: 401
      });
    }

    console.log(`[handleGeminiRequest] Received request for model: ${model}, candidateKeys count: ${candidateKeys.length}`);

    // Modelos con cuota gratuita garantizada (Flash y Flash-Lite)
    // Se priorizan modelos ligeros de bajo consumo sin costo
    const freeTierModels = [
      'gemini-flash-lite-latest',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'gemini-3.8-flash'
    ];

    const requestedModel = model && freeTierModels.includes(model) ? model : 'gemini-flash-lite-latest';
    const candidateModels = [requestedModel];
    for (const m of freeTierModels) {
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

    // Loop through candidate keys (starting with authoritative server secret)
    keyLoop: for (const keyToUse of candidateKeys) {
      const ai = new GoogleGenAI({
        apiKey: keyToUse,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

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
            console.log(`[Gemini API] Solicitud exitosa con modelo con cuota gratuita: ${currentModel}`);
            break keyLoop;
          }
        } catch (genErr) {
          lastError = genErr.message || String(genErr);
          lastStatus = genErr.status || (lastError.includes('429') ? 429 : (lastError.includes('400') ? 400 : 503));
          console.warn(`[Gemini API] Error con modelo ${currentModel}: ${lastError}`);
          const errLower = lastError.toLowerCase();
          if (
            lastStatus === 400 || 
            lastStatus === 401 || 
            lastStatus === 403 || 
            errLower.includes('api key') || 
            errLower.includes('api_key') || 
            errLower.includes('permission') || 
            errLower.includes('unauthorized') ||
            errLower.includes('forbidden')
          ) {
            break; // Try next candidate key immediately
          }
        }
      }
    }

    if (!responseData) {
      const msgLower = String(lastError || '').toLowerCase();
      const isQuota = lastStatus === 429 || msgLower.includes('429') || msgLower.includes('quota') || msgLower.includes('resource_exhausted');
      const isInvalidKey = lastStatus === 400 || msgLower.includes('api key not valid') || msgLower.includes('api_key_invalid') || msgLower.includes('invalid_argument');
      
      let statusCode = 503;
      let errorType = 'overloaded';
      let friendlyMessage = 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.';

      if (isQuota) {
        statusCode = 429;
        errorType = 'quota_exceeded';
        friendlyMessage = 'Se alcanzó el límite de uso de la cuota gratuita. Puedes esperar unos minutos a que se restablezca o conectar tu propia API Key de Google AI Studio.';
      } else if (isInvalidKey) {
        statusCode = 400;
        errorType = 'invalid_key';
        friendlyMessage = 'La API Key configurada no es válida o está deshabilitada en Google AI Studio. Por favor, verifica tu clave en la configuración de secretos.';
      }

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
