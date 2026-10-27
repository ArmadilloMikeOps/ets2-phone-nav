// Карта на вкладці «Навігація»: MapLibre + pmtiles, вантажівка й точка призначення.
//
// Режими камери:
//   follow   — вантажівка в нижній частині екрана, карта повернута за курсом,
//              масштаб залежить від швидкості (+/− зсувають його).
//   overview — північ угорі, видно вантажівку й точку призначення разом.
//
// Карта навмисно неінтерактивна (без перетягування): свайп по ній гортає вкладки,
// а за кермом потрібні лише кнопки.

import { buildStyle } from "./map-style.js";
import { toLngLat, headingToBearing } from "./projection.js";

/* global maplibregl, pmtiles */

const TILES_BASE = new URL("tiles/", location.href).href;

let map = null;
let currentGame = null;
let truckMarker = null;
let destMarker = null;
let mode = "follow";
let zoomOffset = 0;

// ціль камери оновлюється з кожним кадром телеметрії, а реальна камера плавно до неї тягнеться
const target = { lng: 0, lat: 0, bearing: 0, zoom: 12, speedKmh: 0, valid: false };
const cam = { lng: 0, lat: 0, bearing: 0, zoom: 12, init: false };
let destLngLat = null;

// маршрут: повна лінія з /api/route + прогрес із кожного кадру стану
let routeCoords = null;
let routeId = null;
let routeLoading = false;
let lastTruck = [0, 0];
let lastProgress = 0;
const EMPTY = { type: "FeatureCollection", features: [] };

function addRouteLayers() {
  if (map.getSource("route")) return;
  map.addSource("route", { type: "geojson", data: EMPTY });
  const before = map.getLayer("cities-small") ? "cities-small" : undefined;
  // ["zoom"] дозволений лише на верхньому рівні interpolate — тож обводка має власну шкалу, а не ["*", width, 1.5]
  const width = ["interpolate", ["exponential", 1.5], ["zoom"], 4, 3, 10, 6, 14, 14, 16, 30];
  const caseWidth = ["interpolate", ["exponential", 1.5], ["zoom"], 4, 4.5, 10, 9, 14, 21, 16, 45];
  map.addLayer({
    id: "route-case",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#4a0809", "line-width": caseWidth },
  }, before);
  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#e5252a", "line-width": width },
  }, before);
  drawRoute(lastTruck, lastProgress);
}

async function loadRoute(id) {
  routeLoading = true;
  try {
    const r = await fetch("api/route", { cache: "no-store" }).then((res) => res.json());
    routeCoords = r && r.id === id ? r.coords : null;
    routeId = r ? r.id : null;
  } catch {
    // наступний кадр стану спробує ще раз
  } finally {
    routeLoading = false;
  }
}

function drawRoute(truckLngLat, progress) {
  const src = map.getSource("route");
  if (!src) return;
  if (!routeCoords) {
    src.setData(EMPTY);
    return;
  }
  // лише залишок шляху, і починається він від вантажівки, а не від найближчої точки
  const rest = routeCoords.slice(Math.max(0, progress + 1));
  src.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [truckLngLat, ...rest] } });
}

function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstChild;
}

function createMap(container, game, hasWorld) {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  map = new maplibregl.Map({
    container,
    style: buildStyle(game, TILES_BASE, hasWorld),
    center: [10, 50],
    zoom: 5,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
  });
  currentGame = game;
  window.__navMap = map; // для налагодження з консолі
  map.on("style.load", addRouteLayers); // і після setStyle при зміні гри

  truckMarker = new maplibregl.Marker({
    element: el(`<svg class="truck-marker" viewBox="0 0 40 40" width="40" height="40">
      <circle cx="20" cy="20" r="18" fill="#0b0d10" fill-opacity="0.55"/>
      <path d="M20 5 L31 32 L20 26 L9 32 Z" fill="#ffb020" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`),
    rotationAlignment: "map",
  });
  destMarker = new maplibregl.Marker({
    element: el(`<svg class="dest-marker" viewBox="0 0 32 40" width="32" height="40">
      <path d="M16 39 C16 39 3 23 3 15 a13 13 0 0 1 26 0 C29 23 16 39 16 39 Z" fill="#3ddc84" stroke="#000" stroke-width="1.5"/>
      <circle cx="16" cy="15" r="5" fill="#0b0d10"/>
    </svg>`),
    anchor: "bottom",
  });

  requestAnimationFrame(tick);
}

