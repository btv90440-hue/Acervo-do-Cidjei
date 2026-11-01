// GET|HEAD /api/stream/:id  -> repassa o arquivo do Google Drive com suporte a Range (seek no player)
//
// Cloudflare Pages Functions (runtime Workers). O corpo da resposta é repassado como stream
// (sem ler o arquivo na memória e sem gastar CPU em JS), então cabe no limite de 10 ms do plano gratuito.

const ID_RE = /^[\w-]{10,200}$/;
const RANGE_RE = /^bytes=\d*-\d*$/;

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

const text = (status, msg, extra = {}) =>
  new Response(msg, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

export async function onRequest({ request, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Método não permitido', { Allow: 'GET, HEAD' });
  }

  const id = String(params.id || '');
  if (!ID_RE.test(id)) return text(400, 'ID de arquivo inválido');

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : readCookie(request, 'cine_token');
  if (!token) return text(401, 'Reconecte ao Google Drive (token ausente)');

  const range = request.headers.get('Range');
  if (range && !RANGE_RE.test(range)) return text(416, 'Intervalo (Range) inválido');

  let upstream;
  try {
    upstream = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      {
        method: request.method,
        headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
        redirect: 'follow',
      }
    );
  } catch (err) {
    console.error('Erro no streaming:', err);
    return text(502, 'Falha na ponte de streaming');
  }

  if (!upstream.ok) { // 206 já conta como ok
    const msg = upstream.status === 401 ? 'Sessão do Google Drive expirada'
      : upstream.status === 403 || upstream.status === 404 ? 'Sem acesso a este arquivo no Drive'
      : `Drive recusou a mídia (${upstream.status})`;
    return text(upstream.status, msg);
  }

  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
  });
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  // Se o usuário fechar/pular o filme, o Cloudflare cancela este corpo e o download do Drive para junto.
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}
