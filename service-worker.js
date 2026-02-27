const CACHE_NAME = 'mlb-scoreboard-v12';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './assets/stadium.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin: cache優先（オフラインでも最低限開けるように）
  if (url.origin === self.location.origin) {
    // config.js は設定変更が反映されるよう network-first
    if (url.pathname.endsWith('/config.js')) {
      event.respondWith(
        fetch(request).catch(() => caches.match(request))
      );
      return;
    }
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // MLB API: ネット優先、失敗したらキャッシュ（ほぼ無い想定）
  if (url.hostname === 'statsapi.mlb.com') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
  }
});

