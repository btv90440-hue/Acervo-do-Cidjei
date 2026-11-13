// Proxy mínimo do Drive do responsável, só para o que está dentro do catálogo.
// Usado pelo player para achar e baixar legendas:  /api/gd/files  e  /api/gd/files/:id
import { getSession, inCatalog, drive, json } from '../lib.js';

const ID_RE = /^[\w-]{10,200}$/;

export async function onRequest({ request, env, params }) {
    if (request.method !== 'GET') return json(405, { error: 'method' });
    if (!(await getSession(request, env))) return json(401, { error: 'login' });
    const u = new URL(request.url), id = params.id;
    let path;
    if (!id) {
        const q = u.searchParams.get('q') || '', m = q.match(/^'([\w-]{10,200})' in parents and trashed=false$/);
        if (!m || !(await inCatalog(env, m[1]))) return json(403, { error: 'forbidden' });
        path = 'files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=' + encodeURIComponent('files(id,name,mimeType)') + '&q=' + encodeURIComponent(q);
    } else {
        if (!ID_RE.test(id) || !(await inCatalog(env, id))) return json(403, { error: 'forbidden' });
        path = `files/${id}?supportsAllDrives=true&` + (u.searchParams.get('alt') === 'media' ? 'alt=media' : 'fields=parents');
    }
    const r = await drive(env, path);
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}