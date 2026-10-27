#!/bin/bash
# Збирає ~/Desktop/ETS2 Phone Nav.app з іконкою ETS2: відкриває Terminal і запускає scripts/macos/start.sh.
# Шлях до репозиторію вшивається в застосунок — після переміщення теки запустіть скрипт ще раз.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$HOME/Desktop/ETS2 Phone Nav.app"
STEAM="$HOME/Library/Application Support/Steam/steamapps/common"
ICON=""
for g in "Euro Truck Simulator 2" "American Truck Simulator"; do
	f="$STEAM/$g/$g.app/Contents/Resources/app_icon.icns"
	if [ -f "$f" ]; then ICON="$f"; break; fi
done

# AppleScript генеруємо тут, щоб у ньому був шлях саме цієї копії репозиторію
SCRIPT="$(mktemp -t ets2-phone-nav).applescript"
trap 'rm -f "$SCRIPT"' EXIT
START="$ROOT/scripts/macos/start.sh"
START_SH="'${START//\'/\'\\\'\'}'"          # у одинарних лапках для shell
START_AS="${START_SH//\\/\\\\}"             # і екранування для рядка AppleScript
START_AS="${START_AS//\"/\\\"}"
cat > "$SCRIPT" <<EOF
-- ETS2 Phone Nav: відкриває Terminal і запускає сервер для iPhone (згенеровано scripts/macos/make-app.sh)
tell application "Terminal"
	activate
	do script "clear; $START_AS"
end tell
EOF

# збираємо поруч і лише потім підміняємо, щоб збій не лишив без застосунку
TMP_APP="$(mktemp -d)/ETS2 Phone Nav.app"
osacompile -o "$TMP_APP" "$SCRIPT"
if [ -n "$ICON" ]; then
	cp "$ICON" "$TMP_APP/Contents/Resources/applet.icns"
	# свіжі macOS беруть іконку з Assets.car (CFBundleIconName) — прибираємо, щоб узялась applet.icns
	rm -f "$TMP_APP/Contents/Resources/Assets.car"
	/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$TMP_APP/Contents/Info.plist" 2>/dev/null || true
else
	echo "Іконку гри не знайдено — застосунок буде зі стандартною іконкою."
fi
codesign --force --deep -s - "$TMP_APP"
rm -rf "$APP"
mv "$TMP_APP" "$APP"
touch "$APP"
echo "готово: $APP"
