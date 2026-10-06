#!/usr/bin/env python3
"""
Târgu Mureș blokktérkép – adatletöltő.

Downloads OpenStreetMap data (only OSM, via the Overpass API) for Târgu Mureș:
  * buildings with addr:housenumber / addr:block (ways, relations, nodes)
  * all building=apartments outlines (even without a number)
  * stand-alone address nodes (used to give numbers to unnumbered blocks)
  * all entrance=* nodes (staircases)
  * place=suburb/neighbourhood/quarter nodes (only for the coverage report)

Outputs:
  data/raw_overpass.json   the untouched Overpass response
  data/blocks.geojson      buildings (polygons) + address points
  data/entrances.geojson   entrances, each linked to a building
  data/stats.json          coverage numbers (also printed)
  data/roads.geojson       named/usable streets as LineStrings (our own street layer)
  data/context.geojson     river, lakes, big parks, railways (orientation only)
  data/raw_roads.json, data/raw_context.json   untouched Overpass responses (gitignored)

Usage:
  python3 fetch_data.py              # download + process
  python3 fetch_data.py --from-raw   # re-process the raw_*.json files only
  python3 fetch_data.py --roads-only # (re)download + rebuild only roads/context, keep blocks

Standard library only – no pip install needed.
"""
import json
import math
import os
import random
import re
import shutil
import ssl
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RAW_PATH = os.path.join(DATA, "raw_overpass.json")
RAW_ROADS_PATH = os.path.join(DATA, "raw_roads.json")
RAW_CONTEXT_PATH = os.path.join(DATA, "raw_context.json")

BBOX = (46.49, 24.47, 46.60, 24.66)  # south, west, north, east
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "courier-mures-map/1.0 (personal offline map of Targu Mures apartment blocks; python-urllib)"
TRIES_PER_ENDPOINT = 3
HTTP_TIMEOUT = 360          # seconds, client side
OVERPASS_TIMEOUT = 300      # seconds, server side ([timeout:])
ENTRANCE_LINK_MAX_M = 50    # max distance between an entrance and "its" building

QUERY = """
[out:json][timeout:{t}][maxsize:536870912];
(
  way["building"]["addr:housenumber"]({b});
  relation["building"]["addr:housenumber"]({b});
  node["building"]["addr:housenumber"]({b});
  way["building"]["addr:block"]({b});
  relation["building"]["addr:block"]({b});
  way["building"="apartments"]({b});
  relation["building"="apartments"]({b});
  node["addr:housenumber"]({b});
  node["addr:block"]({b});
  node["entrance"]({b});
  node["place"~"^(suburb|neighbourhood|quarter)$"]({b});
);
out body geom qt;
"""


ROAD_CLASSES = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|"
                "pedestrian|footway|path|track|steps|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link")
ROADS_QUERY = """
[out:json][timeout:{t}][maxsize:536870912];
way["highway"~"^({classes})$"]({b});
out tags geom qt;
"""
CONTEXT_QUERY = """
[out:json][timeout:{t}][maxsize:536870912];
(
  way["waterway"="river"]({b});
  way["natural"="water"]({b});
  relation["natural"="water"]({b});
  way["leisure"="park"]({b});
  relation["leisure"="park"]({b});
  way["railway"="rail"]({b});
);
out tags geom qt;
"""

# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------

def _ssl_context():
    try:
        import certifi  # noqa: F401
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _post_urllib(url, query):
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    })
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=_ssl_context()) as r:
        return r.status, r.read()


def _post_curl(url, query):
    """Fallback when Python's SSL store is broken (common with python.org builds on macOS)."""
    cmd = ["curl", "-sS", "--fail-with-body", "-m", str(HTTP_TIMEOUT), "-A", USER_AGENT,
           "-H", "Accept: application/json", "--data-urlencode", "data@-", url,
           "-w", "\n%{http_code}"]
    p = subprocess.run(cmd, input=query.encode(), capture_output=True)
    out = p.stdout
    body, _, code = out.rpartition(b"\n")
    code = int(code or 0)
    if p.returncode != 0 and code == 0:
        raise RuntimeError("curl failed: " + p.stderr.decode(errors="replace").strip())
    return code, body


