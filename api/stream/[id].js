// GET|HEAD /api/stream/:id  -> repassa o arquivo do Google Drive com suporte a Range (seek no player)
'use strict';
const { Readable } = require('node:stream');

const ID_RE = /^[\w-]{10,200}$/;
const RANGE_RE = /^bytes=\d*-\d*$/;

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Método não permitido');
  }

  const id = String(req.query.id || '');
  if (!ID_RE.test(id)) return res.status(400).send('ID de arquivo inválido');

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : readCookie(req, 'cine_token');
  if (!token) return res.status(401).send('Reconecte ao Google Drive (token ausente)');

  const range = req.headers.range;
  if (range && !RANGE_RE.test(range)) return res.status(416).send('Intervalo (Range) inválido');

  const controller = new AbortController();
  res.on('close', () => controller.abort()); // usuário fechou/pulou: para de baixar do Drive

  try {
    const upstream = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
        signal: controller.signal,
        redirect: 'follow',
      }
    );

    if (!upstream.ok) { // 206 já conta como ok
      const msg = upstream.status === 401 ? 'Sessão do Google Drive expirada'
        : upstream.status === 403 || upstream.status === 404 ? 'Sem acesso a este arquivo no Drive'
        : `Drive recusou a mídia (${upstream.status})`;
      return res.status(upstream.status === 416 ? 416 : upstream.status).send(msg);
    }

    const headers = {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    };
    for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }

    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) return res.end();

    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error('Erro no streaming:', err);
    if (!res.headersSent) return res.status(502).send('Falha na ponte de streaming');
    res.destroy();
  }
}

module.exports = handler;
module.exports.config = { api: { responseLimit: false } }; // arquivos grandes
