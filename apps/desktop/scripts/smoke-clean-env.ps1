# M8 acceptance: core flows in a PATH-stripped shell — no system git/node.
# Uses the packaged Electron binary as the node runtime and the bundled git.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$electronBin = if ($env:ENGRAM_ELECTRON_BIN) { $env:ENGRAM_ELECTRON_BIN } else { 'node_modules\electron\dist\electron.exe' }
$bundleDir = Join-Path (Get-Location).Path 'bundle'
$outJs = Join-Path (Get-Location).Path 'dist\smoke\smoke.cjs'

if (-not (Test-Path (Join-Path $bundleDir 'git'))) {
  Write-Host 'bundle missing — running bundle-binaries first'
  node scripts/bundle-binaries.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

New-Item -ItemType Directory -Force (Split-Path $outJs) | Out-Null
$coreAlias = (Resolve-Path '..\..\packages\core\src\index.ts').Path
npx esbuild scripts/smoke-core.ts --bundle --platform=node --format=cjs `
  --outfile="$outJs" --log-level=warning --alias:core="$coreAlias"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '-- running smoke with PATH stripped --'
# PATH must point at an (empty) directory rather than being unset: libuv's
# spawn on Windows reports ENOENT for every executable — absolute paths
# included — when the PATH variable does not exist at all.
$emptyDir = Join-Path $env:TEMP 'engram-smoke-empty-path'
New-Item -ItemType Directory -Force $emptyDir | Out-Null
$oldPath = $env:PATH
try {
  $env:PATH = $emptyDir
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:ENGRAM_BUNDLE_DIR = $bundleDir
  & $electronBin $outJs
  exit $LASTEXITCODE
} finally {
  $env:PATH = $oldPath
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:ENGRAM_BUNDLE_DIR -ErrorAction SilentlyContinue
}
