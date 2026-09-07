param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$sdkVersion = '1.0.4191.47'
$sdkRoot = Join-Path $desktopRoot 'native-bin/sdk'
$outputRoot = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $desktopRoot 'native-bin/browser' }
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (!(Test-Path "$sdkRoot/lib/net462/Microsoft.Web.WebView2.Core.dll")) {
    $archive = Join-Path $desktopRoot 'native-bin/webview2.zip'
    if (!(Test-Path $archive)) { Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $archive }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($archive))).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($hash -ne 'F492BBF547D0DA329553B6727435B677579B1E9F91CC9E4A1AD029366D5F23D0') { throw 'WebView2 SDK checksum mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $sdkRoot)
}
Copy-Item "$sdkRoot/lib/net462/Microsoft.Web.WebView2.Core.dll" $outputRoot
Copy-Item "$sdkRoot/lib/net462/Microsoft.Web.WebView2.WinForms.dll" $outputRoot
Copy-Item "$sdkRoot/runtimes/win-x64/native/WebView2Loader.dll" $outputRoot
Copy-Item "$sdkRoot/LICENSE.txt" "$outputRoot/WebView2-LICENSE.txt"
Copy-Item "$sdkRoot/NOTICE.txt" "$outputRoot/WebView2-NOTICE.txt"
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
$compilerArgs = @('/nologo', '/target:exe', '/platform:x64', '/out:EngramBrowser.exe')
$compilerArgs += $references | ForEach-Object { "/reference:$_" }
$compilerArgs += (Get-ChildItem "$desktopRoot/native/browser" -Filter '*.cs').FullName
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
Push-Location $outputRoot
try { & $compiler @compilerArgs }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Browser host compilation failed' }
