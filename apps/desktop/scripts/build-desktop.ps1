param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$outputRoot = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $desktopRoot 'native-bin/desktop' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$references = @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')
$references += @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object { Join-Path $frameworkRoot "WPF/$_" }
$compilerArgs = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:EngramDesktop.exe')
$compilerArgs += $references | ForEach-Object { "/reference:$_" }
$compilerArgs += (Get-ChildItem (Join-Path $desktopRoot 'native/desktop') -Filter '*.cs').FullName
$compiler = Join-Path $frameworkRoot 'csc.exe'
Push-Location $outputRoot
try { & $compiler @compilerArgs }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Desktop helper compilation failed' }
