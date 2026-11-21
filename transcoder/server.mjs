// Transcodificador de áudio com FFmpeg. Roda em qualquer máquina com Docker (não no Cloudflare Workers).
// O vídeo é copiado sem recodificar (-c:v copy); só o áudio vira AAC, e só quando o codec não é nativo.
//
// Rotas (exigem "Authorization: Bearer <TRANSCODER_SECRET>", exceto /health):
//   POST /jobs         {id, source} -> analisa o áudio; se precisar, inicia a conversão
//   GET  /jobs/:id                  -> {state, progress, error}
//   GET  /files/:id                 -> MP4 convertido (aceita Range)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const SECRET = process.env.TRANSCODER_SECRET || '';
const SOURCE_ORIGIN = process.env.SOURCE_ORIGIN ? new URL(process.env.SOURCE_ORIGIN).origin : '';
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS) || 1);
const CACHE_MAX_BYTES = (Number(process.env.CACHE_MAX_GB) || 100) * 1024 ** 3;

const ID_RE = /^[\w-]{10,200}$/;
const NATIVE_AUDIO = new Set(['aac', 'mp3']); // codecs que o navegador toca sem ajuda
const PROTOCOLS = 'https,http,tcp,tls,crypto'; // o ffmpeg só lê pela rede, nunca arquivos locais

if (SECRET.length < 32 || !SOURCE_ORIGIN) {
  console.error('Defina TRANSCODER_SECRET (32+ caracteres) e SOURCE_ORIGIN (URL pública do site).');
  process.exit(1);
}

const jobs = new Map(); // id -> { state, progress, duration, error }
let running = 0;
const waiting = [];

const finalPath = (id) => join(DATA_DIR, `${id}.mp4`);
const partPath = (id) => join(DATA_DIR, `${id}.part.mp4`);
const exists = (path) => stat(path).then(() => true, () => false);

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const text = (res, status, msg) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(msg);
};

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Lê só o primeiro áudio (codec e duração). Não baixa o arquivo inteiro.
function probe(source) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-protocol_whitelist', PROTOCOLS,
      '-select_streams', 'a:0', '-show_entries', 'stream=codec_name:format=duration',
      '-of', 'json', source,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || 'ffprobe falhou'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Resposta inválida do ffprobe')); }
    });
  });
}

function acquireSlot() {
  if (running < MAX_JOBS) { running++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // a vaga passa direto para o próximo da fila
  else running--;
}

function transcode(id, source, job) {
  const args = [
    '-hide_banner', '-nostdin', '-nostats', '-y', '-progress', 'pipe:1',
    '-protocol_whitelist', PROTOCOLS,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-i', source,
    '-map', '0:V:0?', '-map', '0:a:0', // 1º vídeo (ignora capa) e 1º áudio
    '-c:v', 'copy', // vídeo intacto, sem recodificar
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-sn', '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-f', 'mp4', partPath(id),
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let pending = '';
    p.stdout.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && job.duration > 0) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / job.duration);
      }
    });
    p.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(log.trim().split('\n').slice(-5).join(' | ') || `ffmpeg saiu com código ${code}`));
      }
      rename(partPath(id), finalPath(id)).then(resolve, reject);
    });
  });
}

// Mantém o cache dentro do limite: remove os convertidos menos usados até caber.
async function pruneCache(keepId) {
  const files = [];
  let total = 0;
  for (const name of await readdir(DATA_DIR)) {
    if (!name.endsWith('.mp4') || name.endsWith('.part.mp4')) continue;
    const st = await stat(join(DATA_DIR, name));
    files.push({ name, size: st.size, mtime: st.mtimeMs });
    total += st.size;
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_MAX_BYTES) break;
    if (f.name === `${keepId}.mp4`) continue;
    await unlink(join(DATA_DIR, f.name)).catch(() => {});
    jobs.delete(f.name.slice(0, -4));
    total -= f.size;
  }
}

async function runJob(id, source, job) {
  job.state = 'queued';
  await acquireSlot();
  try {
    job.state = 'running';
    await transcode(id, source, job);
    job.state = 'ready';
    job.progress = 1;
    pruneCache(id).catch((err) => console.error('limpeza do cache:', err.message));
  } catch (err) {
    job.state = 'failed';
    job.error = String(err.message || err).slice(-800);
    await unlink(partPath(id)).catch(() => {});
  } finally {
    releaseSlot();
  }
}

async function startJob(id, source) {
  const current = jobs.get(id);
  if (current && current.state !== 'failed') return current; // já analisado ou em andamento
  if (await exists(finalPath(id))) {
    const ready = { state: 'ready', progress: 1, duration: 0, error: '' };
    jobs.set(id, ready);
    return ready;
  }
  const job = { state: 'probing', progress: 0, duration: 0, error: '' };
  jobs.set(id, job);
  try {
    const info = await probe(source);
    const audio = info.streams?.[0];
    if (!audio || NATIVE_AUDIO.has(audio.codec_name)) {
      job.state = 'not_needed';
      return job;
    }
    job.duration = Number(info.format?.duration) || 0;
    runJob(id, source, job); // segue em segundo plano
  } catch (err) {
    job.state = 'failed';
    job.error = String(err.message || err).slice(-800);
  }
  return job;
}

async function currentState(id) {
  const job = jobs.get(id);
  if (job) return job;
  if (await exists(finalPath(id))) return { state: 'ready', progress: 1 };
  return null;
}

const publicJob = (job) => ({
  state: job.state,
  progress: Math.round((job.progress || 0) * 1000) / 1000,
  ...(job.error ? { error: job.error } : {}),
});

async function serveFile(req, res, id) {
  const path = finalPath(id);
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    return text(res, 404, 'Ainda não convertido');
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2])); // intervalo de sufixo: últimos N bytes
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  utimes(path, new Date(), new Date()).catch(() => {}); // marca como recente para a limpeza
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('corpo grande demais');
  }
  return raw;
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') return text(res, 200, 'ok');
    if (!authorized(req)) return text(res, 401, 'Não autorizado');

    if (pathname === '/jobs' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return text(res, 400, 'JSON inválido'); }
      const { id, source } = body || {};
      if (typeof id !== 'string' || !ID_RE.test(id) || typeof source !== 'string') {
        return text(res, 400, 'Pedido inválido');
      }
      let u;
      try { u = new URL(source); } catch { return text(res, 400, 'Origem inválida'); }
      if (u.origin !== SOURCE_ORIGIN || u.pathname !== `/api/stream/${id}`) {
        return text(res, 403, 'Origem não permitida');
      }
      return json(res, 202, publicJob(await startJob(id, source)));
    }

    const m = /^\/(jobs|files)\/([^/]+)$/.exec(pathname);
    if (m && ID_RE.test(m[2])) {
      const id = m[2];
      if (m[1] === 'jobs' && req.method === 'GET') {
        const job = await currentState(id);
        return job ? json(res, 200, publicJob(job)) : json(res, 404, { state: 'none' });
      }
      if (m[1] === 'files' && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveFile(req, res, id);
      }
    }
    return text(res, 404, 'Não encontrado');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) text(res, 500, 'Erro interno');
  }
});

await mkdir(DATA_DIR, { recursive: true });
for (const name of await readdir(DATA_DIR)) {
  if (name.endsWith('.part.mp4')) await unlink(join(DATA_DIR, name)).catch(() => {});
}
server.listen(PORT, () => console.log(`Transcodificador ouvindo na porta ${PORT}`));
