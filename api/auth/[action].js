// Login Google persistente (OAuth "authorization code" com refresh token). Sem dependências.
//
//   GET  /api/auth/status    -> { configured }
//   GET  /api/auth/login     -> redireciona para o Google
//   GET  /api/auth/callback  -> troca o código pelo refresh token e guarda num cookie criptografado
//   POST /api/auth/refresh   -> devolve um access token novo (+ e-mail e pastas salvas)
//   POST /api/auth/folders   -> lembra as pastas importadas (cookie)
//   POST /api/auth/logout    -> revoga o refresh token e apaga o cookie
//
// Variáveis no Vercel: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, COOKIE_SECRET (texto aleatório longo)
'use strict';
const crypto = require('crypto');

const { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, COOKIE_SECRET } = process.env;
const CONFIGURED = Boolean(CLIENT_ID && CLIENT_SECRET && COOKIE_SECRET);
const YEAR = 31536000;
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.readonly';

// ---- cookie criptografado (AES-256-GCM) ----
const key = () => crypto.createHash('sha256').update(COOKIE_SECRET).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
function unseal(token) {
  const b = Buffer.from(token, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---- utilidades ----
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
};
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/api/auth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const siteUrl = req => 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
const form = body => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
async function googleToken(params) {
  const r = await fetch('https://oauth2.googleapis.com/token',
    form({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }));
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
function sendJson(res, status, payload, cookies) {
  res.setHeader('Cache-Control', 'no-store');
  if (cookies) res.setHeader('Set-Cookie', cookies);
  res.status(status).json(payload);
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = async function handler(req, res) {
  const action = req.query.action;

  if (action === 'status') return sendJson(res, 200, { configured: CONFIGURED });
  if (!CONFIGURED) return sendJson(res, 503, { error: 'not_configured' });
  if (action !== 'login' && action !== 'callback' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method' });
  }

  try {
    if (action === 'login') {
      const state = crypto.randomBytes(16).toString('hex');
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: siteUrl(req) + '/api/auth/callback',
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'select_account consent',
        state,
      });
      res.setHeader('Set-Cookie', cookie('acervo_st', state, 600));
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, 'https://accounts.google.com/o/oauth2/v2/auth?' + params);
    }

    if (action === 'callback') {
      const { code, state } = req.query;
      if (!code || !state || !safeEqual(state, readCookie(req, 'acervo_st'))) return res.redirect(302, '/?auth=err');
      const { ok, data } = await googleToken({
        code, grant_type: 'authorization_code', redirect_uri: siteUrl(req) + '/api/auth/callback',
      });
      if (!ok || !data.refresh_token) return res.redirect(302, '/?auth=err');
      let email = '';
      try { email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url')).email || ''; } catch { /* sem e-mail */ }
      res.setHeader('Set-Cookie', [
        cookie('acervo_rt', seal(JSON.stringify({ rt: data.refresh_token, email })), YEAR),
        cookie('acervo_st', '', 0),
      ]);
      return res.redirect(302, '/?auth=ok');
    }

    if (action === 'refresh') {
      let session;
      try { session = JSON.parse(unseal(readCookie(req, 'acervo_rt'))); }
      catch { return sendJson(res, 401, { error: 'no_session' }); }
      const { ok, data } = await googleToken({ refresh_token: session.rt, grant_type: 'refresh_token' });
      if (!ok) {
        return sendJson(res, 401, { error: data.error || 'refresh_failed' },
          data.error === 'invalid_grant' ? [cookie('acervo_rt', '', 0)] : undefined);
      }
      let folders = [];
      try { folders = JSON.parse(Buffer.from(readCookie(req, 'acervo_f'), 'base64url').toString()); } catch { /* nenhuma */ }
      return sendJson(res, 200, {
        access_token: data.access_token, expires_in: data.expires_in, email: session.email, folders,
      });
    }

    if (action === 'folders') {
      const list = (Array.isArray(req.body) ? req.body : [])
        .filter(f => f && /^[\w-]{10,}$/.test(f.id))
        .slice(0, 15)
        .map(f => ({ id: f.id, name: String(f.name || '').slice(0, 40) }));
      return sendJson(res, 200, { ok: 1 },
        [cookie('acervo_f', Buffer.from(JSON.stringify(list)).toString('base64url'), YEAR)]);
    }

    if (action === 'logout') {
      try {
        const session = JSON.parse(unseal(readCookie(req, 'acervo_rt')));
        await fetch('https://oauth2.googleapis.com/revoke', form({ token: session.rt }));
      } catch { /* já estava desconectado */ }
      return sendJson(res, 200, { ok: 1 }, [cookie('acervo_rt', '', 0)]);
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('auth:', err);
    return sendJson(res, 500, { error: 'server_error' });
  }
};
