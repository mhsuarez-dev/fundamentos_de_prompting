import fs from 'fs';
import path from 'path';

function getServerSecret() {
    const envKeys = [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENAI_API_KEY',
        'API_KEY',
        'GEMINI_KEY',
        'GENAI_API_KEY'
    ];

    for (const k of envKeys) {
        const val = process.env[k];
        if (typeof val === 'string' && val.trim().length > 10 && val.trim() !== 'MY_GEMINI_API_KEY') {
            return val.trim();
        }
    }

    try {
        const paths = ['/app/.dev.env.json', './.dev.env.json', '../.dev.env.json', './.env.json'];
        for (const p of paths) {
            if (fs.existsSync(p)) {
                const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                for (const k of envKeys) {
                    const secret = parsed[k];
                    if (typeof secret === 'string' && secret.trim().length > 10 && secret.trim() !== 'MY_GEMINI_API_KEY') {
                        return secret.trim();
                    }
                }
            }
        }
    } catch(e) {}

    return undefined;
}

export default async function handler(req, res) {
    // 1. Manejo de preflight CORS (OPTIONS)
    if (req.method === 'OPTIONS') {
        if (res && typeof res.status === 'function') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-goog-api-key, x-api-key');
            return res.status(200).end();
        }
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, x-goog-api-key, x-api-key',
            }
        });
    }

    const clientKey = (req.headers && (req.headers['x-goog-api-key'] || req.headers['x-api-key'])) || undefined;
    const serverKey = getServerSecret();
    const candidateKeys = [];
    if (clientKey && typeof clientKey === 'string' && clientKey.trim().length > 10 && clientKey.trim() !== 'MY_GEMINI_API_KEY') {
        candidateKeys.push(clientKey.trim());
    }
    if (serverKey && !candidateKeys.includes(serverKey)) {
        candidateKeys.push(serverKey);
    }

    if (candidateKeys.length === 0) {
        const errorPayload = { 
            error: 'No se encontró una API Key configurada. Por favor, asegúrate de ingresar una API Key en la configuración de secretos o en el campo del Laboratorio.',
            errorType: 'missing_key',
            status: 401
        };
        if (res && typeof res.status === 'function') {
            return res.status(401).json(errorPayload);
        }
        return Response.json(errorPayload, { status: 401 });
    }

    if (req.method !== 'POST') {
        const errorPayload = { error: 'Método no permitido. Solo se acepta POST.' };
        if (res && typeof res.status === 'function') {
            return res.status(405).json(errorPayload);
        }
        return Response.json(errorPayload, { status: 405 });
    }

    try {
        let body;
        if (req.body) {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } else if (typeof req.json === 'function') {
            body = await req.json();
        } else {
            body = {};
        }

        const requestedModel = body.model || 'gemini-flash-lite-latest';

        // Separamos campos propios para no enviar atributos inválidos a la API REST de Google
        const { model: _ignored, apiKey: _ignoredKey, ...geminiPayload } = body;

        // Aseguramos límite de tokens (2048) para respuestas completas sin truncamiento
        if (!geminiPayload.generationConfig) {
            geminiPayload.generationConfig = {};
        }
        if (!geminiPayload.generationConfig.maxOutputTokens) {
            geminiPayload.generationConfig.maxOutputTokens = 2048;
        }

        // Modelos candidatos gratuitos garantizados (Flash y Flash-Lite)
        const freeTierModels = [
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite',
            'gemini-flash-latest',
            'gemini-3.8-flash'
        ];
        const candidateModels = [requestedModel];
        for (const m of freeTierModels) {
            if (!candidateModels.includes(m)) {
                candidateModels.push(m);
            }
        }

        let apiResponse = null;
        let data = null;

        keyLoop: for (const keyToUse of candidateKeys) {
            for (const currentModel of candidateModels) {
                try {
                    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${keyToUse}`;
                    apiResponse = await fetch(googleUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(geminiPayload)
                    });
                    data = await apiResponse.json();
                    if (apiResponse.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                        break keyLoop;
                    }
                } catch (fetchErr) {
                    console.warn(`Fetch error with model ${currentModel}:`, fetchErr.message);
                }
            }
        }

        if (!apiResponse.ok) {
            const rawMsg = data?.error?.message || data?.error || '';
            const msgLower = (typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg)).toLowerCase();
            const isQuota = apiResponse.status === 429 || msgLower.includes('quota') || msgLower.includes('resource_exhausted');
            const isInvalidKey = apiResponse.status === 401 || apiResponse.status === 403 || msgLower.includes('api key not valid') || msgLower.includes('api_key_invalid') || msgLower.includes('api key not found') || msgLower.includes('invalid api key');
            
            if (isQuota) {
                data.errorType = 'quota_exceeded';
                data.friendlyMessage = 'Se alcanzó el límite de uso de la cuota gratuita. Puedes esperar unos minutos a que se restablezca o conectar tu propia API Key de Google AI Studio.';
            } else if (isInvalidKey) {
                data.errorType = 'invalid_key';
                data.friendlyMessage = 'La API Key configurada no es válida o está deshabilitada en Google AI Studio. Por favor verifica tu clave en la configuración de secretos.';
            } else {
                data.errorType = 'overloaded';
                data.friendlyMessage = 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.';
            }
        }

        if (res && typeof res.status === 'function') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            return res.status(apiResponse.status).json(data);
        }

        return Response.json(data, {
            status: apiResponse.status,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            }
        });
    } catch (err) {
        const errPayload = { error: err.message || 'Error interno en la función de Vercel' };
        if (res && typeof res.status === 'function') {
            return res.status(500).json(errPayload);
        }
        return Response.json(errPayload, { status: 500 });
    }
}