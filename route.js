/* Offline router over data/roads.geojson (our own OSM extract): no server, no key, works offline.
   Router.fromGeoJSON(gj).route([lat, lon], [lat, lon], "car" | "bike" | "foot")
   -> { coords: [[lat, lon], ...], distance (m), duration (s), steps: [...] } or null.
   Plain ES5 so it runs in old phone browsers and in node (for tests). */
(function (root) {
  "use strict";

  var LAT0 = 46.545, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;

  // km/h per road class; null = not usable in that mode
  var SPEED = {
    car: {
      motorway: 70, motorway_link: 40, trunk: 50, trunk_link: 35, primary: 40, primary_link: 30,
      secondary: 38, secondary_link: 30, tertiary: 33, tertiary_link: 25, unclassified: 28,
      residential: 24, living_street: 10, service: 14, track: 8,
    },
    bike: {
      trunk: 16, trunk_link: 16, primary: 17, primary_link: 16, secondary: 17, secondary_link: 16,
      tertiary: 17, tertiary_link: 16, unclassified: 16, residential: 16, living_street: 12,
      service: 14, track: 10, pedestrian: 9, footway: 8, path: 10, steps: 2,
    },
    foot: {
      trunk: 4.5, trunk_link: 4.5, primary: 5, primary_link: 5, secondary: 5, secondary_link: 5,
      tertiary: 5, tertiary_link: 5, unclassified: 5, residential: 5, living_street: 5,
      service: 5, track: 5, pedestrian: 5, footway: 5, path: 5, steps: 3,
    },
  };
  var MAX_SPEED = { car: 70, bike: 17, foot: 5 };

  function xy(lat, lon) { return [lon * KX, lat * KY]; }
  function dist(a, b) { var dx = (a[1] - b[1]) * KX, dy = (a[0] - b[0]) * KY; return Math.sqrt(dx * dx + dy * dy); }
  function bearing(a, b) { // degrees clockwise from north, a/b = [lat, lon]
    return (Math.atan2((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) * 180 / Math.PI + 360) % 360;
  }

  // ---------------------------------------------------------------- binary heap
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  };

  // ---------------------------------------------------------------- graph
  function Router(ways) {
    this.ways = ways;                 // [{h, n, oneway: 1|-1|0, noCar, noBike, priv, round}]
    this.lat = []; this.lon = [];     // node coordinates
    this.adj = [];                    // node -> [edge ids]
    this.eA = []; this.eB = []; this.eLen = []; this.eWay = [];
    this.grid = {}; this.cell = 120;  // segment index for snapping
  }

  function wayInfo(p) {
    var o = p.o, oneway = 0;
    if (o === "yes" || o === "1" || o === "true") oneway = 1;
    else if (o === "-1" || o === "reverse") oneway = -1;
    else if (!o && (p.j === "roundabout" || p.j === "circular" || p.h === "motorway")) oneway = 1;
    var a = p.a || "", v = p.v || "";
    return {
      h: p.h, n: p.n || "", oneway: oneway, round: p.j === "roundabout" || p.j === "circular",
      noCar: (a === "no" && v !== "yes" && v !== "destination") || v === "no",
      noBike: a === "no" && p.b !== "yes" && p.b !== "designated",
      noFoot: a === "no" && p.h !== "footway",
      priv: a === "private" || a === "customers",
    };
  }

  Router.fromGeoJSON = function (gj) {
    var ways = [], r = new Router(ways), ids = {};
    function node(c) {
      var key = c[0] + "," + c[1], id = ids[key];
      if (id === undefined) {
        id = ids[key] = r.lat.length;
        r.lat.push(c[1]); r.lon.push(c[0]); r.adj.push([]);
      }
      return id;
    }
    gj.features.forEach(function (f) {
      if (!f.geometry || f.geometry.type !== "LineString") return;
      var w = ways.length, c = f.geometry.coordinates;
      ways.push(wayInfo(f.properties || {}));
      var prev = node(c[0]);
      for (var i = 1; i < c.length; i++) {
        var cur = node(c[i]);
        if (cur === prev) continue;
        var e = r.eA.length, len = dist([r.lat[prev], r.lon[prev]], [r.lat[cur], r.lon[cur]]);
        r.eA.push(prev); r.eB.push(cur); r.eLen.push(len); r.eWay.push(w);
        r.adj[prev].push(e); r.adj[cur].push(e);
        r._index(e);
        prev = cur;
      }
    });
    r._components();
    return r;
  };

  // label connected pieces; detached sidewalk fragments must not swallow a start or end point
  Router.prototype._components = function () {
    var N = this.lat.length, comp = new Int32Array(N).fill(-1), sizes = [];
    for (var i = 0; i < N; i++) {
      if (comp[i] >= 0) continue;
      var c = sizes.length, stack = [i], n = 0;
      comp[i] = c;
      while (stack.length) {
        var x = stack.pop(); n++;
        for (var k = 0; k < this.adj[x].length; k++) {
          var e = this.adj[x][k], y = this.eA[e] === x ? this.eB[e] : this.eA[e];
          if (comp[y] < 0) { comp[y] = c; stack.push(y); }
        }
      }
      sizes.push(n);
    }
    var main = 0;
    for (var j = 1; j < sizes.length; j++) if (sizes[j] > sizes[main]) main = j;
    this.comp = comp; this.mainComp = main;
  };

  Router.prototype._index = function (e) {
    var a = this.eA[e], b = this.eB[e], pa = xy(this.lat[a], this.lon[a]), pb = xy(this.lat[b], this.lon[b]);
    var c = this.cell;
    for (var gx = Math.floor(Math.min(pa[0], pb[0]) / c); gx <= Math.floor(Math.max(pa[0], pb[0]) / c); gx++)
      for (var gy = Math.floor(Math.min(pa[1], pb[1]) / c); gy <= Math.floor(Math.max(pa[1], pb[1]) / c); gy++) {
        var k = gx + ":" + gy;
        (this.grid[k] = this.grid[k] || []).push(e);
      }
  };

  // seconds to travel edge e in direction a->b (forward) or b->a; Infinity if not allowed
  Router.prototype.cost = function (e, forward, mode) {
    var w = this.ways[this.eWay[e]], kmh = SPEED[mode][w.h];
    if (!kmh) return Infinity;
    if (mode === "car" && w.noCar || mode === "bike" && w.noBike || mode === "foot" && w.noFoot) return Infinity;
    if (mode !== "foot" && w.oneway && (w.oneway === 1) !== forward) return Infinity;
    var s = this.eLen[e] / (kmh / 3.6);
    if (w.priv) s *= 3;  // courtyards behind barriers: only when there is no other way
    return s;
  };

  // nearest usable segment within maxM metres: {e, t, at:[lat,lon], d}
  Router.prototype.snap = function (ll, mode, maxM) {
    var p = xy(ll[0], ll[1]), c = this.cell, best = null, seen = {};
    var gx = Math.floor(p[0] / c), gy = Math.floor(p[1] / c), rr = Math.ceil((maxM || 250) / c);
    for (var dx = -rr; dx <= rr; dx++) for (var dy = -rr; dy <= rr; dy++) {
      var list = this.grid[(gx + dx) + ":" + (gy + dy)];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (seen[e]) continue;
        seen[e] = 1;
        if (this.comp[this.eA[e]] !== this.mainComp) continue;
        if (this.cost(e, true, mode) === Infinity && this.cost(e, false, mode) === Infinity) continue;
        var a = this.eA[e], b = this.eB[e], pa = xy(this.lat[a], this.lon[a]), pb = xy(this.lat[b], this.lon[b]);
        var vx = pb[0] - pa[0], vy = pb[1] - pa[1], L2 = vx * vx + vy * vy;
        var t = L2 ? Math.max(0, Math.min(1, ((p[0] - pa[0]) * vx + (p[1] - pa[1]) * vy) / L2)) : 0;
        var qx = pa[0] + t * vx, qy = pa[1] + t * vy, d = Math.hypot(p[0] - qx, p[1] - qy);
        if (!best || d < best.d) best = { e: e, t: t, d: d, at: [qy / KY, qx / KX] };
      }
    }
    return best && best.d <= (maxM || 250) ? best : null;
  };

  Router.prototype.route = function (from, to, mode) {
    mode = SPEED[mode] ? mode : "car";
    var s = this.snap(from, mode, 300), g = this.snap(to, mode, 300);
    if (!s || !g) return null;
    var self = this, N = this.lat.length, S = N, T = N + 1;
    var best = new Float64Array(N + 2).fill(Infinity), prevNode = new Int32Array(N + 2).fill(-1);
    var prevEdge = new Int32Array(N + 2).fill(-1), done = new Uint8Array(N + 2);
    var vmax = MAX_SPEED[mode] / 3.6, goal = [g.at[0], g.at[1]];
    function h(n) { return n === T ? 0 : dist([self.lat[n], self.lon[n]], goal) / vmax; }
    var heap = new Heap();

    // virtual start: from the snapped point to both ends of its segment (if direction allowed)
    function partial(e, forward, frac) { var c = self.cost(e, forward, mode); return c === Infinity ? c : c * frac; }
    var sa = this.eA[s.e], sb = this.eB[s.e];
    var toA = partial(s.e, false, s.t), toB = partial(s.e, true, 1 - s.t);
    best[S] = 0;
    [[sa, toA], [sb, toB]].forEach(function (x) {
      if (x[1] < best[x[0]]) { best[x[0]] = x[1]; prevNode[x[0]] = S; prevEdge[x[0]] = s.e; heap.push(x[1] + h(x[0]), x[0]); }
    });
    // same segment, reachable directly
    if (s.e === g.e) {
      var fwd = g.t >= s.t, direct = partial(s.e, fwd, Math.abs(g.t - s.t));
      if (direct < Infinity) { best[T] = direct; prevNode[T] = S; prevEdge[T] = s.e; heap.push(direct, T); }
    }
    var ga = this.eA[g.e], gb = this.eB[g.e];
    var fromA = partial(g.e, true, g.t), fromB = partial(g.e, false, 1 - g.t);

    while (heap.k.length) {
      var n = heap.pop();
      if (done[n]) continue;
      done[n] = 1;
      if (n === T) break;
      if (n === ga && fromA < Infinity && best[n] + fromA < best[T]) { best[T] = best[n] + fromA; prevNode[T] = n; prevEdge[T] = g.e; heap.push(best[T], T); }
      if (n === gb && fromB < Infinity && best[n] + fromB < best[T]) { best[T] = best[n] + fromB; prevNode[T] = n; prevEdge[T] = g.e; heap.push(best[T], T); }
      if (n >= N) continue;
      var es = this.adj[n];
      for (var i = 0; i < es.length; i++) {
        var e = es[i], fw = this.eA[e] === n, m = fw ? this.eB[e] : this.eA[e];
        if (done[m]) continue;
        var c = this.cost(e, fw, mode);
        if (c === Infinity) continue;
        var nb = best[n] + c;
        if (nb < best[m]) { best[m] = nb; prevNode[m] = n; prevEdge[m] = e; heap.push(nb + h(m), m); }
      }
    }
    if (best[T] === Infinity) return null;

    // walk back: list of [lat, lon] with the way index of the hop that arrives there
    var pts = [], wayOf = [], nodeOf = [], cur = T;
    while (cur !== -1) {
      var ll = cur === S ? s.at : cur === T ? g.at : [this.lat[cur], this.lon[cur]];
      pts.push(ll); wayOf.push(prevEdge[cur] >= 0 ? this.eWay[prevEdge[cur]] : -1); nodeOf.push(cur < N ? cur : -1);
      cur = prevNode[cur];
    }
    pts.reverse(); wayOf.reverse(); nodeOf.reverse();
    // wayOf[i] = way used to reach pts[i]; shift so hops[i] = way from pts[i] to pts[i+1]
    var hops = wayOf.slice(1), coords = [pts[0]], hw = [], nodes = [nodeOf[0]];
    for (var k = 1; k < pts.length; k++) {
      if (dist(pts[k], coords[coords.length - 1]) < 0.5) continue;
      coords.push(pts[k]); hw.push(hops[k - 1]); nodes.push(nodeOf[k]);
    }
    var total = 0;
    for (var q = 1; q < coords.length; q++) total += dist(coords[q - 1], coords[q]);
    return {
      coords: coords, distance: total, duration: best[T], mode: mode,
      steps: this.instructions(coords, hw, nodes, mode), start: s, end: g,
    };
  };

  // ---------------------------------------------------------------- turn-by-turn
  function pointAlong(coords, i, metres, dir) { // walk from coords[i] backwards (-1) or forwards (+1)
    var acc = 0, j = i;
    while (j + dir >= 0 && j + dir < coords.length) {
      var d = dist(coords[j], coords[j + dir]);
      if (acc + d >= metres) {
        var t = (metres - acc) / d;
        return [coords[j][0] + (coords[j + dir][0] - coords[j][0]) * t, coords[j][1] + (coords[j + dir][1] - coords[j][1]) * t];
      }
      acc += d; j += dir;
    }
    return coords[j];
  }
  function modifier(delta) {
    var a = Math.abs(delta), side = delta > 0 ? "right" : "left";
    if (a < 25) return "straight";
    if (a < 60) return "slight " + side;
    if (a < 140) return side;
    if (a < 165) return "sharp " + side;
    return "uturn";
  }

  Router.prototype.instructions = function (coords, hw, nodes, mode) {
    var self = this, groups = [];
    for (var i = 0; i < hw.length; i++) {
      var w = this.ways[hw[i]] || { n: "", h: "" }, key = w.round ? "#round" : w.n;
      var len = dist(coords[i], coords[i + 1]), last = groups[groups.length - 1];
      if (last && last.key === key) { last.len += len; last.end = i + 1; }
      else groups.push({ key: key, name: w.n, cls: w.h, round: w.round, start: i, end: i + 1, len: len });
    }
    // short unnamed connectors (crossings, bits of service road) are not worth an instruction
    for (var j = groups.length - 2; j >= 1; j--) {
      var gr = groups[j];
      if (!gr.name && !gr.round && gr.len < 30) {
        groups[j - 1].len += gr.len; groups[j - 1].end = gr.end; groups.splice(j, 1);
      }
    }
    for (var m = groups.length - 1; m >= 1; m--) {
      if (groups[m].key === groups[m - 1].key) {
        groups[m - 1].len += groups[m].len; groups[m - 1].end = groups[m].end; groups.splice(m, 1);
      }
    }
    var steps = [];
    groups.forEach(function (gr, k) {
      var at = coords[gr.start], step = { name: gr.name, cls: gr.cls, distance: gr.len, idx: gr.start, at: at };
      if (k === 0) {
        step.type = "depart";
        step.bearing = bearing(coords[0], pointAlong(coords, 0, 20, 1));
      } else {
        var bin = bearing(pointAlong(coords, gr.start, 20, -1), at), bout = bearing(at, pointAlong(coords, gr.start, 20, 1));
        var delta = ((bout - bin + 540) % 360) - 180;
        step.type = "turn";
        step.modifier = modifier(delta);
        if (step.modifier === "straight") step.type = "continue";
      }
      if (gr.round && groups[k + 1]) {
        // count the exits passed on the ring; the step names the street we leave on
        var exits = 0, ringWay = hw[gr.start];
        for (var q = gr.start + 1; q <= gr.end; q++) {
          var nd = nodes[q];
          if (nd < 0) continue;
          var adj = self.adj[nd];
          for (var z = 0; z < adj.length; z++) {
            var ed = adj[z];
            if (self.ways[self.eWay[ed]].round) continue;
            if (self.cost(ed, self.eA[ed] === nd, mode) < Infinity) { exits++; break; }
          }
        }
        step.type = "roundabout";
        step.exit = Math.max(1, exits);
        step.name = groups[k + 1].name;
        step.distance = gr.len + groups[k + 1].len;
        groups[k + 1].skip = true;
        void ringWay;
      }
      if (!gr.skip) steps.push(step);
    });
    var endAt = coords[coords.length - 1];
    steps.push({ type: "arrive", distance: 0, idx: coords.length - 1, at: endAt, name: "" });
    return steps;
  };

  Router.dist = dist;
  Router.bearing = bearing;
  root.BlokkRouter = Router;
  if (typeof module !== "undefined" && module.exports) module.exports = Router;
})(typeof window !== "undefined" ? window : this);
