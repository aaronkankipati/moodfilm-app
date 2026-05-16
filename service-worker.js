// Moodfilm Service Worker v1.0
// Strategy: Cache-first for shell assets, network-only for API calls

const CACHE_NAME = "moodfilm-v1";

// Static assets to cache on install (the app shell)
const SHELL_ASSETS = [
  "/moodfilm-app/",
  "/moodfilm-app/index.html",
  "/moodfilm-app/manifest.json",
  "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap",
];

// ── INSTALL: cache the app shell ─────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use individual adds so one failure doesn't block others
      return Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
  // Take control immediately without waiting for old SW to finish
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ── FETCH: routing strategy ───────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Skip non-GET requests (POST to Cloudflare Worker etc.) — always network
  if (request.method !== "GET") return;

  // 2. Skip Cloudflare Worker API calls — always network, never cache
  if (url.hostname.includes("workers.dev")) return;

  // 3. Skip TMDb image CDN — let browser handle caching natively
  if (url.hostname.includes("image.tmdb.org")) return;

  // 4. Skip chrome-extension and other non-http(s) schemes
  if (!url.protocol.startsWith("http")) return;

  // 5. For everything else (app shell, fonts, icons): cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache for next time
      return fetch(request)
        .then((response) => {
          // Only cache valid responses
          if (
            !response ||
            response.status !== 200 ||
            response.type === "error"
          ) {
            return response;
          }

          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, toCache);
          });

          return response;
        })
        .catch(() => {
          // Offline fallback — return cached index.html for navigation requests
          if (request.mode === "navigate") {
            return caches.match("/moodfilm-app/index.html");
          }
        });
    })
  );
});
