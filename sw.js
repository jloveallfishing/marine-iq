const RELEASE = '2.7.0';
const CACHE = 'marine-iq-v27';
const INDEX = './index.html?v=27';
const SHELL = [INDEX, './marine-motion.js?v=27', './marine-tiles.js?v=27', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './brand.jpg?v=6', './brand-light.jpg?v=11'];
const urls = new Set(SHELL.map(path => new URL(path, self.location.href).href));
const appRoot = new URL('./', self.location.href).pathname;
const appIndex = new URL(INDEX, self.location.href).pathname;

async function installShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL.map(path => new Request(path, {cache: 'reload'})));
  const index = await cache.match(INDEX);
  if (!(await index.text()).includes('<meta name="marinecast-version" content="' + RELEASE + '">')) {
    await caches.delete(CACHE);
    throw Error('The published app shell is from a different release');
  }
  await self.skipWaiting();
}

self.addEventListener('install', event => event.waitUntil(installShell()));

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('marine-iq-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data === 'marinecast-version') event.ports[0]?.postMessage(RELEASE);
});

const fromShell = path => caches.open(CACHE).then(cache => cache.match(path));

async function navigate(request, url) {
  const response = await fetch(request, {cache: 'no-cache'});
  if (response.status >= 500) return (await fromShell(INDEX)) || response;
  if (!response.ok || ![appRoot, appIndex].includes(url.pathname) ||
      !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const html = await response.clone().text();
  const published = html.match(/name="marinecast-version" content="([\d.]+)"/)?.[1] ||
                    html.match(/Version (\d+\.\d+) ·/)?.[1];
  if (!published) return response;
  const wanted = RELEASE.split('.').map(Number), actual = published.split('.').map(Number);
  const firstDifference = wanted.findIndex((part, i) => part !== (actual[i] || 0));
  const older = firstDifference >= 0 && (actual[firstDifference] || 0) < wanted[firstDifference];
  return older ? (await fromShell(INDEX)) || response : response;
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (url.searchParams.get('marinecast-release') === RELEASE) {
      event.respondWith(fromShell(INDEX).then(response => response || fetch(request)));
      return;
    }
    event.respondWith(navigate(request, url).catch(() => fromShell(INDEX)));
  } else if (urls.has(request.url)) {
    event.respondWith(fromShell(request).then(response => response || fetch(request)));
  }
});
