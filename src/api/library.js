// GET /api/library -> lista os filmes das pastas do responsável (só para quem tem sessão).
import { getSession, cfg, drive, json } from '../lib.js';

const VID = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;
let cache = { t: 0, v: null };

export async function onRequest({ request, env }) {
    if (!(await getSession(request, env))) return json(401, { error: 'login' });
    if (cache.v && Date.now() - cache.t < 60e3) return json(200, cache.v, { 'Cache-Control': 'private, max-age=0' });
    try {
        const roots = cfg(env).roots, items = [], where = new Map(); // id da pasta -> { r: nome da raiz, p: caminho }
        for (const id of roots) {
            const r = await drive(env, `files/${id}?fields=name&supportsAllDrives=true`);
            where.set(id, { r: 'Drive: ' + ((await r.json().catch(() => ({}))).name || 'Filmes'), p: '' });
        }
        let level = [...roots], calls = roots.length;
        while (level.length && calls < 40) {            // 1 consulta por nível de pastas (limite do plano gratuito: 50 chamadas)
            const next = [];
            for (let i = 0; i < level.length && calls < 40; i += 20) {
                const q = level.slice(i, i + 20).map(p => `'${p}' in parents`).join(' or ') + ' and trashed=false';
                let page = '';
                do {
                    calls++;
                    const r = await drive(env, 'files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,parents)&q=' + encodeURIComponent(`(${q.replace(' and trashed=false', '')}) and trashed=false`) + page);
                    if (!r.ok) throw new Error('drive ' + r.status);
                    const d = await r.json();
                    for (const f of d.files || []) {
                        const w = where.get((f.parents || [])[0]); if (!w) continue;
                        if (f.mimeType === 'application/vnd.google-apps.folder') { where.set(f.id, { r: w.r, p: w.p + f.name + '/' }); next.push(f.id); }
                        else if (VID.test(f.name) && (f.mimeType.startsWith('video/') || f.mimeType === 'application/octet-stream' || /\.(mkv|avi)$/i.test(f.name)))
                            items.push({ id: 'drive:' + f.id, driveId: f.id, r: w.r, p: w.p + f.name, n: f.name, source: 'drive' });
                    }
                    page = d.nextPageToken ? '&pageToken=' + encodeURIComponent(d.nextPageToken) : '';
                } while (page && calls < 40);
            }
            level = next;
        }
        cache = { t: Date.now(), v: { items } };
        return json(200, cache.v);
    } catch (e) {
        console.error('library:', e);
        return json(502, { error: 'drive' });
    }
}