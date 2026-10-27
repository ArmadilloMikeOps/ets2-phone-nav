// Ігрові координати (x, z) → [lng, lat] для MapLibre.
// Порт packages/libs/map/projections.ts з truckermudgeon/maps (GPL-3),
// без proj4: сферична конічна проєкція Ламберта (обернена формула, Snyder 15-*).
// Спільний модуль для веб-клієнта і companion.

const R = 6_370_997; // Clarke 1866 authalic sphere; у формулах скорочується
const DEG = Math.PI / 180;
const LENGTH_OF_DEGREE = (R * Math.PI) / 180;

function lambertInverse({ lat1, lat2, lat0, lon0 }) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, p0 = lat0 * DEG;
  const t = (p) => Math.tan(Math.PI / 4 + p / 2);
  const n = Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  const F = (Math.cos(p1) * Math.pow(t(p1), n)) / n;
  const rho0 = (R * F) / Math.pow(t(p0), n);
  return (x, y) => {
    const dy = rho0 - y;
    const rho = Math.sign(n) * Math.hypot(x, dy);
    const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * dy);
    const lat = 2 * Math.atan(Math.pow((R * F) / rho, 1 / n)) - Math.PI / 2;
    const lng = lon0 * DEG + theta / n;
    return [lng / DEG, lat / DEG];
  };
}

// з def/climate.sii
const ETS2 = {
  inverse: lambertInverse({ lat1: 37, lat2: 65, lat0: 50, lon0: 15 }),
  mapOffset: [16660, 4150],
  mapFactor: [-0.000171570875, 0.0001729241463],
};
const ATS = {
  inverse: lambertInverse({ lat1: 33, lat2: 45, lat0: 39, lon0: -96 }),
  mapFactor: [-0.00017706234, 0.000176689948],
};

function ets2ToLngLat(x, y) {
  const sx = Math.floor(x / 4000);
  const sy = Math.floor(y / 4000);
  x -= ETS2.mapOffset[0];
  y -= ETS2.mapOffset[1];
  // UK зроблена в трохи більшому масштабі; все вгору-ліворуч від сектора Кале — UK
  const isUk = sx <= -8 && sy <= -2 && !(sx === -8 && sy === -2);
  if (isUk) {
    const calais = [-31100, -5500];
    x = (x + calais[0] / 2) * 0.75;
    y = (y + calais[1] / 2) * 0.75;
  }
  return ETS2.inverse(x * ETS2.mapFactor[1] * LENGTH_OF_DEGREE, y * ETS2.mapFactor[0] * LENGTH_OF_DEGREE);
}

function atsToLngLat(x, y) {
  return ATS.inverse(x * ATS.mapFactor[1] * LENGTH_OF_DEGREE, y * ATS.mapFactor[0] * LENGTH_OF_DEGREE);
}

/** game: "eut2" | "ats"; x, z — світові координати з телеметрії (z = y на карті). */
export function toLngLat(game, x, z) {
  return game === "ats" ? atsToLngLat(x, z) : ets2ToLngLat(x, z);
}

/** heading телеметрії (частки оберту, 0 = північ, проти год. стрілки) → bearing MapLibre (градуси за год. стрілкою). */
export function headingToBearing(heading) {
  return (360 * (1 - heading)) % 360;
}