def download(query=None):
    query = query or QUERY.format(t=OVERPASS_TIMEOUT, b="{},{},{},{}".format(*BBOX))
    use_curl = False
    errors = []
    for url in ENDPOINTS:
        for attempt in range(1, TRIES_PER_ENDPOINT + 1):
            t0 = time.time()
            via = "curl" if use_curl else "urllib"
            print(f"→ {url}  (attempt {attempt}/{TRIES_PER_ENDPOINT}, via {via}) …", flush=True)
            try:
                status, raw = (_post_curl if use_curl else _post_urllib)(url, query)
            except urllib.error.HTTPError as e:
                status, raw = e.code, e.read()
            except (ssl.SSLError, urllib.error.URLError) as e:
                reason = getattr(e, "reason", e)
                if isinstance(reason, ssl.SSLError) or "CERTIFICATE" in str(e).upper():
                    print("  ! Python SSL certificate problem:", reason)
                    print("    (python.org Python on macOS: run 'Install Certificates.command' "
                          "from /Applications/Python 3.x/ to fix it permanently.)")
                    if shutil.which("curl") and not use_curl:
                        print("  ! Switching to the system 'curl' for the download (explicitly, not silently).")
                        use_curl = True
                        continue
                errors.append(f"{url}: {e}")
                print("  ! network error:", e)
                time.sleep(5 * attempt)
                continue
            except Exception as e:  # timeouts, curl errors …
                errors.append(f"{url}: {e}")
                print("  ! error:", e)
                time.sleep(5 * attempt)
                continue

            dt = time.time() - t0
            if status == 200:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    snippet = raw[:300].decode(errors="replace")
                    errors.append(f"{url}: invalid JSON ({snippet!r})")
                    print("  ! response is not JSON:", snippet)
                    time.sleep(10 * attempt)
                    continue
                remark = data.get("remark")
                if remark and ("runtime error" in remark.lower() or "timed out" in remark.lower()):
                    errors.append(f"{url}: overpass remark: {remark}")
                    print("  ! Overpass reported an error:", remark)
                    time.sleep(15 * attempt)
                    continue
                print(f"  ✓ {len(raw)/1e6:.1f} MB, {len(data.get('elements', []))} elements in {dt:.0f}s")
                return data
            snippet = raw[:200].decode(errors="replace").replace("\n", " ")
            errors.append(f"{url}: HTTP {status} {snippet}")
            print(f"  ! HTTP {status} after {dt:.0f}s: {snippet}")
            # 429 = rate limited, 504 = server busy: wait longer
            time.sleep((30 if status in (429, 504) else 10) * attempt)
    print("\nAll Overpass endpoints failed:")
    for e in errors:
        print("  -", e)
    sys.exit(1)


# ----------------------------------------------------------------------------
# Geometry helpers (local equirectangular projection, metres)
# ----------------------------------------------------------------------------

LAT0 = (BBOX[0] + BBOX[2]) / 2
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110540.0


def xy(lat, lon):
    return (lon * KX, lat * KY)


