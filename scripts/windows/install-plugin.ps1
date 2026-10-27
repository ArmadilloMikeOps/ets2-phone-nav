# Копіює ets2-phone-nav.dll у bin\win_x64\plugins обох ігор (якщо встановлені).
# Ідемпотентний: після оновлення гри через Steam просто запустити ще раз.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-plugin.ps1 -Uninstall
#   ... -GameDir "D:\SteamLibrary\steamapps\common\Euro Truck Simulator 2"   (якщо гру не знайдено)
#
# Тека гри зазвичай у Program Files — для запису потрібні права адміністратора;
# скрипт сам перезапуститься з ними (Windows спитає дозволу).
param(
    [switch]$Uninstall,
    [string]$GameDir
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\steam.ps1"

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$dll = Join-Path $root 'plugin\build\ets2-phone-nav.dll'
if (-not $Uninstall -and -not (Test-Path $dll)) {
    Write-Host "Немає $dll." -ForegroundColor Red
    Write-Host "Завантажте архів релізу з GitHub (там DLL уже зібрана) або зберіть: див. docs\WINDOWS.md"
    exit 1
}

if ($GameDir) {
    $games = @([pscustomobject]@{ Name = (Split-Path $GameDir -Leaf); Bin = (Join-Path $GameDir 'bin\win_x64') })
} else {
    $games = @(Find-TruckGames)
}
if ($games.Count -eq 0) {
    Write-Host 'Не знайшов ETS2/ATS у бібліотеках Steam. Вкажіть теку: -GameDir "...\steamapps\common\Euro Truck Simulator 2"' -ForegroundColor Red
    exit 1
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
    foreach ($g in $games) {
        $plugins = Join-Path $g.Bin 'plugins'
        $target = Join-Path $plugins 'ets2-phone-nav.dll'
        # стара назва плагіна (до перейменування) — щоб гра не вантажила обидва
        $legacy = Join-Path $plugins 'trucknav.dll'
        if (Test-Path $legacy) { Remove-Item $legacy -Force }
        if ($Uninstall) {
            if (Test-Path $target) { Remove-Item $target -Force }
            if ((Test-Path $plugins) -and -not (Get-ChildItem $plugins)) { Remove-Item $plugins }
            Write-Host "видалено: $target"
        } else {
            New-Item -ItemType Directory -Force -Path $plugins | Out-Null
            Copy-Item $dll $target -Force
            Write-Host "встановлено: $target" -ForegroundColor Green
        }
    }
} catch {
    $denied = ($_.Exception -is [System.UnauthorizedAccessException]) -or ($_.Exception.InnerException -is [System.UnauthorizedAccessException])
    if (-not $denied -or (Test-Admin)) { throw }
    Write-Host 'Потрібні права адміністратора — перезапускаю…'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($GameDir) { $argList += @('-GameDir', "`"$GameDir`"") }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
    exit
}
Write-Host 'Готово. Перезапустіть гру: плагіни вона підхоплює лише під час старту.'
if (-not (Test-Admin)) { Start-Sleep -Seconds 1 }
