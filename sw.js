/**
 * Offline shell.
 *
 * The viewer is useful precisely because it needs nothing but its own files, so
 * the shell is cached after the first visit and works offline afterwards.
 * Requests go to the network first - see the fetch handler - and the cache is
 * the fallback. Nothing the user opens is ever cached: only the app itself.
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

  // Network first, cache as the fallback. Serving the shell cache-first kept
  // working offline but also kept serving *yesterday's* JavaScript and
  // WebAssembly after a deploy, so a fixed bug stayed visible until the user
  // cleared their cache. The cache is now what it should be for an app whose
  // data never leaves the disk: an offline copy, not the source of truth.
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only whole, same-origin responses are worth keeping; a 206 from a
        // range request must pass through untouched.
        if (response.ok && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
