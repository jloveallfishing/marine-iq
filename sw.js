const CACHE = 'marine-iq-v24';
const SHELL = ['./', './index.html', './marine-motion.js?v=24', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './brand.jpg?v=6', './brand-light.jpg?v=11'];
const urls = new Set(SHELL.map(path => new URL(path, self.location.href).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache =>
    cache.addAll(SHELL.map(path => new Request(path, {cache: 'reload'})))
  ).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('marine-iq-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, {cache: 'no-cache'}).catch(() => caches.match('./index.html')));
  } else if (urls.has(request.url)) {
    event.respondWith(caches.match(request).then(response => response || fetch(request)));
  }
});
