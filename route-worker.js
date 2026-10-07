/* Routing off the main thread: builds the graph from data/roads.geojson (sent by app.js as raw bytes)
   and answers route requests, so the map never freezes while a route is worked out. */
importScripts("route.js");
var router = null;
self.onmessage = function (e) {
  var m = e.data;
  if (m.type === "data") {
    router = BlokkRouter.fromGeoJSON(JSON.parse(new TextDecoder().decode(m.buf)));
  } else if (m.type === "route") {
    var res = null;
    try { res = router ? router.route(m.from, m.to, m.mode) : null; } catch (err) { console.warn(err); }
    self.postMessage({ type: "route", id: m.id, res: res });
  }
};
