param(
    [switch]$Run,
    [switch]$PreflightOnly
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$source = [IO.Path]::GetFullPath((Join-Path $repo 'apps/desktop/e2e/fixtures/worker'))
$output = [IO.Path]::GetFullPath((Join-Path $repo ('tmp/worker-session/' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$library = Join-Path $env:WINDIR 'System32/mstscax.dll'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework compiler is unavailable.' }
if (-not (Test-Path -LiteralPath $library)) { throw 'The Remote Desktop ActiveX library is unavailable.' }
$importer = Join-Path $output 'ImportTypeLibrary.exe'
$entry = Join-Path $source 'ImportTypeLibrary.cs'
& $compiler /nologo /target:exe /platform:x64 "/out:$importer" $entry
if ($LASTEXITCODE -ne 0) { throw 'Type library importer compilation failed.' }
& $importer $library $output
if ($LASTEXITCODE -ne 0) { throw 'The installed Remote Desktop contract could not be imported.' }
$sources = Get-ChildItem -LiteralPath $source -Filter '*.cs' |
    Where-Object Name -ne 'ImportTypeLibrary.cs' | ForEach-Object FullName
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll',
    'System.Windows.Forms.dll', 'System.Web.Extensions.dll', (Join-Path $output 'MSTSCLib.dll'))
$executable = Join-Path $output 'WorkerSession.exe'
$arguments = @('/nologo', '/target:exe', '/platform:x64', '/langversion:5', "/out:$executable")
$arguments += $references | ForEach-Object { '/reference:' + $_ }
$arguments += $sources
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Worker session fixture compilation failed.' }
Write-Host "Fixture built: $output"
if ($Run -and $PreflightOnly) { throw 'Select either Run or PreflightOnly.' }
if ($Run -or $PreflightOnly) {
    $mode = if ($Run) { '--run-hosted' } else { '--preflight' }
    & $executable $mode
    $result = $LASTEXITCODE
    $report = Join-Path $output 'results/parent-result.json'
    if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report }
    if ($result -ne 0) { throw "Worker session validation failed ($result)." }
}
