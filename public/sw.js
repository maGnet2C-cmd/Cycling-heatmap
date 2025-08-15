// Simple service worker to cache the app shell and points.bin
const CACHE_NAME = 'htmap-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './summary.json',
  // points.bin is cached on demand; not precached to avoid stale data
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/points.bin')) {
      // Network-first for points.bin with fallback to cache
      event.respondWith(
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        }).catch(() => caches.match(event.request))
      );
      return;
    }

    // Cache-first for app shell; for summary.json prefer network-first to stay fresh
    if (url.pathname.endsWith('/summary.json')) {
      event.respondWith(
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        }).catch(() => caches.match(event.request))
      );
    } else {
      event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
      );
    }
  }
});