def ring_area_xy(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def point_in_ring(px, py, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def dist_point_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def join_rings(segments):
    """Join way geometries (lists of (lat,lon)) into closed rings."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[-2::-1]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings


class Poly:
    """A building polygon: outer rings + holes, in lat/lon and local xy."""

    def __init__(self, outers, inners):
        self.outers = outers
        self.inners = inners
        self.outers_xy = [[xy(*p) for p in r] for r in outers]
        self.inners_xy = [[xy(*p) for p in r] for r in inners]
        xs = [p[0] for r in self.outers_xy for p in r]
        ys = [p[1] for r in self.outers_xy for p in r]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.area = sum(abs(ring_area_xy(r)) for r in self.outers_xy) - \
            sum(abs(ring_area_xy(r)) for r in self.inners_xy)

    def contains(self, px, py):
        if not (self.bbox[0] <= px <= self.bbox[2] and self.bbox[1] <= py <= self.bbox[3]):
            return False
        if not any(point_in_ring(px, py, r) for r in self.outers_xy):
            return False
        return not any(point_in_ring(px, py, r) for r in self.inners_xy)

    def edge_distance(self, px, py):
        d = float("inf")
        for r in self.outers_xy + self.inners_xy:
            for i in range(len(r) - 1):
                d = min(d, dist_point_seg(px, py, r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]))
        return d

    def label_point(self):
        """Area centroid of the largest outer ring; if that falls outside (L/U shaped
        blocks), the midpoint of the longest horizontal chord through the centre."""
        ring = max(self.outers_xy, key=lambda r: abs(ring_area_xy(r)))
        a = ring_area_xy(ring)
        if abs(a) < 1e-9:
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
        else:
            cx = cy = 0.0
            for i in range(len(ring) - 1):
                x1, y1 = ring[i]
                x2, y2 = ring[i + 1]
                f = x1 * y2 - x2 * y1
                cx += (x1 + x2) * f
                cy += (y1 + y2) * f
            cx /= 6 * a
            cy /= 6 * a
        if not self.contains(cx, cy):
            best = None
            ys = [p[1] for p in ring]
            for k in range(1, 20):
                yy = min(ys) + (max(ys) - min(ys)) * k / 20
                xs = []
                for i in range(len(ring) - 1):
                    (x1, y1), (x2, y2) = ring[i], ring[i + 1]
                    if (y1 > yy) != (y2 > yy):
                        xs.append(x1 + (yy - y1) * (x2 - x1) / (y2 - y1))
                xs.sort()
                for j in range(0, len(xs) - 1, 2):
                    w = xs[j + 1] - xs[j]
                    if best is None or w > best[0]:
                        best = (w, (xs[j] + xs[j + 1]) / 2, yy)
            if best:
                cx, cy = best[1], best[2]
        return (round(cy / KY, 7), round(cx / KX, 7))


class Grid:
    def __init__(self, cell=100.0):
        self.cell = cell
        self.cells = defaultdict(list)

    def add(self, bbox, item):
        c = self.cell
        for gx in range(int(bbox[0] // c), int(bbox[2] // c) + 1):
            for gy in range(int(bbox[1] // c), int(bbox[3] // c) + 1):
                self.cells[(gx, gy)].append(item)

    def near(self, px, py, r):
        c = self.cell
        seen = set()
        for gx in range(int((px - r) // c), int((px + r) // c) + 1):
            for gy in range(int((py - r) // c), int((py + r) // c) + 1):
                for it in self.cells.get((gx, gy), ()):
                    if id(it) not in seen:
                        seen.add(id(it))
                        yield it


# ----------------------------------------------------------------------------
# Labelling
# ----------------------------------------------------------------------------

def fold(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn").lower().strip()


BLOCK_PREFIX = re.compile(r"^\s*(bl(oc|ock|okk)?|blk)\.?\s*(nr\.?\s*)?", re.I)
STAIR_PREFIX = re.compile(r"^\s*(sc(ara)?|lépcsőház|lepcsohaz|entrance|intrarea?)\.?\s*", re.I)
SHORT_CODE = re.compile(r"^[A-Za-z0-9]{1,3}$")


def clean_block(v):
    """'Bloc 14', 'bl. 14', '14' -> '14'."""
    v = (v or "").strip()
    return BLOCK_PREFIX.sub("", v).strip() or v


NAME_IS_BLOCK = re.compile(r"^\s*bl(oc|ocul|ock)?\b\.?\s*(nr\.?\s*)?[A-Za-z0-9-]{1,6}\s*$", re.I)


def block_of(t):
    """Block number from addr:block, else from a name like 'Bloc 14', else from a
    housenumber written like 'Bl. 14'."""
    if (t.get("addr:block") or "").strip():
        return clean_block(t["addr:block"])
    name = (t.get("name") or "").strip()
    if name and NAME_IS_BLOCK.match(name):
        return clean_block(name)
    hn = (t.get("addr:housenumber") or "").strip()
    if hn and re.match(r"^\s*bl", hn, re.I):
        return clean_block(hn)
    return ""


def building_label(t):
    parts = []
    blk = block_of(t)
    if blk:
        parts.append(f"Bl. {blk}")
    hn = (t.get("addr:housenumber") or "").strip()
    if hn and not re.match(r"^\s*bl", hn, re.I) and fold(hn) != fold(blk):
        parts.append(f"nr. {hn}" if blk else hn)
    name = (t.get("name") or "").strip()
    if name and not NAME_IS_BLOCK.match(name) and \
            not any(fold(name) in fold(p) or fold(p) in fold(name) for p in parts):
        parts.append(name)
    return " · ".join(parts)


def entrance_label(t):
    for k in ("entrance:ref", "ref", "addr:unit", "addr:entrance", "addr:staircase", "name"):
        v = (t.get(k) or "").strip()
        if v:
            core = STAIR_PREFIX.sub("", v).strip()
            if SHORT_CODE.match(core):
                return f"Sc. {core.upper() if core.isalpha() else core}", k
            return v, k
    # Staircase codes are almost never mapped in Targu Mures; the only per-entrance
    # identifier OSM usually has is the street number. Show it as "nr. 4" (never as
    # "Sc. 4": that would claim a staircase number we do not know).
    hn = (t.get("addr:housenumber") or "").strip()
    if hn:
        return f"nr. {hn}", "addr:housenumber"
    return "", None


NUM_TOKEN = re.compile(r"(\d+)\s*([A-Za-z]?)")


def number_tokens(*values):
    """All street numbers a building answers to: '2-6' -> {2,4,6}, '30A, 30B' -> {30A,30B}."""
    out = set()
    for v in values:
        v = (v or "").replace("\u2013", "-")
        for a, b in re.findall(r"(\d+)\s*-\s*(\d+)", v):
            a, b = int(a), int(b)
            if a < b and b - a <= 40:
                out.update(str(n) for n in range(a, b + 1, 2 if (b - a) % 2 == 0 else 1))
        for num, letter in NUM_TOKEN.findall(v):
            out.add(num + letter.upper())
        for m in re.finditer(r"(\d+)\s*([A-Za-z])(?:\s*[/,]\s*([A-Za-z]))+", v):  # '32 A/B'
            for letter in re.findall(r"[A-Za-z]", v[m.start(2):m.end()]):
                out.add(m.group(1) + letter.upper())
    return out


def numbers_match(a, b):
    """Token sets match exactly, or one side is the bare number of a lettered one ('6' ~ '6A')."""
    if a & b:
        return True
    base = lambda tokens: {re.sub(r"[A-Z]$", "", x) for x in tokens}
    return bool(base(a) & {x for x in b if x.isdigit()} or {x for x in a if x.isdigit()} & base(b))


def is_stair_label(label):
    return bool(label) and not label.startswith("nr. ")


# ----------------------------------------------------------------------------
# Processing
# ----------------------------------------------------------------------------

def process(raw):
    els = raw.get("elements", [])
    buildings = []      # dicts with poly or point
    addr_nodes = []
    entrances = []
    places = []

    for e in els:
        t = e.get("tags", {})
        typ = e["type"]
        if typ == "node":
            if "entrance" in t:
                entrances.append(e)
            elif "place" in t and "name" in t and not ("building" in t or "addr:housenumber" in t):
                places.append(e)
            elif "building" in t and ("addr:housenumber" in t or "addr:block" in t):
                buildings.append({"el": e, "poly": None, "pt": (e["lat"], e["lon"])})
            elif "addr:housenumber" in t or "addr:block" in t:
                addr_nodes.append(e)
            continue
        if "building" not in t:
            continue
        if typ == "way":
            g = [(p["lat"], p["lon"]) for p in e.get("geometry", []) if p]
            if len(g) < 4 or g[0] != g[-1]:
                continue
            buildings.append({"el": e, "poly": Poly([g], []), "nodes": set(e.get("nodes", []))})
        elif typ == "relation":
            outer, inner = [], []
            for m in e.get("members", []):
                if m.get("type") != "way" or not m.get("geometry"):
                    continue
                g = [(p["lat"], p["lon"]) for p in m["geometry"] if p]
                (inner if m.get("role") == "inner" else outer).append(g)
            outers = join_rings(outer)
            if not outers:
                continue
            buildings.append({"el": e, "poly": Poly(outers, join_rings(inner)), "nodes": set()})

    # spatial index of polygons
    grid = Grid()
    node_to_b = defaultdict(list)
    for b in buildings:
        if b["poly"]:
            grid.add(b["poly"].bbox, b)
            for nid in b.get("nodes", ()):
                node_to_b[nid].append(b)

    def containing(px, py):
        hits = [b for b in grid.near(px, py, 1) if b["poly"].contains(px, py)]
        return min(hits, key=lambda b: b["poly"].area) if hits else None

    # address nodes: give their numbers to the building they sit in
    for b in buildings:
        b["extra_numbers"], b["extra_blocks"], b["extra_streets"] = [], [], []
    loose_addr = 0
    point_feats = []
    for n in addr_nodes:
        t = n["tags"]
        px, py = xy(n["lat"], n["lon"])
        b = containing(px, py)
        if b is not None:
            if t.get("addr:housenumber"):
                b["extra_numbers"].append(t["addr:housenumber"].strip())
            if t.get("addr:block"):
                b["extra_blocks"].append(t["addr:block"].strip())
            if t.get("addr:street"):
                b["extra_streets"].append(t["addr:street"].strip())
        else:
            loose_addr += 1
            point_feats.append({"el": n, "poly": None, "pt": (n["lat"], n["lon"]), "addr_only": True,
                                "extra_numbers": [], "extra_blocks": [], "extra_streets": []})

    # entrances -> building
    ent_feats = []
    link_method = Counter()
    for n in entrances:
        t = n["tags"]
        label, label_key = entrance_label(t)
        px, py = xy(n["lat"], n["lon"])
        target, method, dist = None, None, None
        on = [b for b in node_to_b.get(n["id"], [])]
        if on:
            target = min(on, key=lambda b: b["poly"].area)
            method, dist = "outline", 0.0
        else:
            best = None
            hn = (t.get("addr:housenumber") or "").strip()
            want = number_tokens(hn) if hn else set()
            for b in grid.near(px, py, ENTRANCE_LINK_MAX_M):
                p = b["poly"]
                d = 0.0 if p.contains(px, py) else p.edge_distance(px, py)
                if d > ENTRANCE_LINK_MAX_M:
                    continue
                # an entrance that carries a street number may only attach to a building
                # with that number (otherwise it lands on the neighbouring block)
                if want:
                    if "tokens" not in b:
                        bt = b["el"].get("tags", {})
                        b["tokens"] = number_tokens(bt.get("addr:housenumber"), *b["extra_numbers"])
                    if not numbers_match(want, b["tokens"]):
                        continue
                # prefer apartment blocks a little when distances are similar
                score = d - (3 if b["el"]["tags"].get("building") == "apartments" else 0)
                if best is None or score < best[0]:
                    best = (score, d, b)
            if best:
                target, dist = best[2], best[1]
                method = "inside" if dist == 0 else "nearest"
        link_method[method or "none"] += 1
        bid = f"{target['el']['type'][0]}{target['el']['id']}" if target else None
        ent_f = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [n["lon"], n["lat"]]},
            "properties": {
                "id": f"n{n['id']}",
                "label": label,
                "label_key": label_key,
                "entrance": t.get("entrance"),
                "building_id": bid,
                "link": method,
                "dist_m": None if dist is None else round(dist, 1),
                "housenumber": t.get("addr:housenumber"),
                "wheelchair": t.get("wheelchair"),
                "tags": t,
            },
        }
        ent_feats.append(ent_f)
        if target is not None:
            target.setdefault("ent_feats", []).append(ent_f)

    # building features
    def sort_key(s):
        m = re.match(r"(\d+)(.*)", s or "")
        return (0, int(m.group(1)), m.group(2)) if m else (1, 0, s or "")

    feats = []
    for b in buildings + point_feats:
        e = b["el"]
        t = dict(e.get("tags", {}))
        derived = {}
        if not t.get("addr:housenumber") and b["extra_numbers"]:
            nums = sorted(set(b["extra_numbers"]), key=sort_key)
            t["addr:housenumber"] = ", ".join(nums)
            derived["housenumber_from"] = "address node(s) inside"
        if not t.get("addr:block") and b["extra_blocks"]:
            t["addr:block"] = ", ".join(sorted(set(b["extra_blocks"]), key=sort_key))
            derived["block_from"] = "address node(s) inside"
        if not t.get("addr:street") and b["extra_streets"]:
            t["addr:street"] = sorted(set(b["extra_streets"]))[0]
        efs = b.get("ent_feats", [])
        # a lone entrance (or entrances that all repeat the building's own number) adds
        # nothing on the map: keep the data but hide the duplicate pill
        hn_b = fold(t.get("addr:housenumber"))
        num_efs = [x for x in efs if x["properties"]["label_key"] == "addr:housenumber"]
        if num_efs and (len(efs) == 1 or {fold(x["properties"]["housenumber"]) for x in num_efs} == {hn_b}):
            for x in num_efs:
                x["properties"]["label"], x["properties"]["redundant"] = "", True
        ents = sorted({x["properties"]["label"] for x in efs if is_stair_label(x["properties"]["label"])},
                      key=lambda s: (len(s), s))
        ent_nums = sorted({x["properties"]["housenumber"] for x in efs
                           if x["properties"]["label"] and not is_stair_label(x["properties"]["label"])}, key=sort_key)
        n_unlabelled = sum(1 for x in efs if not x["properties"]["label"] and not x["properties"].get("redundant"))
        is_apts = t.get("building") == "apartments"
        kind = "address" if b.get("addr_only") else ("apartments" if is_apts else "other")
        props = {
            "id": f"{e['type'][0]}{e['id']}",
            "kind": kind,
            "label": building_label(t),
            "block": block_of(t) or None,
            "housenumber": t.get("addr:housenumber"),
            "street": t.get("addr:street") or t.get("addr:place"),
            "name": t.get("name"),
            "ref": t.get("ref"),
            "levels": t.get("building:levels"),
            "building": t.get("building"),
            "entrances": ents,
            "entrance_nums": ent_nums,
            "entrances_unlabelled": n_unlabelled,
            **derived,
        }
        if b["poly"]:
            p = b["poly"]
            lat, lon = p.label_point()
            props["lp"] = [lat, lon]
            rings = [[[round(lo, 7), round(la, 7)] for la, lo in r] for r in p.outers]
            holes = [[[round(lo, 7), round(la, 7)] for la, lo in r] for r in p.inners]
            if len(rings) == 1:
                geom = {"type": "Polygon", "coordinates": rings + holes}
            else:  # holes are attached to the first ring (good enough for display)
                geom = {"type": "MultiPolygon", "coordinates": [[rings[0]] + holes] + [[r] for r in rings[1:]]}
        else:
            lat, lon = b["pt"]
            props["lp"] = [lat, lon]
            geom = {"type": "Point", "coordinates": [lon, lat]}
        feats.append({"type": "Feature", "geometry": geom, "properties": props, "_tags": e.get("tags", {})})

    return feats, ent_feats, places, link_method, loose_addr


# ----------------------------------------------------------------------------
# Roads + orientation context (our own street map, no tiles needed)
# ----------------------------------------------------------------------------

MIN_FOOTWAY_M = 15          # unnamed footway/path/steps shorter than this are noise
ROAD_SIMPLIFY_M = 0.8       # Douglas-Peucker tolerance for roads
CONTEXT_SIMPLIFY_M = 2.0
MIN_PARK_M2 = 5000          # parks and squares big enough to orient by (Parcul Municipal ~11k m²)
MIN_WATER_M2 = 2500
MINOR_UNNAMED = {"footway", "path", "steps"}


def path_length_m(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def simplify_xy(pts, tol):
    """Douglas-Peucker on [(x, y), ...] (metres); keeps the end points."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        best, idx = -1.0, None
        for i in range(a + 1, b):
            d = dist_point_seg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1])
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep.add(idx)
            stack.append((a, idx))
            stack.append((idx, b))
    return sorted(keep)


