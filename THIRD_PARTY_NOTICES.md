# Сторонні компоненти

| Компонент | Де | Ліцензія | Як використано |
|---|---|---|---|
| [SCS Telemetry SDK 1.16](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry) | `plugin/vendor/scs_sdk/` | MIT-подібна, © SCS Software — [`sdk_license.txt`](plugin/vendor/scs_sdk/sdk_license.txt) | заголовні файли SDK у складі плагіна |
| [MapLibre GL JS 5.24.0](https://github.com/maplibre/maplibre-gl-js) | `web/vendor/maplibre-gl.*` | BSD-3-Clause — [`maplibre-gl.LICENSE.txt`](web/vendor/maplibre-gl.LICENSE.txt) | рендер карти на телефоні |
| [PMTiles 4.5.0](https://github.com/protomaps/PMTiles) | `web/vendor/pmtiles.js` | BSD-3-Clause — [`pmtiles.LICENSE.txt`](web/vendor/pmtiles.LICENSE.txt) | читання тайлів карти |
| [truckermudgeon/maps](https://github.com/truckermudgeon/maps) | не входить у репозиторій: клонується `scripts/setup-mapdata.sh` | GPL-3.0 | парсер карти гри, генератор тайлів і графа, маршрутизація й підказки (`router/router.ts` імпортує його модулі); `web/map-style.js` і `web/projection.js` портовано з нього; виправлення для ETS2 1.61 — `mapdata/patches/` |
| [tippecanoe](https://github.com/felt/tippecanoe) | не входить; ставиться окремо | BSD-2-Clause | генерація векторних тайлів |

Шрифти підписів на карті завантажуються з `fonts.openmaptiles.org` (OpenMapTiles, Noto Sans — SIL OFL 1.1).
