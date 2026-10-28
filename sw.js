/* Service worker do Acervo do Cidjei.
   Guarda só a "casca" do app para abrir rápido e mostrar algo sem internet.
   Nunca toca em /api/ nem em requisições Range, para não interferir no streaming do Drive. */
const V = 'acervo-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || r.headers.has('range')) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put('/', c)) } return res }).catch(() => caches.match('/')));
    return;
  }
  if (SHELL.includes(u.pathname)) e.respondWith(caches.match(r).then(h => h || fetch(r)));
});
