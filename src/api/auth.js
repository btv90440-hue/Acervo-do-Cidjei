// Login com Google SÓ para identificar o visitante (permissões básicas: openid, e-mail e perfil).
//   GET  /api/auth/login     -> vai para o Google
//   GET  /api/auth/callback  -> confere se o e-mail foi liberado e abre a sessão
//   GET  /api/auth/me        -> { email, name, picture } ou 401
//   POST /api/auth/logout    -> encerra a sessão
import { b64u, dec, seal, readCookie, json, safeEqual, hasAccess, getSession } from '../lib.js';

const HOURS = 12;
const ck = (n, v, age, path = '/api') => `${n}=${v}; Path=${path}; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const go = (loc, cookies = []) => {
  const h = new Headers({ Location: loc, 'Cache-Control': 'no-store' });
  cookies.forEach(c => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
};

export async function onRequest({ request, params, env }) {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, COOKIE_SECRET: key } = env;
  const a = params.action, url = new URL(request.url), site = url.origin;
  if (a === 'status') return json(200, { configured: Boolean(id && secret && key && env.OWNER_REFRESH_TOKEN && env.FOLDER_IDS) });
  if (!(id && secret && key)) return json(503, { error: 'not_configured' });
  try {
    if (a === 'login') {
      const state = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
      return go('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: id, redirect_uri: site + '/api/auth/callback', response_type: 'code',
        scope: 'openid email profile', prompt: 'select_account', state,
      }), [ck('acervo_st', state, 600, '/api/auth')]);
    }
    if (a === 'callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state || !safeEqual(state, readCookie(request, 'acervo_st'))) return go('/?auth=err');
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: site + '/api/auth/callback' }),
      });
      const d = await r.json().catch(() => ({}));
      const p = r.ok && d.id_token ? JSON.parse(dec.decode(b64u.dec(d.id_token.split('.')[1]))) : null;
      if (!p || !p.email || p.email_verified === false) return go('/?auth=err');
      const clear = ck('acervo_st', '', 0, '/api/auth');
      if (!(await hasAccess(env, p.email))) return go('/?auth=denied&e=' + encodeURIComponent(p.email), [clear]);
      const s = await seal(key, JSON.stringify({ email: p.email, name: p.name || p.email, picture: p.picture || '', exp: Date.now() + HOURS * 36e5 }));
      return go('/', [ck('acervo_s', s, HOURS * 3600), clear]);
    }
    if (a === 'me') {
      const s = await getSession(request, env);
      return s ? json(200, { email: s.email, name: s.name, picture: s.picture }) : json(401, { error: 'login' });
    }
    if (a === 'logout' && request.method === 'POST') {
      const o = request.headers.get('Origin');
      if (o && o !== site) return json(403, { error: 'origin' });
      return json(200, { ok: 1 }, { 'Set-Cookie': ck('acervo_s', '', 0) });
    }
    return json(404, { error: 'not_found' });
  } catch (e) {
    console.error('auth:', e);
    return a === 'callback' ? go('/?auth=err') : json(500, { error: 'server_error' });
  }
}