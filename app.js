/* Blokktérkép Marosvásárhely – OSM blocks + staircases, offline-capable. */
(function () {
  "use strict";

  var CITY_BOUNDS = L.latLngBounds([46.49, 24.47], [46.60, 24.66]);
  var CENTER = [46.5425, 24.5575];
  var LABEL_MIN_ZOOM = 16, STAIR_MIN_ZOOM = 17, NUM_MIN_ZOOM = 18;
  var MAX_BLOCK_LABELS = 450, MAX_STAIR_LABELS = 450, MAX_STREET_LABELS = 70;
  var TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  var TILE_SUBDOMAINS = "abcd";
  var TILE_CACHE = "tiles-v1";
  var OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  var CARTO_ATTRIB = '&copy; <a href="https://carto.com/attributions">CARTO</a>';
  var TILE_PREF_KEY = "blokk.basemap";

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

  // ---------- optional CARTO tiles underneath
  var tiles = L.tileLayer(TILE_URL, {
    subdomains: TILE_SUBDOMAINS, maxZoom: 19, maxNativeZoom: 18, attribution: CARTO_ATTRIB,
    crossOrigin: true, detectRetina: false,
  });
  function readPref() { try { return localStorage.getItem(TILE_PREF_KEY); } catch (e) { return null; } }
  function writePref(v) { try { localStorage.setItem(TILE_PREF_KEY, v); } catch (e) { /* private mode */ } }
  var tileErrors = 0;
  tiles.on("tileerror", function () {
    if (++tileErrors === 4) toast(t("toast.tilesFail"), 5000);
  });
  // CARTO answers keyless requests with one identical "API key required" watermark tile.
  // Two different tiles with identical bytes = placeholder, so switch the layer off again.
  function probeTiles() {
    function get(x, y) {
      return fetch(tileUrl(15, x, y), { mode: "cors" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      });
    }
    var z15x = lon2x(CENTER[1], 15), z15y = lat2y(CENTER[0], 15);
    return Promise.all([get(z15x, z15y), get(z15x + 1, z15y + 1)]).then(function (b) {
      if (b[0].byteLength !== b[1].byteLength) return true;
      var a = new Uint8Array(b[0]), c = new Uint8Array(b[1]);
      for (var i = 0; i < a.length; i++) if (a[i] !== c[i]) return true;
      return false;
    });
  }
  function setBasemap(on, remember) {
    var cb = $("bm-toggle");
    if (cb) cb.checked = on;
    document.body.classList.toggle("no-tiles", !on);
    if (remember) writePref(on ? "1" : "0");
    if (!on) { if (map.hasLayer(tiles)) map.removeLayer(tiles); return; }
    tileErrors = 0;
    if (!map.hasLayer(tiles)) tiles.addTo(map);
    probeTiles().then(function (ok) {
      if (ok) return;
      if (map.hasLayer(tiles)) map.removeLayer(tiles);
      if (cb) cb.checked = false;
      document.body.classList.add("no-tiles");
      toast(t("toast.cartoWatermark"), 7000);
    }).catch(function () { /* blocked or offline: tileerror handles the message */ });
  }
  var BasemapControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      var box = L.DomUtil.create("div", "bl-controls");
      var opts = Object.keys(LANGS).map(function (code) {
        return '<option value="' + code + '"' + (code === lang ? " selected" : "") + ">" + esc(LANGS[code]["lang.name"] || code) + "</option>";
      }).join("");
      box.innerHTML = '<label class="lang-pick"><span class="lang-globe" aria-hidden="true">🌐</span>' +
        '<select id="lang-select" data-i18n-attr="aria-label:lang.label;title:lang.label">' + opts + "</select></label>" +
        '<label class="bm-toggle"><input type="checkbox" id="bm-toggle"> <span data-i18n="ui.basemap">' + esc(t("ui.basemap")) + "</span></label>";
      L.DomEvent.disableClickPropagation(box);
      box.querySelector("#bm-toggle").addEventListener("change", function (e) { setBasemap(e.target.checked, true); });
      box.querySelector("#lang-select").addEventListener("change", function (e) { setLanguage(e.target.value); });
      return box;
    },
  });
  map.addControl(new BasemapControl());
  applyStaticText();  // the control's own labels

  function setLanguage(code) {
    if (!LANGS[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch (e) { /* private mode */ }
    applyStaticText();
    // dynamic content was built in the old language: close it, or rebuild the result list
    map.closePopup();
    closeSheet();
    if (!resEl.hidden) showResults();
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
  measureCtx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  function textW(t) { return measureCtx.measureText(t).width; }
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
      style: function (f) {
        var p = f.properties;
        if (p.kind === "apartments") return p.override ? STYLE.apartmentsOvr : STYLE.apartments;
        return STYLE.other;
      },
      onEachFeature: function (f, layer) { f._layer = layer; layer.on("click", function (ev) { openPopup(f, ev.latlng); }); },
    }).addTo(map);

    addrLayer = L.layerGroup();
    blocks.forEach(function (f) {
      if (f.geometry.type !== "Point") return;
      var c = f.geometry.coordinates;
      var ovr = f.properties.kind === "override";
      var m = L.circleMarker([c[1], c[0]], {
        renderer: canvas, radius: ovr ? 6 : 4, weight: 1.5,
        color: ovr ? "#6d28d9" : "#4b5563", fillColor: ovr ? "#a78bfa" : "#d1d5db", fillOpacity: 0.9,
      });
      f._layer = m;
      m.on("click", function () { openPopup(f, m.getLatLng()); });
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
      var cp = map.latLngToContainerPoint(p.lp), hw = textW(p.label) / 2 + 3;
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
      var sp = map.latLngToContainerPoint([g[1], g[0]]), sw = l ? textW(l) / 2 + 6 : 6;
      boxes.push([sp.x - sw, sp.y - 9, sp.x + sw, sp.y + 9]);
      stairLayer.addLayer(L.marker([g[1], g[0]], {
        icon: L.divIcon({ className: "stair" + (l ? "" : " nolabel") + (l && l.indexOf("nr. ") === 0 ? " num" : "") + (e.properties.override ? " ovr" : ""),
          html: "<span>" + esc(l ? l.replace(/^(Sc|nr)\. /, "") : "") + "</span>", iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }));
    });
    return addrLabels;
  }

  // ------------------------------------------------------------------ popup
  var hlLayer = null;
  function highlight(f) {
    if (hlLayer && hlLayer._origStyle) hlLayer.setStyle(hlLayer._origStyle);
    hlLayer = null;
    if (f._layer && f._layer.setStyle && f.geometry.type !== "Point") {
      f._layer._origStyle = blocksLayer.options.style(f);
      f._layer.setStyle(HL); f._layer.bringToFront && f._layer.bringToFront();
      hlLayer = f._layer;
    }
  }
  function openPopup(f, latlng) {
    var p = f.properties;
    highlight(f);
    var title = p.label || (p.kind === "apartments" ? t("popup.blockNoNumber") : t("popup.building"));
    var rows = [];
    function row(k, v) { if (v) rows.push('<div class="pp-row"><span>' + k + "</span><b>" + esc(v) + "</b></div>"); }
    row(t("popup.street"), p.street);
    row(t("popup.housenumber"), p.housenumber);
    row(t("popup.block"), p.block ? "Bl. " + p.block : null);
    row(t("popup.name"), p.name && (!p.label || p.label.indexOf(p.name) < 0) ? p.name : null);
    row(t("popup.levels"), p.levels);
    if (p.override && p.osm_label !== undefined) row(t("popup.inOsm"), p.osm_label || "–");
    if (p.note) row(t("popup.note"), p.note);
    var unl = p._ents.filter(function (e) { return !e.properties.label && !e.properties.redundant; }).length;
    var nums = p.entrance_nums || [];
    var stairs = p.entrances && p.entrances.length
      ? '<div class="pp-stairs">' + p.entrances.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>"
      : '<div class="pp-sub">' + esc(t("popup.noStairs")) + (unl ? " " + esc(t("popup.unlabelled", { n: unl })) : "") + "</div>";
    if (nums.length) stairs += '<div class="pp-sub" style="margin-top:6px">' + esc(t("popup.entranceNums")) + '</div><div class="pp-stairs num">' +
      nums.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>";
    if (p.entrances && p.entrances.length && unl) stairs += '<div class="pp-sub">' + esc(t("popup.unlabelled", { n: unl })) + "</div>";
    var dest = p.lp || [latlng.lat, latlng.lng];
    var gmaps = "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + dest[0].toFixed(6) + "," + dest[1].toFixed(6);
    var osmUrl = /^[wnr]\d+$/.test(p.id) ? "https://www.openstreetmap.org/" + { w: "way", n: "node", r: "relation" }[p.id[0]] + "/" + p.id.slice(1) : null;
    var html = '<div class="pp-title">' + esc(title) + "</div>" +
      (p.street && !p.housenumber ? "" : "") + rows.join("") +
      '<div style="margin-top:8px;font-weight:600">' + esc(t("popup.stairs")) + "</div>" + stairs +
      '<div class="pp-actions"><a href="' + gmaps + '" target="_blank" rel="noopener">' + esc(t("popup.route")) + "</a></div>" +
      (osmUrl ? '<div class="pp-id"><a href="' + osmUrl + '" target="_blank" rel="noopener">OSM ' + esc(p.id) + "</a> · " + esc(t("popup.coords")) + ": " +
        dest[0].toFixed(6) + ", " + dest[1].toFixed(6) + "</div>" : '<div class="pp-id">' + esc(t("popup.own")) + "</div>");
    L.popup({ maxWidth: 300, autoPanPadding: [20, 80] }).setLatLng(latlng).setContent(html).openOn(map);
  }
  map.on("popupclose", function () { if (hlLayer && hlLayer._origStyle) hlLayer.setStyle(hlLayer._origStyle); hlLayer = null; });

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
        var chip = p.kind === "street" ? '<span class="chip green">' + esc(t("chip.street")) + "</span>" :
          p.kind === "apartments" ? '<span class="chip">' + esc(t("chip.block")) + "</span>" :
          p.kind === "override" ? '<span class="chip purple">' + esc(t("chip.own")) + "</span>" :
          '<span class="chip grey">' + esc(t(p.kind === "address" ? "chip.address" : "chip.building")) + "</span>";
        var sub = p.kind === "street" ? t("search.streetSub") :
          [p.street, p.entrances.length ? p.entrances.join(", ") : ""].filter(Boolean).join(" · ");
        return '<li data-i="' + i + '"><div class="r-main">' + esc(p.label || p.name || t("search.noNumber")) + chip +
          '</div><div class="r-sub">' + esc(sub || "–") + "</div></li>";
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
  resEl.addEventListener("click", function (e) {
    var li = e.target.closest("li[data-i]");
    if (li) goTo(resEl._r[+li.getAttribute("data-i")]);
  });
  map.on("click", function () { resEl.hidden = true; qEl.blur(); });
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
    setTimeout(function () { openPopup(f, ll); }, 350);
  }

  // ------------------------------------------------------------------ locate
  var locBtn = $("btn-locate"), locOn = false, locMarker = null, locCircle = null, firstFix = false;
  locBtn.addEventListener("click", function () {
    if (locOn) { map.stopLocate(); locOn = false; locBtn.classList.remove("on"); return; }
    if (!window.isSecureContext) toast(t("toast.locHttps"), 6000);
    locOn = true; firstFix = true; locBtn.classList.add("on");
    map.locate({ watch: true, enableHighAccuracy: true, setView: false, maximumAge: 5000, timeout: 20000 });
  });
  map.on("locationfound", function (e) {
    if (!locMarker) {
      locCircle = L.circle(e.latlng, { radius: e.accuracy, renderer: canvas, color: "#2563eb", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      locMarker = L.circleMarker(e.latlng, { renderer: canvas, radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1, interactive: false }).addTo(map);
    } else { locMarker.setLatLng(e.latlng); locCircle.setLatLng(e.latlng).setRadius(e.accuracy); }
    if (firstFix) { firstFix = false; map.setView(e.latlng, Math.max(map.getZoom(), 17)); }
  });
  map.on("locationerror", function (e) {
    locOn = false; locBtn.classList.remove("on");
    toast(t("toast.locFail", { msg: e.message }), 6000);
  });

  // ------------------------------------------------------------------ sheet (info / offline)
  var sheet = $("sheet"), sheetBody = $("sheet-body");
  function openSheet(html) { sheetBody.innerHTML = html; sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; }
  sheet.addEventListener("click", function (e) { if (e.target === sheet || e.target.closest(".sheet-close")) closeSheet(); });

  $("btn-info").addEventListener("click", function () {
    var sw = function (style, key) { return '<div class="sw" style="' + style + '"></div><div>' + esc(t(key)) + "</div>"; };
    var h = "<h2>" + esc(t("app.title")) + "</h2>" +
      '<div class="legend">' +
      sw("background:#3b82f6;opacity:.6;border:1px solid #1d4ed8", "legend.apartments") +
      sw("background:#9ca3af;opacity:.6;border:1px solid #6b7280", "legend.other") +
      sw("background:#ea580c;border-radius:9px", "legend.stair") +
      sw("background:#fff;border:1.5px solid #ea580c;border-radius:9px", "legend.entranceNum") +
      sw("background:#a78bfa;border-radius:9px", "legend.override") +
      sw("background:#fff3bf;border:2px solid #c9a227", "legend.mainRoad") +
      sw("background:#fff;border:2px solid #c3bcae", "legend.street") +
      sw("background:#a9cdee", "legend.water") +
      sw("background:#d6ebc8", "legend.park") + "</div>";
    if (stats) {
      var pct = function (a, b) { return b ? Math.round(100 * a / b) + "%" : "–"; };
      var tr = function (key, val) { return "<tr><td>" + esc(t(key)) + '</td><td class="n">' + val + "</td></tr>"; };
      h += "<h3>" + esc(t("cov.title")) + "</h3><table>" +
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
      h += '<p class="muted">' + esc(t("info.footer", { ts: stats.osm_timestamp || stats.generated })) + "</p>";
    }
    openSheet(h);
  });

  // ---------- offline tile download
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function tileUrl(z, x, y) {
    var s = TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length];
    // must produce exactly the URL Leaflet requests, or the cached tile is never hit:
    // Leaflet fills {r} with "@2x" on high-DPI screens
    return TILE_URL.replace("{s}", s).replace("{z}", z).replace("{x}", x).replace("{y}", y).replace("{r}", L.Browser.retina ? "@2x" : "");
  }
  function plannedTiles() {
    var set = {}, list = [];
    function add(z, x, y) { var k = z + "/" + x + "/" + y; if (!set[k]) { set[k] = 1; list.push([z, x, y]); } }
    var B = CITY_BOUNDS;
    for (var z = 13; z <= 16; z++) {
      for (var x = lon2x(B.getWest(), z); x <= lon2x(B.getEast(), z); x++)
        for (var y = lat2y(B.getNorth(), z); y <= lat2y(B.getSouth(), z); y++) add(z, x, y);
    }
    // z17 + z18 only where there are buildings we show (keeps it to the built-up areas)
    blocks.forEach(function (f) {
      var bb = f.properties._bb || (f.properties.lp && [f.properties.lp[0], f.properties.lp[1], f.properties.lp[0], f.properties.lp[1]]);
      if (!bb || f.properties.kind === "address") return;
      for (var z = 17; z <= 18; z++)
        for (var x = lon2x(bb[1], z); x <= lon2x(bb[3], z); x++)
          for (var y = lat2y(bb[2], z); y <= lat2y(bb[0], z); y++) add(z, x, y);
    });
    return list;
  }
  var dl = { running: false, stop: false };
  $("btn-offline").addEventListener("click", function () {
    if (!("caches" in window) || !navigator.serviceWorker) {
      openSheet("<h2>" + esc(t("off.unsupportedTitle")) + "</h2><p>" + esc(t("off.unsupported")) + "</p>");
      return;
    }
    var list = plannedTiles();
    var byZ = {}; list.forEach(function (t) { byZ[t[0]] = (byZ[t[0]] || 0) + 1; });
    var mb = Math.round(list.length * (L.Browser.retina ? 40 : 14) / 1024);  // rough estimate per tile
    // off.p1 / off.p2 carry <b>/<i> markup from our own lang files, so they are inserted as HTML
    openSheet("<h2>" + esc(t("off.title")) + "</h2>" +
      "<p>" + t("off.p1") + "</p><p>" + t("off.p2") + "</p>" +
      "<table><tr><th>" + esc(t("off.zoom")) + '</th><th class="n">' + esc(t("off.tiles")) + "</th></tr>" +
      Object.keys(byZ).map(function (z) { return "<tr><td>" + z + '</td><td class="n">' + byZ[z] + "</td></tr>"; }).join("") +
      "<tr><td><b>" + esc(t("off.total")) + '</b></td><td class="n"><b>' + list.length + "</b> (" + esc(t("off.estimate", { mb: mb })) + ")</td></tr></table>" +
      '<p class="muted">' + esc(t("off.note")) + "</p>" +
      '<progress id="dlp" max="' + list.length + '" value="0"></progress><div id="dls" class="muted">&nbsp;</div>' +
      '<button class="btn" id="dlgo">' + esc(dl.running ? t("off.running") : t("off.start")) + '</button><button class="btn sec" id="dlstop">' + esc(t("off.stop")) + "</button>" +
      '<button class="btn sec" id="dlclear">' + esc(t("off.clear")) + "</button>");
    $("dlgo").onclick = function () { if (!dl.running) runDownload(list); };
    $("dlstop").onclick = function () { dl.stop = true; };
    $("dlclear").onclick = function () { caches.delete(TILE_CACHE).then(function () { $("dls").textContent = t("off.cleared"); }); };
  });
  function runDownload(list) {
    dl.running = true; dl.stop = false;
    var i = 0, done = 0, have = 0, failed = 0;
    caches.open(TILE_CACHE).then(function (cache) {
      function upd() {
        var p = $("dlp"), s = $("dls");
        if (p) p.value = done;
        if (s) s.textContent = t("off.progress", { done: done, total: list.length, have: have, failed: failed });
      }
      function next() {
        if (dl.stop || i >= list.length) return Promise.resolve();
        var tile = list[i++], url = tileUrl(tile[0], tile[1], tile[2]);
        return cache.match(url).then(function (hit) {
          if (hit) { have++; return; }
          return fetch(url, { mode: "cors" }).then(function (r) {
            if (r.ok) return cache.put(url, r); failed++;
          }).catch(function () { failed++; });
        }).then(function () { done++; if (done % 20 === 0) upd(); return next(); });
      }
      return Promise.all([next(), next(), next(), next()]).then(function () {
        upd(); dl.running = false;
        var s = $("dls");
        var msg = dl.stop ? t("off.stopped") : (failed ? t("off.doneErrors", { n: failed }) : t("off.done"));
        if (s) s.textContent += " – " + msg;
        toast(msg, 5000);
      });
    });
  }

  // ------------------------------------------------------------------ service worker
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("SW registration failed", e); });
    });
  }

  setBasemap(readPref() === "1", false);

  window.__blokk = { map: map, streetStats: function () { return streetStats; }, renderLabels: renderLabels, blocks: function () { return blocks; }, entrances: function () { return entrances; }, search: search };
})();