// масштаб за швидкістю: стоїмо — ближче, трасою — далі
function autoZoom(kmh) {
  const t = Math.min(Math.max(kmh, 0), 90) / 90;
  return 15 - t * 3 + zoomOffset;
}

function shortestAngle(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function tick() {
  requestAnimationFrame(tick);
  if (!map || !target.valid || mode !== "follow") return;

  const k = cam.init ? 0.15 : 1;
  cam.lng += (target.lng - cam.lng) * k;
  cam.lat += (target.lat - cam.lat) * k;
  cam.bearing += shortestAngle(cam.bearing, target.bearing) * k;
  cam.zoom += (autoZoom(target.speedKmh) - cam.zoom) * (cam.init ? 0.05 : 1);
  cam.init = true;

  const h = map.getContainer().clientHeight;
  map.jumpTo({
    center: [cam.lng, cam.lat],
    bearing: cam.bearing,
    zoom: cam.zoom,
    padding: { top: h * 0.4, bottom: 0, left: 0, right: 0 },
  });
}

function overview() {
  if (!map || !target.valid) return;
  const pts = [[target.lng, target.lat]];
  if (destLngLat) pts.push(destLngLat);
  if (routeCoords) pts.push(...routeCoords);
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  // відступи з урахуванням панелей поверх карти, щоб маркери не ховались під ними
  const box = map.getContainer().getBoundingClientRect();
  const info = document.querySelector(".nav-info")?.getBoundingClientRect();
  const side = document.querySelector(".overlay.nav-side")?.getBoundingClientRect();
  const padding = {
    top: 40,
    bottom: 40,
    left: (info ? info.right - box.left : 0) + 30,
    right: (side ? box.right - side.left : 0) + 30,
  };
  if (padding.left + padding.right > box.width - 40) {
    padding.left = padding.right = 30; // вузький екран — панелі однаково перекриють
  }
  map.fitBounds(b, { padding, bearing: 0, maxZoom: 13, duration: 600 });
}

export function setMode(m) {
  mode = m;
  if (mode === "overview") overview();
  else cam.init = false;
}

export function getMode() {
  return mode;
}

export function zoomBy(delta) {
  if (mode === "follow") {
    zoomOffset = Math.max(-6, Math.min(4, zoomOffset + delta));
  } else if (map) {
    map.zoomTo(map.getZoom() + delta, { duration: 250 });
  }
}

/**
 * Викликається на кожен стан із companion.
 * Повертає false, якщо карту показати не можна (немає тайлів для цієї гри).
 */
export function updateMap(container, d, tiles) {
  const game = d.game_id === "ats" ? "ats" : "eut2";
  const tileKey = game === "ats" ? "ats" : "ets2";
  if (!tiles.includes(tileKey)) return false;

  if (!map) createMap(container, game, tiles.includes("world"));
  else if (currentGame !== game) {
    map.setStyle(buildStyle(game, TILES_BASE, tiles.includes("world")));
    currentGame = game;
    cam.init = false;
  }

  const [lng, lat] = toLngLat(game, d.pos_x, d.pos_z);
  const bearing = headingToBearing(d.heading);
  Object.assign(target, { lng, lat, bearing, speedKmh: Math.abs(d.speed) * 3.6, valid: true });
  truckMarker.setLngLat([lng, lat]).setRotation(bearing).addTo(map);

  if (d.dest_x !== null && d.dest_y !== null) {
    const next = toLngLat(game, d.dest_x, d.dest_y);
    const changed = !destLngLat || next[0] !== destLngLat[0] || next[1] !== destLngLat[1];
    destLngLat = next;
    destMarker.setLngLat(destLngLat).addTo(map);
    if (changed && mode === "overview") overview();
  } else {
    destLngLat = null;
    destMarker.remove();
  }

  if (d.route_id == null) {
    routeCoords = null;
    routeId = null;
  } else if (d.route_id !== routeId && !routeLoading) {
    const fresh = routeId === null;
    // на паузі нових кадрів стану не буде — малюємо одразу після завантаження
    loadRoute(d.route_id).then(() => {
      drawRoute(lastTruck, lastProgress);
      if (fresh && mode === "overview") overview();
    });
  }
  lastTruck = [lng, lat];
  lastProgress = d.route_progress ?? 0;
  drawRoute(lastTruck, lastProgress);
  return true;
}
