#!/bin/bash
# Копіює ets2-phone-nav.dylib у plugins/ обох ігор (якщо встановлені).
# Ідемпотентний: після оновлення гри через Steam просто запустити ще раз.
# Видалення: ./install-plugin.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DYLIB="$ROOT/plugin/build/ets2-phone-nav.dylib"
STEAM="$HOME/Library/Application Support/Steam/steamapps/common"

GAMES=(
	"$STEAM/Euro Truck Simulator 2/Euro Truck Simulator 2.app/Contents/MacOS"
	"$STEAM/American Truck Simulator/American Truck Simulator.app/Contents/MacOS"
)

for dir in "${GAMES[@]}"; do
	[ -d "$dir" ] || { echo "skip (не встановлено): $dir"; continue; }
	rm -f "$dir/plugins/trucknav.dylib" # стара назва плагіна (до перейменування) — щоб гра не вантажила обидва
	if [ "${1:-}" = "--uninstall" ]; then
		rm -f "$dir/plugins/ets2-phone-nav.dylib"
		rmdir "$dir/plugins" 2>/dev/null || true
		echo "removed: $dir/plugins/ets2-phone-nav.dylib"
	else
		[ -f "$DYLIB" ] || { echo "немає $DYLIB — спершу make у plugin/"; exit 1; }
		mkdir -p "$dir/plugins"
		cp "$DYLIB" "$dir/plugins/ets2-phone-nav.dylib"
		echo "installed: $dir/plugins/ets2-phone-nav.dylib"
	fi
done
