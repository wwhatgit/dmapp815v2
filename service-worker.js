/* DMapp · BIS v2 — service-worker.js
   Built: 2026-03-24  Version: 2026.03.24.01
   MapLibre removed. Google Maps external navigation.
*/
const CACHE_VER = 'dmapp-v2-2026.04.03.06';
const APP_FILES = [
  './', './index.html', './app.js', './style.css',
  './optimiser.js', './manifest.json', './version.json'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VER).then(c => c.addAll(APP_FILES).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const external = [
    'googleapis.com','google.com','script.google.com',
    'openstreetmap.org','unpkg.com','fonts.google',
    'router.project-osrm.org'
  ];
  if (external.some(h => url.hostname.includes(h))) {
    e.respondWith(fetch(e.request).catch(() => new Response('', {status:503})));
    return;
  }
  e.respondWith(
    fetch(e.request, {cache:'no-store'})
      .then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          caches.open(CACHE_VER).then(c => c.put(e.request, resp.clone()));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
