# Створює на робочому столі ярлик «ETS2 Phone Nav» з іконкою ETS2 (або ATS), що запускає start.ps1.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\make-shortcut.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\steam.ps1"

$start = Join-Path $PSScriptRoot 'start.ps1'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'ETS2 Phone Nav.lnk'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$start`""
$s.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$s.Description = 'ETS2 Phone Nav: навігація й прилади ETS2/ATS на телефоні'

$game = Find-TruckGames | Select-Object -First 1
if ($game) {
    $s.IconLocation = "$($game.Exe),0"
} else {
    Write-Host 'Гру не знайдено — ярлик буде зі стандартною іконкою.' -ForegroundColor Yellow
}
$s.Save()
Write-Host "Готово: $lnk" -ForegroundColor Green
