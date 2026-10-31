// Login Google persistente (OAuth code flow). Sem dependências.
// Variáveis no Vercel: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, COOKIE_SECRET (string aleatória longa)
const c = require('crypto');
const { GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: SEC, COOKIE_SECRET: CS } = process.env;
const OK = !!(ID && SEC && CS), YEAR = 31536000;
const K = () => c.createHash('sha256').update(CS).digest();
const enc = s => { const iv = c.randomBytes(12), k = c.createCipheriv('aes-256-gcm', K(), iv), b = Buffer.concat([k.update(s, 'utf8'), k.final()]); return Buffer.concat([iv, k.getAuthTag(), b]).toString('base64url') };
const dec = t => { const b = Buffer.from(t, 'base64url'), d = c.createDecipheriv('aes-256-gcm', K(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8') };
const get = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)')); return m ? m[1] : '' };
const ck = (n, v, age) => n + '=' + v + '; Path=/api/auth; Max-Age=' + age + '; HttpOnly; Secure; SameSite=Lax';
const site = req => 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const token = async p => { const r = await fetch('https://oauth2.googleapis.com/token', form({ client_id: ID, client_secret: SEC, ...p })); return { ok: r.ok, d: await r.json().catch(() => ({})) } };
const json = (res, code, o, cookies) => { res.setHeader('Cache-Control', 'no-store'); if (cookies) res.setHeader('Set-Cookie', cookies); res.status(code).json(o) };

module.exports = async (req, res) => {
  const a = req.query.action;
  if (a === 'status') return json(res, 200, { configured: OK });
  if (!OK) return json(res, 503, { error: 'not_configured' });
  if (a !== 'login' && a !== 'callback' && req.method !== 'POST') return json(res, 405, { error: 'method' });
  try {
    if (a === 'login') {
      const st = c.randomBytes(16).toString('hex');
      const q = new URLSearchParams({ client_id: ID, redirect_uri: site(req) + '/api/auth/callback', response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'select_account consent', state: st });
      res.setHeader('Set-Cookie', ck('acervo_st', st, 600)); res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, 'https://accounts.google.com/o/oauth2/v2/auth?' + q);
    }
    if (a === 'callback') {
      const { code, state } = req.query;
      if (!code || !state || state !== get(req, 'acervo_st')) return res.redirect(302, '/?auth=err');
      const { ok, d } = await token({ code, grant_type: 'authorization_code', redirect_uri: site(req) + '/api/auth/callback' });
      if (!ok || !d.refresh_token) return res.redirect(302, '/?auth=err');
      let email = ''; try { email = JSON.parse(Buffer.from(d.id_token.split('.')[1], 'base64url')).email || '' } catch { }
      res.setHeader('Set-Cookie', [ck('acervo_rt', enc(JSON.stringify({ rt: d.refresh_token, email })), YEAR), ck('acervo_st', '', 0)]);
      return res.redirect(302, '/?auth=ok');
    }
    if (a === 'refresh') {
      let s; try { s = JSON.parse(dec(get(req, 'acervo_rt'))) } catch { return json(res, 401, { error: 'no_session' }) }
      const { ok, d } = await token({ refresh_token: s.rt, grant_type: 'refresh_token' });
      if (!ok) return json(res, 401, { error: d.error || 'refresh_failed' }, d.error === 'invalid_grant' ? [ck('acervo_rt', '', 0)] : undefined);
      let folders = []; try { folders = JSON.parse(Buffer.from(get(req, 'acervo_f'), 'base64url').toString()) } catch { }
      return json(res, 200, { access_token: d.access_token, expires_in: d.expires_in, email: s.email, folders });
    }
    if (a === 'folders') {
      const f = (Array.isArray(req.body) ? req.body : []).filter(x => /^[\w-]{10,}$/.test(x?.id)).slice(0, 15).map(x => ({ id: x.id, name: String(x.name || '').slice(0, 40) }));
      return json(res, 200, { ok: 1 }, [ck('acervo_f', Buffer.from(JSON.stringify(f)).toString('base64url'), YEAR)]);
    }
    if (a === 'logout') {
      try { const s = JSON.parse(dec(get(req, 'acervo_rt'))); await fetch('https://oauth2.googleapis.com/revoke', form({ token: s.rt })) } catch { }
      return json(res, 200, { ok: 1 }, [ck('acervo_rt', '', 0)]);
    }
    return json(res, 404, { error: 'not_found' });
  } catch { return json(res, 500, { error: 'server_error' }) }
};
