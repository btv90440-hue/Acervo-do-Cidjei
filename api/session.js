// api/session.js
'use strict';

export default async function handler(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'DELETE') {
        res.setHeader(
            'Set-Cookie',
            'cine_token=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0'
        );
        return res.status(204).end();
    }

    if (req.method === 'POST') {
        const { token } = req.body || {};

        if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
            return res.status(400).send('Token inválido');
        }

        // Define o Cookie com o OAuth Access Token do Google
        res.setHeader(
            'Set-Cookie',
            `cine_token=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`
        );
        return res.status(204).end();
    }

    return res.status(405).send('Método não permitido');
}
