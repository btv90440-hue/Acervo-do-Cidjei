// Funções compartilhadas pelas rotas /api/*.
export const enc = new TextEncoder();
export const dec = new TextDecoder();
// ---- base64url ----
export const b64u = {
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
export async function seal(secret, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text)));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return b64u.enc(out);
}
export async function unseal(secret, token) {
    const b = b64u.dec(token);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await aesKey(secret), b.slice(12));
    return dec.decode(pt);
}


export const readCookie = (request, name) => {
    const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? m[1] : '';
};
export const safeEqual = (a, b) => {
    const x = enc.encode(String(a)), y = enc.encode(String(b));
    if (x.length !== y.length) return false;
    let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
};
export const json = (status, payload, headers = {}) => new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

// ---- configuração (vem do wrangler.jsonc > vars) ----
const list = v => String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
export const cfg = env => ({
    roots: list(env.FOLDER_IDS),                       // pastas do catálogo
    owner: String(env.OWNER_EMAIL || '').toLowerCase(), // sempre tem acesso
    allow: list(env.ALLOWED_EMAILS).map(s => s.toLowerCase()), // liberados por e-mail
    mode: env.ACCESS_MODE === 'lista' ? 'lista' : 'compartilhamento',
});

// ---- Drive do responsável (o visitante nunca dá acesso ao próprio Drive) ----
let tok = { v: '', exp: 0 };
export async function ownerToken(env) {
    if (tok.v && Date.now() < tok.exp - 60e3) return tok.v;
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: String(env.OWNER_REFRESH_TOKEN || '').trim(), grant_type: 'refresh_token'
        }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error('token do responsável recusado pelo Google (' + (d.error || r.status) + ')');
    tok = { v: d.access_token, exp: Date.now() + (d.expires_in || 3000) * 1000 };
    return tok.v;
}
export const drive = async (env, path, init = {}) => fetch('https://www.googleapis.com/drive/v3/' + path,
    { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + await ownerToken(env) } });

// ---- sessão do visitante (cookie criptografado, 12 h) ----
export async function getSession(request, env) {
    try {
        const s = JSON.parse(await unseal(env.COOKIE_SECRET, readCookie(request, 'acervo_s')));
        return s.exp > Date.now() ? s : null;
    } catch { return null; }
}

// ---- este e-mail foi liberado? ----
export async function hasAccess(env, email) {
    const c = cfg(env); email = String(email).toLowerCase();
    if (email === c.owner || c.allow.includes(email)) return true;
    if (c.mode === 'lista') return false;
    for (const id of c.roots) { // quem tem a pasta compartilhada no Drive entra
        let page = '';
        for (let i = 0; i < 5; i++) {
            const r = await drive(env, `files/${id}/permissions?pageSize=100&supportsAllDrives=true&fields=nextPageToken,permissions(emailAddress)` + page);
            if (!r.ok) break;
            const d = await r.json();
            if ((d.permissions || []).some(p => String(p.emailAddress || '').toLowerCase() === email)) return true;
            if (!d.nextPageToken) break;
            page = '&pageToken=' + encodeURIComponent(d.nextPageToken);
        }
    }
    return false;
}

// ---- este arquivo/pasta está dentro das pastas do catálogo? (impede ler o resto do Drive) ----
const okIds = new Set();
export async function inCatalog(env, id) {
    const roots = cfg(env).roots; let cur = id;
    for (let i = 0; i < 12; i++) {
        if (roots.includes(cur) || okIds.has(cur)) { if (okIds.size > 5000) okIds.clear(); okIds.add(id); return true; }
        const r = await drive(env, `files/${encodeURIComponent(cur)}?fields=parents&supportsAllDrives=true`);
        if (!r.ok) return false;
        cur = ((await r.json()).parents || [])[0];
        if (!cur) return false;
    }
    return false;
}