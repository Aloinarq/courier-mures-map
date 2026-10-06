# Next step: real data + verification

You're continuing work on this repo: an offline-capable Leaflet map of apartment blocks ("blocuri") and their staircases ("scara A/B/C…") in Târgu Mureș, Romania, for a food-delivery courier. Read README.md, fetch_data.py and app.js first. The code was written and tested only on a small made-up dataset, because the previous environment couldn't reach Overpass or the map tiles. Your job is to run it against real data, adjust it to real data, and verify it.

**Hard rule:** use ONLY OpenStreetMap data (Overpass API). Do NOT extract, scrape, decompile or intercept data from the Glovo Rider app or any other proprietary map service. Do not pre-fill data/overrides.csv from any source.

## 0. Network check (do this first)
Check `curl -sS -o /dev/null -w '%{http_code}' https://overpass-api.de/api/status` and a CARTO tile such as `https://a.basemaps.cartocdn.com/light_all/13/4700/2900.png`. If either is blocked, STOP and tell me. This environment's network access must be set to Full (or allow overpass-api.de, overpass.kumi.systems, overpass.private.coffee, *.basemaps.cartocdn.com). Don't try to work around a block.

## 1. Fetch real data
- Run `python3 fetch_data.py`. If it fails (SSL, timeout, HTTP 429/504, Overpass "remark" errors), debug it and report exactly what happened. Don't silently fall back or shrink the bounding box.
- Confirm data/raw_overpass.json, data/blocks.geojson, data/entrances.geojson and data/stats.json exist, and give their sizes.

## 2. Adapt labelling to how this city is actually tagged
- Write a throwaway analysis (not committed) over data/raw_overpass.json:
  - Count how often each tag appears on building=apartments and on entrance=* nodes.
  - Show the 30 most common distinct values of addr:housenumber, addr:block, name and ref on apartment blocks.
  - Show the same for entrance ref, entrance:ref, addr:unit, addr:entrance and name.
  - Look for local patterns, e.g. "Bl. 12", "12/A", "bl.3 sc.A", block numbers in name or ref, addr:housenumber holding a block number, entrances with addr:housenumber instead of a staircase letter, and staircase info stored on the building instead of on entrance nodes.
- Update building_label(), block_of() and entrance_label() in fetch_data.py to handle the real patterns. Keep the rules: block shown as "Bl. X", 1–3 character staircase codes shown as "Sc. A", no duplicates.
- Re-run with `python3 fetch_data.py --from-raw` and show before/after samples for 20 blocks and 12 entrances.
- Check entrance→building linking: counts linked via outline, inside, nearest ≤50 m, and not at all. Spot-check 5 "nearest" links.

## 3. Verify the map in a real browser
- `python3 -m http.server 8000`, then open http://localhost:8000 with Playwright/Chromium at 390×844 (phone) and one desktop size.
- Screenshot and look at:
  - (a) z14 whole city, with tiles loading.
  - (b) z16 in a dense block area such as Tudor Vladimirescu, Dâmbul Pietros or 7 Noiembrie, with block labels visible.
  - (c) z17–18 with orange staircase pills.
  - (d) a popup.
  - (e) search for "ialomita", "bl 12" and "bloc 3", plus one real street+number from the data.
- Fix label collisions, unreadable text, pills covering block labels, slow panning (measure render time at z16 in the densest area), and any console errors.
- Check that the service worker registers, and that the ⤓ dialog shows a tile count and an MB estimate. Report the real numbers, and propose a smaller set if z17–18 is over ~150 MB.

## 4. Commit
Commit the generated data/blocks.geojson, data/entrances.geojson and data/stats.json, but NOT data/raw_overpass.json (it's gitignored), along with your code changes. Push to a new branch `real-data`. Don't merge to main and don't enable GitHub Pages; I'll do that.

## 5. Report honestly
- Real coverage: buildings, apartment blocks with a number/label (% of total), blocks with ≥1 labelled staircase, entrances total and labelled.
- The neighbourhood table, stating clearly which neighbourhoods are well covered and which are weak or empty. If most blocks have no number in OSM, say so plainly.
- What you changed and why.
- The most useful next step, e.g. which areas to fill by hand in overrides.csv or by editing OSM (addr:block on buildings, entrance=staircase + ref=A on entrances).
