const RELEASE = '3.0.8';
const CACHE = 'marine-iq-v308';
const INDEX = './index.html?v=308';
const RULES_SCRIPT = './marine-rules.js?v=308';
const RULES_DATA = './fishing-rules.json?v=308';
const SHELL = [INDEX, './marine-motion.js?v=302', './marine-tiles.js?v=300', './marine-mpa.js?v=300',
  RULES_SCRIPT, RULES_DATA,
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png', './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './brand.jpg?v=6', './brand-light.jpg?v=11'];
const urls = new Set(SHELL.map(path => new URL(path, self.location.href).href));
const snapshotCache = 'marinecast-mpa-v28';
const boundaries = new URL('./mpa-boundaries.geojson?v=28', self.location.href).href;
const appRoot = new URL('./', self.location.href).pathname;
const appIndex = new URL(INDEX, self.location.href).pathname;

async function installShell() {
  const requested = new URL(self.location.href).searchParams.get('release');
  // A registration keeps its script URL across updates, including an old
  // release query. Allow that URL to serve a newer worker, and reject stale bytes.
  if (requested) {
    const actual = RELEASE.split('.').map(Number);
    const wanted = requested.split('.').map(Number);
    const difference = actual.findIndex((part,i)=>part!==wanted[i]);
    if (!/^\d+\.\d+\.\d+$/.test(requested) ||
        (difference>=0 && actual[difference]<wanted[difference])) throw Error('Worker release still propagating');
  }
  const cache = await caches.open(CACHE);
  try {
    await cache.addAll(SHELL.map(path => new Request(path, {cache: 'reload'})));
    const [index, script, rules] = await Promise.all([
      cache.match(INDEX).then(response => response.text()),
      cache.match(RULES_SCRIPT).then(response => response.text()),
      cache.match(RULES_DATA).then(response => response.json())
    ]);
    if (!index.includes('<meta name="marinecast-version" content="' + RELEASE + '">') ||
        !script.includes("const release = '" + RELEASE + "';") || rules.release !== RELEASE) {
      throw Error('The published app shell is from a different release');
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
  await self.skipWaiting();
}

self.addEventListener('install', event => event.waitUntil(installShell()));

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => (key.startsWith('marine-iq-') && key !== CACHE) ||
      (key.startsWith('marinecast-mpa-') && key !== snapshotCache)).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data === 'marinecast-version') event.ports[0]?.postMessage(RELEASE);
});

const fromShell = path => caches.open(CACHE).then(cache => cache.match(path));

async function navigate(request, url) {
  const response = await fetch(request, {cache: 'no-store'});
  if (response.status >= 500) return (await fromShell(INDEX)) || response;
  if (!response.ok || ![appRoot, appIndex].includes(url.pathname) ||
      !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const html = await response.clone().text();
  const published = html.match(/name="marinecast-version" content="([\d.]+)"/)?.[1] ||
                    html.match(/Version (\d+\.\d+) ·/)?.[1];
  if (!published) return (await fromShell(INDEX)) || response;
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
    if ([appRoot, appIndex].includes(url.pathname) && url.searchParams.get('marinecast-release') === RELEASE) {
      event.respondWith(fromShell(INDEX).then(response => response || fetch(request)));
      return;
    }
    event.respondWith(navigate(request, url).catch(() => fromShell(INDEX)));
  } else if (request.url === boundaries) {
    event.respondWith((async () => {
      const saved = await caches.match(request, {cacheName: snapshotCache});
      return saved || fetch(request);
    })());
  } else if (urls.has(request.url)) {
    event.respondWith(fromShell(request).then(response => response || fetch(request)));
  }
});
