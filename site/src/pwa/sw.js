// Oke Night service worker (served at /sw.js, scope /). Makes the site installable and gives it an offline
// screen. Kept small on purpose:
// - Pages: network first. Offline, the last copy of that page (if this phone opened it before), else
//   /offline.html. Live numbers always come from the network; nothing posted is ever queued or replayed.
// - The shared scripts (/awards.js etc.) and icons: served from the cache, refreshed in the background.
// - /api/*, POSTs and other sites: never touched.
// Bump VERSION when this file changes so phones drop the old caches.
const VERSION = "oke-v1";
const SHELL = ["/offline.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const STATIC = /^\/(bingo|fun|awards|songs|drafts|art|duets|picker)\.js$|^\/icons\//;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (req.mode === "navigate") {
    if (/\/host\/?$/.test(url.pathname)) return; // the host page is never kept on the phone
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(url.pathname, copy)); }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || caches.match("/offline.html"))));
    return;
  }
  if (STATIC.test(url.pathname)) {
    e.respondWith(caches.open(VERSION).then((c) => c.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; });
      return hit ? (e.waitUntil(fresh.catch(() => {})), hit) : fresh;
    })));
  }
});
