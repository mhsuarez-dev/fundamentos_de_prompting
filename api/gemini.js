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

    const apiKey = process.env.GEMINI_API_KEY;
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

        const model = body.model || 'gemini-flash-lite-latest';
        // Separamos el campo model para no enviar atributos inválidos a la API REST de Google
        const { model: _ignored, ...geminiPayload } = body;

        const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const apiResponse = await fetch(googleUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        const data = await apiResponse.json();

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