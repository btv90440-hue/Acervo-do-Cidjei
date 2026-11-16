// Catálogo público do Google Drive.
// A API key é mantida no Worker (Secret) e nunca enviada ao navegador.
// As pastas precisam estar compartilhadas como "Qualquer pessoa com o link — Leitor".

const VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov|avi|ogv)$/i;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const enc = new TextEncoder();
const dec = new TextDecoder();
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function b64url(bytes) {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64url(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - s.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function makeStreamToken(id, details, secret) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, ...details })));
  const signature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(id + '.' + payload))));
  return payload + '.' + signature;
}

export async function verifyPublicStreamToken(id, token, env) {
  const secret = String(env.GOOGLE_DRIVE_API_KEY || '');
  if (!secret || !token) return null;
  try {
    const [payload, signature, extra] = String(token).split('.');
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(signature), enc.encode(id + '.' + payload));
    if (!valid) return null;
    const details = JSON.parse(dec.decode(unb64url(payload)));
    if (!details || !Number.isFinite(details.exp) || details.exp < Date.now()) return null;
    if (details.link && !isAllowedDownloadUrl(details.link)) return null;
    if (!Array.isArray(details.resourceKeys)) return null;
    return details;
  } catch {
    return null;
  }
}

function isAllowedDownloadUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (
      u.hostname === 'drive.google.com' ||
      u.hostname === 'drive.usercontent.google.com' ||
      u.hostname === 'www.googleapis.com' ||
      u.hostname.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

async function driveJson(path, params, apiKey, resourceKeys = []) {
  const url = new URL('https://www.googleapis.com/drive/v3/' + path);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  if (resourceKeys.length) headers['X-Goog-Drive-Resource-Keys'] = resourceKeys.join(',');
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail?.error?.message || 'Google Drive API recusou a solicitação.';
    throw new Error('Google Drive (' + response.status + '): ' + message);
  }
  return response.json();
}

export async function buildPublicCatalog(env) {
  const apiKey = String(env.GOOGLE_DRIVE_API_KEY || '');
  const rootIds = String(env.PUBLIC_DRIVE_FOLDER_IDS || '')
    .split(',').map(v => v.trim()).filter(v => /^[\w-]{10,200}$/.test(v));
  if (!apiKey) throw new Error('GOOGLE_DRIVE_API_KEY não configurada no Worker.');
  if (!rootIds.length) throw new Error('PUBLIC_DRIVE_FOLDER_IDS não contém IDs válidos.');

  const folders = [];
  const files = [];
  const seenFiles = new Set();
  const allResourceKeys = [];

  for (const rootId of rootIds) {
    const root = await driveJson('files/' + encodeURIComponent(rootId), {
      fields: 'id,name,mimeType,resourceKey',
      supportsAllDrives: 'true',
    }, apiKey);
    if (root.mimeType !== FOLDER_MIME) {
      throw new Error('O ID ' + rootId + ' não corresponde a uma pasta do Google Drive.');
    }

    const rootKeys = root.resourceKey ? [rootId + '/' + root.resourceKey] : [];
    const folderSummary = { id: root.id, name: root.name || 'Pasta do acervo', count: 0 };
    folders.push(folderSummary);
    const queue = [{ id: root.id, name: '', resourceKeys: rootKeys, depth: 0 }];
    const visited = new Set([root.id]);

    while (queue.length) {
      const current = queue.shift();
      if (current.depth > 12) continue;
      let pageToken = '';
      do {
        const page = await driveJson('files', {
          q: "'" + current.id + "' in parents and trashed = false",
          fields: 'nextPageToken,files(id,name,mimeType,parents,resourceKey,size,modifiedTime,webContentLink)',
          pageSize: 1000,
          pageToken,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        }, apiKey, current.resourceKeys);
        for (const item of page.files || []) {
          if (item.mimeType === FOLDER_MIME) {
            if (!visited.has(item.id)) {
              visited.add(item.id);
              const keys = current.resourceKeys.slice();
              if (item.resourceKey) keys.push(item.id + '/' + item.resourceKey);
              queue.push({
                id: item.id,
                name: current.name + item.name + '/',
                resourceKeys: keys,
                depth: current.depth + 1,
              });
            }
            continue;
          }
          if (!VIDEO_RE.test(item.name || '') && !String(item.mimeType || '').startsWith('video/')) continue;
          if (seenFiles.has(item.id)) continue;
          seenFiles.add(item.id);

          const resourceKeys = current.resourceKeys.slice();
          if (item.resourceKey) resourceKeys.push(item.id + '/' + item.resourceKey);
          const token = await makeStreamToken(item.id, {
            resourceKeys,
            link: item.webContentLink || '',
          }, apiKey);
          files.push({
            id: item.id,
            name: item.name,
            mimeType: item.mimeType || '',
            size: item.size || null,
            modifiedTime: item.modifiedTime || null,
            rootId: root.id,
            rootName: folderSummary.name,
            path: current.name + item.name,
            streamToken: token,
          });
          folderSummary.count++;
          if (files.length >= 5000) break;
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken && files.length < 5000);
      if (files.length >= 5000) break;
    }
  }

  return {
    public: true,
    folders,
    files,
    total: files.length,
    generatedAt: new Date().toISOString(),
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return new Response('Método não permitido', { status: 405, headers: { Allow: 'GET' } });
  }
  try {
    const catalog = await buildPublicCatalog(env);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120, s-maxage=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Catálogo público:', error);
    return new Response(JSON.stringify({ public: false, error: error.message || 'Falha ao carregar o catálogo público.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
