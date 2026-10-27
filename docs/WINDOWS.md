# Встановлення на Windows

> ⚠️ **Windows-версія ще не перевірена на живій грі.** Плагін збирається (MSVC у CI і mingw-w64), розкладка даних
> звірена з MSVC-збіркою, решта — той самий код, що працює на macOS. Якщо щось не так — відкрийте Issue
> з вмістом `.logs\` і рядками `[ets2-phone-nav]` з `game.log.txt`.

Що де працює:

| Частина | Де |
|---|---|
| плагін гри (`ets2-phone-nav.dll`) | у грі, нативно |
| сервер для телефона (companion) | Windows, Node.js |
| маршрутизатор (червона лінія, підказки) і разова генерація даних карти | **WSL** (Ubuntu усередині Windows) — бо `tippecanoe`, яким генеруються тайли карти, не має версії для Windows |

Без WSL працюють прилади, вантаж і сповіщення; без даних карти й маршрутизатора не буде карти й маршруту.

## 1. Node.js 24+ (у Windows)

```powershell
winget install OpenJS.NodeJS.LTS
```

або інсталятор з [nodejs.org](https://nodejs.org). Перевірка: `node -v` → `v24…` або новіше.

## 2. Код

Завантажте `ets2-phone-nav-<версія>-windows.zip` з [Releases](../../releases) — плагін там уже зібраний — і
розпакуйте, наприклад, у `C:\ets2-phone-nav` (шлях без пробілів спрощує роботу з WSL).

Архіви з інтернету Windows позначає як «завантажені»; якщо PowerShell відмовляється запускати скрипти:

```powershell
Get-ChildItem C:\ets2-phone-nav -Recurse | Unblock-File
```

<details><summary>Зібрати плагін самостійно</summary>

Потрібні Visual Studio 2022 Build Tools (C++) і CMake:

```powershell
cmake -S plugin -B plugin\build-cmake -A x64
cmake --build plugin\build-cmake --config Release
```

Результат — `plugin\build\ets2-phone-nav.dll`. Або з macOS/Linux: `make -C plugin windows` (mingw-w64).
</details>

## 3. Плагін у гру

Запустіть у PowerShell (так видно, куди встановлено плагін):

```powershell
powershell -ExecutionPolicy Bypass -File C:\ets2-phone-nav\scripts\windows\install-plugin.ps1
```

Скрипт сам знаходить ETS2/ATS у бібліотеках Steam і копіює DLL у `…\bin\win_x64\plugins\`.
Тека гри зазвичай у Program Files — Windows попросить права адміністратора.
Якщо гру не знайдено: `-GameDir "D:\SteamLibrary\steamapps\common\Euro Truck Simulator 2"`. Видалити: `-Uninstall`.

**Перезапустіть гру.** У `Документи\Euro Truck Simulator 2\game.log.txt` має з'явитися `[ets2-phone-nav] ready`.
Якщо під час старту гра покаже вікно про використання SDK-плагінів — це саме цей плагін, підтвердіть.

## 4. WSL і дані карти (разово, ~20 хв разом зі встановленням)

### 4.1. Встановити WSL з Ubuntu

У PowerShell від імені адміністратора:

```powershell
wsl --install -d Ubuntu
```

Перезавантажте комп'ютер, відкрийте **Ubuntu** з меню «Пуск» і створіть користувача.

### 4.2. Інструменти в Ubuntu

```bash
sudo apt update
sudo apt install -y build-essential git python3 curl libsqlite3-dev zlib1g-dev
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
# tippecanoe — збирається з коду (~2 хв)
git clone --depth 1 https://github.com/felt/tippecanoe.git ~/tippecanoe
make -C ~/tippecanoe -j"$(nproc)" && sudo make -C ~/tippecanoe install
```

### 4.3. Згенерувати дані

```bash
cd /mnt/c/ets2-phone-nav
bash scripts/setup-mapdata.sh
```

Скрипт клонує [truckermudgeon/maps](https://github.com/truckermudgeon/maps) у `~/.trucksim-maps` (у Linux-теці — так у рази
швидше), накладає виправлення для ETS2 1.61 і генерує з ваших файлів гри дані у `C:\ets2-phone-nav\mapdata\out\`
(~330 МБ). Гру шукає в `C:\Program Files (x86)\Steam\…`; якщо вона в іншій бібліотеці:

```bash
bash scripts/setup-mapdata.sh --game-dir "/mnt/d/SteamLibrary/steamapps/common/Euro Truck Simulator 2"
```

Для **ATS** — те саме з `--game ats` (дані лягають поруч, сервер сам бере потрібні за запущеною грою).

Повторюйте після оновлення гри або купівлі нового DLC з картою.

## 5. Запуск

Подвійний клік по `scripts\windows\ETS2 Phone Nav.cmd`, або ярлик на робочому столі з іконкою гри:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ets2-phone-nav\scripts\windows\make-shortcut.ps1
```

Відкриється вікно: маршрутизатор стартує у WSL у фоні (лог — `.logs\router.log`), сервер надрукує адресу на
кшталт `http://192.168.1.23:8420`. Закрили вікно — зупинилось усе.

**Брандмауер Windows** при першому запуску спитає про `node.exe` — дозвольте для **приватних** мереж.
Якщо ваша домашня Wi-Fi позначена в Windows як «загальнодоступна», телефон не підключиться:
*Параметри → Мережа й Інтернет → Wi-Fi → ваша мережа → Тип профілю мережі: Приватна*.

## 6. Телефон

- Відкрийте адресу в браузері. На iPhone: Safari → *Поділитися → На екран Додому* — на весь екран, як застосунок.
- Щоб екран не гас — вимкніть автоблокування на час гри (сторінка відкривається через `http://`, тож сама тримати екран не може).
- Карті потрібен WebGL2: iPhone з iOS 15+, будь-який сучасний Android.

## Якщо щось не так

| Симптом | Що робити |
|---|---|
| «Гру не запущено або плагін не працює» | гра запущена? у `game.log.txt` є `[ets2-phone-nav] ready`? Файл даних: `%LOCALAPPDATA%\ets2-phone-nav\ets2-phone-nav.shm` |
| «У грі стара версія плагіна» | `install-plugin.ps1` і перезапуск гри; якщо сервер старіший — перезапустіть і його |
| Немає карти, «Немає тайлів…» | не виконано крок 4.3 (`mapdata\out\tiles\ets2.pmtiles`) |
| «Маршрутизатор не запущено» | `.logs\router.err.log`; у Ubuntu має існувати `~/.trucksim-maps`; спробуйте вручну: `wsl -e bash -lc "cd ~/.trucksim-maps && node --import tsx /mnt/c/ets2-phone-nav/router/router.ts"` |
| Телефон не відкриває адресу | та сама Wi-Fi? брандмауер (див. крок 5)? тип мережі «Приватна»? |