def simplified_lonlat(latlon, tol, digits):
    pts = [xy(la, lo) for la, lo in latlon]
    return [[round(latlon[i][1], digits), round(latlon[i][0], digits)] for i in simplify_xy(pts, tol)]


def process_roads(raw):
    feats, dropped = [], Counter()
    for e in raw.get("elements", []):
        t = e.get("tags", {})
        h = t.get("highway")
        g = [(p["lat"], p["lon"]) for p in e.get("geometry", []) if p]
        if e["type"] != "way" or not h or len(g) < 2:
            continue
        if h == "service" and t.get("service") == "parking_aisle":
            dropped["parking_aisle"] += 1
            continue
        pts = [xy(la, lo) for la, lo in g]
        named = bool(t.get("name"))
        if h in MINOR_UNNAMED and not named and path_length_m(pts) < MIN_FOOTWAY_M:
            dropped["short unnamed footway"] += 1
            continue
        coords = simplified_lonlat(g, ROAD_SIMPLIFY_M, 6)
        props = {"h": h}
        for k, v in (("n", t.get("name")), ("r", t.get("ref")), ("o", t.get("oneway")),
                     ("s", t.get("service")), ("a", t.get("access"))):
            if v and v not in ("no",) :
                props[k] = v
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props})
    return feats, dropped


