/* Service worker: app shell + data offline, map tiles cached as you browse / download. */
var VERSION = "v4";
var SHELL = "shell-" + VERSION;
var TILES = "tiles-v1";
var SHELL_FILES = [
  "./", "index.html", "app.js", "style.css", "manifest.webmanifest",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "vendor/leaflet/images/layers.png", "vendor/leaflet/images/layers-2x.png",
  "vendor/leaflet/images/marker-icon.png", "vendor/leaflet/images/marker-icon-2x.png", "vendor/leaflet/images/marker-shadow.png",
  "icons/icon-192.png", "icons/icon-512.png",
  "data/blocks.geojson", "data/entrances.geojson", "data/roads.geojson", "data/context.geojson", "data/overrides.csv", "data/stats.json",
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("shell-") === 0 && k !== SHELL; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Map tiles: cache first, then network (and store).
  if (/basemaps\.cartocdn\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(TILES).then(function (c) {
      return c.match(req.url).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) {
          if (r.ok || r.type === "opaque") c.put(req.url, r.clone());
          return r;
        });
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Own files: network first (so updated data shows up), cache fallback when offline.
  e.respondWith(fetch(req).then(function (r) {
    if (r.ok) {
      var copy = r.clone();
      caches.open(SHELL).then(function (c) { c.put(req, copy); });
    }
    return r;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || caches.match("index.html");
    });
  }));
});
