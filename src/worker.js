// Roteador do Worker: só /api/* chega aqui (ver run_worker_first em wrangler.jsonc).
// Todo o resto é servido direto da pasta public/ como arquivo estático.
import { onRequest as session } from './api/session.js';
import { onRequest as stream } from './api/stream.js';
import { onRequest as auth } from './api/auth.js';

const plain = (status, msg) =>
  new Response(msg, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/session') return session({ request, env, params: {} });

    let m = pathname.match(/^\/api\/stream\/([^/]+)$/);
    if (m) {
      let id;
      try { id = decodeURIComponent(m[1]); } catch { return plain(400, 'ID de arquivo inválido'); }
      return stream({ request, env, params: { id } });
    }

    m = pathname.match(/^\/api\/auth\/([^/]+)$/);
    if (m) return auth({ request, env, params: { action: m[1] } });

    if (pathname.startsWith('/api/')) return plain(404, 'Não encontrado');
    return env.ASSETS.fetch(request);
  },
};