def process_context(raw):
    feats, kept = [], Counter()

    def add(kind, geom, name=None):
        props = {"k": kind}
        if name:
            props["n"] = name
        feats.append({"type": "Feature", "geometry": geom, "properties": props})
        kept[kind] += 1

    for e in raw.get("elements", []):
        t = e.get("tags", {})
        name = t.get("name")
        if e["type"] == "way":
            g = [(p["lat"], p["lon"]) for p in e.get("geometry", []) if p]
            if len(g) < 2:
                continue
            if t.get("waterway") == "river":
                add("river", {"type": "LineString", "coordinates": simplified_lonlat(g, CONTEXT_SIMPLIFY_M, 5)}, name)
            elif t.get("railway") == "rail":
                if t.get("service") in ("yard", "siding", "spur"):
                    continue
                add("rail", {"type": "LineString", "coordinates": simplified_lonlat(g, CONTEXT_SIMPLIFY_M, 5)})
            elif g[0] == g[-1] and len(g) >= 4:
                rings = [g]
                kind = "water" if t.get("natural") == "water" else "park"
                area = abs(ring_area_xy([xy(la, lo) for la, lo in g]))
                if area >= (MIN_WATER_M2 if kind == "water" else MIN_PARK_M2):
                    add(kind, {"type": "Polygon", "coordinates": [simplified_lonlat(g, CONTEXT_SIMPLIFY_M, 5)]}, name)
        elif e["type"] == "relation":
            kind = "water" if t.get("natural") == "water" else ("park" if t.get("leisure") == "park" else None)
            if not kind:
                continue
            outer = [[(p["lat"], p["lon"]) for p in m["geometry"] if p] for m in e.get("members", [])
                     if m.get("type") == "way" and m.get("geometry") and m.get("role") != "inner"]
            for ring in join_rings(outer):
                area = abs(ring_area_xy([xy(la, lo) for la, lo in ring]))
                if area >= (MIN_WATER_M2 if kind == "water" else MIN_PARK_M2):
                    add(kind, {"type": "Polygon", "coordinates": [simplified_lonlat(ring, CONTEXT_SIMPLIFY_M, 5)]}, name)
    return feats, kept


