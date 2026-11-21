// Roteador do Worker: só /api/* chega aqui (ver run_worker_first em wrangler.jsonc).
// Todo o resto é servido direto da pasta public/ como arquivo estático.
import { onRequest as session } from './api/session.js';
import { onRequest as stream } from './api/stream.js';
import { onRequest as auth } from './api/auth.js';
<<<<<<< Updated upstream
=======
import { onRequest as publicCatalog, onStatus as publicStatus } from './api/public.js';
import { onRequest as transcode } from './api/transcode.js'; // NOVO: conversão automática de áudio
>>>>>>> Stashed changes

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

    // NOVO: estado/início da conversão de áudio e entrega do arquivo convertido
    m = pathname.match(/^\/api\/transcode\/([^/]+)$/);
    if (m) return transcode({ request, env, params: { id: m[1], route: 'job' } });
    m = pathname.match(/^\/api\/transcoded\/([^/]+)$/);
    if (m) return transcode({ request, env, params: { id: m[1], route: 'file' } });

    m = pathname.match(/^\/api\/auth\/([^/]+)$/);
    if (m) return auth({ request, env, params: { action: m[1] } });

    if (pathname.startsWith('/api/')) return plain(404, 'Não encontrado');
    return env.ASSETS.fetch(request);
  },
};
