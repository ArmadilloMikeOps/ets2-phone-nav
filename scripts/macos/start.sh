#!/bin/bash
# Запускає ETS2 Phone Nav: маршрутизатор (у фоні) і companion (сервер для iPhone).
# Адресу для телефона друкує при старті. Зупинка — Ctrl+C або закрити вікно:
# маршрутизатор зупиняється разом із companion.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# клон truckermudgeon/maps (кладе scripts/setup-mapdata.sh) — ті самі місця, що шукає router.ts
TSM="${TRUCKSIM_MAPS:-}"
if [ -z "$TSM" ]; then
	for d in "$ROOT/.trucksim-maps" "$HOME/.trucksim-maps" "$HOME/Projects/trucksim-maps"; do
		if [ -d "$d/node_modules" ]; then TSM="$d"; break; fi
	done
fi
PORT=8420
ROUTER_PORT=8430
LOG_DIR="$ROOT/.logs"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
	echo "ETS2 Phone Nav уже запущено (порт $PORT зайнятий)."
	for ip in $(ipconfig getifaddr en0 2>/dev/null) $(ipconfig getifaddr en1 2>/dev/null); do
		echo "  на iPhone відкрий:  http://$ip:$PORT"
	done
	exit 0
fi

mkdir -p "$LOG_DIR"

# Маршрутизатор: код навігатора truckermudgeon/maps, запускається з його клону.
# Без нього все працює, крім червоної лінії маршруту.
ROUTER_PID=""
if lsof -nP -iTCP:$ROUTER_PORT -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Маршрутизатор уже працює (порт $ROUTER_PORT)."
elif [ -n "$TSM" ]; then
	echo "Запускаю маршрутизатор (дані вантажаться ~15 с, лог: .logs/router.log)…"
	# `node --import tsx` — один процес (на відміну від npx tsx), тож його легко зупинити
	(cd "$TSM" && exec node --import tsx "$ROOT/router/router.ts") > "$LOG_DIR/router.log" 2>&1 &
	ROUTER_PID=$!
	trap 'kill "$ROUTER_PID" 2>/dev/null || true' EXIT
else
	echo "Маршрутизатор пропущено: немає клону truckermudgeon/maps — запустіть scripts/setup-mapdata.sh."
fi

node "$ROOT/companion/server.ts" --port "$PORT"
