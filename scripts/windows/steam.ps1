# Спільні функції для Windows-скриптів ETS2 Phone Nav: де стоїть Steam і ігри.
# Підключається через: . "$PSScriptRoot\steam.ps1"
# Сумісно з Windows PowerShell 5.1 (без ?? і тернарного оператора).

$Games = @(
    @{ Id = 'ets2'; Name = 'Euro Truck Simulator 2'; Exe = 'eurotrucks2.exe' },
    @{ Id = 'ats';  Name = 'American Truck Simulator'; Exe = 'amtrucks.exe' }
)

function Get-SteamLibraries {
    $roots = @()
    foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
        $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($p -and $p.SteamPath) { $roots += ($p.SteamPath -replace '/', '\') }
        if ($p -and $p.InstallPath) { $roots += $p.InstallPath }
    }
    $roots += "${env:ProgramFiles(x86)}\Steam", "$env:ProgramFiles\Steam"

    $libs = @()
    foreach ($root in ($roots | Select-Object -Unique)) {
        if (-not (Test-Path $root)) { continue }
        $libs += $root
        # інші бібліотеки Steam перелічені в libraryfolders.vdf: "path"  "D:\\SteamLibrary"
        $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
        if (Test-Path $vdf) {
            foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) {
                $libs += ($m.Groups[1].Value -replace '\\\\', '\')
            }
        }
    }
    return $libs | Select-Object -Unique
}

# Повертає список знайдених ігор: Id, Name, Dir (тека гри), Bin (bin\win_x64)
function Find-TruckGames {
    $found = @()
    foreach ($lib in Get-SteamLibraries) {
        foreach ($g in $Games) {
            $dir = Join-Path $lib ("steamapps\common\" + $g.Name)
            $bin = Join-Path $dir 'bin\win_x64'
            if (Test-Path (Join-Path $bin $g.Exe)) {
                $found += [pscustomobject]@{ Id = $g.Id; Name = $g.Name; Dir = $dir; Bin = $bin; Exe = (Join-Path $bin $g.Exe) }
            }
        }
    }
    return $found | Sort-Object Dir -Unique
}
