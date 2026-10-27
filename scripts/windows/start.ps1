# Запускає ETS2 Phone Nav під Windows:
#   - маршрутизатор (червона лінія маршруту й підказки) — у WSL, де лежить клон truckermudgeon/maps;
#   - companion (сервер для iPhone) — тут, у Windows (Node ≥ 24).
# Адресу для телефона companion друкує при старті. Зупинка — Ctrl+C або закрити вікно.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1 [-NoRouter] [-Port 8420]
#
# Без WSL / без даних маршрутизації працює все, крім лінії маршруту та підказок.
param(
    [int]$Port = 8420,
    [switch]$NoRouter,
    [string]$WslDeps = '~/.trucksim-maps'  # тека клону всередині WSL (setup-mapdata.sh кладе його сюди)
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Host.UI.RawUI.WindowTitle = 'ETS2 Phone Nav'

function Test-Port([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Show-Addresses {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        ForEach-Object { Write-Host ("  на iPhone відкрий:  http://{0}:{1}" -f $_.IPAddress, $Port) }
}

if (Test-Port $Port) {
    Write-Host "ETS2 Phone Nav уже запущено (порт $Port зайнятий)."
    Show-Addresses
    Read-Host 'Enter — закрити'
    exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Не знайшов Node.js. Встановіть Node 24 LTS або новіший: https://nodejs.org (або winget install OpenJS.NodeJS.LTS)' -ForegroundColor Red
    Read-Host 'Enter — закрити'
    exit 1
}

# ---------- маршрутизатор у WSL ----------
$routerStarted = $false
if (-not $NoRouter) {
    if (Test-Port 8430) {
        Write-Host 'Маршрутизатор уже працює (порт 8430).'
    } elseif (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        Write-Host 'WSL не встановлено — маршрут і підказки вимкнено (див. docs\WINDOWS.md).' -ForegroundColor Yellow
    } else {
        $routerWin = Join-Path $root 'router\router.ts'
        $routerWsl = (& wsl.exe -e wslpath -a ($routerWin -replace '\\', '/')).Trim()
        $logDir = Join-Path $root '.logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $bash = "cd $WslDeps && exec node --import tsx '$routerWsl'"
        Write-Host 'Запускаю маршрутизатор у WSL (дані вантажаться ~15 с, лог: .logs\router.log)…'
        Start-Process -FilePath wsl.exe -ArgumentList @('-e', 'bash', '-lc', "`"$bash`"") -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir 'router.log') -RedirectStandardError (Join-Path $logDir 'router.err.log') | Out-Null
        $routerStarted = $true
    }
}

# ---------- companion ----------
try {
    & node (Join-Path $root 'companion\server.ts') --port $Port
} finally {
    if ($routerStarted) {
        # закриття wsl.exe не завжди гасить процес усередині Linux — прибираємо явно
        & wsl.exe -e pkill -f 'router/router.ts' 2>$null | Out-Null
    }
}
