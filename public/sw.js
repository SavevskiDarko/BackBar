/* ===========================================================================
   Backbar service worker

   Its job is narrow: keep the app shell available when the wifi isn't. Data
   caching and the write queue live in IndexedDB (src/lib/db.js), not here —
   this only makes sure the app itself still opens.

   Vite fingerprints filenames on every build, so there is no fixed list to
   pre-cache. Instead assets are cached the first time they're fetched, and a
   new CACHE name on deploy retires everything from the previous build.
   =========================================================================== */

/* __BUILD_ID__ is replaced at build time (scripts/stamp-sw.mjs). A fixed cache
   name meant a deployed update could keep serving the previous bundle until the
   customer cleared their cache — unacceptable for an installed app on a bar
   tablet that nobody thinks to reset. */
const CACHE = "backbar-shell-__BUILD_ID__";

self.addEventListener("install", (e) => {
  // A fresh worker should take over straight away — a bar tablet may sit open
  // for days, and waiting for every tab to close is not realistic.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest"])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

// Tell every open tab that a new version is live, so they can reload instead of
// running last week's code until the app is force-quit.
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "sw-updated", cache: CACHE });
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API. A stale login or a stale bar snapshot is worse than
  // an honest failure the app can handle.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: try the network so a deploy is picked up, fall back to the
  // cached shell so the app still opens with no signal.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || caches.match(request)))
    );
    return;
  }

  // Everything else — hashed JS, CSS, icons — is immutable, so cache first.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
