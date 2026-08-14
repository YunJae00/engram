# Launch the packaged Engram as a BRAND-NEW user: a throwaway userData dir
# (workspace registry, settings, localStorage — everything the app remembers)
# under %TEMP%, so onboarding runs from scratch and none of your real
# workspaces/vaults are touched or visible.
#
#   .\scripts\fresh.ps1          # fresh run (new temp profile every time)
#
# Your normal double-click launch keeps using the regular profile as before.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$profileDir = Join-Path $env:TEMP "engram-fresh\$stamp\userdata"
New-Item -ItemType Directory -Force $profileDir | Out-Null

$exe = Join-Path $PSScriptRoot '..\dist\win-unpacked\Engram.exe'
if (-not (Test-Path $exe)) {
  Write-Error "No packaged build at $exe — run 'pnpm dist' first."
  exit 1
}

$env:ENGRAM_USERDATA = $profileDir
Write-Host "fresh profile: $profileDir"
Start-Process -FilePath $exe
