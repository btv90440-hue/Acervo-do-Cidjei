// Login Google persistente (OAuth "authorization code" com refresh token). Sem dependências.
//
//   GET  /api/auth/status    -> { configured }
//   GET  /api/auth/login     -> redireciona para o Google
//   GET  /api/auth/callback  -> troca o código pelo refresh token e guarda num cookie criptografado
//   POST /api/auth/refresh   -> devolve um access token novo (+ e-mail e pastas salvas)
//   POST /api/auth/folders   -> lembra as pastas importadas (cookie)
//   POST /api/auth/logout    -> revoga o refresh token e apaga o cookie
//
// Cloudflare Workers.
// Segredos (Cloudflare > Workers & Pages > seu Worker > Settings > Variables and Secrets, tipo Secret):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, COOKIE_SECRET (texto aleatório longo)

const YEAR = 31536000;
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.readonly';
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- base64url ----
const b64u = {
  enc(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

// ---- cookie criptografado (AES-256-GCM via Web Crypto) ----
async function aesKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64u.enc(out);
}
async function unseal(secret, token) {
  const b = b64u.dec(token);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await aesKey(secret), b.slice(12));
  return dec.decode(pt);
}

// ---- utilidades ----
const readCookie = (request, name) => {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : '';
};
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/api/auth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function respond(status, payload, cookies = [], extra = {}) {
  const headers = new Headers({ 'Cache-Control': 'no-store', ...extra });
  if (payload !== null) headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(payload === null ? null : JSON.stringify(payload), { status, headers });
}
const redirect = (location, cookies = []) => respond(302, null, cookies, { Location: location });

const safeEqual = (a, b) => {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};

export async function onRequest({ request, params, env }) {
  const { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, COOKIE_SECRET } = env;
  const configured = Boolean(CLIENT_ID && CLIENT_SECRET && COOKIE_SECRET);
  const action = params.action;
  const url = new URL(request.url);
  const site = url.origin;

  async function googleToken(body) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  }

  if (action === 'status') return respond(200, { configured });
  if (!configured) return respond(503, { error: 'not_configured' });
  if (action !== 'login' && action !== 'callback' && request.method !== 'POST') {
    return respond(405, { error: 'method' });
  }
  // Ações POST só aceitam chamadas vindas do próprio site.
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== site) return respond(403, { error: 'origin' });
  }

  try {
    if (action === 'login') {
      const state = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
      const query = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: site + '/api/auth/callback',
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'select_account consent',
        state,
      });
      return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + query, [cookie('acervo_st', state, 600)]);
    }

    if (action === 'callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || !safeEqual(state, readCookie(request, 'acervo_st'))) return redirect('/?auth=err');
      const { ok, data } = await googleToken({
        code, grant_type: 'authorization_code', redirect_uri: site + '/api/auth/callback',
      });
      if (!ok || !data.refresh_token) return redirect('/?auth=err');
      let email = '';
      try { email = JSON.parse(dec.decode(b64u.dec(data.id_token.split('.')[1]))).email || ''; } catch { /* sem e-mail */ }
      return redirect('/?auth=ok', [
        cookie('acervo_rt', await seal(COOKIE_SECRET, JSON.stringify({ rt: data.refresh_token, email })), YEAR),
        cookie('acervo_st', '', 0),
      ]);
    }

    if (action === 'refresh') {
      let session;
      try { session = JSON.parse(await unseal(COOKIE_SECRET, readCookie(request, 'acervo_rt'))); }
      catch { return respond(401, { error: 'no_session' }); }
      const { ok, data } = await googleToken({ refresh_token: session.rt, grant_type: 'refresh_token' });
      if (!ok) {
        return respond(401, { error: data.error || 'refresh_failed' },
          data.error === 'invalid_grant' ? [cookie('acervo_rt', '', 0)] : []);
      }
      let folders = [];
      try { folders = JSON.parse(dec.decode(b64u.dec(readCookie(request, 'acervo_f')))); } catch { /* nenhuma */ }
      return respond(200, {
        access_token: data.access_token, expires_in: data.expires_in, email: session.email, folders,
      });
    }

    if (action === 'folders') {
      const body = await request.json().catch(() => []);
      const list = (Array.isArray(body) ? body : [])
        .filter(f => f && typeof f.id === 'string' && /^[\w-]{10,}$/.test(f.id))
        .slice(0, 15)
        .map(f => ({ id: f.id, name: String(f.name || '').slice(0, 40) }));
      // Cookies têm limite de ~4 KB: se os nomes forem muito longos (acentos), descarta as últimas pastas.
      let value = b64u.enc(enc.encode(JSON.stringify(list)));
      while (value.length > 3600 && list.length) {
        list.pop();
        value = b64u.enc(enc.encode(JSON.stringify(list)));
      }
      return respond(200, { ok: 1 }, [cookie('acervo_f', value, YEAR)]);
    }

    if (action === 'logout') {
      try {
        const session = JSON.parse(await unseal(COOKIE_SECRET, readCookie(request, 'acervo_rt')));
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: session.rt }),
        });
      } catch { /* já estava desconectado */ }
      return respond(200, { ok: 1 }, [cookie('acervo_rt', '', 0)]);
    }

    return respond(404, { error: 'not_found' });
  } catch (err) {
    console.error('auth:', err);
    return respond(500, { error: 'server_error' });
  }
}
