/* Service worker: the app, its data and fonts work offline; OpenStreetMap tiles are cached only as you view them
   (their usage policy forbids bulk downloading). */
var VERSION = "v7";
var SHELL = "shell-" + VERSION;
var TILES = "tiles-osm-v1";
var MAX_TILES = 3000;                 // roughly 50 MB of viewed tiles
var TILE_MAX_AGE = 7 * 24 * 3600e3;   // refresh a viewed tile after a week (OSM tile policy)
var SHELL_FILES = [
  "./", "index.html", "app.js", "route.js", "style.css", "manifest.webmanifest",
  "lang/en.js", "lang/hu.js", "lang/ro.js",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "fonts/big-shoulders-display-latin-800-normal.woff2", "fonts/big-shoulders-display-latin-ext-800-normal.woff2",
  "fonts/big-shoulders-display-latin-900-normal.woff2", "fonts/big-shoulders-display-latin-ext-900-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2", "fonts/atkinson-hyperlegible-latin-ext-400-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-700-normal.woff2", "fonts/atkinson-hyperlegible-latin-ext-700-normal.woff2",
  "icons/icon-192.png", "icons/icon-512.png",
  "data/blocks.geojson", "data/entrances.geojson", "data/roads.geojson", "data/context.geojson", "data/overrides.csv", "data/stats.json",
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return (k.indexOf("shell-") === 0 && k !== SHELL) || (k.indexOf("tiles-") === 0 && k !== TILES);  // old CARTO placeholders too
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function trimTiles(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_TILES) return;
    return Promise.all(keys.slice(0, keys.length - MAX_TILES).map(function (k) { return cache.delete(k); }));
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // OpenStreetMap tiles: cached copy first (works offline), refreshed in the background once it is a week old
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(caches.open(TILES).then(function (c) {
      return c.match(req.url).then(function (hit) {
        var refresh = function () {
          return fetch(req).then(function (r) {
            if (r.ok) c.put(req.url, r.clone()).then(function () { return trimTiles(c); });
            return r;
          });
        };
        if (!hit) return refresh();
        var date = Date.parse(hit.headers.get("date") || "");
        if (!date || Date.now() - date > TILE_MAX_AGE) refresh().catch(function () { /* offline: keep the old one */ });
        return hit;
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
