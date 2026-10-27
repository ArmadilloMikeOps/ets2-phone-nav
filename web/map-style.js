// Стиль MapLibre для карт ETS2/ATS у темній темі.
// Кольори й вирази — з packages/libs/ui/GameMapStyle.tsx і colors.ts
// (truckermudgeon/maps, GPL-3), спрощено під навігатор: без POI-іконок і спрайтів.

const C = {
  land: "#1a1a1a",
  water: "#36415d",
  countryBorder: "#333",
  ferry: "#6c90ff88",
  mapAreaOutline: "#777a",
};

// roadType → [лінія, обведення]
const ROADS = {
  freeway: ["#95813e", "#372f21"],
  divided: ["#3c4043", "#4c5043"],
  no_vehicles: ["#606166", "#888888"],
  local: ["#606166", "#333"],
  train: ["#ff0000", "#f8c248"],
  tram: ["#00ff00", "#f8c248"],
  unknown: ["#f0f", "#f0f"],
};

// MapAreaColor: 0 road, 1 light, 2 dark, 3 green, 4–8 nav-кольори з map_data.sii
const AREAS = [
  "hsl(200, 2%, 36%)",
  "hsl(38, 25%, 35%)",
  "hsl(38, 25%, 25%)",
  "hsl(143, 20%, 25%)",
  "hsl(0, 100%, 25%)",
  "hsl(107, 51%, 25%)",
  "hsl(201, 53%, 25%)",
  "hsl(53, 84%, 25%)",
  "hsl(267, 46%, 25%)",
];

const match = (prop, pairs, fallback) => ["match", ["get", prop], ...pairs.flat(), fallback];
const roadColor = match("roadType", Object.entries(ROADS).map(([k, v]) => [k, v[0]]), "#f0f");
const roadCaseColor = match("roadType", Object.entries(ROADS).map(([k, v]) => [k, v[1]]), "#b0b");
const areaColor = match("color", AREAS.map((c, i) => [i, c]), "#b0b");

const roadWidth = ["interpolate", ["exponential", 1.5], ["zoom"], 3, 0.8, 14, 30, 16, 150];
const roadCaseWidth = ["interpolate", ["exponential", 1.5], ["zoom"], 10, 1, 14, 2, 16, 3];
const roadLayout = { "line-cap": "round", "line-join": "bevel" };

const isType = (t, geom) => ["all", ["==", ["geometry-type"], geom], ["==", ["get", "type"], t]];
const visibleRoad = ["all", ...isType("road", "LineString").slice(1), ["!=", ["get", "roadType"], "train"], ["==", ["get", "hidden"], false]];

const textPaint = { "text-color": "hsl(42, 10%, 86%)", "text-halo-width": 2, "text-halo-color": "hsl(42, 10%, 0%)" };

function cityLabels(layer, id, rankFilter, size, minzoom, maxzoom, font) {
  return {
    id,
    type: "symbol",
    source: "game",
    "source-layer": layer,
    minzoom,
    maxzoom,
    filter: ["all", ...isType("city", "Point").slice(1), rankFilter],
    layout: {
      "text-field": ["get", "name"],
      "text-font": [font],
      "text-size": size,
      "text-allow-overlap": false,
      "text-rotation-alignment": "viewport",
      "text-pitch-alignment": "viewport",
    },
    paint: textPaint,
  };
}

/** game: "eut2" | "ats"; tilesBase: абсолютний URL до /tiles/; hasWorld: чи є world.pmtiles */
export function buildStyle(game, tilesBase, hasWorld) {
  const layer = game === "ats" ? "ats" : "ets2";
  const sources = {
    game: { type: "vector", url: `pmtiles://${tilesBase}${layer}.pmtiles` },
  };
  if (hasWorld) sources.world = { type: "vector", url: `pmtiles://${tilesBase}world.pmtiles` };

  const layers = [{ id: "background", type: "background", paint: { "background-color": C.land } }];
  if (hasWorld) {
    layers.push({ id: "water", type: "fill", source: "world", "source-layer": "water", paint: { "fill-color": C.water } });
  }
  layers.push(
    {
      id: "map-areas",
      type: "fill",
      source: "game",
      "source-layer": layer,
      filter: isType("mapArea", "Polygon"),
      layout: { "fill-sort-key": ["get", "zIndex"] },
      paint: {
        "fill-color": areaColor,
        "fill-outline-color": ["case", ["==", ["get", "color"], 0], C.mapAreaOutline, areaColor],
      },
    },
    {
      id: "prefabs",
      type: "fill",
      source: "game",
      "source-layer": layer,
      filter: isType("prefab", "Polygon"),
      layout: { "fill-sort-key": ["get", "zIndex"] },
      paint: { "fill-color": areaColor },
    },
    {
      id: "roads-case",
      type: "line",
      source: "game",
      "source-layer": layer,
      filter: visibleRoad,
      layout: roadLayout,
      paint: { "line-color": roadCaseColor, "line-gap-width": roadWidth, "line-width": roadCaseWidth },
    },
    {
      id: "roads",
      type: "line",
      source: "game",
      "source-layer": layer,
      filter: visibleRoad,
      layout: roadLayout,
      paint: { "line-color": roadColor, "line-width": roadWidth },
    },
    {
      id: "ferries",
      type: "line",
      source: "game",
      "source-layer": layer,
      filter: isType("ferry", "LineString"),
      paint: { "line-color": C.ferry, "line-width": 2, "line-dasharray": [3, 3] },
    },
  );
  if (hasWorld) {
    layers.push({
      id: "countries",
      type: "line",
      source: "world",
      "source-layer": "countries",
      paint: { "line-color": C.countryBorder, "line-width": 2 },
    });
  }
  layers.push(
    cityLabels(layer, "cities-small", [">", ["get", "scaleRank"], 6], 12, 6, 24, "Klokantech Noto Sans Regular"),
    cityLabels(layer, "cities-medium", ["all", ["<=", ["get", "scaleRank"], 6], [">", ["get", "scaleRank"], 3]], 14, 5, 24, "Klokantech Noto Sans Regular"),
    cityLabels(layer, "cities-big", ["<=", ["get", "scaleRank"], 3], 16, 3, 24, "Klokantech Noto Sans Bold"),
  );

  return {
    version: 8,
    glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}
