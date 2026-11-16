// GET|HEAD /api/stream/:id -> repassa mídia do Drive com suporte a Range.
// Em modo público, o parâmetro ?public contém uma autorização assinada pelo Worker.
// No modo legado, mantém o cookie OAuth HttpOnly de visitante.
import { verifyPublicStreamToken } from './public.js';

const ID_RE = /^[\w-]{10,200}$/;
const RANGE_RE = /^bytes=\d*-\d*$/;

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
}

const text = (status, msg, extra = {}) => new Response(msg, {
  status,
  headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

function mediaResponse(request, upstream) {
  const headers = new Headers({
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
  });
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function publicMedia(request, id, token, env) {
  const details = await verifyPublicStreamToken(id, token, env);
  if (!details) return text(403, 'Autorização pública inválida ou expirada. Atualize o acervo.');

  const range = request.headers.get('Range');
  if (range && !RANGE_RE.test(range)) return text(416, 'Intervalo (Range) inválido');

  const headers = {};
  if (range) headers.Range = range;
  if (details.resourceKeys.length) headers['X-Goog-Drive-Resource-Keys'] = details.resourceKeys.join(',');

  let upstream = null;
  // Primeiro tenta o webContentLink público retornado pelo próprio Google Drive.
  if (details.link) {
    try {
      upstream = await fetch(details.link, { method: request.method, headers, redirect: 'follow' });
      const type = (upstream.headers.get('content-type') || '').toLowerCase();
      if (!upstream.ok || type.includes('text/html')) upstream = null;
    } catch {
      upstream = null;
    }
  }

  // Fallback para files.get alt=media. A chave fica somente no Worker.
  if (!upstream) {
    const apiKey = String(env.GOOGLE_DRIVE_API_KEY || '');
    if (!apiKey) return text(503, 'Chave da Google Drive API não configurada no Worker.');
    const url = new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id));
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('key', apiKey);
    try {
      upstream = await fetch(url, { method: request.method, headers, redirect: 'follow' });
    } catch (err) {
      console.error('Erro no streaming público:', err);
      return text(502, 'Falha na ponte pública de streaming');
    }
  }

  if (!upstream.ok) {
    const msg = upstream.status === 403 || upstream.status === 404
      ? 'O Google Drive não liberou o download público deste vídeo.'
      : 'Google Drive recusou a mídia (' + upstream.status + ').';
    return text(upstream.status, msg);
  }
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) return text(502, 'O Google Drive retornou uma página de confirmação, não o vídeo.');
  return mediaResponse(request, upstream);
}

export async function onRequest({ request, params, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Método não permitido', { Allow: 'GET, HEAD' });
  }

  const id = String(params.id || '');
  if (!ID_RE.test(id)) return text(400, 'ID de arquivo inválido');

  const url = new URL(request.url);
  const publicToken = url.searchParams.get('public');
  if (publicToken) return publicMedia(request, id, publicToken, env);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : readCookie(request, 'cine_token');
  if (!token) return text(401, 'Reconecte ao Google Drive (token ausente)');

  const range = request.headers.get('Range');
  if (range && !RANGE_RE.test(range)) return text(416, 'Intervalo (Range) inválido');

  let upstream;
  try {
    upstream = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true',
      {
        method: request.method,
        headers: { Authorization: 'Bearer ' + token, ...(range ? { Range: range } : {}) },
        redirect: 'follow',
      }
    );
  } catch (err) {
    console.error('Erro no streaming:', err);
    return text(502, 'Falha na ponte de streaming');
  }

  if (!upstream.ok) {
    const msg = upstream.status === 401 ? 'Sessão do Google Drive expirada'
      : upstream.status === 403 || upstream.status === 404 ? 'Sem acesso a este arquivo no Drive'
      : 'Drive recusou a mídia (' + upstream.status + ')';
    return text(upstream.status, msg);
  }
  return mediaResponse(request, upstream);
}
