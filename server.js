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
    const apiKey = (typeof customKey === 'string' && customKey.trim().length > 10)
      ? customKey.trim()
      : (process.env.GEMINI_API_KEY || process.env.API_KEY);

    if (!apiKey) {
      return res.status(500).json({
        error: 'No se encontró una clave de API configurada en el entorno.',
        errorType: 'overloaded'
      });
    }

    // Build model priority list (only lightweight flash models to protect free quota)
    const requestedModel = model || 'gemini-flash-latest';
    const lightFallbackModels = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    const candidateModels = [requestedModel];
    for (const m of lightFallbackModels) {
      if (!candidateModels.includes(m)) {
        candidateModels.push(m);
      }
    }

    // Prepare payload
    const geminiPayload = {
      contents: Array.isArray(contents) ? contents : [{ parts: [{ text: String(contents) }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        ...(generationConfig || {})
      }
    };

    if (systemInstruction) {
      if (typeof systemInstruction === 'string') {
        geminiPayload.systemInstruction = { parts: [{ text: systemInstruction }] };
      } else if (systemInstruction.parts) {
        geminiPayload.systemInstruction = systemInstruction;
      }
    }

    let responseData = null;
    let lastError = null;
    let lastStatus = 503;

    for (const currentModel of candidateModels) {
      try {
        const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`;
        const apiRes = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'User-Agent': 'aistudio-build'
          },
          body: JSON.stringify(geminiPayload)
        });

        const data = await apiRes.json();
        lastStatus = apiRes.status;

        if (apiRes.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          responseData = data;
          break;
        } else {
          lastError = data?.error?.message || JSON.stringify(data?.error || data);
        }
      } catch (fetchErr) {
        lastError = fetchErr.message;
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
