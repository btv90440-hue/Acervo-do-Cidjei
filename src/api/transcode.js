// Ponte entre o Worker e o transcodificador (pasta transcoder/).
// Só atende arquivos do acervo público: cada pedido precisa do mesmo token assinado
// usado no streaming (?public=...). Sem token válido, ninguém dispara conversões.
//
//   POST /api/transcode/:id?public=TOKEN   -> analisa o áudio e, se preciso, começa a converter
//   GET  /api/transcode/:id?public=TOKEN   -> none | not_needed | probing | queued | running | ready | failed
//   GET  /api/transcoded/:id?public=TOKEN  -> MP4 convertido (aceita Range)

import { verifyPublicStreamToken } from './public.js';

const ID_RE = /^[\w-]{10,200}$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const text = (status, msg) => new Response(msg, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

// Repassa a resposta JSON do transcodificador sem expor a URL nem o segredo.
async function relayJson(url, init) {
  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch {
    return json(200, { state: 'failed', error: 'Transcodificador indisponível.' });
  }
  if (upstream.status === 404) return json(200, { state: 'none' });
  const data = await upstream.json().catch(() => null);
  if (!data || typeof data.state !== 'string') {
    return json(200, { state: 'failed', error: 'Resposta inválida do transcodificador.' });
  }
  return json(200, data);
}

export async function onRequest({ request, env, params }) {
  const base = String(env.TRANSCODER_URL || '').replace(/\/+$/, '');
  const secret = String(env.TRANSCODER_SECRET || '');
  if (!base || secret.length < 32) return json(503, { state: 'unavailable' });

  const { id, route } = params;
  if (!ID_RE.test(id)) return text(400, 'ID de arquivo inválido');

  const url = new URL(request.url);
  const token = url.searchParams.get('public') || '';
  if (!(await verifyPublicStreamToken(id, token, env))) {
    return text(403, 'Autorização pública inválida ou expirada. Atualize o acervo.');
  }

  const auth = { Authorization: 'Bearer ' + secret };

  if (route === 'file') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Método não permitido');
    const headers = { ...auth };
    const range = request.headers.get('Range');
    if (range) headers.Range = range;
    let upstream;
    try {
      upstream = await fetch(`${base}/files/${id}`, { method: request.method, headers });
    } catch {
      return text(502, 'Transcodificador indisponível');
    }
    if (upstream.status >= 500) return text(502, 'Erro no transcodificador');
    const out = new Headers({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: out,
    });
  }

  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return text(403, 'Origem não permitida');
    // O transcodificador lê o arquivo pelo próprio stream público do Worker (com o mesmo token).
    const source = `${url.origin}/api/stream/${id}?public=${encodeURIComponent(token)}`;
    return relayJson(`${base}/jobs`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source }),
    });
  }

  if (request.method === 'GET') return relayJson(`${base}/jobs/${id}`, { headers: auth });
  return text(405, 'Método não permitido');
}
