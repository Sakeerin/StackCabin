param([string]$Installer = '')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
if (!$Installer) { $Installer = "target/release/bundle/nsis/StackCabin_${version}_x64-setup.exe" }
$bundle = Join-Path $workspace 'artifacts/offline-windows-x64'
if (!(Test-Path -LiteralPath (Join-Path $bundle 'catalog.json'))) {
    throw 'Create the matching offline runtime pack first with npm run offline:pack -- --platform=windows --dev.'
}
$prerequisites = Join-Path $bundle 'prerequisites'
New-Item -ItemType Directory -Force -Path $prerequisites | Out-Null
$sources = @{
    'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' = 'https://go.microsoft.com/fwlink/p/?LinkId=2124701'
    'vc_redist.x64.exe' = (Get-Content -LiteralPath (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -Raw | ConvertFrom-Json).visualCpp.url
}
$manifest = @()
foreach ($name in $sources.Keys) {
    $file = Join-Path $prerequisites $name
    if (!(Test-Path -LiteralPath $file)) {
        Write-Output "Downloading Microsoft prerequisite: $name"
        Invoke-WebRequest -Uri $sources[$name] -OutFile $file -TimeoutSec 1800
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Invalid Microsoft Authenticode signature: $name ($($signature.Status))"
    }
    $manifest += @{ file = "prerequisites/$name"; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower(); url = $sources[$name]; signer = $signature.SignerCertificate.Subject }
}
& (Join-Path $workspace 'src-tauri/windows/install-vc-runtime.ps1') -PayloadDirectory $prerequisites -Manifest (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -CheckOnly
if ($LASTEXITCODE -ne 0) { throw 'Pinned Visual C++ prerequisite verification failed' }
Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri/windows/install-vc-runtime.ps1') -Destination $prerequisites -Force
Copy-Item -LiteralPath (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -Destination $bundle -Force
$sourceInstaller = [IO.Path]::GetFullPath((Join-Path $workspace $Installer))
if (!(Test-Path -LiteralPath $sourceInstaller)) { throw 'Build the normal Windows installer first.' }
Copy-Item -LiteralPath $sourceInstaller -Destination (Join-Path $bundle 'StackCabin-setup.exe') -Force
$manifest += @{file = 'StackCabin-setup.exe'; sha256 = (Get-FileHash -LiteralPath $sourceInstaller -Algorithm SHA256).Hash.ToLower()}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bundle 'installer-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-StackCabin.ps1') -Destination $bundle -Force
Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination $bundle -Force
Copy-Item -LiteralPath (Join-Path $workspace 'resources/THIRD_PARTY_NOTICES.txt') -Destination $bundle -Force
@'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-StackCabin.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $bundle 'Install.cmd') -Encoding ASCII
@'
StackCabin 0.1.0 Windows x64 development offline bundle

1. Keep this complete folder together and run Install.cmd.
2. The script checks payload hashes, installs Visual C++ (UAC may be requested),
   installs WebView2 if missing, and opens the StackCabin installer.
3. In StackCabin > Runtimes > Install from offline pack, choose this folder.

No PHP, Node.js, database server, Rust or npm system installation is required.
Framework dependencies must already be installed for Windows or available in cache.
This development build is unsigned. Clean-machine and upgrade VM certification
are still required before public distribution. Microsoft and runtime components
retain their own license terms; StackCabin source is licensed under MIT.

Prerequisites are downloaded and Microsoft signatures checked when this bundle
is built. This folder is not installed or executed by the bundler.
'@ | Set-Content -LiteralPath (Join-Path $bundle 'README.txt') -Encoding UTF8
Write-Output "Prepared offline bundle: $bundle"
