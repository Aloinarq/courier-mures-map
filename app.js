/* Blokktérkép Marosvásárhely – OSM blocks + staircases, offline-capable. */
(function () {
  "use strict";

  var CITY_BOUNDS = L.latLngBounds([46.49, 24.47], [46.60, 24.66]);
  var CENTER = [46.5425, 24.5575];
  var LABEL_MIN_ZOOM = 16, STAIR_MIN_ZOOM = 17, NUM_MIN_ZOOM = 18;
  var MAX_BLOCK_LABELS = 450, MAX_STAIR_LABELS = 450;
  var TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  var TILE_SUBDOMAINS = "abcd";
  var TILE_CACHE = "tiles-v1";
  var ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> közreműködők &copy; <a href="https://carto.com/attributions">CARTO</a>';

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
  var tiles = L.tileLayer(TILE_URL, {
    subdomains: TILE_SUBDOMAINS, maxZoom: 19, maxNativeZoom: 18, attribution: ATTRIB,
    crossOrigin: true, detectRetina: false,
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

  var blocksLayer, addrLayer, extraLayer = L.layerGroup().addTo(map);
  var labelLayer = L.layerGroup().addTo(map);
  var stairLayer = L.layerGroup().addTo(map);
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
    toast("Nem sikerült betölteni az adatokat: " + e.message + " – futott a fetch_data.py?", 15000);
  });

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
    if (overrideCount) toast("Saját kiegészítések betöltve: " + overrideCount);
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
  function renderLabels() {
    labelLayer.clearLayers(); stairLayer.clearLayers();
    var z = map.getZoom();
    if (z < LABEL_MIN_ZOOM) return;
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
      labelLayer.addLayer(L.marker(p.lp, {
        icon: L.divIcon({ className: cls, html: "<span>" + esc(p.label) + "</span>", iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }));
      count++;
    });
    if (z < STAIR_MIN_ZOOM) return;
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
      stairLayer.addLayer(L.marker([g[1], g[0]], {
        icon: L.divIcon({ className: "stair" + (l ? "" : " nolabel") + (l && l.indexOf("nr. ") === 0 ? " num" : "") + (e.properties.override ? " ovr" : ""),
          html: "<span>" + esc(l ? l.replace(/^(Sc|nr)\. /, "") : "") + "</span>", iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }));
    });
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
    var title = p.label || (p.kind === "apartments" ? "Blokk (szám nélkül)" : "Épület");
    var rows = [];
    function row(k, v) { if (v) rows.push('<div class="pp-row"><span>' + k + "</span><b>" + esc(v) + "</b></div>"); }
    row("Utca", p.street);
    row("Házszám", p.housenumber);
    row("Blokk", p.block ? "Bl. " + p.block : null);
    row("Név", p.name && (!p.label || p.label.indexOf(p.name) < 0) ? p.name : null);
    row("Szintek", p.levels);
    if (p.override && p.osm_label !== undefined) row("OSM-ben", p.osm_label || "–");
    if (p.note) row("Megjegyzés", p.note);
    var unl = p._ents.filter(function (e) { return !e.properties.label && !e.properties.redundant; }).length;
    var nums = p.entrance_nums || [];
    var stairs = p.entrances && p.entrances.length
      ? '<div class="pp-stairs">' + p.entrances.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>"
      : '<div class="pp-sub">Nincs ismert lépcsőház-jelölés' + (unl ? " (" + unl + " jelöletlen bejárat)" : "") + ".</div>";
    if (nums.length) stairs += '<div class="pp-sub" style="margin-top:6px">Bejáratok házszámai (lépcsőházbetű nincs az OSM-ben):</div><div class="pp-stairs num">' +
      nums.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>";
    if (p.entrances && p.entrances.length && unl) stairs += '<div class="pp-sub">+ ' + unl + " jelöletlen bejárat</div>";
    var dest = p.lp || [latlng.lat, latlng.lng];
    var gmaps = "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + dest[0].toFixed(6) + "," + dest[1].toFixed(6);
    var osmUrl = /^[wnr]\d+$/.test(p.id) ? "https://www.openstreetmap.org/" + { w: "way", n: "node", r: "relation" }[p.id[0]] + "/" + p.id.slice(1) : null;
    var html = '<div class="pp-title">' + esc(title) + "</div>" +
      (p.street && !p.housenumber ? "" : "") + rows.join("") +
      '<div style="margin-top:8px;font-weight:600">Lépcsőházak</div>' + stairs +
      '<div class="pp-actions"><a href="' + gmaps + '" target="_blank" rel="noopener">Útvonal</a></div>' +
      (osmUrl ? '<div class="pp-id"><a href="' + osmUrl + '" target="_blank" rel="noopener">OSM ' + esc(p.id) + "</a> · koordináta: " +
        dest[0].toFixed(6) + ", " + dest[1].toFixed(6) + "</div>" : '<div class="pp-id">Saját kiegészítés</div>');
    L.popup({ maxWidth: 300, autoPanPadding: [20, 80] }).setLatLng(latlng).setContent(html).openOn(map);
  }
  map.on("popupclose", function () { if (hlLayer && hlLayer._origStyle) hlLayer.setStyle(hlLayer._origStyle); hlLayer = null; });

  // ------------------------------------------------------------------ search
  function buildSearchIndex() {
    searchIndex = blocks.filter(function (f) { var p = f.properties; return p.label || p.street || p.name; })
      .map(function (f) {
        var p = f.properties;
        var nums = fold([p.housenumber, p.block].filter(Boolean).join(" ")).split(/[\s,;/·]+/).filter(Boolean);
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
    var toks = rest.replace(/[.,;]/g, " ").split(/\s+/).filter(function (t) { return t && t !== "str" && t !== "strada" && t !== "nr" && t !== "utca"; });
    var out = [];
    searchIndex.forEach(function (it) {
      var score = 0;
      if (blockQ) {
        if (it.block.indexOf(blockQ) >= 0) score += 100;
        else return;
      }
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (/^\d+[a-z]?$/.test(t)) {
          if (it.nums.indexOf(t) >= 0) score += 50;
          else if (it.block.indexOf(t) >= 0) score += 40;
          else return;
        } else if (it.hay.indexOf(t) >= 0 || (t.length >= 5 && it.hay.indexOf(t.slice(0, -1)) >= 0)) {
          score += 10 + (new RegExp("(^|\\s)" + t.replace(/[^a-z0-9]/g, "")).test(it.hay) ? 5 : 0);
        } else return;
      }
      if (it.f.properties.kind === "apartments") score += 3;
      out.push({ it: it, s: score });
    });
    out.sort(function (a, b) {
      return b.s - a.s || String(a.it.f.properties.street || "").localeCompare(String(b.it.f.properties.street || ""), "ro") ||
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
      resEl.innerHTML = '<li class="r-empty">Nincs találat. Próbáld: „ialomita 10”, „bl 12”, „bloc 3A”.</li>';
    } else {
      resEl.innerHTML = r.map(function (f, i) {
        var p = f.properties;
        var chip = p.kind === "apartments" ? '<span class="chip">blokk</span>' :
          p.kind === "override" ? '<span class="chip purple">saját</span>' : '<span class="chip grey">' + (p.kind === "address" ? "cím" : "épület") + "</span>";
        var sub = [p.street, p.entrances.length ? p.entrances.join(", ") : ""].filter(Boolean).join(" · ");
        return '<li data-i="' + i + '"><div class="r-main">' + esc(p.label || p.name || "(szám nélkül)") + chip +
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
    if (!window.isSecureContext) toast("A helymeghatározás csak HTTPS-en vagy localhoston működik.", 6000);
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
    toast("Helymeghatározás sikertelen: " + e.message, 6000);
  });

  // ------------------------------------------------------------------ sheet (info / offline)
  var sheet = $("sheet"), sheetBody = $("sheet-body");
  function openSheet(html) { sheetBody.innerHTML = html; sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; }
  sheet.addEventListener("click", function (e) { if (e.target === sheet || e.target.closest(".sheet-close")) closeSheet(); });

  $("btn-info").addEventListener("click", function () {
    var h = "<h2>Blokktérkép – Marosvásárhely</h2>" +
      '<div class="legend">' +
      '<div class="sw" style="background:#3b82f6;opacity:.6;border:1px solid #1d4ed8"></div><div>Tömbház (building=apartments)</div>' +
      '<div class="sw" style="background:#9ca3af;opacity:.6;border:1px solid #6b7280"></div><div>Egyéb számozott épület</div>' +
      '<div class="sw" style="background:#ea580c;border-radius:9px"></div><div>Lépcsőház (17-es nagyítástól)</div>' +
      '<div class="sw" style="background:#fff;border:1.5px solid #ea580c;border-radius:9px"></div><div>Bejárat, csak házszámmal (nr.)</div>' +
      '<div class="sw" style="background:#a78bfa;border-radius:9px"></div><div>Saját kiegészítés (overrides.csv)</div></div>';
    if (stats) {
      var pct = function (a, b) { return b ? Math.round(100 * a / b) + "%" : "–"; };
      h += "<h3>Lefedettség (OSM)</h3><table>" +
        '<tr><td>Tömbházak</td><td class="n">' + stats.apartments + "</td></tr>" +
        '<tr><td>… számmal / jelöléssel</td><td class="n">' + stats.apartments_labelled + " (" + pct(stats.apartments_labelled, stats.apartments) + ")</td></tr>" +
        '<tr><td>… lépcsőházzal</td><td class="n">' + stats.apartments_with_stairs + " (" + pct(stats.apartments_with_stairs, stats.apartments) + ")</td></tr>" +
        '<tr><td>Bejáratok / ebből jelölt</td><td class="n">' + stats.entrances + " / " + stats.entrances_labelled + "</td></tr>" +
        (stats.entrances_numbered != null ? '<tr><td>… csak házszámmal (nr.)</td><td class="n">' + stats.entrances_numbered + " (" + pct(stats.entrances_numbered, stats.entrances) + ")</td></tr>" : "") +
        '<tr><td>Saját kiegészítések</td><td class="n">' + overrideCount + "</td></tr></table>";
      if (stats.neighbourhoods && stats.neighbourhoods.length) {
        h += '<h3>Negyedenként</h3><table><tr><th>Negyed</th><th class="n">Blokk</th><th class="n">Számmal</th><th class="n">Lépcsőh.</th></tr>' +
          stats.neighbourhoods.map(function (n) {
            return "<tr><td>" + esc(n.name) + '</td><td class="n">' + n.blocks + '</td><td class="n">' + pct(n.labelled, n.blocks) +
              '</td><td class="n">' + pct(n.with_stairs, n.blocks) + "</td></tr>";
          }).join("") + "</table>";
      }
      h += '<p class="muted">OSM adatok állapota: ' + esc(stats.osm_timestamp || stats.generated) + ". Adatok: © OpenStreetMap közreműködők (ODbL). " +
        "Ha egy blokkon hiányzik a szám, írd be a data/overrides.csv fájlba, vagy pótold közvetlenül az OpenStreetMapen.</p>";
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
    return TILE_URL.replace("{s}", s).replace("{z}", z).replace("{x}", x).replace("{y}", y).replace("{r}", "");
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
      openSheet("<h2>Offline mód</h2><p>Ez a böngésző / kapcsolat nem támogatja az offline tárolást (HTTPS vagy localhost kell).</p>");
      return;
    }
    var list = plannedTiles();
    var byZ = {}; list.forEach(function (t) { byZ[t[0]] = (byZ[t[0]] || 0) + 1; });
    var mb = Math.round(list.length * 14 / 1024);
    openSheet("<h2>Térkép letöltése offline használatra</h2>" +
      "<p>A blokkok, számok és lépcsőházak adatai már a telefonon vannak (az app automatikusan elmenti őket). " +
      "Ez a gomb a háttértérkép csempéit (utcák) is letölti, hogy térerő nélkül is látszódjanak.</p>" +
      '<table><tr><th>Nagyítás</th><th class="n">Csempe</th></tr>' +
      Object.keys(byZ).map(function (z) { return "<tr><td>" + z + '</td><td class="n">' + byZ[z] + "</td></tr>"; }).join("") +
      '<tr><td><b>Összesen</b></td><td class="n"><b>' + list.length + "</b> (~" + mb + " MB)</td></tr></table>" +
      '<p class="muted">13–16: az egész város; 17–18: csak a beépített részek. A böngészés közben megnézett csempék amúgy is mentődnek. ' +
      "Wi-Fi-n indítsd. Lassan, 4 szálon tölt, hogy ne terhelje a CARTO szervereit.</p>" +
      '<progress id="dlp" max="' + list.length + '" value="0"></progress><div id="dls" class="muted">&nbsp;</div>' +
      '<button class="btn" id="dlgo">' + (dl.running ? "Fut…" : "Letöltés indítása") + '</button><button class="btn sec" id="dlstop">Leállítás</button>' +
      '<button class="btn sec" id="dlclear">Csempék törlése</button>');
    $("dlgo").onclick = function () { if (!dl.running) runDownload(list); };
    $("dlstop").onclick = function () { dl.stop = true; };
    $("dlclear").onclick = function () { caches.delete(TILE_CACHE).then(function () { $("dls").textContent = "Csempe-gyorsítótár törölve."; }); };
  });
  function runDownload(list) {
    dl.running = true; dl.stop = false;
    var i = 0, done = 0, have = 0, failed = 0;
    caches.open(TILE_CACHE).then(function (cache) {
      function upd() {
        var p = $("dlp"), s = $("dls");
        if (p) p.value = done;
        if (s) s.textContent = done + " / " + list.length + " (már megvolt: " + have + ", hiba: " + failed + ")";
      }
      function next() {
        if (dl.stop || i >= list.length) return Promise.resolve();
        var t = list[i++], url = tileUrl(t[0], t[1], t[2]);
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
        var msg = dl.stop ? "Leállítva." : (failed ? "Kész, de " + failed + " csempe nem jött le – próbáld újra." : "Kész! A térkép offline is működik.");
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

  window.__blokk = { map: map, blocks: function () { return blocks; }, entrances: function () { return entrances; }, search: search };
})();
