// api/stream/[id].js
'use strict';
const { Readable } = require('node:stream');

export const config = {
  api: {
    responseLimit: false, // Desativa limite de resposta para permitir arquivos grandes
  },
};

// Função auxiliar para extrair o cookie manualmente em ambiente Node.js puro
function parseCookie(req, name) {
  const list = {};
  const rc = req.headers.cookie;
  rc && rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list[name];
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(405).send('Método não permitido');
  }

  const { id } = req.query;

  if (!id || !/^[\w-]{10,200}$/.test(id)) {
    return res.status(400).send('ID de arquivo inválido');
  }

  // Obtém o token do cabeçalho ou decodifica corretamente do Cookie
  let token = '';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = parseCookie(req, 'cine_token');
  }

  if (!token) {
    return res.status(401).send('Reconecte ao Google Drive (Token ausente)');
  }

  const range = req.headers.range;
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    return res.status(416).send('Intervalo (Range) inválido');
  }

  try {
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    
    const upstream = await fetch(driveUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(range ? { Range: range } : {}),
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status === 401 ? 401 : upstream.status).send(
        upstream.status === 401 ? 'Sessão do Google Drive expirada' : `Drive recusou a mídia (${upstream.status})`
      );
    }

    const headers = {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    };

    for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
      if (upstream.headers.has(h)) {
        headers[h] = upstream.headers.get(h);
      }
    }

    res.writeHead(upstream.status, headers);

    if (req.method === 'HEAD' || !upstream.body) {
      return res.end();
    }

    // Transmite o fluxo diretamente para a resposta, garantindo suporte perfeito a seeks e ranges
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    return;
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Erro no streaming:', err);
    if (!res.headersSent) {
      return res.status(500).send('Falha na ponte de streaming');
    }
    res.destroy();
  }
}