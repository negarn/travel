const CACHE_NAME = 'travel-offline-v1';
const APP_SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

function isSameOriginUrl(url) {
  return url.origin === self.location.origin;
}

async function cacheResponse(request, response) {
  if (!response || !response.ok || response.type === 'opaque') {
    return response;
  }

  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function fetchAndCache(request) {
  return cacheResponse(request, await fetch(request));
}

async function respondWithCachedFallback(request, fallbackRequest = request) {
  try {
    return await fetchAndCache(request);
  } catch (error) {
    const cachedResponse = await caches.match(fallbackRequest);

    if (cachedResponse) {
      return cachedResponse;
    }

    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        )
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (!isSameOriginUrl(url) || url.pathname.startsWith('/auth/')) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(respondWithCachedFallback(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(respondWithCachedFallback(request, '/index.html'));
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      return cachedResponse ?? fetchAndCache(request);
    })
  );
});
