/* Service worker: the app, its data and fonts work offline; OpenStreetMap tiles are cached only as you view them
   (their usage policy forbids bulk downloading). */
var VERSION = "v16";
var SHELL = "shell-" + VERSION;
var TILES = "tiles-osm-v1";
var MAX_TILES = 3000;                 // roughly 50 MB of viewed tiles
var TILE_MAX_AGE = 7 * 24 * 3600e3;   // refresh a viewed tile after a week (OSM tile policy)
var SHELL_FILES = [
  "./", "index.html", "config.js", "app.js", "route.js", "route-worker.js", "style.css", "manifest.webmanifest",
  "lang/en.js", "lang/hu.js", "lang/ro.js",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "fonts/google-sans-latin-wght-normal.woff2", "fonts/google-sans-latin-ext-wght-normal.woff2",
  "icons/icon-192.png", "icons/icon-512.png",
  "data/blocks.geojson", "data/entrances.geojson", "data/roads.geojson", "data/context.geojson", "data/pois.geojson", "data/overrides.csv", "data/stats.json",
];

self.addEventListener("install", function (e) {
  // fresh copies, not whatever the browser's HTTP cache still holds
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return c.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: "reload" }); }));
  }).then(function () { return self.skipWaiting(); }));
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

  // Own files: the saved copy at once (a weak signal never holds up the start), refreshed in the
  // background for the next start. A new app version replaces the whole set when VERSION changes.
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r.ok) return c.put(req, r.clone()).then(function () { return r; });
        return r;
      });
      if (hit) { e.waitUntil(net.catch(function () { /* offline: the saved copy stays */ })); return hit; }
      return net.catch(function () { return c.match("index.html"); });
    });
  }));
});
