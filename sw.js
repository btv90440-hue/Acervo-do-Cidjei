/* Service worker desativado.
   Este arquivo existe só para remover o service worker antigo dos aparelhos que já o instalaram:
   ele apaga os caches, se desregistra e recarrega a página. Não intercepta nenhuma requisição. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
