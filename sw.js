// Service worker: caches the app shell so the app opens offline.
// GitHub API calls are cross-origin and always go straight to the network.
const CACHE = 'pbt-v7';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'core.js',
  'github.js',
  'versions.js',
  'lock.js',
  'manifest.webmanifest',
  'logo-flame.png',
  'icon-v4-192.png',
  'icon-v4-512.png',
  'icon-v4-maskable-512.png',
  'apple-touch-icon-v4.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network first (skipping the browser's own HTTP cache) so updates arrive right away;
  // fall back to the cached copy when offline.
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('index.html'))),
  );
});
