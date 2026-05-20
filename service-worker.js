// Moodfilm Service Worker v2.0
// Strategy: Cache-first for shell assets, network-only for API calls
// New in v2: Background Sync, Periodic Background Sync, Push Notifications

const CACHE_NAME = "moodfilm-v2";
const SYNC_TAG = "moodfilm-bg-sync";
const PERIODIC_SYNC_TAG = "moodfilm-periodic-sync";

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
      return Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
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
  self.clients.claim();

  // Register periodic background sync if supported
  if ("periodicSync" in self.registration) {
    event.waitUntil(
      self.registration.periodicSync
        .register(PERIODIC_SYNC_TAG, { minInterval: 24 * 60 * 60 * 1000 }) // once a day
        .catch(() => {}) // fails gracefully if permission not granted
    );
  }
});

// ── FETCH: routing strategy ───────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Skip non-GET requests — always network
  if (request.method !== "GET") return;

  // 2. Skip Cloudflare Worker API calls — always network, never cache
  if (url.hostname.includes("workers.dev")) return;

  // 3. Skip TMDb image CDN — browser handles caching natively
  if (url.hostname.includes("image.tmdb.org")) return;

  // 4. Skip non-http(s) schemes
  if (!url.protocol.startsWith("http")) return;

  // 5. For everything else (app shell, fonts, icons): cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
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
          if (request.mode === "navigate") {
            return caches.match("/moodfilm-app/index.html");
          }
        });
    })
  );
});

// ── BACKGROUND SYNC ───────────────────────────────────────────────────────────
// Fires when connectivity is restored after going offline.
// Replays any queued mood requests that failed due to network loss.
self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(replayQueuedRequests());
  }
});

async function replayQueuedRequests() {
  const cache = await caches.open("moodfilm-sync-queue");
  const keys = await cache.keys();
  for (const request of keys) {
    try {
      const response = await fetch(request.clone());
      if (response.ok) {
        await cache.delete(request);
        // Notify open clients that the queued request succeeded
        const clients = await self.clients.matchAll();
        clients.forEach((client) =>
          client.postMessage({ type: "SYNC_COMPLETE", url: request.url })
        );
      }
    } catch {
      // Still offline — will retry on next sync event
    }
  }
}

// ── PERIODIC BACKGROUND SYNC ──────────────────────────────────────────────────
// Fires roughly once a day (browser-controlled) to pre-warm the app shell,
// so the next open feels instant even on slow connections.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(refreshAppShell());
  }
});

async function refreshAppShell() {
  const cache = await caches.open(CACHE_NAME);
  // Re-fetch core shell assets in the background so they're always fresh
  await Promise.allSettled(
    SHELL_ASSETS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.ok) await cache.put(url, response);
      } catch {
        // Network unavailable — keep existing cached version
      }
    })
  );
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
// Receives push payloads from your server and shows a notification.
// Expected payload shape: { title, body, icon, url }
self.addEventListener("push", (event) => {
  let data = {
    title: "Moodfilm",
    body: "Your daily film pick is ready 🎬",
    icon: "/moodfilm-app/icon-192.png",
    badge: "/moodfilm-app/icon-96.png",
    url: "/moodfilm-app/",
  };

  if (event.data) {
    try {
      Object.assign(data, event.data.json());
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      data: { url: data.url },
      vibrate: [100, 50, 100],
      requireInteraction: false,
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/moodfilm-app/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus existing tab if open
        for (const client of clients) {
          if (client.url.includes("/moodfilm-app/") && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open a new tab
        return self.clients.openWindow(targetUrl);
      })
  );
});
