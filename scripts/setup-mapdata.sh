#!/usr/bin/env bash
# Генерує дані карти й маршрутизації з файлів гри (разово й після оновлення гри/DLC).
# Працює на macOS і Linux — під Windows запускати у WSL (Ubuntu), див. docs/WINDOWS.md.
#
#   scripts/setup-mapdata.sh [--game ets2|ats] [--game-dir ШЛЯХ] [--deps ШЛЯХ]
#
#   --game      ets2 (за замовчуванням) або ats
#   --game-dir  тека гри зі .scs-файлами; за замовчуванням шукаємо стандартну теку Steam
#   --deps      куди клонувати truckermudgeon/maps (за замовчуванням <репо>/.trucksim-maps,
#               а у WSL — ~/.trucksim-maps: npm у Linux-теці в рази швидший, ніж на /mnt/c)
#
# Результат (mapdata/out/, у .gitignore — це похідні від файлів гри, їх не можна публікувати):
#   <game>/            розібрані дані + <map>-graph.json + <map>-roundabouts.json
#   tiles/<game>.pmtiles, tiles/world.pmtiles
#
# Потрібно: git, Node ≥ 24.13 і npm, tippecanoe, компілятор C++ і python3 (для node-gyp).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSM_REPO="https://github.com/truckermudgeon/maps.git"
TSM_COMMIT="$(cat "$ROOT/mapdata/patches/trucksim-maps-BASE.txt")"
PATCH="$ROOT/mapdata/patches/trucksim-maps-1.61.patch"

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

GAME="ets2"
GAME_DIR=""
DEPS=""
while [ $# -gt 0 ]; do
	case "$1" in
		--game) GAME="$2"; shift 2 ;;
		--game-dir) GAME_DIR="$2"; shift 2 ;;
		--deps) DEPS="$2"; shift 2 ;;
		-h|--help) sed -n '2,17p' "$0"; exit 0 ;;
		*) echo "невідомий параметр: $1" >&2; exit 2 ;;
	esac
done

case "$GAME" in
	ets2) MAP="europe"; STEAM_NAME="Euro Truck Simulator 2" ;;
	ats)  MAP="usa";    STEAM_NAME="American Truck Simulator" ;;
	*) echo "--game має бути ets2 або ats" >&2; exit 2 ;;
esac

if [ -z "$DEPS" ]; then
	if is_wsl; then DEPS="$HOME/.trucksim-maps"; else DEPS="$ROOT/.trucksim-maps"; fi
fi

if [ -z "$GAME_DIR" ]; then
	for d in \
		"$HOME/Library/Application Support/Steam/steamapps/common/$STEAM_NAME" \
		"/mnt/c/Program Files (x86)/Steam/steamapps/common/$STEAM_NAME" \
		"/mnt/c/Program Files/Steam/steamapps/common/$STEAM_NAME" \
		"$HOME/.steam/steam/steamapps/common/$STEAM_NAME" \
		"$HOME/.local/share/Steam/steamapps/common/$STEAM_NAME"; do
		if [ -f "$d/base.scs" ]; then GAME_DIR="$d"; break; fi
	done
fi
if [ -z "$GAME_DIR" ] || [ ! -f "$GAME_DIR/base.scs" ]; then
	echo "Не знайшов теку гри $STEAM_NAME (з base.scs). Вкажіть її: --game-dir \"…/steamapps/common/$STEAM_NAME\"" >&2
	echo "Якщо гра в іншій бібліотеці Steam — шлях видно в Steam: гра → Властивості → Встановлені файли → Огляд." >&2
	exit 1
fi

# ---------- перевірка інструментів ----------
missing=()
for tool in git node npm tippecanoe python3; do command -v "$tool" >/dev/null || missing+=("$tool"); done
command -v c++ >/dev/null || command -v g++ >/dev/null || command -v clang++ >/dev/null || missing+=("c++ (компілятор)")
if [ ${#missing[@]} -gt 0 ]; then
	echo "Бракує: ${missing[*]}" >&2
	if [ "$(uname)" = "Darwin" ]; then
		echo "macOS: brew install node tippecanoe; xcode-select --install" >&2
	else
		echo "Ubuntu/WSL: див. docs/WINDOWS.md (Node 24 з nodesource, tippecanoe збирається з коду)" >&2
	fi
	exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then echo "Потрібен Node ≥ 24.13, а зараз $(node -v)" >&2; exit 1; fi

echo "Гра:      $GAME_DIR"
echo "Клон:     $DEPS"
echo "Результат: $ROOT/mapdata/out"

# ---------- truckermudgeon/maps на перевіреному коміті + наш патч ----------
if [ ! -d "$DEPS/.git" ]; then
	git clone --filter=blob:none "$TSM_REPO" "$DEPS"
fi
git -C "$DEPS" fetch --quiet origin "$TSM_COMMIT" 2>/dev/null || true
if [ "$(git -C "$DEPS" rev-parse HEAD)" != "$TSM_COMMIT" ]; then
	git -C "$DEPS" checkout --quiet "$TSM_COMMIT"
fi
git -C "$DEPS" submodule update --init --depth 1 packages/clis/parser/gdeflate/libdeflate
if git -C "$DEPS" apply --reverse --check "$PATCH" 2>/dev/null; then
	echo "патч для 1.61 уже накладено"
else
	# клон наш: скидаємо парсер до чистого стану (там міг лишитися старіший варіант патча) і накладаємо заново
	git -C "$DEPS" checkout --quiet -- packages/clis/parser
	git -C "$DEPS" apply "$PATCH"
	echo "наклав патч для 1.61"
fi

# --ignore-scripts: кореневий prepare (husky) нам не потрібен і падає поза git-хуками
(cd "$DEPS" && npm install --no-audit --no-fund --ignore-scripts \
	--workspace packages/clis/parser --workspace packages/clis/generator --workspace packages/apis/navigation)
(cd "$DEPS" && npm run build --workspace packages/clis/parser)

run() { (cd "$DEPS" && node --import tsx "$@"); }

OUT="$ROOT/mapdata/out"
mkdir -p "$OUT/$GAME" "$OUT/tiles"

echo "== парсер (кілька хвилин)…"
run packages/clis/parser/index.ts -i "$GAME_DIR" -o "$OUT/$GAME"
echo "== тайли карти…"
run packages/clis/generator/index.ts map -m "$MAP" -i "$OUT/$GAME" -o "$OUT/tiles"
echo "== граф доріг…"
run packages/clis/generator/index.ts graph -m "$MAP" -i "$OUT/$GAME" -o "$OUT/$GAME"
echo "== кругові перехрестя…"
run packages/clis/generator/index.ts roundabouts -m "$MAP" -i "$OUT/$GAME" -g "$OUT/$GAME" -o "$OUT/$GAME"
if [ ! -f "$OUT/tiles/world.pmtiles" ]; then
	echo "== базовий шар (вода, кордони)…"
	R="$DEPS/packages/clis/generator/resources"
	tippecanoe -Z4 -z8 -b 10 -X --force -q -o "$OUT/tiles/world.pmtiles" \
		"$R/countries.geojson" "$R/states.geojson" "$R/water.geojson"
fi

echo
echo "Готово:"
du -sh "$OUT/$GAME" "$OUT/tiles"/*.pmtiles
