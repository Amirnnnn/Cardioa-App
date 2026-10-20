/* Offline UI shell only. BLE requires a compatible secure-context browser. */
const CACHE = "cardioa-ecg-v7-display-filter";
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest",
  "./Js/app.js", "./Js/ecg-protocol-v3.js", "./Js/ecg-display-filter.js", "./Js/dark-theme.js",
  "./Css/styles.css", "./Css/responsive.css", "./Css/font-style.css", "./Css/dark-theme.css",
  "./icons/logo-web.png", "./icons/cardioa_icon.png", "./icons/icon-192.png", "./icons/icon-512.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith("cardioa-ecg-") && k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
