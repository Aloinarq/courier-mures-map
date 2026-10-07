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
  var canvas = L.canvas({ padding: 0.4, tolerance: 6 });
  // our own street map sits between the (optional) tiles and the buildings
  map.createPane("context").style.zIndex = 320;
  map.createPane("roads").style.zIndex = 350;
  map.createPane("streetLabels").style.zIndex = 590;  // under block labels (markerPane 600)
  map.getPane("streetLabels").style.pointerEvents = "none";
  var ctxCanvas = L.canvas({ pane: "context", padding: 0.4 });
  var roadCanvas = L.canvas({ pane: "roads", padding: 0.4 });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  map.attributionControl.addAttribution(OSM_ATTRIB);

  map.createPane("route").style.zIndex = 450;   // above the buildings, under all labels
  map.getPane("route").style.pointerEvents = "none";
  var routeCanvas = L.canvas({ pane: "route", padding: 0.5 });

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

  var blocksLayer, addrLayer, extraLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup().addTo(map);
  var stairLayer = L.layerGroup().addTo(map);
  var streetLabelLayer = L.layerGroup().addTo(map);
  var roadGroups = [], roadsByName = {}, roadChains = [], streetHl = null, streetIndex = [], streetStats = null;
  var blocks = [], byId = {}, entrances = [], searchIndex = [], stats = null, overrideCount = 0;

  var STYLE = {
    apartments: { renderer: canvas, color: "#1d4ed8", weight: 1.2, fillColor: "#3b82f6", fillOpacity: 0.38 },
    other: { renderer: canvas, color: "#6b7280", weight: 1, fillColor: "#9ca3af", fillOpacity: 0.35 },
    apartmentsOvr: { renderer: canvas, color: "#6d28d9", weight: 1.6, fillColor: "#3b82f6", fillOpacity: 0.38 },
  };
  var HL = { color: "#f97316", weight: 4, fillOpacity: 0.5 };

  // ------------------------------------------------------------------ data
  Promise.all([
    fetchJSON("data/blocks.geojson"),
    fetchJSON("data/entrances.geojson"),
    fetchText("data/overrides.csv").catch(function (e) { console.warn("overrides.csv:", e.message); return ""; }),
    fetchJSON("data/stats.json").catch(function () { return null; }),
  ]).then(function (res) {
    stats = res[3];
    build(res[0], res[1], parseCSV(res[2]));
  }).catch(function (e) {
    console.error(e);
    toast(t("toast.dataFail", { msg: e.message }), 15000);
  });

  Promise.all([
    fetchJSON("data/context.geojson").catch(function (e) { console.warn(e.message); return null; }),
    fetchJSON("data/roads.geojson"),
  ]).then(function (res) {
    buildStreetMap(res[0], res[1]);
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
  function buildStreetMap(cgj, rgj) {
    if (cgj) {
      L.geoJSON(cgj, {
        renderer: ctxCanvas, interactive: false,
        style: function (f) {
          var k = f.properties.k;
          if (k === "water") return { renderer: ctxCanvas, stroke: false, fillColor: "#a9cdee", fillOpacity: 1 };
          if (k === "park") return { renderer: ctxCanvas, stroke: false, fillColor: "#d6ebc8", fillOpacity: 1 };
          if (k === "river") return { renderer: ctxCanvas, color: "#8bbbe6", weight: 6, opacity: 1 };
          return { renderer: ctxCanvas, color: "#4b5563", weight: 1.6, dashArray: "7 5", opacity: 0.85 };
        },
      }).addTo(map);
    }
    var byCls = {};
    rgj.features.forEach(function (f) {
      var cls = ROAD_CLASS[f.properties.h] || "minor";
      (byCls[cls] = byCls[cls] || []).push(f);
      var c = f.geometry.coordinates, s = 90, w = 180, n = -90, e = -180;
      for (var i = 0; i < c.length; i++) {
        if (c[i][1] < s) s = c[i][1]; if (c[i][1] > n) n = c[i][1];
        if (c[i][0] < w) w = c[i][0]; if (c[i][0] > e) e = c[i][0];
      }
      f._bb = [s, w, n, e];
      f._cls = cls;
      var nm = f.properties.n;
      if (nm) (roadsByName[nm] = roadsByName[nm] || []).push(f);
    });
    buildChains();
    // draw order: minor/foot under, then casings of all wide roads, then their fills
    ["foot", "minor"].forEach(function (cls) {
      if (!byCls[cls]) return;
      roadGroups.push({ cls: cls, part: "fill", layer: L.geoJSON(byCls[cls], { renderer: roadCanvas, interactive: false }) });
    });
    ["ped", "mid", "major"].forEach(function (cls) {
      if (byCls[cls]) roadGroups.push({ cls: cls, part: "casing", layer: L.geoJSON(byCls[cls], { renderer: roadCanvas, interactive: false }) });
    });
    ["ped", "mid", "major"].forEach(function (cls) {
      if (byCls[cls]) roadGroups.push({ cls: cls, part: "fill", layer: L.geoJSON(byCls[cls], { renderer: roadCanvas, interactive: false }) });
    });
    styleRoads();
    map.on("zoomend", styleRoads);
    addStreetsToSearch();
    renderLabels();
    routerData = rgj;  // the routing graph is built from the same roads, off the critical path
    setTimeout(getRouter, 1200);
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
          var bb = [90, 180, -90, -180];
          cur.forEach(function (c) {
            bb[0] = Math.min(bb[0], c[1]); bb[1] = Math.min(bb[1], c[0]); bb[2] = Math.max(bb[2], c[1]); bb[3] = Math.max(bb[3], c[0]);
          });
          roadChains.push({ name: name, major: major, coords: cur, bb: bb });
        }
      });
    });
  }
  var styledZoom = null;
  function styleRoads() {
    var z = map.getZoom();
    if (z === styledZoom) return;
    styledZoom = z;
    roadGroups.forEach(function (g) {
      var st = ROAD_STYLE[g.cls], on = z >= st.minZ;
      if (!on) { if (map.hasLayer(g.layer)) map.removeLayer(g.layer); return; }
      var w = widthAt(st.w, z);
      if (g.part === "casing") g.layer.setStyle({ color: st.casing, weight: w + (z >= 15 ? 2.5 : 1.5), opacity: 1, lineCap: "round", lineJoin: "round" });
      else g.layer.setStyle({ color: st.fill, weight: w, opacity: 1, dashArray: st.dash || null, lineCap: st.dash ? "butt" : "round", lineJoin: "round" });
      if (!map.hasLayer(g.layer)) g.layer.addTo(map);
    });
  }

  // ---------- street name labels
  var measureCtx = document.createElement("canvas").getContext("2d");
  var STREET_FONT = '500 12px "Google Sans", Roboto, system-ui, sans-serif';
  function textW(s) { measureCtx.font = STREET_FONT; return measureCtx.measureText(s).width; }
  function textD(s, px) { measureCtx.font = "700 " + px + 'px "Google Sans", Roboto, system-ui, sans-serif'; return measureCtx.measureText(s).width; }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (blocks.length) renderLabels(); });
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
  function renderStreetLabels(boxes) {
    streetLabelLayer.clearLayers();
    var z = map.getZoom();
    if (z < 15 || !roadGroups.length) return;
    var vb = map.getBounds(), size = map.getSize();
    var byName = {};
    roadChains.forEach(function (ch) {
      if (z < 16 && !ch.major) return;
      var bb = ch.bb;
      if (bb[2] < vb.getSouth() || bb[0] > vb.getNorth() || bb[3] < vb.getWest() || bb[1] > vb.getEast()) return;
      // on-screen polyline in pixels, split where it leaves the viewport (minus search bar / edges)
      var c = ch.coords, pts = [], list = byName[ch.name] = byName[ch.name] || [];
      var flush = function () {
        var len = 0;
        for (var k = 1; k < pts.length; k++) len += pts[k].distanceTo(pts[k - 1]);
        if (len > 0) list.push({ pts: pts, len: len, major: ch.major });
        pts = [];
      };
      for (var i = 0; i < c.length; i++) {
        var p = map.latLngToContainerPoint([c[i][1], c[i][0]]);
        if (p.x > 20 && p.y > 90 && p.x < size.x - 20 && p.y < size.y - 30) pts.push(p);
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
    taken.push([size.x - 84, size.y - 330, size.x, size.y], [0, size.y - 110, 210, size.y]);
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
      var a = spot.at.angle, p = spot.at.p;
      var deg = a * 180 / Math.PI;
      streetLabelLayer.addLayer(L.marker(map.containerPointToLatLng(p), {
        pane: "streetLabels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "slbl" + (cd.major ? " major" : ""), iconSize: [0, 0],
          html: '<span style="transform:translate(-50%,-50%) rotate(' + deg.toFixed(1) + 'deg)">' + esc(label) + "</span>" }),
      }));
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
      renderer: roadCanvas, interactive: false, style: { color: "#f97316", weight: 7, opacity: 0.55, lineCap: "round" },
    }).addTo(map);
    map.fitBounds(f._bounds, { maxZoom: 17, padding: [50, 50] });
    setTimeout(function () { if (streetHl) { map.removeLayer(streetHl); streetHl = null; } }, 6000);
  }

  function build(bgj, egj, overrides) {
    bgj.features.forEach(function (f) {
      var p = f.properties;
      p._ents = [];
      if (f.geometry.type !== "Point") {
        var b = L.geoJSON(f).getBounds();
        p._bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      }
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

    var polyFeats = blocks.filter(function (f) { return f.geometry.type !== "Point"; });
    // draw other buildings first so blue blocks are on top
    polyFeats.sort(function (a, b) { return (a.properties.kind === "apartments") - (b.properties.kind === "apartments"); });
    blocksLayer = L.geoJSON({ type: "FeatureCollection", features: polyFeats }, {
      bubblingMouseEvents: false,
      style: function (f) {
        var p = f.properties;
        if (p.kind === "apartments") return p.override ? STYLE.apartmentsOvr : STYLE.apartments;
        return STYLE.other;
      },
      onEachFeature: function (f, layer) { f._layer = layer; layer.on("click", function (ev) { openPlace(f); }); },
    }).addTo(map);

    addrLayer = L.layerGroup();
    blocks.forEach(function (f) {
      if (f.geometry.type !== "Point") return;
      var c = f.geometry.coordinates;
      var ovr = f.properties.kind === "override";
      var m = L.circleMarker([c[1], c[0]], {
        bubblingMouseEvents: false,
        renderer: canvas, radius: ovr ? 6 : 4, weight: 1.5,
        color: ovr ? "#6d28d9" : "#4b5563", fillColor: ovr ? "#a78bfa" : "#d1d5db", fillOpacity: 0.9,
      });
      f._layer = m;
      m.on("click", function () { openPlace(f); });
      addrLayer.addLayer(m);
    });
    updateAddrVisibility();

    buildSearchIndex();
    map.on("moveend zoomend", renderLabels);
    map.on("zoomend", updateAddrVisibility);
    renderLabels();
    console.log("[blokkterkep] loaded", {
      buildings: polyFeats.length, points: blocks.length - polyFeats.length,
      entrances: entrances.length, overrides: overrideCount,
    });
    if (overrideCount) toast(t("toast.overrides", { n: overrideCount }));
  }

  function updateAddrVisibility() {
    if (!addrLayer) return;
    if (map.getZoom() >= 15) { if (!map.hasLayer(addrLayer)) addrLayer.addTo(map); }
    else if (map.hasLayer(addrLayer)) map.removeLayer(addrLayer);
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
  // priority: block labels + staircase pills > street names > other buildings / address points
  function renderLabels() {
    var boxes = [];
    var addrLabels = renderBlockLabels(boxes) || [];
    renderStreetLabels(boxes);
    addrLabels.forEach(function (a) { if (!overlaps(a.box, boxes)) labelLayer.addLayer(a.marker); });
  }
  function renderBlockLabels(boxes) {
    labelLayer.clearLayers(); stairLayer.clearLayers();
    var z = map.getZoom(), addrLabels = [];
    if (z < LABEL_MIN_ZOOM) return addrLabels;
    var b = map.getBounds().pad(0.15), c = map.getCenter(), count = 0;
    var vis = [];
    blocks.forEach(function (f) {
      var p = f.properties;
      if (!p.label || !p.lp || p.kind === "address" && z < 17) return;
      if (b.contains(p.lp)) vis.push(f);
    });
    if (vis.length > MAX_BLOCK_LABELS) { // keep those closest to the centre, apartments first
      vis.sort(function (a, b2) {
        var ka = (a.properties.kind === "apartments" ? 0 : 1e9) + c.distanceTo(a.properties.lp);
        var kb = (b2.properties.kind === "apartments" ? 0 : 1e9) + c.distanceTo(b2.properties.lp);
        return ka - kb;
      });
      vis.length = MAX_BLOCK_LABELS;
    }
    vis.forEach(function (f) {
      var p = f.properties;
      var cls = "lbl" + (p.kind === "apartments" ? "" : " other") + (z >= 18 ? " z18" : "") + (p.override ? " ovr" : "");
      var cp = map.latLngToContainerPoint(p.lp), hw = textD(p.label, z >= 18 ? 15 : 13) / 2 + 3;
      var box = [cp.x - hw, cp.y - 9, cp.x + hw, cp.y + 9];
      var mk = L.marker(p.lp, {
        icon: L.divIcon({ className: cls, html: "<span>" + esc(p.label) + "</span>", iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      });
      // only apartment blocks (and own overrides) outrank street names; plain houses and address points yield
      if (p.kind === "address" || (p.kind === "other" && !p.override)) { addrLabels.push({ box: box, marker: mk }); count++; return; }
      boxes.push(box);
      labelLayer.addLayer(mk);
      count++;
    });
    if (z < STAIR_MIN_ZOOM) return addrLabels;
    var sv = [];
    entrances.forEach(function (e) {
      var g = e.geometry.coordinates;
      // street-number pills ("nr. 13A") only from z18; at z17 they would bury the block labels
      if (z < NUM_MIN_ZOOM && /^nr\. /.test(e.properties.label || "")) return;
      if (b.contains([g[1], g[0]])) sv.push(e);
    });
    if (sv.length > MAX_STAIR_LABELS) {
      sv.sort(function (a, b2) {
        return (a.properties.label ? 0 : 1e9) + c.distanceTo([a.geometry.coordinates[1], a.geometry.coordinates[0]]) -
          ((b2.properties.label ? 0 : 1e9) + c.distanceTo([b2.geometry.coordinates[1], b2.geometry.coordinates[0]]));
      });
      sv.length = MAX_STAIR_LABELS;
    }
    sv.forEach(function (e) {
      var g = e.geometry.coordinates, l = e.properties.label;
      var sp = map.latLngToContainerPoint([g[1], g[0]]), sw = l ? textD(l.replace(/^(Sc|nr)\. /, ""), 11.5) / 2 + 8 : 6;
      boxes.push([sp.x - sw, sp.y - 9, sp.x + sw, sp.y + 9]);
      stairLayer.addLayer(L.marker([g[1], g[0]], {
        icon: L.divIcon({ className: "stair" + (l ? "" : " nolabel") + (l && l.indexOf("nr. ") === 0 ? " num" : "") + (e.properties.override ? " ovr" : ""),
          html: "<span>" + esc(l ? l.replace(/^(Sc|nr)\. /, "") : "") + "</span>", iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }));
    });
    return addrLabels;
  }

  // ------------------------------------------------------------------ place card
  var hlLayer = null;
  function highlight(f) {
    clearHighlight();
    if (f._layer && f._layer.setStyle && f.geometry.type !== "Point") {
      f._layer._origStyle = blocksLayer.options.style(f);
      f._layer.setStyle(HL); f._layer.bringToFront && f._layer.bringToFront();
      hlLayer = f._layer;
    }
  }
  function clearHighlight() {
    if (hlLayer && hlLayer._origStyle) hlLayer.setStyle(hlLayer._origStyle);
    hlLayer = null;
  }
  // what is painted on the plate: block number, else the house number, else whatever label we have
  function plateNum(p) {
    if (p.override) return p.label || "?";
    if (p.block) return "Bl. " + p.block;
    return p.housenumber || p.label || "?";
  }
  function openPlace(f) {
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
  function buildSearchIndex() {
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
    searchIndex.concat(streetIndex).forEach(function (it) {
      var score = 0;
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
          else return;
        } else if (it.hay.indexOf(tok) >= 0 || (tok.length >= 5 && it.hay.indexOf(tok.slice(0, -1)) >= 0)) {
          score += 10 + (new RegExp("(^|\\s)" + tok.replace(/[^a-z0-9]/g, "")).test(it.hay) ? 5 : 0);
        } else return;
      }
      if (it.street) score += 8;  // a bare street name should land on the street itself
      if (it.f.properties.kind === "apartments") score += 3;
      out.push({ it: it, s: score });
    });
    out.sort(function (a, b) {
      return b.s - a.s || String(a.it.f.properties.street || a.it.f.properties.label || "").localeCompare(String(b.it.f.properties.street || ""), "ro") ||
        String(a.it.f.properties.label).localeCompare(String(b.it.f.properties.label), "ro", { numeric: true });
    });
    return out.slice(0, 40).map(function (o) { return o.it.f; });
  }
  var qEl = $("q"), resEl = $("results"), clearEl = $("qclear"), sTimer;
  function showResults() {
    var v = qEl.value;
    clearEl.hidden = !v;
    if (!v.trim()) { resEl.hidden = true; resEl.innerHTML = ""; return; }
    var r = search(v);
    if (!r.length) {
      resEl.innerHTML = '<li class="r-empty">' + esc(t("search.none")) + "</li>";
    } else {
      resEl.innerHTML = r.map(function (f, i) {
        var p = f.properties;
        if (p.kind === "street") {
          return '<li data-i="' + i + '" tabindex="0"><span class="r-num street">' + esc(t("chip.street")) + '</span><span class="r-main">' +
            esc(p.label) + '</span><span class="r-sub">' + esc(t("search.streetSub")) + "</span></li>";
        }
        var kind = p.kind === "apartments" ? t("chip.block") : p.kind === "override" ? t("chip.own") : t(p.kind === "address" ? "chip.address" : "chip.building");
        var sub = [kind, p.entrances.length ? p.entrances.join(", ") : "", p.name || ""].filter(Boolean).join(" · ");
        return '<li data-i="' + i + '" tabindex="0"><span class="r-num' + (p.kind === "apartments" || p.kind === "override" ? "" : " other") + '">' +
          esc(p.housenumber || p.block || p.label ? plateNum(p) : t("search.noNumber")) + '</span><span class="r-main">' + esc(p.street || p.name || p.label || "") +
          '</span><span class="r-sub">' + esc(sub) + "</span></li>";
      }).join("");
      resEl._r = r;
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
    var li = e.target.closest("li[data-i]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); goTo(resEl._r[+li.getAttribute("data-i")]); }
  });
  resEl.addEventListener("click", function (e) {
    var li = e.target.closest("li[data-i]");
    if (li) goTo(resEl._r[+li.getAttribute("data-i")]);
  });
  map.on("click", function () {
    resEl.hidden = true; qEl.blur();
    if (sheetSpec && (sheetSpec.kind === "place" || sheetSpec.kind === "settings" || sheetSpec.kind === "intro")) closeSheet();
  });
  function goTo(f) {
    resEl.hidden = true; qEl.blur();
    var p = f.properties, ll;
    if (p.kind === "street") { showStreet(f); return; }
    if (f.geometry.type === "Point") {
      ll = L.latLng(p.lp); map.setView(ll, 18);
    } else {
      var b = f._layer.getBounds(); ll = L.latLng(p.lp);
      map.fitBounds(b, { maxZoom: 18, padding: [60, 60] });
      if (map.getZoom() < 17) map.setZoom(17);
    }
    setTimeout(function () { openPlace(f); }, 350);
  }

  // ------------------------------------------------------------------ bottom sheet
  // one sheet at a time: {kind, html(), acts{}, after(el), onClose(), closeAct(), compact}
  var sheetEl = $("sheet"), sheetBody = $("sheet-body"), sheetSpec = null;
  function openSheet(spec) {
    if (sheetSpec && sheetSpec.kind !== spec.kind && sheetSpec.onClose) sheetSpec.onClose();
    sheetSpec = spec;
    sheetEl.classList.toggle("no-close", !!spec.noClose);
    renderSheet();
    sheetEl.hidden = false;
    document.body.classList.add("sheet-open");
    sheetEl.scrollTop = 0;
  }
  function renderSheet() {
    if (!sheetSpec) return;
    sheetBody.innerHTML = sheetSpec.html();
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
      document.documentElement.style.setProperty("--sheet-h", sheetEl.hidden ? "0px" : sheetEl.offsetHeight + "px");
    });
  }
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
    setLocBtn();
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
          html: '<div class="me-wrap"><div class="me-cone"></div><div class="me-pulse"></div><div class="me-dot"></div></div>' }),
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
    if (heading != null) el.querySelector(".me-cone").style.transform = "rotate(" + heading.toFixed(0) + "deg)";
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
  function followCamera(jump) {
    var pos = loc.shown || loc.pos;
    if (!pos) return;
    var size = map.getSize(), z = map.getZoom();
    var top = nav.active ? $("navbar").getBoundingClientRect().bottom + 12 : $("topbar").getBoundingClientRect().bottom + 8;
    var bottom = size.y - (sheetEl.hidden ? 0 : sheetEl.offsetHeight);
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
    map.getContainer().addEventListener(ev, function () { if (nav.active || loc.follow) pauseFollow(); }, { passive: true });
  });
  recenterBtn.addEventListener("click", resumeFollow);
  locBtn.addEventListener("click", function () {
    if (loc.watchId === null) { startLocation(true); return; }
    if (!loc.pos) return;
    if (loc.follow && !nav.active) { loc.follow = false; setLocBtn(); return; }
    resumeFollow();
  });
  // no gliding while Leaflet re-positions the dot for a zoom
  map.on("zoomstart", function () { map.getContainer().classList.add("no-glide"); });
  map.on("zoomend", function () { setTimeout(function () { map.getContainer().classList.remove("no-glide"); }, 60); });

  // first visit: explain before the browser asks; a site that already has permission just starts
  function initLocation() {
    var go = function (state) {
      if (state === "granted") startLocation(true);
      else if (state !== "denied" && !readPref(PREF.locIntro)) showLocIntro();
    };
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then(function (r) { go(r.state); }, function () { go("prompt"); });
    } else go("prompt");
  }
  function showLocIntro() {
    var done = function (allow) {
      writePref(PREF.locIntro, "1");
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
  var routerData = null, router = null;
  function getRouter() {
    if (!router && routerData && window.BlokkRouter) router = BlokkRouter.fromGeoJSON(routerData);
    return router;
  }
  var MODES = ["car", "bike", "foot"];
  var CAR_FACTOR = 1.25;  // lights, junctions, parking: free-flow road speeds are optimistic in town
  var route = { dest: null, res: null, cum: null, mode: MODES.indexOf(readPref(PREF.mode)) >= 0 ? readPref(PREF.mode) : "car",
    casing: null, line: null, pin: null };
  var nav = { active: false, seg: 0, off: 0, lastReroute: 0, left: 0, leftTime: 0 };

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
    openSheet(waitSpec());
    loc.waiting.push(function (err) {
      if (route.dest !== dest) return;
      if (err) openSheet(noLocSpec()); else computeRoute(true);
    });
    startLocation(false);
  }
  function computeRoute(fit) {
    var r = getRouter();
    if (!r) { toast(t("route.loading"), 2000); setTimeout(function () { computeRoute(fit); }, 700); return; }
    var res = r.route(loc.pos, route.dest.at, route.mode);
    if (res && route.mode === "car") res.duration *= CAR_FACTOR;
    route.res = res;
    route.cum = null;
    if (res) {
      route.cum = [0];
      for (var i = 1; i < res.coords.length; i++) route.cum.push(route.cum[i - 1] + BlokkRouter.dist(res.coords[i - 1], res.coords[i]));
    }
    drawRoute();
    if (nav.active) return;
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
    if (route.pin) map.removeLayer(route.pin);
    route.pin = route.dest ? L.marker(route.dest.at, {
      icon: L.divIcon({ className: "dest-pin", iconSize: [0, 0], html: '<div class="pin-plate">' + esc(route.dest.plate) + '</div><div class="pin-dot"></div>' }),
      interactive: false, keyboard: false, zIndexOffset: 1500,
    }).addTo(map) : null;
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
      onClose: function () { if (!nav.active) clearRoute(); },
    };
  }
  function waitSpec() {
    return {
      kind: "route-wait",
      html: function () {
        return modesHtml() + '<div class="summary"><span class="rest"><b>' + esc(t("loc.waiting")) + "</b></span></div>" + destLine() +
          '<div class="actions"><button class="btn go" disabled>' + ICON.go + esc(t("route.start")) + "</button>" +
          '<a class="btn ghost" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener" aria-label="' + esc(t("place.mapsAria")) + '">' + ICON.ext + "Maps</a></div>";
      },
      acts: { mode: function (el) { route.mode = el.getAttribute("data-mode"); writePref(PREF.mode, route.mode); renderSheet(); } },
      onClose: function () { if (!nav.active) clearRoute(); },
    };
  }
  function noLocSpec() {
    return {
      kind: "route-noloc",
      html: function () {
        return "<h2>" + esc(t("loc.title")) + "</h2><p>" + esc(t("loc.needed")) + "</p>" + destLine() +
          '<div class="actions"><a class="btn go" href="' + gmapsUrl(route.dest.at) + '" target="_blank" rel="noopener">' + ICON.ext + "Google Maps</a></div>";
      },
      onClose: clearRoute,
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
      onClose: function () { if (!nav.active) clearRoute(); },
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
    document.body.classList.remove("navigating");
    $("navbar").hidden = true;
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
        nav.off = 0; nav.lastReroute = now; nav.seg = 0;
        toast(t("route.recalc"), 2500);
        computeRoute(false);
        if (!route.res) { endNav(false); toast(t("route.none"), 6000); return; }
        pr = project(loc.pos);
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
    $("nav-arrow").innerHTML = turnSvg(next);
    $("nav-dist").textContent = fmtDist(Math.max(0, toNext));
    $("nav-verb").textContent = stepVerb(next);
    $("nav-street").textContent = stepStreet(next);
    var thenEl = $("nav-then");
    if (next && after && next.type !== "arrive" && route.cum[after.idx] - route.cum[next.idx] < 150) {
      thenEl.innerHTML = esc(t("route.then")) + " " + turnSvg(after) + " " + esc(stepVerb(after));
      thenEl.hidden = false;
    } else thenEl.hidden = true;
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

  setBasemap(readPref(PREF.basemap) !== "0", false);  // on by default; switched off only when the user did
  setTraffic(readPref(PREF.traffic) !== "0", false);  // on by default when a key is configured
  initLocation();

  window.__blokk = { map: map, trafficOn: trafficOn, route: function () { return route; }, nav: function () { return nav; }, loc: function () { return loc; }, streetStats: function () { return streetStats; }, renderLabels: renderLabels, blocks: function () { return blocks; }, entrances: function () { return entrances; }, search: search };
})();
