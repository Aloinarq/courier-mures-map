/* Blokktérkép Marosvásárhely – OSM blocks + staircases, offline-capable. */
(function () {
  "use strict";

  var CITY_BOUNDS = L.latLngBounds([46.49, 24.47], [46.60, 24.66]);
  var CENTER = [46.5425, 24.5575];
  var LABEL_MIN_ZOOM = 16, STAIR_MIN_ZOOM = 17, NUM_MIN_ZOOM = 18;
  var MAX_BLOCK_LABELS = 450, MAX_STAIR_LABELS = 450, MAX_STREET_LABELS = 70;
  // OpenStreetMap's own tiles: free and keyless. Their usage policy forbids bulk downloading, so
  // tiles are only cached as they are viewed (sw.js); our own street layer works without them.
  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  var PREF = { basemap: "blokk.basemap", mode: "blokk.mode", locIntro: "blokk.locIntro", traffic: "blokk.traffic" };
  var CONFIG = window.BLOKK_CONFIG || {};
  function readPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ------------------------------------------------------------------ i18n (lang/*.js)
  var LANGS = window.BLOKK_LANG || {}, LANG_KEY = "blokk.lang", DEFAULT_LANG = "en";
  var lang = (function () {
    try { var v = localStorage.getItem(LANG_KEY); if (v && LANGS[v]) return v; } catch (e) { /* private mode */ }
    return DEFAULT_LANG;
  })();
  function t(key, vars) {
    var s = (LANGS[lang] && LANGS[lang][key]) || (LANGS[DEFAULT_LANG] && LANGS[DEFAULT_LANG][key]) || key;
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
  }
  function applyStaticText() {
    document.documentElement.lang = lang;
    document.title = t("app.title");
    [].forEach.call(document.querySelectorAll("[data-i18n]"), function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    [].forEach.call(document.querySelectorAll("[data-i18n-attr]"), function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var kv = pair.split(":");
        el.setAttribute(kv[0].trim(), t(kv[1].trim()));
      });
    });
  }
  applyStaticText();

  // ------------------------------------------------------------------ helpers
  function fold(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[şș]/gi, "s").replace(/[ţț]/gi, "t").toLowerCase();
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  var toastTimer;
  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3000);
  }
  function stairLabel(v) {
    v = String(v || "").trim();
    var core = v.replace(/^\s*(sc(ara)?|lépcsőház)\.?\s*/i, "").trim();
    if (/^[A-Za-z0-9]{1,3}$/.test(core)) return "Sc. " + (/^[a-z]+$/i.test(core) ? core.toUpperCase() : core);
    return v;
  }
  // metres-based local projection for distance checks
  var KX = 111320 * Math.cos(46.545 * Math.PI / 180), KY = 110540;
  function pxy(lat, lon) { return [lon * KX, lat * KY]; }
  function inRing(p, ring) { // ring: [[lon,lat],...]
    var x = p[0], y = p[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0] * KX, yi = ring[i][1] * KY, xj = ring[j][0] * KX, yj = ring[j][1] * KY;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }
  function polys(geom) {
    if (geom.type === "Polygon") return [geom.coordinates];
    if (geom.type === "MultiPolygon") return geom.coordinates;
    return [];
  }
  function contains(f, lat, lon) {
    var p = pxy(lat, lon);
    return polys(f.geometry).some(function (pg) {
      return inRing(p, pg[0]) && !pg.slice(1).some(function (h) { return inRing(p, h); });
    });
  }
  function edgeDist(f, lat, lon) {
    var p = pxy(lat, lon), best = Infinity;
    polys(f.geometry).forEach(function (pg) {
      pg.forEach(function (r) {
        for (var i = 0; i < r.length - 1; i++) {
          var ax = r[i][0] * KX, ay = r[i][1] * KY, bx = r[i + 1][0] * KX, by = r[i + 1][1] * KY;
          var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          var t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)) : 0;
          best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
        }
      });
    });
    return best;
  }
  function parseCSV(text) {
    var rows = [], row = [], cur = "", q = false;
    text = text.replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === "," || c === ";") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
        row = [];
      } else cur += c;
    }
    row.push(cur);
    if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
    var rowsNoComments = rows.filter(function (r) { return !/^\s*#/.test(r[0]); });
    if (!rowsNoComments.length) return [];
    var head = rowsNoComments[0].map(function (h) { return h.trim().toLowerCase(); });
    return rowsNoComments.slice(1).map(function (r) {
      var o = {}; head.forEach(function (h, k) { o[h] = (r[k] || "").trim(); }); return o;
    });
  }
  function fetchJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }
  function fetchText(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.text();
    });
  }

  // ------------------------------------------------------------------ map
  var map = L.map("map", {
    center: CENTER, zoom: 14, minZoom: 12, maxZoom: 19,
    zoomControl: true, preferCanvas: true,
    maxBounds: CITY_BOUNDS.pad(0.6), maxBoundsViscosity: 0.8,
  });
  // heading-up while navigating: the map element is turned with CSS around the user's position.
  // rot.on = turned; rot.shown = the angle the map is turned by (deg, unwrapped); labels counter-rotate by it.
  var appReady = false;
  var rot = { on: false, shown: 0, pivot: null, D: 0 };
  var ui = { topBottom: 70, navBottom: 0, sheetH: 0 };  // see measureUi
  function rotBox(cx, cy, w, h) {  // container-space box of a label that is upright on screen
    if (!rot.on) return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    var r = rot.shown * Math.PI / 180, c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
    var bw = w * c + h * sn, bh = w * sn + h * c;
    return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
  }
  function toScreen(p) {  // container point -> viewport point
    if (!rot.on) return p;
    var r = -rot.shown * Math.PI / 180, dx = p.x - rot.D / 2, dy = p.y - rot.D / 2;
    return L.point(rot.pivot.x + dx * Math.cos(r) - dy * Math.sin(r), rot.pivot.y + dx * Math.sin(r) + dy * Math.cos(r));
  }
  // ---------- our own drawing: two canvases for the street map and the buildings, one for all labels.
  // L.Canvas still positions them, scales them for sharp screens and runs the zoom animation; the
  // per-shape Leaflet objects (25,000 of them, re-clipped after every move) are gone: we draw in batches
  // straight from typed arrays and skip redrawing while what's on screen is still covered.
  var DataCanvas = L.Canvas.extend({
    initialize: function (options) {
      L.Canvas.prototype.initialize.call(this, options);
      this._drawFn = options.draw;
      this._lazy = options.lazy !== false;
      this._basePad = options.padding;
    },
    _update: function () {
      if (this._map._animatingZoom && this._bounds) return;
      var m = this._map, z = m.getZoom();
      if (this._lazy && !this._force && this._bounds && this._drawnZoom === z && this._origin && this._origin.equals(m.getPixelOrigin())) {
        var a = m.containerPointToLayerPoint([0, 0]), b = m.containerPointToLayerPoint(m.getSize());
        if (this._bounds.contains(a) && this._bounds.contains(b)) return;  // the pane only moved
      }
      this._force = false;
      this._drawnZoom = z;
      this._origin = m.getPixelOrigin();
      L.Canvas.prototype._update.call(this);
      if (this._drawFn && appReady) this._drawFn(this._ctx, this._bounds);
    },
    redraw: function () { if (this._map) { this._force = true; this._update(); } return this; },
    _updatePaths: function () {},  // no Leaflet shapes here; Leaflet's version would wipe our drawing after a view reset
  });
  map.createPane("context").style.zIndex = 320;
  map.createPane("roads").style.zIndex = 350;
  map.createPane("labels").style.zIndex = 580;  // over the route (450), under the dot and the destination pin (600)
  ["context", "roads", "labels"].forEach(function (n) { map.getPane(n).style.pointerEvents = "none"; });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  map.attributionControl.addAttribution(OSM_ATTRIB);

  map.createPane("route").style.zIndex = 450;   // above the buildings, under all labels
  map.getPane("route").style.pointerEvents = "none";
  var routeCanvas = L.canvas({ pane: "route", padding: 0.5 });

  // normalised Web Mercator (0..1): pixel = m * 256 * 2^zoom at any zoom, so nothing is re-projected per zoom
  function mx(lon) { return (lon + 180) / 360; }
  function my(lat) { var s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
  function xLon(x) { return x * 360 - 180; }
  function yLat(y) { return 360 / Math.PI * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90; }
  var CELL = 1 / 32768;  // spatial grid cell (~850 m here)
  function Grid() { this.cells = {}; this.items = []; this.stamp = 0; }
  Grid.prototype.add = function (item) {  // item.bb = [x0, y0, x1, y1] in normalised units
    var i = this.items.push(item) - 1, bb = item.bb;
    for (var cx = Math.floor(bb[0] / CELL); cx <= Math.floor(bb[2] / CELL); cx++)
      for (var cy = Math.floor(bb[1] / CELL); cy <= Math.floor(bb[3] / CELL); cy++)
        (this.cells[cx + ":" + cy] = this.cells[cx + ":" + cy] || []).push(i);
  };
  Grid.prototype.query = function (x0, y0, x1, y1) {
    var out = [], st = ++this.stamp, items = this.items;
    for (var cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (var cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        var list = this.cells[cx + ":" + cy];
        if (!list) continue;
        for (var k = 0; k < list.length; k++) {
          var it = items[list[k]];
          if (it._st === st) continue;
          it._st = st;
          var bb = it.bb;
          if (bb[2] >= x0 && bb[0] <= x1 && bb[3] >= y0 && bb[1] <= y1) out.push(it);
        }
      }
    return out;
  };
  function normRing(coords) {  // [[lon, lat], ...] -> Float64Array + bbox
    var a = new Float64Array(coords.length * 2), bb = [1, 1, 0, 0];
    for (var i = 0; i < coords.length; i++) {
      var x = mx(coords[i][0]), y = my(coords[i][1]);
      a[2 * i] = x; a[2 * i + 1] = y;
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
    }
    return { a: a, bb: bb };
  }
  function mergeBB(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
  var geo = { ctx: new Grid(), roads: new Grid(), bld: new Grid(), dots: new Grid(), lbl: new Grid(), ent: new Grid(), poi: new Grid() };
  // what the canvas covers, in normalised units, and the transform from normalised units to its layer points
  function drawView(b) {
    var z = map.getZoom(), S = 256 * Math.pow(2, z), o = map.getPixelOrigin();
    return { z: z, S: S, ox: o.x, oy: o.y, x0: (b.min.x + o.x) / S, y0: (b.min.y + o.y) / S, x1: (b.max.x + o.x) / S, y1: (b.max.y + o.y) / S };
  }
  function tracePath(ctx, a, v, close) {  // skips vertices closer than ~0.7 px to the last drawn one
    var x = a[0] * v.S - v.ox, y = a[1] * v.S - v.oy, lx = x, ly = y, n = a.length;
    ctx.moveTo(x, y);
    for (var i = 2; i < n; i += 2) {
      x = a[i] * v.S - v.ox; y = a[i + 1] * v.S - v.oy;
      if (i === n - 2 || Math.abs(x - lx) + Math.abs(y - ly) > 0.7) { ctx.lineTo(x, y); lx = x; ly = y; }
    }
    if (close) ctx.closePath();
  }
  var baseLayer = new DataCanvas({ pane: "roads", padding: 0.5, draw: function (ctx, b) { drawBase(ctx, b); } }).addTo(map);
  var bldLayer = new DataCanvas({ pane: "overlayPane", padding: 0.5, draw: function (ctx, b) { drawBuildings(ctx, b); } }).addTo(map);
  var labelsLayer = new DataCanvas({ pane: "labels", padding: 0.15, lazy: false, draw: function (ctx, b) { drawLabels(ctx, b); } }).addTo(map);

  // ---------- optional background tiles
  var tiles = L.tileLayer(TILE_URL, { maxZoom: 19, maxNativeZoom: 19, crossOrigin: true });
  var tileErrors = 0;
  tiles.on("tileerror", function () { if (++tileErrors === 4) toast(t("toast.tilesFail"), 5000); });
  tiles.on("tileload", function () { tileErrors = 0; });
  // ---------- live traffic (TomTom Traffic Flow tiles: transparent, only where traffic is slower than usual)
  // Needs internet by nature; when the key is missing the switch is hidden, when offline the layer stays empty.
  map.createPane("traffic").style.zIndex = 360;   // over our roads, under the buildings and the route
  map.getPane("traffic").style.pointerEvents = "none";
  var TRAFFIC_REFRESH_MS = 3 * 60 * 1000;         // TomTom updates flow about every minute; 3 min keeps us well inside the free quota
  var trafficLayer = null, trafficTimer = null, trafficErrors = 0;
  function trafficUrl() {
    return "https://api.tomtom.com/traffic/map/4/tile/flow/relative-delay/{z}/{x}/{y}.png?tileSize=256&key=" +
      encodeURIComponent(CONFIG.tomtomKey) + "&t=" + Math.floor(Date.now() / TRAFFIC_REFRESH_MS);
  }
  function trafficOn() { return !!trafficLayer && map.hasLayer(trafficLayer); }
  function setTraffic(on, remember) {
    if (!CONFIG.tomtomKey) return;
    if (remember) writePref(PREF.traffic, on ? "1" : "0");
    if (!trafficLayer) {
      trafficLayer = L.tileLayer(trafficUrl(), {
        pane: "traffic", minZoom: 11, maxZoom: 19, maxNativeZoom: 18, opacity: 0.9, crossOrigin: true,
        attribution: 'Traffic &copy; <a href="https://www.tomtom.com/" target="_blank" rel="noopener">TomTom</a>',
      });
      trafficLayer.on("tileerror", function () { if (++trafficErrors === 4) toast(t("traffic.fail"), 5000); });
      trafficLayer.on("tileload", function () { trafficErrors = 0; });
    }
    clearInterval(trafficTimer);
    if (!on) { if (map.hasLayer(trafficLayer)) map.removeLayer(trafficLayer); return; }
    trafficErrors = 0;
    trafficLayer.setUrl(trafficUrl());
    if (!map.hasLayer(trafficLayer)) trafficLayer.addTo(map);
    trafficTimer = setInterval(function () {
      if (document.visibilityState === "visible" && navigator.onLine !== false) trafficLayer.setUrl(trafficUrl());
    }, TRAFFIC_REFRESH_MS);
  }
  document.addEventListener("visibilitychange", function () {  // back from the background: fresh traffic at once
    if (document.visibilityState === "visible" && trafficOn()) trafficLayer.setUrl(trafficUrl());
  });

  function setBasemap(on, remember) {
    if (remember) writePref(PREF.basemap, on ? "1" : "0");
    tileErrors = 0;
    if (on) { if (!map.hasLayer(tiles)) tiles.addTo(map); }
    else if (map.hasLayer(tiles)) map.removeLayer(tiles);
  }
  function setLanguage(code) {
    if (!LANGS[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch (e) { /* private mode */ }
    applyStaticText();
    refreshSheet();
    if (!resEl.hidden) showResults();
    if (nav.active) updateNav();
  }

  var roadsByName = {}, roadChains = [], streetHl = null, streetIndex = [], streetStats = null;
  var blocks = [], byId = {}, entrances = [], searchIndex = [], stats = null, overrideCount = 0, pois = [], poiIndex = [];
  // [fill, fill opacity, outline, outline width] per building kind
  var BLD_STYLE = { other: ["#9ca3af", 0.35, "#6b7280", 1], apartments: ["#3b82f6", 0.38, "#1d4ed8", 1.2], ovr: ["#3b82f6", 0.38, "#6d28d9", 1.6] };

  // ------------------------------------------------------------------ data
  Promise.all([
    fetchJSON("data/blocks.geojson"),
    fetchJSON("data/entrances.geojson"),
    fetchText("data/overrides.csv").catch(function (e) { console.warn("overrides.csv:", e.message); return ""; }),
    fetchJSON("data/stats.json").catch(function () { return null; }),
    fetchJSON("data/pois.geojson").catch(function (e) { console.warn("pois:", e.message); return { features: [] }; }),
  ]).then(function (res) {
    stats = res[3];
    pois = res[4].features;
    pois.forEach(function (f) { f.properties.kind = "poi"; });
    build(res[0], res[1], parseCSV(res[2]));
  }).catch(function (e) {
    console.error(e);
    toast(t("toast.dataFail", { msg: e.message }), 15000);
  });

  Promise.all([
    fetchJSON("data/context.geojson").catch(function (e) { console.warn(e.message); return null; }),
    fetch("data/roads.geojson", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("data/roads.geojson: HTTP " + r.status);
      return r.arrayBuffer();
    }),
  ]).then(function (res) {
    var rgj = JSON.parse(new TextDecoder().decode(res[1]));
    startRouter(res[1], rgj);  // hands the raw file to the routing worker
    buildStreetMap(res[0], rgj);
  }).catch(function (e) {
    console.error(e);
    toast(t("toast.roadsFail", { msg: e.message }), 8000);
  });

  // ------------------------------------------------------------------ street map (own layer)
  var ROAD_CLASS = {
    motorway: "major", trunk: "major", primary: "major", secondary: "major",
    motorway_link: "major", trunk_link: "major", primary_link: "major", secondary_link: "major",
    tertiary: "mid", tertiary_link: "mid", unclassified: "mid", residential: "mid", living_street: "mid",
    pedestrian: "ped", service: "minor", track: "minor", footway: "foot", path: "foot", steps: "foot",
  };
  // [min zoom, casing colour, fill colour, base width at z16, dash]
  var ROAD_STYLE = {
    major: { minZ: 12, casing: "#c9a227", fill: "#fff3bf", w: 6.5 },
    mid: { minZ: 13, casing: "#c3bcae", fill: "#ffffff", w: 4.2 },
    ped: { minZ: 15, casing: "#c3bcae", fill: "#f1ede6", w: 3.2 },
    minor: { minZ: 15, fill: "#a8a090", w: 1.4, dash: "5 4" },
    foot: { minZ: 17, fill: "#c4a98f", w: 1.0, dash: "2 3" },  // ~5,000 sidewalks: clutter + 40% of redraw cost at z16
  };
  function widthAt(base, z) { return Math.max(0.6, base * Math.pow(1.45, z - 16)); }
  var roadsLoaded = false;
  function buildStreetMap(cgj, rgj) {
    if (cgj) cgj.features.forEach(function (f) {
      var k = f.properties.k, g = f.geometry;
      if (g.type === "Polygon") {
        var rings = g.coordinates.map(normRing);
        geo.ctx.add({ k: k, poly: true, rings: rings.map(function (r) { return r.a; }), bb: rings.reduce(function (m, r) { return mergeBB(m, r.bb); }, rings[0].bb) });
      } else if (g.type === "LineString") {
        var r = normRing(g.coordinates);
        geo.ctx.add({ k: k, poly: false, a: r.a, bb: r.bb });
      }
    });
    rgj.features.forEach(function (f) {
      var cls = ROAD_CLASS[f.properties.h] || "minor";
      var c = f.geometry.coordinates, s = 90, w = 180, n = -90, e = -180;
      for (var i = 0; i < c.length; i++) {
        if (c[i][1] < s) s = c[i][1]; if (c[i][1] > n) n = c[i][1];
        if (c[i][0] < w) w = c[i][0]; if (c[i][0] > e) e = c[i][0];
      }
      f._bb = [s, w, n, e];
      f._cls = cls;
      var r = normRing(c);
      geo.roads.add({ cls: cls, a: r.a, bb: r.bb });
      var nm = f.properties.n;
      if (nm) (roadsByName[nm] = roadsByName[nm] || []).push(f);
    });
    buildChains();
    roadsLoaded = true;
    baseLayer.redraw();
    addStreetsToSearch();
    renderLabels();
  }
  var ROAD_PASSES = [["foot", "fill"], ["minor", "fill"], ["ped", "casing"], ["mid", "casing"], ["major", "casing"],
    ["ped", "fill"], ["mid", "fill"], ["major", "fill"]];
  function drawBase(ctx, b) {
    if (!roadsLoaded) return;
    var v = drawView(b), z = v.z;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // water and parks, then the river and railways
    var cx = geo.ctx.query(v.x0, v.y0, v.x1, v.y1);
    [["water", "#a9cdee"], ["park", "#d6ebc8"]].forEach(function (pair) {
      ctx.beginPath();
      cx.forEach(function (it) { if (it.k === pair[0] && it.poly) it.rings.forEach(function (r) { tracePath(ctx, r, v, true); }); });
      ctx.fillStyle = pair[1]; ctx.fill("evenodd");
    });
    ctx.beginPath();
    cx.forEach(function (it) { if (it.k === "river" && !it.poly) tracePath(ctx, it.a, v, false); });
    ctx.strokeStyle = "#8bbbe6"; ctx.lineWidth = 6; ctx.stroke();
    ctx.beginPath();
    cx.forEach(function (it) { if (it.k === "rail" && !it.poly) tracePath(ctx, it.a, v, false); });
    ctx.save(); ctx.setLineDash([7, 5]); ctx.globalAlpha = 0.85; ctx.strokeStyle = "#4b5563"; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore();
    // roads: one path per class and pass (casing under fill), so a few thousand streets cost a handful of strokes
    var rs = geo.roads.query(v.x0, v.y0, v.x1, v.y1), byCls = {};
    rs.forEach(function (it) { (byCls[it.cls] = byCls[it.cls] || []).push(it); });
    ROAD_PASSES.forEach(function (pass) {
      var cls = pass[0], st = ROAD_STYLE[cls], list = byCls[cls];
      if (!list || z < st.minZ || (pass[1] === "casing" && !st.casing)) return;
      var w = widthAt(st.w, z);
      ctx.beginPath();
      for (var i = 0; i < list.length; i++) tracePath(ctx, list[i].a, v, false);
      if (pass[1] === "casing") { ctx.setLineDash([]); ctx.lineCap = "round"; ctx.strokeStyle = st.casing; ctx.lineWidth = w + (z >= 15 ? 2.5 : 1.5); }
      else { ctx.setLineDash(st.dash ? st.dash.split(" ").map(Number) : []); ctx.lineCap = st.dash ? "butt" : "round"; ctx.strokeStyle = st.fill; ctx.lineWidth = w; }
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }
  // OSM splits one street into many short ways; join same-name pieces that touch end to end,
  // so a label sees the whole visible stretch instead of 30 m fragments
  function buildChains() {
    Object.keys(roadsByName).forEach(function (name) {
      [true, false].forEach(function (major) {
        var segs = roadsByName[name].filter(function (f) {
          return f._cls !== "foot" && f._cls !== "minor" && (f._cls === "major") === major;
        }).map(function (f) { return f.geometry.coordinates.slice(); });
        var key = function (c) { return c[0] + "," + c[1]; };
        while (segs.length) {
          var cur = segs.pop(), grown = true;
          while (grown) {
            grown = false;
            for (var i = 0; i < segs.length; i++) {
              var s2 = segs[i], h = key(cur[0]), t = key(cur[cur.length - 1]);
              if (key(s2[0]) === t) cur = cur.concat(s2.slice(1));
              else if (key(s2[s2.length - 1]) === t) cur = cur.concat(s2.slice(0, -1).reverse());
              else if (key(s2[s2.length - 1]) === h) cur = s2.slice(0, -1).concat(cur);
              else if (key(s2[0]) === h) cur = s2.slice(1).reverse().concat(cur);
              else continue;
              segs.splice(i, 1); grown = true; break;
            }
          }
          var r = normRing(cur);
          roadChains.push({ name: name, major: major, n: r.a, nb: r.bb });
        }
      });
    });
  }

  // ---------- labels: all of them on one canvas, redrawn after every move. A few hundred texts cost a few
  // milliseconds; the DOM markers they replace (with text shadows, re-rotated for every heading change)
  // cost the browser a full style and layout pass each time.
  var measureCtx = document.createElement("canvas").getContext("2d");
  var FONT_FAMILY = '"Google Sans", Roboto, system-ui, sans-serif';
  var STREET_FONT = "500 12px " + FONT_FAMILY, PILL_FONT = "700 11.5px " + FONT_FAMILY;
  var widthCache = {};
  function textWidth(font, s) {
    var k = font + "|" + s, w = widthCache[k];
    if (w === undefined) { measureCtx.font = font; w = widthCache[k] = measureCtx.measureText(s).width; }
    return w;
  }
  function textW(s) { return textWidth(STREET_FONT, s); }
  function fontsChanged() { widthCache = {}; renderLabels(); }
  if (document.fonts && document.fonts.load) {
    Promise.all(["700 13px ", "500 12px "].map(function (f) { return document.fonts.load(f + FONT_FAMILY); })).then(fontsChanged, function () {});
  }
  function shortName(n) {
    return n.replace(/^Strada /, "Str. ").replace(/^Bulevardul /, "B-dul ").replace(/^Aleea /, "Al. ")
      .replace(/^Piața /, "P-ța ").replace(/^Pasajul /, "Pas. ");
  }
  function overlaps(b, boxes) {
    for (var i = 0; i < boxes.length; i++) {
      var o = boxes[i];
      if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
    }
    return false;
  }
  // container point of a normalised point: x * S + dx; layer point: container point + (tlx, tly)
  function labelView() {
    var z = map.getZoom(), S = 256 * Math.pow(2, z), o = map.getPixelOrigin(), tl = map.containerPointToLayerPoint([0, 0]);
    return { z: z, S: S, dx: -o.x - tl.x, dy: -o.y - tl.y, tlx: tl.x, tly: tl.y, size: map.getSize() };
  }
  function queryView(grid, V, pad) {
    var px = V.size.x * pad, py = V.size.y * pad;
    return grid.query((-px - V.dx) / V.S, (-py - V.dy) / V.S, (V.size.x + px - V.dx) / V.S, (V.size.y + py - V.dy) / V.S);
  }
  function placeItems(list, V) {
    for (var i = 0; i < list.length; i++) { list[i].cx = list[i].x * V.S + V.dx; list[i].cy = list[i].y * V.S + V.dy; }
    return list;
  }
  function nearestFirst(list, V, extra, max) {  // keep those closest to the centre (after `extra`, a rank)
    if (list.length <= max) return list;
    var cx = V.size.x / 2, cy = V.size.y / 2;
    list.forEach(function (it) { it.k = extra(it) + (it.cx - cx) * (it.cx - cx) + (it.cy - cy) * (it.cy - cy); });
    list.sort(function (a, b) { return a.k - b.k; });
    list.length = max;
    return list;
  }
  function collectStreetLabels(V, boxes, out) {
    var z = V.z;
    if (z < 15 || !roadChains.length) return;
    var size = V.size, vtop = 90, vbottom = size.y - 30, vw = size.x;
    if (rot.on) { vtop = ui.navBottom + 8; vbottom = window.innerHeight - ui.sheetH - 10; vw = window.innerWidth; }
    function inView(p) {
      var v = toScreen(p);
      return v.x > 20 && v.y > vtop && v.x < vw - (rot.on ? 84 : 20) && v.y < vbottom;
    }
    var x0 = -V.dx / V.S, y0 = -V.dy / V.S, x1 = (size.x - V.dx) / V.S, y1 = (size.y - V.dy) / V.S;
    var byName = {};
    roadChains.forEach(function (ch) {
      if (z < 16 && !ch.major) return;
      var nb = ch.nb;
      if (nb[2] < x0 || nb[0] > x1 || nb[3] < y0 || nb[1] > y1) return;
      // on-screen polyline in pixels, split where it leaves the viewport (minus search bar / edges)
      var a = ch.n, pts = [], list = byName[ch.name] = byName[ch.name] || [];
      var flush = function () {
        var len = 0;
        for (var k = 1; k < pts.length; k++) len += pts[k].distanceTo(pts[k - 1]);
        if (len > 0) list.push({ pts: pts, len: len, major: ch.major });
        pts = [];
      };
      for (var i = 0; i < a.length; i += 2) {
        var p = L.point(a[i] * V.S + V.dx, a[i + 1] * V.S + V.dy);
        if (inView(p)) pts.push(p);
        else if (pts.length) flush();
      }
      if (pts.length) flush();
    });
    var cands = [];
    Object.keys(byName).forEach(function (name) {
      var best = byName[name].sort(function (a, b) { return b.len - a.len; }), placed = [];
      best.forEach(function (s) {
        // one label per visible stretch of the same street
        var mid = pointAt(s.pts, s.len, 0.5);
        if (placed.some(function (q) { return q.distanceTo(mid.p) < 260; })) return;
        placed.push(mid.p);
        cands.push({ name: name, len: s.len, major: s.major, pts: s.pts });
      });
    });
    cands.sort(function (a, b) { return (b.major - a.major) || (b.len - a.len); });
    var taken = boxes, n = 0;
    // keep names out from under the round buttons (bottom right) and the basemap switch (bottom left)
    if (!rot.on) taken.push([size.x - 84, size.y - 330, size.x, size.y], [0, size.y - 110, 210, size.y]);
    streetStats = { candidates: cands.length, tooShort: 0, collided: 0, placed: 0 };
    for (var i = 0; i < cands.length && n < MAX_STREET_LABELS; i++) {
      var cd = cands[i], label = shortName(cd.name), w = textW(label) + 6, h = 15;
      if (cd.len < w * 0.8) { streetStats.tooShort++; continue; }  // the street is shorter on screen than its name
      // try a few spots along the street; block labels and pills always win
      var spot = null;
      for (var fi = 0; fi < LABEL_SPOTS.length && !spot; fi++) {
        var at = pointAt(cd.pts, cd.len, LABEL_SPOTS[fi]);
        var a0 = at.angle, ca = Math.abs(Math.cos(a0)), sa = Math.abs(Math.sin(a0));
        var bw = w * ca + h * sa, bh = w * sa + h * ca;
        var bx = [at.p.x - bw / 2, at.p.y - bh / 2, at.p.x + bw / 2, at.p.y + bh / 2];
        if (!overlaps(bx, taken)) spot = { at: at, box: bx };
      }
      if (!spot) { streetStats.collided++; continue; }
      taken.push(spot.box); n++; streetStats.placed++;
      var ang = spot.at.angle;
      if (rot.on) {  // keep the text upright on the turned screen
        var B = rot.shown * Math.PI / 180, sr = ang - B;
        sr = Math.atan2(Math.sin(sr), Math.cos(sr));
        if (sr > Math.PI / 2) sr -= Math.PI; else if (sr < -Math.PI / 2) sr += Math.PI;
        ang = sr + B;
      }
      out.push({ x: spot.at.p.x, y: spot.at.p.y, a: ang, text: label, color: cd.major ? "#3f3a36" : "#57534e" });
    }
  }
  var LABEL_SPOTS = [0.5, 0.3, 0.7, 0.15, 0.85];
  function pointAt(pts, len, frac) {
    var half = len * frac, acc = 0;
    for (var k = 1; k < pts.length; k++) {
      var d = pts[k].distanceTo(pts[k - 1]);
      if (acc + d >= half) {
        var t = d ? (half - acc) / d : 0, a = pts[k - 1], b = pts[k];
        var ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;  // keep text upright
        return { p: L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), angle: ang };
      }
      acc += d;
    }
    return { p: pts[0], angle: 0 };
  }

  // ---------- streets in search
  function addStreetsToSearch() {
    Object.keys(roadsByName).forEach(function (name) {
      var ways = roadsByName[name], s = 90, w = 180, n = -90, e = -180;
      ways.forEach(function (f) { s = Math.min(s, f._bb[0]); w = Math.min(w, f._bb[1]); n = Math.max(n, f._bb[2]); e = Math.max(e, f._bb[3]); });
      var f = { type: "Feature", geometry: { type: "Street" }, _ways: ways, _bounds: L.latLngBounds([s, w], [n, e]),
        properties: { kind: "street", label: name, street: null, entrances: [] } };
      streetIndex.push({ f: f, hay: fold(name), block: [], nums: [], street: true });
    });
  }
  function showStreet(f) {
    if (streetHl) map.removeLayer(streetHl);
    streetHl = L.geoJSON({ type: "FeatureCollection", features: f._ways }, {
      renderer: routeCanvas, interactive: false, style: { color: "#f97316", weight: 7, opacity: 0.55, lineCap: "round" },
    }).addTo(map);
    map.fitBounds(f._bounds, { maxZoom: 17, padding: [50, 50] });
    setTimeout(function () { if (streetHl) { map.removeLayer(streetHl); streetHl = null; } }, 6000);
  }

  var bldLoaded = false;
  function ptItem(f, lat, lon, extra) {
    var x = mx(lon), y = my(lat), it = { f: f, x: x, y: y, bb: [x, y, x, y] };
    for (var k in extra) it[k] = extra[k];
    return it;
  }
  function build(bgj, egj, overrides) {
    bgj.features.forEach(function (f) {
      var p = f.properties;
      p._ents = [];
      blocks.push(f); byId[p.id] = f;
    });
    entrances = egj.features;
    overrideCount = applyOverrides(overrides);

    // attach entrances to buildings
    entrances.forEach(function (e) {
      var b = e.properties.building_id && byId[e.properties.building_id];
      if (b) b.properties._ents.push(e);
    });
    blocks.forEach(function (f) {
      var ls = {};
      f.properties._ents.forEach(function (e) { if (e.properties.label && e.properties.label.indexOf("nr. ") !== 0) ls[e.properties.label] = 1; });
      f.properties.entrances = Object.keys(ls).sort(function (a, b) { return a.length - b.length || a.localeCompare(b, "ro", { numeric: true }); });
    });

    // everything the canvases draw, in normalised units and a spatial grid
    var nPoly = 0;
    blocks.forEach(function (f) {
      var p = f.properties, g = f.geometry;
      if (g.type === "Point") {
        geo.dots.add(ptItem(f, g.coordinates[1], g.coordinates[0], { ovr: p.kind === "override" }));
      } else {
        var rings = [], bb = null;
        polys(g).forEach(function (pg) { pg.forEach(function (r) { var n = normRing(r); rings.push(n.a); bb = bb ? mergeBB(bb, n.bb) : n.bb; }); });
        if (!rings.length) return;
        // the same box in degrees (south, west, north, east) for the override matching
        p._bb = [yLat(bb[3]), xLon(bb[0]), yLat(bb[1]), xLon(bb[2])];
        geo.bld.add({ f: f, rings: rings, bb: bb, cls: p.kind === "apartments" ? (p.override ? "ovr" : "apartments") : "other" });
        nPoly++;
      }
      if (p.label && p.lp) geo.lbl.add(ptItem(f, p.lp[0], p.lp[1]));
    });
    entrances.forEach(function (e) { var c = e.geometry.coordinates; geo.ent.add(ptItem(e, c[1], c[0])); });
    pois.forEach(function (f) { var c = f.geometry.coordinates; geo.poi.add(ptItem(f, c[1], c[0])); });
    bldLoaded = true;
    bldLayer.redraw();

    buildSearchIndex();
    renderLabels();
    console.log("[blokkterkep] loaded", {
      buildings: nPoly, points: blocks.length - nPoly,
      entrances: entrances.length, overrides: overrideCount,
    });
    if (overrideCount) toast(t("toast.overrides", { n: overrideCount }));
  }
  function drawBuildings(ctx, b) {
    if (!bldLoaded) return;
    var v = drawView(b), z = v.z, list = geo.bld.query(v.x0, v.y0, v.x1, v.y1);
    ctx.lineJoin = "round";
    // other buildings first, so the blue blocks lie on top
    ["other", "apartments", "ovr"].forEach(function (cls) {
      var st = BLD_STYLE[cls], any = false;
      ctx.beginPath();
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it.cls !== cls) continue;
        for (var k = 0; k < it.rings.length; k++) tracePath(ctx, it.rings[k], v, true);
        any = true;
      }
      if (!any) return;
      ctx.globalAlpha = st[1]; ctx.fillStyle = st[0]; ctx.fill("evenodd");
      ctx.globalAlpha = 1; ctx.strokeStyle = st[2]; ctx.lineWidth = z < 15 ? Math.min(st[3], 0.8) : st[3]; ctx.stroke();
    });
    if (z < 15) return;
    // address points (and own points) without a building outline
    var dots = geo.dots.query(v.x0, v.y0, v.x1, v.y1);
    [false, true].forEach(function (ovr) {
      ctx.beginPath();
      dots.forEach(function (d) {
        if (d.ovr !== ovr) return;
        var x = d.x * v.S - v.ox, y = d.y * v.S - v.oy, r = ovr ? 6 : 4;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 2 * Math.PI);
      });
      ctx.globalAlpha = 0.9; ctx.fillStyle = ovr ? "#a78bfa" : "#d1d5db"; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = ovr ? "#6d28d9" : "#4b5563"; ctx.stroke();
    });
  }

  // ------------------------------------------------------------------ overrides
  function findBuildingAt(lat, lon) {
    var hits = blocks.filter(function (f) {
      var bb = f.properties._bb;
      return bb && lat >= bb[0] && lat <= bb[2] && lon >= bb[1] && lon <= bb[3] && contains(f, lat, lon);
    });
    hits.sort(function (a, b) { return (b.properties.kind === "apartments") - (a.properties.kind === "apartments"); });
    return hits[0] || null;
  }
  function nearestBuilding(lat, lon, maxM) {
    var d = maxM / 111000 * 1.6, best = null, bestD = Infinity;
    blocks.forEach(function (f) {
      var bb = f.properties._bb;
      if (!bb || lat < bb[0] - d || lat > bb[2] + d || lon < bb[1] - d || lon > bb[3] + d) return;
      var dist = contains(f, lat, lon) ? 0 : edgeDist(f, lat, lon);
      if (f.properties.kind === "apartments") dist -= 3;
      if (dist < bestD) { bestD = dist; best = f; }
    });
    return bestD <= maxM ? best : null;
  }
  function applyOverrides(rows) {
    var n = 0;
    rows.forEach(function (r, i) {
      var lat = parseFloat(String(r.lat).replace(",", ".")), lon = parseFloat(String(r.lon).replace(",", "."));
      var type = fold(r.type || "block").trim(), label = (r.label || "").trim();
      if (!isFinite(lat) || !isFinite(lon) || !label) { console.warn("overrides.csv: skipped row", i + 2, r); return; }
      n++;
      if (type === "place" || type === "poi" || type === "hely" || type === "loc") {
        pois.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
          properties: { kind: "poi", n: label, k: "override", v: "override", st: r.street || "", note: r.note || "", override: true } });
        return;
      }
      if (type === "entrance" || type === "scara" || type === "lepcsohaz") {
        var lab = stairLabel(label), best = null, bd = 8;
        var p = pxy(lat, lon);
        entrances.forEach(function (e) {
          var c = e.geometry.coordinates, q = pxy(c[1], c[0]);
          var d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < bd) { bd = d; best = e; }
        });
        if (best) {
          best.properties.osm_label = best.properties.label;
          best.properties.label = lab; best.properties.override = true;
        } else {
          var b = nearestBuilding(lat, lon, 50);
          entrances.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
            properties: { id: "ovr-e" + i, label: lab, building_id: b ? b.properties.id : null, override: true, note: r.note } });
        }
      } else {
        var f = findBuildingAt(lat, lon);
        var blk = /^\s*bl(oc)?\.?\s*/i.test(label) ? label.replace(/^\s*bl(oc)?\.?\s*/i, "").trim() : null;
        var nice = blk ? "Bl. " + blk : label;
        if (f) {
          var pp = f.properties;
          pp.osm_label = pp.label; pp.label = nice; pp.override = true;
          if (blk) pp.block = blk;
          if (r.street) pp.street = r.street;
          if (r.note) pp.note = r.note;
        } else {
          var nf = { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
            properties: { id: "ovr-b" + i, kind: "override", label: nice, block: blk, street: r.street || null,
              note: r.note || null, override: true, _ents: [], lp: [lat, lon] } };
          blocks.push(nf); byId[nf.properties.id] = nf;
        }
      }
    });
    return n;
  }

  // ------------------------------------------------------------------ labels
  // priority: block labels + staircase pills > street names > places > other buildings / address points
  function renderLabels() { labelsLayer.redraw(); }
  var poiHits = [];  // where the place badges were drawn (layer points), for taps
  function drawLabels(ctx) {
    poiHits = [];
    var V = labelView(), boxes = [], blk = [], addr = [], pills = [], streets = [], places = [];
    collectBlockLabels(V, boxes, blk, addr, pills);
    collectStreetLabels(V, boxes, streets);
    collectPois(V, boxes, places);
    var ox = V.tlx, oy = V.tly, up = rot.on ? rot.shown * Math.PI / 180 : 0;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)"; ctx.lineWidth = 3.5;
    ctx.font = STREET_FONT;
    streets.forEach(function (s) { haloText(ctx, s.x + ox, s.y + oy, s.a, s.text, s.color); });
    places.forEach(function (p) {
      drawPoi(ctx, p, p.cx + ox, p.cy + oy, up);
      poiHits.push({ f: p.f, box: [p.hit[0] + ox, p.hit[1] + oy, p.hit[2] + ox, p.hit[3] + oy] });
    });
    var font = null;
    addr.filter(function (a) { return !overlaps(a.box, boxes); }).concat(blk).forEach(function (l) {
      if (l.font !== font) ctx.font = font = l.font;
      haloText(ctx, l.cx + ox, l.cy + oy, up, l.text, l.color);
    });
    ctx.font = PILL_FONT;
    pills.forEach(function (p) { drawPill(ctx, p, p.cx + ox, p.cy + oy, up); });
  }
  function haloText(ctx, x, y, a, text, color) {
    if (a) { ctx.save(); ctx.translate(x, y); ctx.rotate(a); x = y = 0; }
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    if (a) ctx.restore();
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // staircase pill (orange), street-number pill (white, orange rim), unlabelled entrance (dot); own ones purple
  function drawPill(ctx, p, x, y, up) {
    ctx.save(); ctx.translate(x, y); if (up) ctx.rotate(up);
    var fill = p.ovr ? "#7c3aed" : "#ff5f14";
    if (p.kind === "dot") {
      ctx.beginPath(); ctx.arc(0, 0.8, 6.5, 0, 2 * Math.PI); ctx.fillStyle = "rgba(0, 0, 0, 0.22)"; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill();
    } else {
      var num = p.kind === "num" && !p.ovr, w = p.w, h = 19;
      ctx.beginPath(); rrect(ctx, -w / 2, -h / 2 + 1, w, h, h / 2); ctx.fillStyle = "rgba(0, 0, 0, 0.22)"; ctx.fill();
      ctx.beginPath(); rrect(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fillStyle = num ? fill : "#fff"; ctx.fill();
      ctx.beginPath(); rrect(ctx, -w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3, h / 2 - 1.5); ctx.fillStyle = num ? "#fff" : fill; ctx.fill();
      ctx.fillStyle = num ? "#c43d00" : "#fff"; ctx.fillText(p.text, 0, 0.5);
    }
    ctx.restore();
  }
  function collectBlockLabels(V, boxes, out, addr, pills) {
    var z = V.z;
    if (z < LABEL_MIN_ZOOM) return;
    var vis = placeItems(queryView(geo.lbl, V, 0.15).filter(function (it) { return !(it.f.properties.kind === "address" && z < 17); }), V);
    nearestFirst(vis, V, function (it) { return it.f.properties.kind === "apartments" ? 0 : 1e9; }, MAX_BLOCK_LABELS);  // apartments first
    vis.forEach(function (it) {
      var p = it.f.properties, apt = p.kind === "apartments";
      var font = (apt ? "700 " : "500 ") + (z >= 18 ? 15 : apt ? 13 : 12) + "px " + FONT_FAMILY;
      var l = { cx: it.cx, cy: it.cy, text: p.label, font: font, color: p.override ? "#5b21b6" : apt ? "#0c2454" : "#374151",
        box: rotBox(it.cx, it.cy, textWidth(font, p.label) + 6, 18) };
      // only apartment blocks (and own overrides) outrank street names; plain houses and address points yield
      if (p.kind === "address" || (p.kind === "other" && !p.override)) { addr.push(l); return; }
      boxes.push(l.box);
      out.push(l);
    });
    if (z < STAIR_MIN_ZOOM) return;
    // street-number pills ("nr. 13A") only from z18; at z17 they would bury the block labels
    var sv = placeItems(queryView(geo.ent, V, 0.15).filter(function (it) {
      return z >= NUM_MIN_ZOOM || !/^nr\. /.test(it.f.properties.label || "");
    }), V);
    nearestFirst(sv, V, function (it) { return it.f.properties.label ? 0 : 1e9; }, MAX_STAIR_LABELS);
    sv.forEach(function (it) {
      var e = it.f.properties, l = e.label, text = l ? l.replace(/^(Sc|nr)\. /, "") : "";
      var w = l ? textWidth(PILL_FONT, text) + 15 : 12;
      boxes.push(rotBox(it.cx, it.cy, w + 1, 18));
      pills.push({ cx: it.cx, cy: it.cy, text: text, w: w, ovr: !!e.override, kind: !l ? "dot" : l.indexOf("nr. ") === 0 ? "num" : "sc" });
    });
  }
  // places get an icon (always, where it fits) and their name (where that fits too)
  var MAX_POIS = 160;
  var POI_COLOR = { food: ["#b4470b", "#d9662a"], grocery: ["#b4470b", "#d9662a"], mall: ["#b4470b", "#d9662a"],
    pharmacy: ["#0d7a50", "#1b9a68"], health: ["#0d7a50", "#1b9a68"] };
  var POI_COLOR_DEF = ["#15387a", "#15387a"];
  var poiImgs = {}, imgTimer = null;
  function poiImage(g) {  // the icon as a picture, made once per kind
    var img = poiImgs[g];
    if (!img) {
      img = poiImgs[g] = new Image();
      img.onload = function () { clearTimeout(imgTimer); imgTimer = setTimeout(renderLabels, 30); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="' +
        (POI_COLOR[g] || POI_COLOR_DEF)[0] + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + (POI_ICON[g] || POI_ICON.other) + "</svg>");
    }
    return img.complete && img.naturalWidth ? img : null;
  }
  function drawPoi(ctx, p, x, y, up) {
    var col = POI_COLOR[p.g] || POI_COLOR_DEF, img = poiImage(p.g);
    ctx.save(); ctx.translate(x, y); if (up) ctx.rotate(up);
    ctx.beginPath(); ctx.arc(0, 1, 12.5, 0, 2 * Math.PI); ctx.fillStyle = "rgba(12, 36, 84, 0.3)"; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 12.5, 0, 2 * Math.PI); ctx.fillStyle = col[1]; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
    if (img) ctx.drawImage(img, -7, -7, 14, 14);
    if (p.name) {
      ctx.textAlign = "left";
      ctx.strokeText(p.name, 15, 0); ctx.fillStyle = "#2f3a52"; ctx.fillText(p.name, 15, 0);
    }
    ctx.restore();
  }
  function collectPois(V, boxes, out) {
    var z = V.z;
    if (z < 16 || !pois.length) return;
    var cx = V.size.x / 2, cy = V.size.y / 2;
    var vis = placeItems(queryView(geo.poi, V, 0).filter(function (it) {
      var p = it.f.properties, g = poiGroup(p);
      return z >= (p._minz || POI_MINZ[g] || 18);
    }), V);
    vis.forEach(function (it) { it.k = POI_RANK[poiGroup(it.f.properties)] * 1e8 + (it.cx - cx) * (it.cx - cx) + (it.cy - cy) * (it.cy - cy); });
    vis.sort(function (a, b) { return a.k - b.k; });
    for (var i = 0, n = 0; i < vis.length && n < MAX_POIS; i++) {
      var it = vis[i], p = it.f.properties, g = poiGroup(p);
      var ibox = rotBox(it.cx, it.cy, 24, 24);
      if (overlaps(ibox, boxes)) continue;
      boxes.push(ibox);
      var name = z >= 17 || (p._minz || POI_MINZ[g]) <= 16 ? p.n : "", hit = ibox;
      if (name) {
        var nw = textW(name) + 8;
        var nbox = rot.on ? rotBox(it.cx + 12 + nw / 2, it.cy, nw, 16) : [it.cx + 13, it.cy - 8, it.cx + 13 + nw, it.cy + 8];
        if (!overlaps(nbox, boxes)) { boxes.push(nbox); hit = mergeBB(ibox, nbox); } else name = "";
      }
      out.push({ cx: it.cx, cy: it.cy, g: g === "override" ? "other" : g, name: name, f: it.f, hit: hit });
      n++;
    }
  }
  // a tap on the map: a place badge, else an address point, else the building under the finger
  function inRingsN(rings, x, y) {
    var inside = false;
    for (var k = 0; k < rings.length; k++) {
      var a = rings[k], n = a.length;
      for (var i = 0, j = n - 2; i < n; j = i, i += 2) {
        var yi = a[i + 1], yj = a[j + 1];
        if ((yi > y) !== (yj > y) && x < (a[j] - a[i]) * (y - yi) / (yj - yi) + a[i]) inside = !inside;
      }
    }
    return inside;
  }
  function hitTest(e) {
    var lp = e.layerPoint, i;
    for (i = poiHits.length - 1; i >= 0; i--) {
      var h = poiHits[i].box;
      if (lp.x >= h[0] && lp.x <= h[2] && lp.y >= h[1] && lp.y <= h[3]) return poiHits[i].f;
    }
    var z = map.getZoom(), S = 256 * Math.pow(2, z), x = mx(e.latlng.lng), y = my(e.latlng.lat);
    if (z >= 15) {
      var r = 12 / S, best = null, bd = Infinity;
      geo.dots.query(x - r, y - r, x + r, y + r).forEach(function (d) {
        var dd = Math.hypot(d.x - x, d.y - y);
        if (dd <= r && dd < bd) { bd = dd; best = d.f; }
      });
      if (best) return best;
    }
    var hit = null, ha = Infinity;
    geo.bld.query(x, y, x, y).forEach(function (it) {
      if (!inRingsN(it.rings, x, y)) return;
      var area = (it.bb[2] - it.bb[0]) * (it.bb[3] - it.bb[1]) + (it.cls === "other" ? 1 : 0);  // blocks first, then the smallest
      if (area < ha) { ha = area; hit = it.f; }
    });
    return hit;
  }

  // ------------------------------------------------------------------ place card
  var hlLayer = null;
  function highlight(f) {
    clearHighlight();
    if (f.geometry.type === "Point") return;
    hlLayer = L.geoJSON(f, { renderer: routeCanvas, interactive: false,
      style: { color: "#f97316", weight: 4, fillColor: BLD_STYLE[f.properties.kind === "apartments" ? "apartments" : "other"][0], fillOpacity: 0.5 } }).addTo(map);
  }
  function clearHighlight() {
    if (hlLayer) map.removeLayer(hlLayer);
    hlLayer = null;
  }
  // what is painted on the plate: block number, else the house number, else whatever label we have
  function plateNum(p) {
    if (p.override) return p.label || "?";
    if (p.block) return "Bl. " + p.block;
    return p.housenumber || p.label || "?";
  }
  function openPlace(f) {
    if (f.properties.kind === "poi") { openPoi(f); return; }
    if (nav.active) return;
    highlight(f);
    var p = f.properties;
    var ents = p._ents.filter(function (e) { return e.properties.label; });
    openSheet({
      kind: "place",
      html: function () {
        var num = plateNum(p), kind = t("place.kind." + (p.kind === "apartments" || p.kind === "address" || p.kind === "override" ? p.kind : "other"));
        var unl = p._ents.filter(function (e) { return !e.properties.label && !e.properties.redundant; }).length;
        var facts = [];
        if (p.levels) facts.push("<b>" + esc(t("place.floors", { n: p.levels })) + "</b>");
        if (p.name && num.indexOf(p.name) < 0) facts.push(esc(p.name));
        if (p.note) facts.push(esc(t("popup.note")) + ": " + esc(p.note));
        if (p.override && p.osm_label !== undefined) facts.push(esc(t("popup.inOsm")) + ": " + esc(p.osm_label || "–"));
        var chips = function (list, cls) {
          return list.length ? '<div class="ents' + cls + '">' + list.map(function (e) {
            return '<span role="button" tabindex="0" data-act="ent" data-i="' + ents.indexOf(e) + '">' + esc(e.properties.label.replace(/^nr\. /, "")) + "</span>";
          }).join("") + "</div>" : "";
        };
        var stairs = ents.filter(function (e) { return e.properties.label.indexOf("nr. ") !== 0; });
        var nums = ents.filter(function (e) { return e.properties.label.indexOf("nr. ") === 0; });
        var osmUrl = /^[wnr]\d+$/.test(p.id) ? "https://www.openstreetmap.org/" + { w: "way", n: "node", r: "relation" }[p.id[0]] + "/" + p.id.slice(1) : null;
        var at = p.lp;
        return '<div class="house"><div class="plate"><span class="hp-street">' + esc(p.street ? shortName(p.street) : kind) + '</span>' +
          '<span class="hp-num' + (num.length > 7 ? " long" : "") + '">' + esc(num) + "</span></div>" +
          '<div class="house-side"><span class="house-kind">' + esc(kind) + "</span>" +
          (p.street ? '<span class="house-street">' + esc(p.street) + "</span>" : "") +
          (facts.length ? '<div class="facts">' + facts.join("<span>·</span>") + "</div>" : "") + "</div></div>" +
          "<h3>" + esc(t("popup.stairs")) + "</h3>" +
          (stairs.length ? chips(stairs, "") : '<p class="muted">' + esc(t("popup.noStairs")) + (unl ? " " + esc(t("popup.unlabelled", { n: unl })) : "") + "</p>") +
          (nums.length ? '<p class="muted">' + esc(t("popup.entranceNums")) + "</p>" + chips(nums, " num") : "") +
          (ents.length ? '<p class="muted">' + esc(t("place.entHint")) + "</p>" : "") +
          '<div class="actions"><button class="btn go" data-act="route">' + ICON.go + esc(t("place.navigate")) + "</button>" +
          '<a class="btn ghost" href="' + gmapsUrl(at) + '" target="_blank" rel="noopener" aria-label="' + esc(t("place.mapsAria")) + '">' + ICON.ext + "Maps</a></div>" +
          '<div class="osm-id">' + (osmUrl ? '<a href="' + osmUrl + '" target="_blank" rel="noopener">OSM ' + esc(p.id) + "</a> · " : esc(t("popup.own")) + " · ") +
          esc(t("popup.coords")) + " " + at[0].toFixed(6) + ", " + at[1].toFixed(6) + "</div>";
      },
      acts: {
        route: function () { planRoute(placeDest(f)); },
        ent: function (el) { planRoute(placeDest(f, ents[+el.getAttribute("data-i")])); },
      },
      onClose: clearHighlight,
    });
  }

  var poiHl = null;
  function openPoi(f) {
    if (nav.active) return;
    var p = f.properties, g = poiGroup(p), c = f.geometry.coordinates, at = [c[1], c[0]];
    if (poiHl) map.removeLayer(poiHl);
    poiHl = L.circleMarker(at, { renderer: routeCanvas, radius: 16, color: "#ff5f14", weight: 3, fill: false, interactive: false }).addTo(map);
    openSheet({
      kind: "place",
      html: function () {
        var addr = p.full || poiAddress(p), rows = [];
        if (p.oh) rows.push("<b>" + esc(t("poi.hours")) + ":</b> " + esc(p.oh));
        if (p.ph) rows.push("<b>" + esc(t("poi.phone")) + ":</b> " + p.ph.split(/[;,]/).map(function (n) {
          n = n.trim(); return '<a href="tel:' + esc(n.replace(/[^+0-9]/g, "")) + '">' + esc(n) + "</a>";
        }).join(", "));
        if (p.cu) rows.push(esc(p.cu.replace(/_/g, " ").replace(/;/g, ", ")));
        if (p.note) rows.push(esc(p.note));
        if (p.w && /^https?:\/\//.test(p.w)) rows.push('<a href="' + esc(p.w) + '" target="_blank" rel="noopener">' + esc(p.w.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) + "</a>");
        return '<div class="house"><div class="plate poi-plate">' + poiIcon(g) + '</div>' +
          '<div class="house-side"><span class="house-kind">' + esc(catLabel(g)) + '</span><span class="house-street poi-name">' + esc(p.n) + "</span>" +
          (addr ? '<div class="facts">' + esc(addr) + "</div>" : "") + "</div></div>" +
          (rows.length ? '<div class="poi-rows">' + rows.map(function (r) { return "<p>" + r + "</p>"; }).join("") + "</div>" : "") +
          '<div class="actions"><button class="btn go" data-act="route">' + ICON.go + esc(t("place.navigate")) + "</button>" +
          '<a class="btn ghost" href="' + gmapsUrl(at) + '" target="_blank" rel="noopener" aria-label="' + esc(t("place.mapsAria")) + '">' + ICON.ext + "Maps</a></div>" +
          '<div class="osm-id">' + (p.src === "tomtom" ? esc(t("ext.source")) + " · " : "") +
          esc(t("popup.coords")) + " " + at[0].toFixed(6) + ", " + at[1].toFixed(6) + "</div>";
      },
      acts: {
        route: function () {
          planRoute({ at: at, f: f, title: p.n, street: poiAddress(p), plate: p.n.length > 18 ? p.n.slice(0, 17) + "…" : p.n });
        },
      },
      onClose: function () { if (poiHl) { map.removeLayer(poiHl); poiHl = null; } },
    });
  }

  // ------------------------------------------------------------------ search
  // every number an address answers to: "29-33" -> 29, 31, 33; "32 A/B" -> 32a, 32b; "45A, 45B" -> 45a, 45b
  function numberTokens(v) {
    var out = {}, m;
    v = fold(v).replace(/–/g, "-");
    var range = /(\d+)\s*-\s*(\d+)/g;
    while ((m = range.exec(v))) {
      var a = +m[1], b = +m[2];
      if (a < b && b - a <= 40) for (var n = a; n <= b; n += (b - a) % 2 ? 1 : 2) out[n] = 1;
    }
    var single = /(\d+)\s*([a-z]?)/g;
    while ((m = single.exec(v))) out[m[1] + m[2]] = 1;
    var letters = /(\d+)\s*([a-z])(?:\s*\/\s*[a-z])+/g;
    while ((m = letters.exec(v))) m[0].replace(/[a-z]/g, function (l) { out[m[1] + l] = 1; });
    return Object.keys(out);
  }
  // "31" also finds 31A, 31B (a bit lower); "31a" only finds 31A
  function numberScore(tok, nums) {
    if (nums.indexOf(tok) >= 0) return 50;
    if (/^\d+$/.test(tok)) {
      for (var i = 0; i < nums.length; i++) if (nums[i].replace(/[a-z]$/, "") === tok) return 45;
    }
    return 0;
  }
  // ---------- named places (POIs)
  var POI_ICON = {
    food: '<path d="M7 3v7M5 3v4a2 2 0 0 0 4 0V3M7 10v11M17 21V3c-2 1-3.5 3.5-3.5 7 0 2 1.5 3 3.5 3"/>',
    grocery: '<path d="M3 4h2l2.3 11h10.4L20 7H6.2"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
    mall: '<path d="M5 8h14l-1 13H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    shop: '<path d="M3 12V4h8l10 10-8 8-10-10Z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    pharmacy: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6Z"/>',
    health: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 8v8M15 8v8M9 12h6"/>',
    money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    fuel: '<path d="M5 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16M4 21h11M7 8h5M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
    education: '<path d="m2 9 10-5 10 5-10 5L2 9Z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>',
    worship: '<path d="M12 2v4M10 4h4M6 21V11l6-5 6 5v10M10 21v-4h4v4"/>',
    transport: '<rect x="5" y="3" width="14" height="14" rx="2"/><path d="M5 11h14M8 20l1-3M16 20l-1-3"/><circle cx="8.5" cy="14" r=".6"/><circle cx="15.5" cy="14" r=".6"/>',
    hotel: '<path d="M3 19V6M3 14h18v5M21 19v-2.5A3.5 3.5 0 0 0 17.5 13H11v1"/><circle cx="7" cy="10.5" r="1.6"/>',
    leisure: '<path d="m12 3 2.5 5.4 5.9.6-4.4 4 1.2 5.8L12 16l-5.2 2.8L8 13 3.6 9l5.9-.6L12 3Z"/>',
    public: '<path d="M3 10h18L12 4 3 10ZM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
    office: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
    other: '<circle cx="12" cy="12" r="4"/>',
  };
  var POI_GROUP_OF = {};  // "amenity=fast_food" -> "food"
  [["food", "amenity", "restaurant fast_food cafe bar pub food_court ice_cream biergarten"],
   ["pharmacy", "amenity", "pharmacy"], ["pharmacy", "shop", "chemist"],
   ["health", "amenity", "hospital clinic doctors dentist veterinary nursing_home"],
   ["money", "amenity", "bank atm bureau_de_change money_transfer payment_centre"],
   ["fuel", "amenity", "fuel charging_station car_wash"],
   ["education", "amenity", "school kindergarten university college library music_school driving_school language_school training"],
   ["worship", "amenity", "place_of_worship monastery"],
   ["transport", "amenity", "bus_station taxi parking ferry_terminal bicycle_rental car_rental"],
   ["public", "amenity", "townhall police post_office courthouse fire_station embassy community_centre social_facility public_building prison"],
   ["leisure", "amenity", "theatre cinema arts_centre nightclub casino events_venue"],
   ["grocery", "amenity", "marketplace"],
   ["grocery", "shop", "supermarket convenience bakery butcher greengrocer deli alcohol beverages kiosk pastry confectionery dairy seafood coffee tea frozen_food"],
   ["mall", "shop", "mall department_store"],
   ["health", "shop", "medical_supply optician hearing_aids"],
   ["hotel", "tourism", "hotel guest_house hostel motel apartment chalet"],
   ["public", "office", "government"],
   ["education", "building", "school university college kindergarten"],
   ["worship", "building", "church cathedral mosque synagogue"],
   ["health", "building", "hospital"], ["transport", "building", "train_station"], ["hotel", "building", "hotel"],
   ["leisure", "building", "stadium sports_hall"], ["public", "building", "government public civic"],
   ["grocery", "building", "supermarket"], ["office", "building", "commercial retail office"],
  ].forEach(function (row) { row[2].split(" ").forEach(function (v) { POI_GROUP_OF[row[1] + "=" + v] = row[0]; }); });
  var POI_KEY_GROUP = { shop: "shop", healthcare: "health", tourism: "leisure", leisure: "leisure", historic: "leisure", sport: "leisure",
    club: "leisure", office: "office", craft: "office", railway: "transport", public_transport: "transport", aeroway: "transport", amenity: "other" };
  // big landmarks show from z16, everyday places from z17, the rest from z18
  var POI_MINZ = { mall: 16, fuel: 16, transport: 17, food: 17, grocery: 17, pharmacy: 17, health: 17, money: 18, education: 17,
    worship: 17, hotel: 17, public: 17, leisure: 18, shop: 18, office: 18, other: 18, override: 16 };
  var POI_RANK = { mall: 0, override: 0, transport: 1, health: 1, grocery: 2, food: 2, pharmacy: 2, fuel: 2, education: 3,
    public: 3, hotel: 3, worship: 4, money: 4, leisure: 5, shop: 5, office: 6, other: 7 };
  function poiGroup(p) {
    if (p._g) return p._g;
    p._g = p.k === "override" ? "override" : POI_GROUP_OF[p.k + "=" + p.v] || POI_KEY_GROUP[p.k] || "other";
    if (p.v === "hospital" || p.v === "university" || p.v === "station") p._minz = 16;
    return p._g;
  }
  function poiIcon(g) { return svg(POI_ICON[g === "override" ? "other" : g] || POI_ICON.other); }
  function catLabel(g) { return t("cat." + (g === "override" ? "other" : g)); }
  function compact(s) { return fold(s).replace(/[^a-z0-9]+/g, ""); }
  // where each word starts inside the compact name: "BKF Carwash" -> "bkfcarwash", starts {0, 3}
  function wordStarts(s) {
    var starts = {}, pos = 0;
    fold(s).split(/[^a-z0-9]+/).forEach(function (w) { if (w) { starts[pos] = 1; pos += w.length; } });
    return starts;
  }
  // what people type for a specific kind of place, in all three languages (search only, never shown)
  var KIND_WORDS = {
    "amenity=hospital": "hospital spital spitalul korhaz", "amenity=clinic": "clinic clinica klinika rendelo policlinica",
    "amenity=doctors": "doctor medic orvos cabinet", "amenity=dentist": "dentist stomatolog fogorvos",
    "amenity=pharmacy": "pharmacy farmacie gyogyszertar patika", "shop=chemist": "drugstore drogerie drogeria",
    "amenity=school": "school scoala liceu iskola gimnazium", "amenity=university": "university universitate facultate egyetem",
    "amenity=kindergarten": "kindergarten gradinita ovoda", "amenity=police": "police politie politia rendorseg",
    "amenity=post_office": "post office posta", "amenity=bank": "bank banca", "amenity=atm": "atm bancomat bankautomata",
    "amenity=fuel": "fuel petrol benzinarie peco benzinkut", "shop=supermarket": "supermarket szupermarket",
    "shop=convenience": "convenience magazin alimentara abc", "shop=bakery": "bakery brutarie patiserie pekseg",
    "amenity=restaurant": "restaurant etterem", "amenity=cafe": "cafe cafenea kavezo", "amenity=fast_food": "fast food gyorsetterem",
    "amenity=bar": "bar", "amenity=pub": "pub", "tourism=hotel": "hotel szalloda", "tourism=guest_house": "pensiune panzio guest house",
    "amenity=parking": "parking parcare parkolo", "railway=station": "train station gara vasutallomas palyaudvar",
    "amenity=bus_station": "bus station autogara buszallomas", "amenity=townhall": "town hall primarie polgarmesteri varoshaza",
    "amenity=place_of_worship": "church biserica templom", "shop=mall": "mall plaza", "amenity=cinema": "cinema mozi",
    "amenity=theatre": "theatre teatru szinhaz", "leisure=park": "park parc", "leisure=fitness_centre": "gym fitness sala edzoterem",
  };
  function catWords(g) {  // category names in every language, so "pharmacy", "farmacie" and "gyógyszertár" all work
    return Object.keys(LANGS).map(function (code) {
      return [LANGS[code]["cat." + g], LANGS[code]["catw." + g]].filter(Boolean).join(" ");
    }).join(" ");
  }
  function buildPoiIndex() {
    poiIndex = pois.map(function (f) {
      var p = f.properties, g = poiGroup(p);
      var names = [p.n].concat(p.alt || []).join(" ");
      var kindW = {};
      [KIND_WORDS[p.k + "=" + p.v] || "", g === "override" ? "" : catWords(g)].join(" ").split(/\s+/).forEach(function (w) {
        w = fold(w); if (w) kindW[w] = (kindW[w] || 0) + 1;
      });
      (KIND_WORDS[p.k + "=" + p.v] || "").split(/\s+/).forEach(function (w) { if (w) kindW[fold(w)] = 9; });  // the exact kind
      return {
        f: f, poi: true, kindW: kindW,
        name: fold(names), nameC: compact(names), nameStarts: wordStarts(names),
        hay: fold([names, p.st, p.hn, g === "override" ? "" : catWords(g), p.cu || "", p.note || ""].join(" ")),
        block: [], nums: numberTokens(p.hn || ""),
      };
    });
  }
  // ---------- places OpenStreetMap doesn't have: ask TomTom's Search API live (official API, same key
  // as traffic). Results are only shown, never saved; they are marked "TomTom" everywhere.
  var ext = { q: "", busy: false, res: null, err: null, timer: null };
  var TT_GROUP = {
    RESTAURANT: "food", CAFE_PUB: "food", "FAST_FOOD": "food", NIGHTLIFE: "food", PHARMACY: "pharmacy",
    SHOPPING_CENTER: "mall", MARKET: "grocery", SHOP: "shop", HOSPITAL_POLYCLINIC: "health", DOCTOR: "health",
    DENTIST: "health", EMERGENCY_MEDICAL_SERVICE: "health", HEALTH_CARE_SERVICE: "health", BANK: "money", CASH_DISPENSER: "money",
    PETROL_STATION: "fuel", ELECTRIC_VEHICLE_STATION: "fuel", SCHOOL: "education", COLLEGE_UNIVERSITY: "education",
    PLACE_OF_WORSHIP: "worship", RAILWAY_STATION: "transport", PUBLIC_TRANSPORT_STOP: "transport", PARKING_GARAGE: "transport",
    OPEN_PARKING_AREA: "transport", AIRPORT: "transport", HOTEL_MOTEL: "hotel", GOVERNMENT_OFFICE: "public", POLICE_STATION: "public",
    POST_OFFICE: "public", CITY_HALL: "public", CINEMA: "leisure", THEATER: "leisure", MUSEUM: "leisure", PARK_RECREATION_AREA: "leisure",
    SPORTS_CENTER: "leisure", FITNESS_CLUB_CENTER: "leisure", IMPORTANT_TOURIST_ATTRACTION: "leisure", COMPANY: "office",
  };
  function extSearch(q) {
    if (!CONFIG.tomtomKey || ext.busy) return;
    ext.q = q; ext.busy = true; ext.res = null; ext.err = null;
    showResults();
    var ref = loc.pos || [map.getCenter().lat, map.getCenter().lng];
    var url = "https://api.tomtom.com/search/2/search/" + encodeURIComponent(q) + ".json?key=" + encodeURIComponent(CONFIG.tomtomKey) +
      "&countrySet=RO&idxSet=POI&limit=10&radius=20000&lat=" + ref[0].toFixed(5) + "&lon=" + ref[1].toFixed(5) +
      "&language=" + ({ en: "en-GB", hu: "hu-HU", ro: "ro-RO" }[lang] || "en-GB");
    fetch(url).then(function (r) {
      if (r.status === 403 || r.status === 401) throw new Error("forbidden");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      ext.res = (j.results || []).filter(function (x) { return x.poi && x.position; }).map(function (x) {
        var a = x.address || {}, code = ((x.poi.classifications || [])[0] || {}).code || "";
        var f = { type: "Feature", geometry: { type: "Point", coordinates: [x.position.lon, x.position.lat] },
          properties: { kind: "poi", src: "tomtom", n: x.poi.name, k: "tomtom", v: code.toLowerCase(),
            st: a.streetName || "", hn: a.streetNumber || "", ph: x.poi.phone || "", w: x.poi.url || "",
            full: a.freeformAddress || "" } };
        f.properties._g = TT_GROUP[code] || (x.poi.categories && /shop|store/i.test(x.poi.categories.join(" ")) ? "shop" : "other");
        return f;
      }).filter(function (f) {  // drop what our OpenStreetMap data already has (same name within 300 m)
        var nC = compact(f.properties.n), c = f.geometry.coordinates;
        return !pois.some(function (o) {
          var oc = o.geometry.coordinates;
          return compact(o.properties.n) === nC && BlokkRouter.dist([oc[1], oc[0]], [c[1], c[0]]) < 300;  // big buildings: points can be far apart
        });
      });
    }).catch(function (e) {
      ext.err = e.message === "forbidden" ? "forbidden" : "fail";
    }).then(function () {
      ext.busy = false;
      if (fold(qEl.value).trim() === fold(q).trim()) showResults();
    });
  }
  function extRows(q, start) {
    if (!CONFIG.tomtomKey || q.length < 3) return "";
    if (ext.q !== q) return '<li class="r-more" data-ext="1" tabindex="0">' + svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>') +
      "<span>" + esc(t("ext.more", { q: q })) + "</span></li>";
    if (ext.busy) return '<li class="r-head">' + esc(t("ext.loading")) + "</li>";
    if (ext.err) return '<li class="r-head">' + esc(t(ext.err === "forbidden" ? "ext.forbidden" : "ext.fail")) + "</li>";
    if (!ext.res || !ext.res.length) return '<li class="r-head">' + esc(t("ext.none", { q: q })) + "</li>";
    return '<li class="r-head">' + esc(t("ext.header")) + "</li>" + ext.res.map(function (f, k) {
      var p = f.properties, g = poiGroup(p);
      return '<li data-i="' + (start + k) + '" tabindex="0"><span class="r-num poi g-' + g + '">' + poiIcon(g) + '</span><span class="r-main">' +
        esc(p.n) + ' <span class="chip grey">TomTom</span></span><span class="r-sub">' +
        esc([catLabel(g), p.full || poiAddress(p), fmtDist(poiDistance(f))].filter(Boolean).join(" · ")) + "</span></li>";
    }).join("");
  }

  function poiAddress(p) { return [p.st, p.hn].filter(Boolean).join(" "); }
  function poiDistance(f) {
    var ref = loc.pos || [map.getCenter().lat, map.getCenter().lng], c = f.geometry.coordinates;
    return BlokkRouter.dist(ref, [c[1], c[0]]);
  }

  function buildSearchIndex() {
    buildPoiIndex();
    searchIndex = blocks.filter(function (f) { var p = f.properties; return p.label || p.street || p.name; })
      .map(function (f) {
        var p = f.properties;
        var nums = numberTokens([p.housenumber, p.block].concat(p.entrance_nums || []).filter(Boolean).join(" "));
        return {
          f: f,
          hay: fold([p.label, p.street, p.name, p.housenumber, p.block ? "bl " + p.block : "", p.entrances.join(" "), (p.entrance_nums || []).join(" ")].join(" ")),
          block: p.block ? fold(p.block).split(/[\s,]+/) : [],
          nums: nums,
        };
      });
  }
  function search(qs) {
    var q = fold(qs).trim();
    if (!q) return [];
    var blockQ = null;
    var m = q.match(/(?:^|\s)(?:bl|bloc|blocul|blokk|block)\.?\s*(?:nr\.?\s*)?([a-z0-9-]+)\s*$/) ||
            q.match(/^(?:bl|bloc|blocul|blokk|block)\.?\s*(?:nr\.?\s*)?([a-z0-9-]+)/);
    var rest = q;
    if (m) { blockQ = m[1]; rest = q.replace(m[0], " ").trim(); }
    var toks = rest.replace(/[.,;]/g, " ").split(/\s+/).filter(function (w) { return w && ["str", "strada", "nr", "utca", "street"].indexOf(w) < 0; });
    var out = [];
    var qC = compact(rest);
    searchIndex.concat(streetIndex, poiIndex).forEach(function (it) {
      var score = 0;
      if (it.poi) {
        if (blockQ) return;
        // "mcdonalds" finds "McDonald's", "shoppingcity" finds "Shopping City"
        // the query squashed together, found in the squashed name from the start of a word:
        // rescues "mcdonalds" for "McDonald's"; a name that starts with the query ranks higher
        var at = qC.length >= 3 ? it.nameC.indexOf(qC) : -1;
        while (at > 0 && !it.nameStarts[at]) at = it.nameC.indexOf(qC, at + 1);
        if (at === 0) score += 20;
      }
      if (blockQ) {
        if (it.block.indexOf(blockQ) >= 0) score += 100;
        else return;
      }
      for (var i = 0; i < toks.length; i++) {
        var tok = toks[i];
        if (/^\d+[a-z]?$/.test(tok)) {
          var ns = numberScore(tok, it.nums);
          if (ns) score += ns;
          else if (it.block.indexOf(tok) >= 0) score += 40;
          else if (new RegExp("(^|\\s)" + tok + "(\\s|$)").test(it.hay)) score += 12;  // "1848" in "Bulevardul 1848"
          else return;
        } else if (it.hay.indexOf(tok) >= 0 || (tok.length >= 5 && it.hay.indexOf(tok.slice(0, -1)) >= 0)) {
          score += 10 + (new RegExp("(^|\\s)" + tok.replace(/[^a-z0-9]/g, "")).test(it.hay) ? 5 : 0);
          if (it.poi) {
            var kw = it.kindW[tok] || (tok.length >= 5 && it.kindW[tok.slice(0, -1)]);
            if (kw === 9) score += 16;          // "hospital" -> hospitals before clinics
            else if (kw) score += 10;           // "farmacie" -> pharmacies before a university with Farmacie in its name
            else if (it.name.indexOf(tok) >= 0) score += 8;  // the place's own name
          }
        } else if (it.poi && at >= 0) {
          score += 30;  // matched as a whole name only ("mcdonalds")
        } else return;
      }
      if (it.street) score += 8;  // a bare street name should land on the street itself
      if (it.f.properties.kind === "apartments") score += 3;
      out.push({ it: it, s: score });
    });
    // same score: nearest first (a chain like Profi lists the closest shop on top)
    out.forEach(function (o) { o.d = o.it.poi ? poiDistance(o.it.f) : 0; });
    out.sort(function (a, b) {
      return b.s - a.s || a.d - b.d ||
        String(a.it.f.properties.street || a.it.f.properties.label || "").localeCompare(String(b.it.f.properties.street || ""), "ro") ||
        String(a.it.f.properties.label).localeCompare(String(b.it.f.properties.label), "ro", { numeric: true });
    });
    return out.slice(0, 40).map(function (o) { return o.it.f; });
  }
  var qEl = $("q"), resEl = $("results"), clearEl = $("qclear"), sTimer;
  function showResults() {
    var v = qEl.value;
    clearEl.hidden = !v;
    if (!v.trim()) { resEl.hidden = true; resEl.innerHTML = ""; return; }
    var r = search(v), q = v.trim();
    if (ext.q && ext.q !== q) { ext.q = ""; ext.res = null; ext.err = null; }
    // nothing of ours matches a place-like query: ask TomTom by itself after a short pause
    clearTimeout(ext.timer);
    if (!r.length && CONFIG.tomtomKey && q.length >= 3 && !/\d/.test(q) && ext.q !== q) {
      ext.timer = setTimeout(function () { if (qEl.value.trim() === q) extSearch(q); }, 600);
    }
    var extList = ext.q === q && ext.res ? ext.res : [];
    if (!r.length) {
      // "nothing here" stays until TomTom has answered; then only TomTom's answer is shown
      resEl.innerHTML = (ext.q === q ? "" : '<li class="r-empty">' + esc(t("search.none")) + "</li>") + extRows(q, 0);
      resEl._r = extList;
    } else {
      resEl.innerHTML = r.map(function (f, i) {
        var p = f.properties;
        if (p.kind === "street") {
          return '<li data-i="' + i + '" tabindex="0"><span class="r-num street">' + esc(t("chip.street")) + '</span><span class="r-main">' +
            esc(p.label) + '</span><span class="r-sub">' + esc(t("search.streetSub")) + "</span></li>";
        }
        if (p.kind === "poi") {
          var g = poiGroup(p), sub2 = [catLabel(g), poiAddress(p), loc.pos || map.getZoom() >= 13 ? fmtDist(poiDistance(f)) : ""].filter(Boolean).join(" · ");
          return '<li data-i="' + i + '" tabindex="0"><span class="r-num poi g-' + g + '">' + poiIcon(g) + '</span><span class="r-main">' +
            esc(p.n) + '</span><span class="r-sub">' + esc(sub2) + "</span></li>";
        }
        var kind = p.kind === "apartments" ? t("chip.block") : p.kind === "override" ? t("chip.own") : t(p.kind === "address" ? "chip.address" : "chip.building");
        var sub = [kind, p.entrances.length ? p.entrances.join(", ") : "", p.name || ""].filter(Boolean).join(" · ");
        return '<li data-i="' + i + '" tabindex="0"><span class="r-num' + (p.kind === "apartments" || p.kind === "override" ? "" : " other") + '">' +
          esc(p.housenumber || p.block || p.label ? plateNum(p) : t("search.noNumber")) + '</span><span class="r-main">' + esc(p.street || p.name || p.label || "") +
          '</span><span class="r-sub">' + esc(sub) + "</span></li>";
      }).join("") + extRows(q, r.length);
      resEl._r = r.concat(extList);
    }
    resEl.hidden = false;
  }
  qEl.addEventListener("input", function () { clearTimeout(sTimer); sTimer = setTimeout(showResults, 120); });
  qEl.addEventListener("focus", function () { if (qEl.value) showResults(); });
  qEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && resEl._r && resEl._r.length) { goTo(resEl._r[0]); }
    if (e.key === "Escape") { resEl.hidden = true; qEl.blur(); }
  });
  clearEl.addEventListener("click", function () { qEl.value = ""; showResults(); qEl.focus(); });
  resEl.addEventListener("keydown", function (e) {
    if (e.target.closest("[data-ext]") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); extSearch(qEl.value.trim()); return; }
    var li = e.target.closest("li[data-i]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); goTo(resEl._r[+li.getAttribute("data-i")]); }
  });
  resEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-ext]")) { extSearch(qEl.value.trim()); return; }
    var li = e.target.closest("li[data-i]");
    if (li) goTo(resEl._r[+li.getAttribute("data-i")]);
  });
  map.on("click", function (e) {
    resEl.hidden = true; qEl.blur();
    var f = nav.active ? null : hitTest(e);
    if (f) { if (f.properties.kind === "poi") openPoi(f); else openPlace(f); return; }
    if (sheetSpec && (sheetSpec.kind === "place" || sheetSpec.kind === "settings" || sheetSpec.kind === "intro")) closeSheet();
  });
  function goTo(f) {
    resEl.hidden = true; qEl.blur();
    var p = f.properties;
    if (p.kind === "street") { showStreet(f); return; }
    if (p.kind === "poi") {
      var c0 = f.geometry.coordinates;
      map.setView([c0[1], c0[0]], Math.max(map.getZoom(), 18));
      setTimeout(function () { openPoi(f); }, 300);
      return;
    }
    if (f.geometry.type === "Point") {
      map.setView(p.lp, 18);
    } else {
      var bb = p._bb;
      map.fitBounds(L.latLngBounds([bb[0], bb[1]], [bb[2], bb[3]]), { maxZoom: 18, padding: [60, 60] });
      if (map.getZoom() < 17) map.setZoom(17);
    }
    setTimeout(function () { openPlace(f); }, 350);
  }

  // ------------------------------------------------------------------ bottom sheet
  // one sheet at a time: {kind, html(), acts{}, after(el), onClose(), closeAct(), compact}
  var sheetEl = $("sheet"), sheetBody = $("sheet-body"), sheetSpec = null;
  function openSheet(spec) {
    if (sheetSpec && sheetSpec.kind !== spec.kind && sheetSpec.onClose) sheetSpec.onClose(spec.kind);
    sheetSpec = spec;
    sheetEl.classList.toggle("no-close", !!spec.noClose);
    renderSheet();
    sheetEl.hidden = false;
    document.body.classList.add("sheet-open");
    sheetEl.scrollTop = 0;
  }
  function renderSheet() {
    if (!sheetSpec) return;
    var h = sheetSpec.html();
    if (h === sheetBody._html && sheetSpec === sheetBody._spec) return;  // navigation re-renders every fix; mostly nothing changed
    sheetBody.innerHTML = h; sheetBody._html = h; sheetBody._spec = sheetSpec;
    if (sheetSpec.after) sheetSpec.after(sheetBody);
    syncSheetHeight();
  }
  function refreshSheet() { if (sheetSpec && !sheetEl.hidden) renderSheet(); }
  function closeSheet() {
    var s = sheetSpec;
    sheetSpec = null;
    sheetEl.hidden = true;
    document.body.classList.remove("sheet-open");
    syncSheetHeight();
    if (s && s.onClose) s.onClose();
  }
  function syncSheetHeight() {
    requestAnimationFrame(function () {
      var h = ui.sheetH;
      measureUi();
      if (h !== ui.sheetH) document.documentElement.style.setProperty("--sheet-h", ui.sheetH + "px");
    });
  }
  // sizes of the bars over the map, read when they change rather than on every GPS fix
  function measureUi() {
    ui.topBottom = $("topbar").getBoundingClientRect().bottom;
    ui.navBottom = $("navbar").hidden ? 0 : $("navbar").getBoundingClientRect().bottom;
    ui.sheetH = sheetEl.hidden ? 0 : sheetEl.offsetHeight;
  }
  window.addEventListener("resize", function () { measureUi(); });
  if (window.ResizeObserver) new ResizeObserver(syncSheetHeight).observe(sheetEl);
  sheetEl.addEventListener("click", function (e) {
    if (e.target.closest(".sheet-close")) {
      if (sheetSpec && sheetSpec.closeAct) sheetSpec.closeAct(); else closeSheet();
      return;
    }
    var el = e.target.closest("[data-act]"), fn = el && sheetSpec && sheetSpec.acts && sheetSpec.acts[el.getAttribute("data-act")];
    if (fn) fn(el, e);
  });
  sheetEl.addEventListener("change", function (e) {
    var el = e.target.closest("[data-change]"), fn = el && sheetSpec && sheetSpec.acts && sheetSpec.acts[el.getAttribute("data-change")];
    if (fn) fn(el, e);
  });

  // ------------------------------------------------------------------ icons + formatting
  function svg(paths, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (extra || "") + ">" + paths + "</svg>";
  }
  var ICON = {
    car: svg('<path d="M4 15v-3.5L6.2 6.5h11.6L20 11.5V15"/><rect x="3" y="15" width="18" height="4" rx="1.5"/><path d="M7 19v1.5M17 19v1.5M4 11.5h16"/>'),
    bike: svg('<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 9h7l2.5 7M9 9l3.5 7H5.5M14 5h2.5l-.5 4"/>'),
    foot: svg('<circle cx="13" cy="4.5" r="1.8"/><path d="m9.5 21 2.2-6.2-2.4-3.1 1.1-4.6 3.6 2.4 2.8.8M11.7 14.8l3 2.2.9 4M9.2 8.6 6.8 11.5"/>'),
    go: svg('<path d="M3 11 21 3l-8 18-2-8-8-2Z"/>'),
    ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  };
  var MODE_ICON = { car: ICON.car, bike: ICON.bike, foot: ICON.foot };
  function turnSvg(step) {
    var m = (step && step.modifier) || "", type = step ? step.type : "arrive", p;
    var mirror = type !== "roundabout" && (/right/.test(m) || m === "uturn");
    if (type === "arrive") p = '<path d="M12 21s-6-5.6-6-10a6 6 0 0 1 12 0c0 4.4-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/>';
    else if (type === "roundabout") p = '<path d="M12 21v-6.5A4.5 4.5 0 1 0 7.5 10H3.5"/><path d="M6 7.5 3.5 10 6 12.5"/>';  // anticlockwise, as driven here
    else if (m === "uturn") p = '<path d="M9 21V10a4.5 4.5 0 0 1 9 0v3"/><path d="m14.5 10 3.5 3.5 3.5-3.5"/>';
    else if (/sharp/.test(m)) p = '<path d="M17 21V9.5L7.5 17"/><path d="M7 11v6.5h6.5"/>';
    else if (/slight/.test(m)) p = '<path d="M15 21v-7.5L8.5 7"/><path d="M8 13V6.5h6.5"/>';
    else if (m === "left" || m === "right") p = '<path d="M16 21v-8a3 3 0 0 0-3-3H6"/><path d="m10 6-4 4 4 4"/>';
    else p = '<path d="M12 21V4"/><path d="m6 10 6-6 6 6"/>';
    return svg(p, mirror ? ' style="transform:scaleX(-1)"' : "");
  }
  var LOCALE = { en: "en-GB", hu: "hu-HU", ro: "ro-RO" };
  function fmtNum(n, d) {
    try { return n.toLocaleString(LOCALE[lang] || lang, { maximumFractionDigits: d, minimumFractionDigits: d }); } catch (e) { return n.toFixed(d); }
  }
  function fmtDist(m) {
    if (m < 950) return t("unit.m", { n: m < 100 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10 });
    return t("unit.km", { n: fmtNum(m / 1000, m < 9950 ? 1 : 0) });
  }
  function fmtDur(s) {
    var min = Math.max(1, Math.round(s / 60));
    if (min < 60) return { n: String(min), u: t("unit.min") };
    return { n: Math.floor(min / 60) + ":" + ("0" + (min % 60)).slice(-2), u: t("unit.h") };
  }
  function fmtClock(s) {
    var d = new Date(Date.now() + s * 1000);
    try { return d.toLocaleTimeString(LOCALE[lang] || lang, { hour: "2-digit", minute: "2-digit", hour12: false }); } catch (e) { return d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2); }
  }
  function gmapsUrl(at) {
    return "https://www.google.com/maps/dir/?api=1&travelmode=" + (route.mode === "foot" ? "walking" : route.mode === "bike" ? "bicycling" : "driving") +
      "&destination=" + at[0].toFixed(6) + "," + at[1].toFixed(6);
  }

  // ------------------------------------------------------------------ live location
  var loc = { watchId: null, pos: null, acc: 0, heading: null, last: 0, follow: false, marker: null, circle: null, waiting: [], denied: false };
  var locBtn = $("btn-locate");
  function setLocBtn() {
    locBtn.classList.toggle("on", loc.watchId !== null);
    locBtn.classList.toggle("follow", loc.follow && !!loc.pos);
    locBtn.classList.toggle("wait", loc.watchId !== null && !loc.pos);
  }
  function flushWaiting(err) { var w = loc.waiting; loc.waiting = []; w.forEach(function (fn) { fn(err); }); }
  function startLocation(follow) {
    if (follow) loc.follow = true;
    if (loc.watchId !== null) {
      if (loc.pos && follow) map.setView(loc.pos, Math.max(map.getZoom(), 17));
      setLocBtn();
      return;
    }
    if (!window.isSecureContext) { toast(t("toast.locHttps"), 7000); flushWaiting(true); return; }
    if (!("geolocation" in navigator)) { toast(t("loc.unavailable"), 6000); flushWaiting(true); return; }
    loc.watchId = navigator.geolocation.watchPosition(onFix, onLocError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    // a quick rough fix (Wi-Fi / cell) while the GPS warms up, so directions don't sit waiting
    navigator.geolocation.getCurrentPosition(function (p) {
      if (!loc.pos && p.coords.accuracy <= 500) onFix(p);
    }, function () { /* the watch reports errors */ }, { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
    setLocBtn();
  }
  function restartLocation(follow) {  // from a tap: also re-asks the browser where it needs a user gesture
    if (loc.watchId !== null) navigator.geolocation.clearWatch(loc.watchId);
    loc.watchId = null;
    startLocation(follow);
  }
  function stopLocation() {
    if (loc.watchId !== null) navigator.geolocation.clearWatch(loc.watchId);
    loc.watchId = null; loc.follow = false;
    setLocBtn();
  }
  function onFix(p) {
    var c = p.coords, ll = [c.latitude, c.longitude], prev = loc.pos, first = !prev, now = Date.now();
    var moved = prev ? BlokkRouter.dist(prev, ll) : 0;
    // speed (m/s) for the auto zoom: the phone's own value, else worked out from the last fix
    if (c.speed != null && !isNaN(c.speed)) loc.speed = c.speed;
    else if (prev && now - loc.last > 300 && now - loc.last < 10000) loc.speed = moved / ((now - loc.last) / 1000);
    if (c.heading != null && !isNaN(c.heading) && (loc.speed || 0) > 0.8) loc.heading = c.heading;
    else if (prev && moved > 6 && c.accuracy < 30) loc.heading = BlokkRouter.bearing(prev, ll);
    loc.pos = ll; loc.shown = ll; loc.acc = c.accuracy || 0; loc.last = now; loc.denied = false;
    flushWaiting(false);
    if (nav.active) updateNav();  // snaps the shown position onto the route
    drawMe();
    if (first && !CITY_BOUNDS.pad(0.3).contains(ll)) { loc.follow = false; toast(t("loc.outside"), 7000); }
    else if (loc.follow) followCamera(first);
    setLocBtn();
  }
  function onLocError(e) {
    if (e.code === 1) {
      stopLocation(); loc.denied = true;
      toast(t("loc.denied"), 9000);
      flushWaiting(true);
    } else if (!loc.pos) {
      toast(t("loc.unavailable"), 6000);
      flushWaiting(true);  // a waiting route request falls back to the Google Maps card
    }
  }
  function drawMe() {
    var pos = loc.shown || loc.pos;
    var heading = nav.active && loc.navBearing != null ? loc.navBearing : loc.heading;
    if (!loc.marker) {
      loc.circle = L.circle(loc.pos, { renderer: routeCanvas, radius: loc.acc, color: "#15387a", weight: 1, opacity: 0.35,
        fillColor: "#15387a", fillOpacity: 0.07, interactive: false }).addTo(map);
      loc.marker = L.marker(pos, {
        icon: L.divIcon({ className: "me", iconSize: [0, 0],
          html: '<div class="me-wrap"><div class="me-cone"></div><div class="me-pulse"></div><div class="me-dot"></div>' +
            '<div class="me-arrow"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 34 35 20 27.5 6 35Z"/></svg></div></div>' }),
        interactive: false, keyboard: false, zIndexOffset: 2000,
      }).addTo(map);
    } else {
      loc.marker.setLatLng(pos);
      loc.circle.setLatLng(loc.pos).setRadius(loc.acc);
    }
    var el = loc.marker.getElement();
    if (!el) return;
    el.classList.remove("stale");
    el.classList.toggle("has-heading", heading != null);
    el.classList.toggle("nav", nav.active);
    if (heading != null) {
      el.querySelector(".me-cone").style.transform = "rotate(" + heading.toFixed(0) + "deg)";
      el.querySelector(".me-arrow").style.transform = "rotate(" + heading.toFixed(1) + "deg)";
    }
  }
  setInterval(function () {  // grey the dot when the phone stops reporting
    if (loc.marker && Date.now() - loc.last > 30000 && loc.marker.getElement()) loc.marker.getElement().classList.add("stale");
  }, 10000);
  // ---------- camera: keeps the dot in view like a navigation app
  // Navigating: the dot sits low in the free part of the screen, opposite the direction of travel, so more
  // road ahead is visible; zoom follows speed. Otherwise: just keep the dot centred.
  var cam = { want: null, votes: 0 };
  function navZoom() {
    var v = loc.speed || 0;                      // m/s
    return v > 14 ? 16 : v > 5 ? 17 : 18;        // > 50 km/h, > 18 km/h, slower
  }
  var MAP_EL = map.getContainer(), RENDERERS = [baseLayer, bldLayer, labelsLayer, routeCanvas];
  function enterRotation() {
    if (rot.on) return;
    // the visible map strip lies between the turn banner and the sheet; the user sits low in it
    var w = window.innerWidth, top = ui.navBottom + 8;
    var bottom = window.innerHeight - ui.sheetH;
    if (bottom - top < 160) { top = 0; bottom = window.innerHeight; }
    var px = w / 2, py = top + 0.72 * (bottom - top);
    // a square around the user, big enough that turning it never uncovers a corner of that strip
    var R = Math.max(Math.hypot(px, py - top), Math.hypot(px, bottom - py)), D = Math.ceil(2 * R + 48);
    rot.on = true; rot.pivot = L.point(px, py); rot.D = D; rot.shown = 0;
    MAP_EL.classList.add("rotated");
    MAP_EL.style.left = (px - D / 2) + "px"; MAP_EL.style.top = (py - D / 2) + "px";
    MAP_EL.style.width = D + "px"; MAP_EL.style.height = D + "px";
    MAP_EL.style.right = MAP_EL.style.bottom = "auto";
    RENDERERS.forEach(function (r) { r.options.padding = r === labelsLayer ? 0.05 : 0.1; });  // keeps the canvases within phone limits
    map.invalidateSize({ pan: false });
  }
  function exitRotation() {
    if (!rot.on) return;
    var pos = loc.shown || loc.pos, z = map.getZoom(), pivot = rot.pivot;
    rot.on = false; rot.shown = 0;
    MAP_EL.classList.remove("rotated");
    ["left", "top", "width", "height", "right", "bottom", "transform", "transition"].forEach(function (k) { MAP_EL.style[k] = ""; });
    MAP_EL.style.removeProperty("--bearing");
    RENDERERS.forEach(function (r) { r.options.padding = r._basePad != null ? r._basePad : 0.5; });
    map.invalidateSize({ pan: false });
    if (pos) map.setView(map.unproject(map.project(pos, z).add(map.getSize().divideBy(2)).subtract(pivot), z), z, { animate: false });
  }
  function setBearing(b, animate) {
    var d = ((b - rot.shown) % 360 + 540) % 360 - 180;  // shortest way round: 359° -> 2° turns 3°
    if (animate && Math.abs(d) < 3) return;
    rot.shown += d;
    MAP_EL.style.transition = animate ? "transform .7s linear" : "none";
    MAP_EL.style.transform = "rotate(" + (-rot.shown).toFixed(1) + "deg)";
    MAP_EL.style.setProperty("--bearing", rot.shown.toFixed(1) + "deg");
  }
  window.addEventListener("resize", function () {
    if (rot.on) { exitRotation(); enterRotation(); followCamera(true); }
  });
  function followCamera(jump) {
    var pos = loc.shown || loc.pos;
    if (!pos) return;
    if (nav.active && loc.follow) {
      enterRotation();
      var zr = map.getZoom(), wantR = navZoom();
      if (wantR === zr) cam.votes = 0;
      else {
        cam.votes = cam.want === wantR ? cam.votes + 1 : 1;
        cam.want = wantR;
        if (cam.votes >= 3 || jump) { zr = wantR; cam.votes = 0; }
      }
      var hr = loc.navBearing != null ? loc.navBearing : loc.heading;
      if (hr != null) setBearing(hr, !jump);
      // the map centre is the user (the turned square is centred on them)
      if (jump || zr !== map.getZoom()) map.setView(pos, zr, { animate: !jump });
      else map.panTo(pos, { animate: true, duration: 0.9, easeLinearity: 1, noMoveStart: true });
      return;
    }
    var size = map.getSize(), z = map.getZoom();
    var top = nav.active ? ui.navBottom + 12 : ui.topBottom + 8;
    var bottom = size.y - ui.sheetH;
    if (bottom - top < 120) { top = 0; bottom = size.y; }
    var at = L.point(size.x / 2, (top + bottom) / 2);
    if (nav.active) {
      var want = navZoom();
      if (want === z) cam.votes = 0;
      else {
        cam.votes = cam.want === want ? cam.votes + 1 : 1;
        cam.want = want;
        if (cam.votes >= 3 || jump) { z = want; cam.votes = 0; }  // three fixes in a row, so a red light doesn't zoom in
      }
      var h = loc.navBearing != null ? loc.navBearing : loc.heading;
      if (h != null) {
        var k = 0.27 * Math.min(size.x, bottom - top), r = h * Math.PI / 180;
        at = at.add(L.point(-Math.sin(r) * k, Math.cos(r) * k));
      }
    } else if (jump) z = Math.max(z, 17);
    var center = map.unproject(map.project(pos, z).add(size.divideBy(2)).subtract(at), z);
    if (jump || z !== map.getZoom()) map.setView(center, z, { animate: true });
    else map.panTo(center, { animate: true, duration: 0.9, easeLinearity: 1, noMoveStart: true });
  }
  // touching the map pauses following; while navigating it comes back by itself after a quiet spell
  var RESUME_MS = 10000, resumeTimer = null, recenterBtn = $("btn-recenter");
  function showRecenter() { recenterBtn.hidden = !(nav.active && !loc.follow && loc.pos); }
  function pauseFollow() {
    if (loc.follow) { loc.follow = false; setLocBtn(); }
    exitRotation();  // looking around happens north-up
    clearTimeout(resumeTimer);
    if (nav.active) resumeTimer = setTimeout(resumeFollow, RESUME_MS);
    showRecenter();
  }
  function resumeFollow() {
    clearTimeout(resumeTimer);
    if (!loc.pos) return;
    loc.follow = true;
    setLocBtn(); showRecenter();
    followCamera(true);
  }
  ["touchstart", "mousedown", "wheel"].forEach(function (ev) {
    map.getContainer().addEventListener(ev, function () { if (nav.active || loc.follow) pauseFollow(); }, { passive: true, capture: true });
  });
  recenterBtn.addEventListener("click", resumeFollow);
  locBtn.addEventListener("click", function () {
    if (loc.watchId === null) { startLocation(true); return; }
    if (!loc.pos) { restartLocation(true); return; }  // still searching: try again
    if (loc.follow && !nav.active) { loc.follow = false; setLocBtn(); return; }
    resumeFollow();
  });
  // no gliding while Leaflet re-positions the dot for a zoom
  map.on("zoomstart", function () { map.getContainer().classList.add("no-glide"); });
  map.on("zoomend", function () { setTimeout(function () { map.getContainer().classList.remove("no-glide"); }, 60); });

  // first visit: explain before the browser asks; a site that already has permission just starts
  // Start right away for anyone who allowed location before. Many phone browsers (Safari on iPhone,
  // Brave) answer "prompt" here even after the user allowed it, so "granted" alone is not enough.
  function initLocation() {
    var intro = readPref(PREF.locIntro);  // "allow", "later", or "1" from older versions (they tapped through)
    var go = function (state) {
      if (state === "denied") return;
      if (state === "granted" || intro === "allow" || intro === "1") startLocation(true);
      else if (!intro) showLocIntro();
    };
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then(function (r) { go(r.state); }, function () { go("prompt"); });
    } else go("prompt");
  }
  function showLocIntro() {
    var done = function (allow) {
      writePref(PREF.locIntro, allow ? "allow" : "later");
      closeSheet();
      if (allow) startLocation(true);
    };
    openSheet({
      kind: "intro",
      html: function () {
        return '<div class="intro"><div class="pin"><svg viewBox="0 0 66 66" aria-hidden="true"><circle cx="33" cy="33" r="31" fill="#15387a"/>' +
          '<circle cx="33" cy="33" r="27" fill="none" stroke="#f4f1e8" stroke-width="2"/><circle cx="33" cy="33" r="16" fill="none" stroke="#f4f1e8" stroke-width="1.6" stroke-dasharray="3 4"/>' +
          '<circle cx="33" cy="33" r="7.5" fill="#ff5f14" stroke="#fff" stroke-width="3"/></svg></div>' +
          "<h2>" + esc(t("loc.title")) + "</h2><p>" + esc(t("loc.text")) + "</p></div>" +
          '<div class="actions"><button class="btn go" data-act="allow">' + ICON.go + esc(t("loc.allow")) + "</button>" +
          '<button class="btn quiet" data-act="later">' + esc(t("loc.later")) + "</button></div>";
      },
      acts: { allow: function () { done(true); }, later: function () { done(false); } },
      closeAct: function () { done(false); },
    });
  }

  // ------------------------------------------------------------------ directions
  // The routing graph is built and searched in a worker (route-worker.js), so neither the one-off build
  // (over a second on a phone) nor a reroute ever freezes the map. Without workers it runs on the page.
  var routerData = null, router = null, worker = null, workerReqs = {}, workerSeq = 0;
  function startRouter(buf, gj) {
    routerData = gj;
    if (!window.Worker) return;
    try {
      worker = new Worker("route-worker.js");
      worker.onmessage = function (e) {
        var m = e.data, q = workerReqs[m.id];
        if (m.type !== "route" || !q) return;
        delete workerReqs[m.id];
        q.cb(m.res);
      };
      worker.onerror = function (e) { console.warn("route worker:", e.message); dropWorker(); };
      worker.postMessage({ type: "data", buf: buf }, [buf]);
    } catch (e) { worker = null; }
  }
  function dropWorker() {  // fall back to routing on the page; requests already sent are asked again here
    if (worker) worker.terminate();
    worker = null;
    var reqs = workerReqs; workerReqs = {};
    Object.keys(reqs).forEach(function (id) { var q = reqs[id]; findRoute(q.from, q.to, q.mode, q.cb); });
  }
  function findRoute(from, to, mode, cb) {
    if (worker) {
      var id = ++workerSeq;
      workerReqs[id] = { from: from, to: to, mode: mode, cb: cb };
      worker.postMessage({ type: "route", id: id, from: from, to: to, mode: mode });
      return;
    }
    if (!routerData) { setTimeout(function () { findRoute(from, to, mode, cb); }, 500); return; }  // roads still loading
    if (!router) router = BlokkRouter.fromGeoJSON(routerData);
    cb(router.route(from, to, mode));
  }
  var MODES = ["car", "bike", "foot"];
  var CAR_FACTOR = 1.25;  // lights, junctions, parking: free-flow road speeds are optimistic in town
  var route = { req: 0, dest: null, res: null, cum: null, mode: MODES.indexOf(readPref(PREF.mode)) >= 0 ? readPref(PREF.mode) : "car",
    casing: null, line: null, pin: null };
  var nav = { active: false, seg: 0, off: 0, lastReroute: 0, left: 0, leftTime: 0 };

  // closing one route card for another (waiting -> route -> navigation) keeps the route;
  // only leaving the route cards altogether clears it
  function keepRouteFor(nextKind) {
    if (nav.active || /^(route|nav)/.test(nextKind || "")) return;
    clearRoute();
  }
  function placeDest(f, ent) {
    var p = f.properties, num = plateNum(p);
    if (!ent) return { at: p.lp, f: f, title: num, street: p.street || "", plate: num };
    var lab = ent.properties.label || "";
    return { at: [ent.geometry.coordinates[1], ent.geometry.coordinates[0]], f: f, title: num + " · " + lab,
      street: p.street || "", plate: lab.replace(/^(Sc|nr)\. /, "") || num };
  }
  function planRoute(dest) {
    route.dest = dest;
    if (loc.pos) { computeRoute(true); return; }
    route.waitStart = Date.now();
    openSheet(waitSpec());
    setTimeout(function () { if (route.dest === dest && sheetSpec && sheetSpec.kind === "route-wait") renderSheet(); }, 12000);
    loc.waiting.push(function (err) {
      if (route.dest !== dest) return;
      if (err) openSheet(noLocSpec()); else computeRoute(true);
    });
    startLocation(false);
  }
  function computeRoute(fit) {
    var id = ++route.req, dest = route.dest, mode = route.mode;
    var slow = setTimeout(function () { if (route.req === id) toast(t("route.loading"), 2500); }, 600);
    findRoute(loc.pos, dest.at, mode, function (res) {
      clearTimeout(slow);
      if (route.req === id && route.dest === dest) routeReady(res, mode, fit);  // else: superseded or closed
    });
  }
  function routeReady(res, mode, fit) {
    if (res && mode === "car") res.duration *= CAR_FACTOR;
    if (nav.active && !res) { endNav(false); toast(t("route.none"), 6000); return; }
    route.res = res;
    route.cum = null;
    if (res) {
      route.cum = [0];
      for (var i = 1; i < res.coords.length; i++) route.cum.push(route.cum[i - 1] + BlokkRouter.dist(res.coords[i - 1], res.coords[i]));
    }
    if (nav.active) { nav.seg = 0; nav.off = 0; updateNav(); return; }  // a reroute: carry on along the new line
    drawRoute();
    if (!res) { openSheet(noRouteSpec()); return; }
    if (sheetSpec && sheetSpec.kind === "route") renderSheet(); else openSheet(routeSpec());
    if (fit) requestAnimationFrame(function () {
      map.fitBounds(L.latLngBounds(res.coords.concat([loc.pos])), {
        paddingTopLeft: [24, 90], paddingBottomRight: [80, sheetEl.offsetHeight + 24], maxZoom: 17,
      });
    });
  }
  function drawRoute(fromSeg, fromPt) {
    var pts = route.res ? route.res.coords : [];
    if (fromSeg != null) pts = [fromPt].concat(pts.slice(fromSeg + 1));
    if (!route.line) {
      route.casing = L.polyline([], { renderer: routeCanvas, color: "#0c2454", weight: 11, opacity: 0.9, lineCap: "round", lineJoin: "round", interactive: false }).addTo(map);
      route.line = L.polyline([], { renderer: routeCanvas, color: "#ff5f14", weight: 6.5, lineCap: "round", lineJoin: "round", interactive: false }).addTo(map);
    }
    route.casing.setLatLngs(pts);
    route.line.setLatLngs(pts);
    if (route.pin && route.pin._dest !== route.dest) { map.removeLayer(route.pin); route.pin = null; }
    if (!route.pin && route.dest) {
      route.pin = L.marker(route.dest.at, {
        icon: L.divIcon({ className: "dest-pin", iconSize: [0, 0], html: '<div class="pin-plate">' + esc(route.dest.plate) + '</div><div class="pin-dot"></div>' }),
        interactive: false, keyboard: false, zIndexOffset: 1500,
      }).addTo(map);
      route.pin._dest = route.dest;
    }
  }
  function clearRoute() {
    [route.casing, route.line, route.pin].forEach(function (l) { if (l) map.removeLayer(l); });
    route.casing = route.line = route.pin = null;
    route.res = route.cum = null;
    route.dest = null;
  }
  function stepVerb(st) {
    if (!st || st.type === "arrive") return t("step.arrive");
    if (st.type === "depart") return t("step.depart");
    if (st.type === "roundabout") return t("step.roundabout", { n: st.exit });
    if (st.type === "continue") return t("step.continue");
    return t("step." + st.modifier.replace(" ", "_"));
  }
  function stepStreet(st) {
    if (!st || st.type === "arrive") return route.dest ? [route.dest.title, route.dest.street].filter(Boolean).join(", ") : "";
    if (st.name) return shortName(st.name);
    return t(ROAD_CLASS[st.cls] === "foot" ? "road.path" : st.cls === "service" ? "road.service" : "road.unnamed");
  }
  function destLine() {
    return '<p class="to-line">' + esc(t("route.to")) + ": <b>" + esc(route.dest.title) + "</b>" + (route.dest.street ? ", " + esc(route.dest.street) : "") + "</p>";
  }
  function modesHtml() {
    return '<div class="modes" role="group">' + MODES.map(function (m) {
      return '<button data-act="mode" data-mode="' + m + '" aria-pressed="' + (m === route.mode) + '">' + MODE_ICON[m] + esc(t("route.mode." + m)) + "</button>";
    }).join("") + "</div>";
  }
  function routeSpec() {
    return {
      kind: "route",
      html: function () {
        var r = route.res, d = fmtDur(r.duration);
        var steps = r.steps.filter(function (s) { return s.type !== "depart"; });
        return modesHtml() +
          '<div class="summary"><span class="big">' + d.n + "<small>" + esc(d.u) + '</small></span><span class="rest"><b>' + esc(fmtDist(r.distance)) +
          "</b> · " + esc(t("route.arrive", { time: fmtClock(r.duration) })) + "</span></div>" + destLine() +
          '<div class="actions"><button class="btn go" data-act="start">' + ICON.go + esc(t("route.start")) + "</button>" +
          '<a class="btn ghost" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener" aria-label="' + esc(t("place.mapsAria")) + '">' + ICON.ext + "Maps</a></div>" +
          '<details class="more"><summary>' + esc(t("route.steps", { n: steps.length })) + '</summary><ol class="steps">' +
          r.steps.map(function (s) {
            return '<li><span class="ico">' + turnSvg(s) + '</span><span><div class="st-verb">' + esc(stepVerb(s)) + '</div><div class="st-street">' +
              esc(stepStreet(s)) + '</div></span><span class="st-dist">' + (s.distance ? esc(fmtDist(s.distance)) : "") + "</span></li>";
          }).join("") + '</ol></details><p class="muted">' + esc(t("route.note")) + "</p>";
      },
      acts: {
        mode: function (el) {
          route.mode = el.getAttribute("data-mode");
          writePref(PREF.mode, route.mode);
          computeRoute(true);
        },
        start: function () { startNav(); },
      },
      onClose: keepRouteFor,
    };
  }
  function waitSpec() {
    return {
      kind: "route-wait",
      html: function () {
        var slow = Date.now() - (route.waitStart || 0) > 11000;
        return modesHtml() + '<div class="summary"><span class="rest"><b>' + esc(t("loc.waiting")) + "</b></span></div>" +
          (slow ? '<p class="muted">' + esc(t("loc.slow")) + "</p>" : "") + destLine() +
          '<div class="actions"><button class="btn go" data-act="retry">' + ICON.go + esc(t("loc.retry")) + "</button>" +
          '<a class="btn ghost" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener" aria-label="' + esc(t("place.mapsAria")) + '">' + ICON.ext + "Maps</a></div>";
      },
      acts: {
        mode: function (el) { route.mode = el.getAttribute("data-mode"); writePref(PREF.mode, route.mode); renderSheet(); },
        retry: function () { route.waitStart = Date.now(); renderSheet(); restartLocation(false); },
      },
      onClose: keepRouteFor,
    };
  }
  function noLocSpec() {
    return {
      kind: "route-noloc",
      html: function () {
        return "<h2>" + esc(t("loc.title")) + "</h2><p>" + esc(t("loc.needed")) + "</p>" + destLine() +
          '<div class="actions"><a class="btn go" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener">' + ICON.ext + "Google Maps</a></div>";
      },
      onClose: keepRouteFor,
    };
  }
  function noRouteSpec() {
    return {
      kind: "route-none",
      html: function () {
        return modesHtml() + "<p><b>" + esc(t("route.none")) + "</b></p>" + destLine() +
          '<div class="actions"><a class="btn go" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener">' + ICON.ext + "Google Maps</a></div>";
      },
      acts: { mode: function (el) { route.mode = el.getAttribute("data-mode"); writePref(PREF.mode, route.mode); openSheet(waitSpec()); computeRoute(true); } },
      onClose: keepRouteFor,
    };
  }

  // ---------- turn-by-turn
  var wakeLock = null;
  function requestWakeLock() {
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (w) { wakeLock = w; }, function () {}); } catch (e) { /* not supported */ }
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* already gone */ } wakeLock = null; }
  document.addEventListener("visibilitychange", function () { if (nav.active && document.visibilityState === "visible") requestWakeLock(); });

  function startNav() {
    if (!route.res || !loc.pos) return;
    nav.active = true; nav.seg = 0; nav.off = 0; nav.lastReroute = Date.now();
    document.body.classList.add("navigating");
    $("navbar").hidden = false;
    resEl.hidden = true;
    openSheet(navSpec());
    updateNav();
    measureUi();
    drawMe();
    resumeFollow();
    requestWakeLock();
  }
  function endNav(arrived) {
    var dest = route.dest;
    nav.active = false;
    clearTimeout(resumeTimer);
    loc.shown = loc.pos; loc.navBearing = null;
    recenterBtn.hidden = true;
    exitRotation();
    if (loc.marker) drawMe();  // back from the triangle to the dot
    document.body.classList.remove("navigating");
    $("navbar").hidden = true;
    measureUi();
    releaseWakeLock();
    closeSheet();
    clearRoute();
    if (arrived && dest) { toast(t("route.arrived"), 5000); openPlace(dest.f); }
  }
  function navSpec() {
    return {
      kind: "nav",
      html: function () {
        var d = fmtDur(nav.leftTime || route.res.duration);
        return '<div class="navstrip"><div class="summary"><span class="big">' + d.n + "<small>" + esc(d.u) + '</small></span><span class="rest"><b>' +
          esc(fmtDist(nav.left || route.res.distance)) + "</b> · " + esc(t("route.arrive", { time: fmtClock(nav.leftTime || route.res.duration) })) +
          '</span></div><button class="btn ghost" data-act="end">' + esc(t("route.end")) + "</button></div>" + destLine();
      },
      acts: { end: function () { endNav(false); } },
      closeAct: function () { endNav(false); },
      noClose: true,
    };
  }
  function setHtml(id, h) { var el = $(id); if (el._h !== h) { el.innerHTML = h; el._h = h; } }
  // where on the route are we: nearest point on the polyline, searched from the last known segment on
  function project(pos) {
    var c = route.res.coords, best = null, KXr = 111320 * Math.cos(pos[0] * Math.PI / 180), KYr = 110540;
    var px = pos[1] * KXr, py = pos[0] * KYr;
    for (var i = Math.max(0, nav.seg - 3); i < c.length - 1; i++) {
      var ax = c[i][1] * KXr, ay = c[i][0] * KYr, bx = c[i + 1][1] * KXr, by = c[i + 1][0] * KYr;
      var vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      var tt = L2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
      var d = Math.hypot(px - ax - tt * vx, py - ay - tt * vy);
      if (!best || d < best.d) best = { seg: i, t: tt, d: d, at: [c[i][0] + (c[i + 1][0] - c[i][0]) * tt, c[i][1] + (c[i + 1][1] - c[i][1]) * tt] };
      if (best.d < 5 && i > best.seg + 40) break;  // found it; don't scan the whole route every second
    }
    best.along = route.cum[best.seg] + (route.cum[best.seg + 1] - route.cum[best.seg]) * best.t;
    return best;
  }
  function updateNav() {
    if (!nav.active || !route.res || !loc.pos) return;
    var pr = project(loc.pos), now = Date.now();
    if (pr.d > Math.max(35, Math.min(loc.acc, 60))) {
      if (++nav.off >= 2 && now - nav.lastReroute > 6000) {
        nav.off = 0; nav.lastReroute = now;
        toast(t("route.recalc"), 2500);
        computeRoute(false);  // the new route takes over when it arrives; until then we stay on this one
      }
    } else nav.off = 0;
    nav.seg = pr.seg;
    // on the route: show the dot on the line, pointing along it (as navigation apps do)
    var cc = route.res.coords, onRoute = pr.d < 25;
    loc.shown = onRoute ? pr.at : loc.pos;
    loc.navBearing = onRoute ? BlokkRouter.bearing(cc[pr.seg], cc[Math.min(pr.seg + 1, cc.length - 1)]) : null;
    var total = route.res.distance, left = Math.max(0, total - pr.along);
    if (left < 20 || BlokkRouter.dist(loc.pos, route.dest.at) < 20) { endNav(true); return; }
    var steps = route.res.steps, next = null, after = null;
    for (var k = 0; k < steps.length; k++) {
      if (steps[k].type !== "depart" && steps[k].idx > pr.seg) { next = steps[k]; after = steps[k + 1] || null; break; }
    }
    var toNext = next ? route.cum[next.idx] - pr.along : left;
    setHtml("nav-arrow", turnSvg(next));
    setHtml("nav-dist", esc(fmtDist(Math.max(0, toNext))));
    setHtml("nav-verb", esc(stepVerb(next)));
    setHtml("nav-street", esc(stepStreet(next)));
    var thenEl = $("nav-then"), then = next && after && next.type !== "arrive" && route.cum[after.idx] - route.cum[next.idx] < 150;
    if (then) setHtml("nav-then", esc(t("route.then")) + " " + turnSvg(after) + " " + esc(stepVerb(after)));
    if (thenEl.hidden !== !then) { thenEl.hidden = !then; measureUi(); }
    nav.left = left;
    nav.leftTime = route.res.duration * left / total;
    if (sheetSpec && sheetSpec.kind === "nav") renderSheet();
    drawRoute(pr.seg, pr.at);
  }

  // ------------------------------------------------------------------ settings
  function offlineState() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return "no";
    return navigator.serviceWorker.controller ? "ok" : "pending";
  }
  function settingsSpec() {
    return {
      kind: "settings",
      html: function () {
        var off = offlineState();
        var langs = Object.keys(LANGS).map(function (code) {
          return '<option value="' + code + '"' + (code === lang ? " selected" : "") + ">" + esc(LANGS[code]["lang.name"] || code) + "</option>";
        }).join("");
        var sw = function (style, key) { return '<div class="sw" style="' + style + '"></div><div>' + esc(t(key)) + "</div>"; };
        var h = "<h2>" + esc(t("settings.title")) + "</h2>" +
          '<div class="set-row"><label for="set-lang">' + esc(t("settings.language")) + '</label><select id="set-lang" data-change="lang">' + langs + "</select></div>" +
          (CONFIG.tomtomKey ? '<div class="set-row"><label for="set-tr">' + esc(t("traffic.title")) + '<span class="muted">' + esc(t("traffic.note")) + "</span></label>" +
            '<span class="switch"><input type="checkbox" id="set-tr" data-change="traffic"' + (trafficOn() ? " checked" : "") + "><span></span></span></div>" : "") +
          '<div class="set-row"><label for="set-bm">' + esc(t("settings.basemap")) + '<span class="muted">' + esc(t("settings.basemapNote")) + "</span></label>" +
          '<span class="switch"><input type="checkbox" id="set-bm" data-change="basemap"' + (map.hasLayer(tiles) ? " checked" : "") + "><span></span></span></div>" +
          '<div class="set-row"><span><b>' + esc(t("settings.offline")) + '</b></span><span class="status' + (off === "ok" ? " ok" : "") + '">' +
          esc(t("settings.offline." + off)) + "</span></div>" +
          '<details class="more"><summary>' + esc(t("settings.legend")) + '</summary><div class="legend">' +
          sw("background:#3b82f6;opacity:.6;border:1px solid #1d4ed8", "legend.apartments") +
          sw("background:#9ca3af;opacity:.6;border:1px solid #6b7280", "legend.other") +
          sw("background:#ff5f14;border-radius:9px", "legend.stair") +
          sw("background:#fff;border:1.5px solid #ff5f14;border-radius:9px", "legend.entranceNum") +
          sw("background:#a78bfa;border-radius:9px", "legend.override") +
          sw("background:#fff3bf;border:2px solid #c9a227", "legend.mainRoad") +
          sw("background:#fff;border:2px solid #c3bcae", "legend.street") +
          sw("background:#a9cdee", "legend.water") +
          sw("background:#d6ebc8", "legend.park") +
          (CONFIG.tomtomKey ? sw("background:#f8a33a", "legend.trafficSlow") + sw("background:#e3262b", "legend.trafficJam") +
            sw("background:#8b1a1e", "legend.trafficStop") : "") + "</div></details>";
        if (stats) {
          var pct = function (a, b) { return b ? Math.round(100 * a / b) + "%" : "–"; };
          var tr = function (key, val) { return "<tr><td>" + esc(t(key)) + '</td><td class="n">' + val + "</td></tr>"; };
          h += '<details class="more"><summary>' + esc(t("cov.title")) + "</summary><table>" +
            tr("cov.blocks", stats.apartments) +
            tr("cov.withNumber", stats.apartments_labelled + " (" + pct(stats.apartments_labelled, stats.apartments) + ")") +
            tr("cov.withStairs", stats.apartments_with_stairs + " (" + pct(stats.apartments_with_stairs, stats.apartments) + ")") +
            tr("cov.entrances", stats.entrances + " / " + stats.entrances_labelled) +
            (stats.entrances_numbered != null ? tr("cov.entrancesNum", stats.entrances_numbered + " (" + pct(stats.entrances_numbered, stats.entrances) + ")") : "") +
            tr("cov.overrides", overrideCount) + "</table>";
          if (stats.neighbourhoods && stats.neighbourhoods.length) {
            h += "<h3>" + esc(t("nb.title")) + "</h3><table><tr><th>" + esc(t("nb.name")) + '</th><th class="n">' + esc(t("nb.blocks")) +
              '</th><th class="n">' + esc(t("nb.numbered")) + '</th><th class="n">' + esc(t("nb.stairs")) + "</th></tr>" +
              stats.neighbourhoods.map(function (n) {
                return "<tr><td>" + esc(n.name) + '</td><td class="n">' + n.blocks + '</td><td class="n">' + pct(n.labelled, n.blocks) +
                  '</td><td class="n">' + pct(n.with_stairs, n.blocks) + "</td></tr>";
              }).join("") + "</table>";
          }
          h += "</details>";
        }
        return h + '<p class="muted">' + esc(t("info.footer", { ts: (stats && (stats.osm_timestamp || stats.generated)) || "–" })) + "</p>";
      },
      acts: {
        lang: function (el) { setLanguage(el.value); },
        basemap: function (el) { setBasemap(el.checked, true); },
        traffic: function (el) { setTraffic(el.checked, true); },
      },
    };
  }
  $("btn-settings").addEventListener("click", function () {
    if (sheetSpec && sheetSpec.kind === "settings") closeSheet(); else openSheet(settingsSpec());
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener && navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (sheetSpec && sheetSpec.kind === "settings") renderSheet();
    });
  }

  // ------------------------------------------------------------------ service worker
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("SW registration failed", e); });
    });
  }

  appReady = true;  // every variable above is set: the canvases may draw now
  [baseLayer, bldLayer, labelsLayer].forEach(function (l) { l.redraw(); });

  setBasemap(readPref(PREF.basemap) !== "0", false);  // on by default; switched off only when the user did
  setTraffic(readPref(PREF.traffic) !== "0", false);  // on by default when a key is configured
  initLocation();

  window.__blokk = { map: map, trafficOn: trafficOn, route: function () { return route; }, nav: function () { return nav; }, loc: function () { return loc; }, streetStats: function () { return streetStats; }, renderLabels: renderLabels, poiHits: function () { return poiHits; }, blocks: function () { return blocks; }, entrances: function () { return entrances; }, search: search };
})();
