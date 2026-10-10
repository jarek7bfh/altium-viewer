// Altium Viewer service worker: offline app shell + Android share target
const VERSION = 'av-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest', './vendor/cfb.min.js',
  './js/app.js', './js/util.js', './js/schparse.js', './js/pcbparse.js', './js/netlink.js',
  './js/schrender.js', './js/pcbrender.js', './js/pane.js', './js/hit.js', './js/store.js',
  './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'av-share-inbox').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll('files');
        const c = await caches.open('av-share-inbox');
        let i = 0;
        for (const f of files) {
          if (!f || !f.name) continue;
          const key = new URL(`./__inbox/${Date.now()}-${i++}?name=${encodeURIComponent(f.name)}`, self.registration.scope).href;
          await c.put(key, new Response(f, { headers: { 'x-lm': String(f.lastModified || Date.now()) } }));
        }
      } catch (err) { /* ignore */ }
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) {
      // refresh in background
      e.waitUntil(fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); }).catch(() => {}));
      return hit;
    }
    try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }
    catch (err) { return (await c.match('./index.html')) || Response.error(); }
  })());
});
