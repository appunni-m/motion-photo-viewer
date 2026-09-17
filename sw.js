/**
 * Offline shell.
 *
 * The viewer is useful precisely because it needs nothing but its own files, so
 * the shell is cached after the first visit and every later visit is served
 * from the cache. Nothing the user opens is ever cached: only the app itself.
 */

const BUILD = '__BUILD_ID__';
const CACHE = `motion-photo-viewer-${BUILD}`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/main.js',
  './src/scan.js',
  './src/worker.js',
  './src/wasm.js',
  './src/files.js',
  './src/preview.js',
  './src/format.js',
  './wasm/motion_photo_wasm.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a new build is picked up, cache as fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    }),
  );
});
