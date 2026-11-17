const CACHE = "rss-reader-shell-v16";
const RUNTIME_CACHE = "rss-reader-runtime-v7";
const RUNTIME_MAX = 50;
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./assets/icon.svg", "./assets/icon-192.png", "./assets/icon-512.png", "./assets/icon-maskable-512.png", "./assets/apple-touch-icon.png", "./fonts/GentiumBookPlus-Regular.woff2", "./fonts/GentiumBookPlus-Bold.woff2", "./fonts/GentiumBookPlus-Italic.woff2", "./fonts/GentiumBookPlus-BoldItalic.woff2"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
async function trimRuntime(cache) {
  const keys = await cache.keys();
  if (keys.length > RUNTIME_MAX) {
    await Promise.all(keys.slice(0, keys.length - RUNTIME_MAX).map(k => cache.delete(k)));
  }
}
/* The shell (navigation and the app's own files) is network-first with
   a cache fallback, so a new build reaches returning users without
   waiting on a hand-bumped version string. Fonts and icons stay
   cache-first: they change rarely and are needed offline. */
const SHELL_RE = /(^|\/)(index\.html|styles\.css|app\.js)$|\/$/;
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // feed fetches are cross-origin: never intercepted
  e.respondWith((async () => {
    if (e.request.mode === "navigate" || SHELL_RE.test(u.pathname)) {
      try {
        const r = await fetch(e.request);
        if (r.ok) {
          const cache = await caches.open(CACHE);
          cache.put(e.request, r.clone());
        }
        return r;
      } catch {
        const cached = await caches.match(e.request, { cacheName: CACHE });
        if (cached) return cached;
        if (e.request.mode === "navigate") return caches.match("./index.html");
        throw e;
      }
    }
    const cached = await caches.match(e.request, { cacheName: CACHE });
    if (cached) return cached;
    try {
      const r = await fetch(e.request);
      if (r.ok && /\.(css|js|woff2|svg|png)$/.test(u.pathname)) {
        const copy = r.clone();
        const runtime = await caches.open(RUNTIME_CACHE);
        await runtime.put(e.request, copy);
        await trimRuntime(runtime);
      }
      return r;
    } catch {
      throw e;
    }
  })());
});
