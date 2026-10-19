// Service worker: makes Car Compare installable and lets the app shell + Featured catalogue work offline.
// Network-first, so a server update is picked up on the next visit; the cache is only the offline fallback.
const CACHE = 'car-compare-v1';
const SHELL = ['/', '/style.css', '/app.js', '/logic.js', '/data/cars.json', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // fonts, photos: browser default
  if (url.pathname.startsWith('/api/')) {
    // live data is never cached here; offline gets a clear message the app shows in its status line
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "you're offline" }),
      { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
    return res;
  }).catch(() => caches.match(url.pathname).then(hit => hit || caches.match('/'))));
});