def write_geojson(path, feats, meta):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "metadata": meta, "features": feats}, fh,
                  ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def build_roads_and_context(roads_raw, context_raw, meta):
    rf, dropped = process_roads(roads_raw)
    cf, kept = process_context(context_raw)
    rs = write_geojson(os.path.join(DATA, "roads.geojson"), rf, meta)
    cs = write_geojson(os.path.join(DATA, "context.geojson"), cf, meta)
    classes = Counter(f["properties"]["h"] for f in rf)
    named = {f["properties"]["n"] for f in rf if f["properties"].get("n")}
    print(f"\nroads.geojson:   {len(rf)} ways, {len(named)} distinct street names, {rs/1e6:.2f} MB  "
          f"(dropped: {dict(dropped)})")
    print("  by class:", dict(classes.most_common()))
    print(f"context.geojson: {len(cf)} features {dict(kept)}, {cs/1e6:.2f} MB")
    return {"roads": len(rf), "street_names": len(named), "roads_bytes": rs, "context_bytes": cs}


def report(feats, ent_feats, places, link_method, loose_addr):
    polys = [f for f in feats if f["properties"]["kind"] != "address"]
    apts = [f for f in polys if f["properties"]["kind"] == "apartments"]
    labelled = [f for f in polys if f["properties"]["label"]]
    apts_lab = [f for f in apts if f["properties"]["label"]]
    apts_blk = [f for f in apts if f["properties"]["block"]]
    apts_ent = [f for f in apts if f["properties"]["entrances"]]
    apts_num = [f for f in apts if f["properties"]["entrance_nums"]]
    ents_lab = [f for f in ent_feats if is_stair_label(f["properties"]["label"])]
    ents_num = [f for f in ent_feats if f["properties"]["label"] and not is_stair_label(f["properties"]["label"])]
    ents_linked = [f for f in ent_feats if f["properties"]["building_id"]]

    def pct(a, b):
        return f"{(100.0 * a / b):.0f}%" if b else "–"

    print("\n================ SUMMARY ================")
    print(f"Buildings (outlines + building nodes): {len(polys)}")
    print(f"  with a number or label:              {len(labelled)}  ({pct(len(labelled), len(polys))})")
    print(f"  building=apartments:                 {len(apts)}")
    print(f"    … with number/label:               {len(apts_lab)}  ({pct(len(apts_lab), len(apts))})")
    print(f"    … with addr:block (Bl.):           {len(apts_blk)}  ({pct(len(apts_blk), len(apts))})")
    print(f"    … with ≥1 labelled staircase:      {len(apts_ent)}  ({pct(len(apts_ent), len(apts))})")
    print(f"    … with entrance street numbers:    {len(apts_num)}  ({pct(len(apts_num), len(apts))})")
    print(f"Loose address points (not in a bldg):  {loose_addr}")
    print(f"Entrances:                             {len(ent_feats)}")
    print(f"  with a staircase label (Sc. …):      {len(ents_lab)}  ({pct(len(ents_lab), len(ent_feats))})")
    print(f"  with only a street number (nr. …):   {len(ents_num)}  ({pct(len(ents_num), len(ent_feats))})")
    print(f"  linked to a building:                {len(ents_linked)}  ({pct(len(ents_linked), len(ent_feats))})"
          f"   [outline {link_method['outline']}, inside {link_method['inside']}, "
          f"nearest≤{ENTRANCE_LINK_MAX_M}m {link_method['nearest']}, none {link_method['none']}]")

    print("\nTag usage on buildings (outlines):")
    for k in ("addr:housenumber", "addr:block", "addr:street", "name", "ref", "building:levels", "addr:place"):
        c = sum(1 for f in polys if f["_tags"].get(k))
        ca = sum(1 for f in apts if f["_tags"].get(k))
        print(f"  {k:18s} all {c:6d}   apartments {ca:6d}")
    print("Tag usage on entrances:")
    for k in ("entrance:ref", "ref", "addr:unit", "addr:entrance", "addr:staircase", "name", "addr:housenumber"):
        c = sum(1 for f in ent_feats if f["properties"]["tags"].get(k))
        print(f"  {k:18s} {c:6d}")
    print("  entrance=* values:", dict(Counter(f["properties"]["entrance"] for f in ent_feats).most_common(8)))

    rnd = random.Random(42)
    sample_pool = [f for f in apts if f["properties"]["label"]] or labelled
    print("\n20 sample building labels (apartment blocks first):")
    for f in rnd.sample(sample_pool, min(20, len(sample_pool))):
        t = f["_tags"]
        raw = {k: t[k] for k in ("addr:street", "addr:housenumber", "addr:block", "name", "ref", "building:levels") if k in t}
        p = f["properties"]
        extra = " (nr from address node)" if p.get("housenumber_from") else ""
        print(f"  {p['label']!s:28s} ← {raw}{extra}  sc: {', '.join(p['entrances']) or '–'}")
    print("\n12 sample entrance labels (staircase codes first, then street numbers):")
    pool = ents_lab + rnd.sample(ents_num, min(9, len(ents_num)))
    for f in pool[:12]:
        t = f["properties"]["tags"]
        raw = {k: t[k] for k in ("entrance", "entrance:ref", "ref", "addr:unit", "addr:entrance", "name") if k in t}
        print(f"  {f['properties']['label']!s:10s} ← {raw}")
    odd = [f["properties"]["label"] for f in ents_lab if not f["properties"]["label"].startswith("Sc. ")]  # e.g. free-text names
    if odd:
        print(f"Entrance labels not in 'Sc. X' form ({len(odd)}):", Counter(odd).most_common(15))

    # neighbourhood coverage (nearest place node within 2.5 km)
    by_place = defaultdict(lambda: [0, 0, 0])
    pxy = [(p["tags"]["name"], xy(p["lat"], p["lon"])) for p in places]
    for f in apts:
        lat, lon = f["properties"]["lp"]
        x, y = xy(lat, lon)
        name = "(no nearby place node)"
        if pxy:
            nm, (qx, qy) = min(pxy, key=lambda q: (q[1][0] - x) ** 2 + (q[1][1] - y) ** 2)
            if math.hypot(qx - x, qy - y) < 2500:
                name = nm
        s = by_place[name]
        s[0] += 1
        s[1] += bool(f["properties"]["label"])
        s[2] += bool(f["properties"]["entrances"])
    rows = sorted(by_place.items(), key=lambda kv: -kv[1][0])
    print("\nApartment-block coverage by neighbourhood (nearest OSM place node):")
    print(f"  {'neighbourhood':28s} {'blocks':>6s} {'labelled':>9s} {'w/ stairs':>9s}")
    for name, (n, l, s) in rows:
        print(f"  {name[:28]:28s} {n:6d} {pct(l, n):>9s} {pct(s, n):>9s}")

    return {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "buildings": len(polys), "buildings_labelled": len(labelled),
        "apartments": len(apts), "apartments_labelled": len(apts_lab),
        "apartments_with_block": len(apts_blk), "apartments_with_stairs": len(apts_ent),
        "apartments_with_entrance_numbers": len(apts_num),
        "address_points": loose_addr,
        "entrances": len(ent_feats), "entrances_labelled": len(ents_lab), "entrances_numbered": len(ents_num),
        "entrances_linked": len(ents_linked),
        "neighbourhoods": [{"name": n, "blocks": v[0], "labelled": v[1], "with_stairs": v[2]} for n, v in rows],
    }


