/* ===========================================================================
   Backbar service worker

   Its job is narrow: keep the app openable when the wifi isn't. Data caching
   and the write queue live in IndexedDB, not here.

   The hard part of a service worker is not caching — it's making sure a new
   version can actually reach a tablet that has been sitting on a wall for a
   fortnight. Three things make that work, and all three are needed:

     1. sw.js is served no-cache (see public/_headers), or the browser keeps
        handing itself the old worker and never learns a new one exists
     2. registration uses updateViaCache:"none" for the same reason
     3. the app asks for an update check when it comes back to the foreground

   __BUILD_ID__ is replaced at build time by scripts/stamp-sw.mjs, so every
   deploy gets a fresh cache and retires the last one.
   =========================================================================== */

const BUILD = "__BUILD_ID__";
const CACHE = `backbar-shell-${BUILD}`;

self.addEventListener("install", (e) => {
  // A bar tablet is never "closed", so waiting for every tab to go away would
  // mean updates that never land.
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(["/", "/manifest.webmanifest"]).catch(() => {})
    )
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();

    // Tell open tabs a new version is live. They decide when to reload —
    // yanking the page out from under a waiter mid-order would be worse than
    // running yesterday's build for another minute.
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "sw-updated", build: BUILD });
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API. A stale login or a stale floor is worse than an
  // honest failure the app already knows how to handle.
  if (url.pathname.startsWith("/api/")) return;

  // Never cache the worker or the manifest — that is how a device gets stuck.
  // build-id.txt is on the list for the opposite reason: it is how a stuck
  // device finds out. The app reads it to compare what is running against what
  // is deployed, so a cached copy would agree with itself forever.
  if (url.pathname === "/sw.js" ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname === "/build-id.txt") return;

  // Navigations: network first so a deploy is picked up, cache as the fallback
  // so the app still opens with no signal.
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

  // Hashed JS, CSS and icons never change under the same name, so cache first.
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
