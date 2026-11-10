// @ts-nocheck — service-worker global scope (ServiceWorkerGlobalScope, not
// Window); the app tsconfig only loads the DOM lib.
// Service worker for the mobile-remote PWA.
//
// It caches ONLY the content-hashed /assets/* files (safe to cache forever —
// a new build emits new names). It deliberately never touches index.html or
// /api/*: the helper serves index.html with no-store so new builds always
// take effect, and /api carries auth cookies and live state. Requests outside
// /assets/ fall through to the network untouched.

const CACHE = "camber-remote-assets-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/assets/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
