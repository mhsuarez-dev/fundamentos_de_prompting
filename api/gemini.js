export default async function handler(req, res) {
    // 1. Manejo de preflight CORS (OPTIONS)
    if (req.method === 'OPTIONS') {
        if (res && typeof res.status === 'function') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            return res.status(200).end();
        }
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        });
    }

    const clientKey = (req.headers && (req.headers['x-goog-api-key'] || req.headers['x-api-key'])) || undefined;
    const apiKey = clientKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        const errorPayload = { 
            error: 'Falta configurar la variable GEMINI_API_KEY en Vercel o falta hacer Redeploy.' 
        };
        if (res && typeof res.status === 'function') {
            return res.status(500).json(errorPayload);
        }
        return Response.json(errorPayload, { status: 500 });
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

        let model = body.model || 'gemini-3.1-flash-lite';
        if (model === 'gemini-flash-lite-latest' || model.includes('lite')) {
            model = 'gemini-3.1-flash-lite';
        }
        // Separamos campos propios para no enviar atributos inválidos a la API REST de Google
        const { model: _ignored, apiKey: _ignoredKey, ...geminiPayload } = body;

        // Aseguramos límite de 1500 tokens para optimizar consumo sin truncar respuestas complejas
        if (!geminiPayload.generationConfig) {
            geminiPayload.generationConfig = {};
        }
        geminiPayload.generationConfig.maxOutputTokens = 1500;

        const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const apiResponse = await fetch(googleUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        const data = await apiResponse.json();

        if (!apiResponse.ok) {
            const rawMsg = data?.error?.message || data?.error || '';
            const msgLower = (typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg)).toLowerCase();
            const isQuota = apiResponse.status === 429 || msgLower.includes('quota') || msgLower.includes('resource_exhausted');
            
            data.errorType = isQuota ? 'quota_exceeded' : 'overloaded';
            data.friendlyMessage = isQuota
                ? 'Se alcanzó el límite de uso del servicio gratuito. Puedes reintentar, esperar unos minutos para que se restablezca la cuota, o conectar tu propia API Key de Google AI Studio para continuar de inmediato.'
                : 'El servicio de IA está saturado en este momento. Por favor, pulsa el botón para reintentar.';
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