def load_or_download(path, query, label):
    print(f"\n== {label} ==")
    raw = download(query)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False)
    print("saved", path)
    return raw


def roads_queries():
    b = "{},{},{},{}".format(*BBOX)
    return (ROADS_QUERY.format(t=OVERPASS_TIMEOUT, b=b, classes=ROAD_CLASSES),
            CONTEXT_QUERY.format(t=OVERPASS_TIMEOUT, b=b))


def main():
    os.makedirs(DATA, exist_ok=True)
    from_raw = "--from-raw" in sys.argv
    roads_only = "--roads-only" in sys.argv
    q_roads, q_context = roads_queries()

    def load(path, query, label):
        if from_raw:
            with open(path, encoding="utf-8") as fh:
                raw = json.load(fh)
            print(f"Re-processing {path} ({len(raw.get('elements', []))} elements)")
            return raw
        return load_or_download(path, query, label)

    if not roads_only:
        if from_raw:
            with open(RAW_PATH, encoding="utf-8") as fh:
                raw = json.load(fh)
            print(f"Re-processing {RAW_PATH} ({len(raw.get('elements', []))} elements)")
        else:
            raw = download()
            with open(RAW_PATH, "w", encoding="utf-8") as fh:
                json.dump(raw, fh, ensure_ascii=False)
            print("saved", RAW_PATH)

        feats, ent_feats, places, link_method, loose_addr = process(raw)
        stats = report(feats, ent_feats, places, link_method, loose_addr)

        osm_ts = (raw.get("osm3s") or {}).get("timestamp_osm_base")
        stats["osm_timestamp"] = osm_ts
        for f in feats:
            f.pop("_tags", None)
        for f in ent_feats:  # keep only the tags that matter
            f["properties"]["tags"] = {k: v for k, v in f["properties"]["tags"].items()
                                       if k.startswith(("entrance", "ref", "addr:", "name", "level", "door"))}
        meta = {"source": "© OpenStreetMap contributors, ODbL", "osm_timestamp": osm_ts}
        write_geojson(os.path.join(DATA, "blocks.geojson"), feats, meta)
        write_geojson(os.path.join(DATA, "entrances.geojson"), ent_feats, meta)
        with open(os.path.join(DATA, "stats.json"), "w", encoding="utf-8") as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=1)
        print("\nwrote data/blocks.geojson, data/entrances.geojson, data/stats.json")
        print(f"OSM data timestamp: {osm_ts}")

    if from_raw and not (os.path.exists(RAW_ROADS_PATH) and os.path.exists(RAW_CONTEXT_PATH)):
        print("\n(no raw_roads.json / raw_context.json yet: run without --from-raw to fetch roads)")
        return
    roads_raw = load(RAW_ROADS_PATH, q_roads, "roads")
    context_raw = load(RAW_CONTEXT_PATH, q_context, "context (river, water, parks, railways)")
    ts = (roads_raw.get("osm3s") or {}).get("timestamp_osm_base")
    info = build_roads_and_context(roads_raw, context_raw, {"source": "© OpenStreetMap contributors, ODbL", "osm_timestamp": ts})
    sp = os.path.join(DATA, "stats.json")
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as fh:
            st = json.load(fh)
        st.update(info)
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump(st, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
