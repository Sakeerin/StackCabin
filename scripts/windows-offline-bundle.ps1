param([string]$Installer = '', [string]$InstallerSha256 = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$module")
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
if (!$Installer) { $Installer = "target/release/bundle/nsis/StackCabin_${version}_x64-setup.exe" }
$sourceInstaller = if ([IO.Path]::IsPathRooted($Installer)) { [IO.Path]::GetFullPath($Installer) } else { [IO.Path]::GetFullPath((Join-Path $workspace $Installer)) }
if (!(Test-Path -LiteralPath $sourceInstaller -PathType Leaf)) { throw 'Build or download the matching normal Windows installer first.' }
if ((Get-Item -LiteralPath $sourceInstaller).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer must not be a link' }
$sourceInstallerHash = (Get-FileHash -LiteralPath $sourceInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
if ($InstallerSha256 -and ($InstallerSha256 -cnotmatch '^[a-f0-9]{64}$' -or $sourceInstallerHash -cne $InstallerSha256)) { throw 'Source installer checksum mismatch' }
$bundle = Join-Path $workspace 'artifacts/offline-windows-x64'
if (!(Test-Path -LiteralPath (Join-Path $bundle 'catalog.json'))) {
    throw 'Create the matching offline runtime pack first with npm run offline:pack -- --platform=windows --dev.'
}
$manifestTool = Join-Path $PSScriptRoot 'windows-offline-manifest.mjs'
& node $manifestTool --verify $bundle
if ($LASTEXITCODE -ne 0) { throw 'Matching signed offline runtime pack verification failed' }
$prerequisites = Join-Path $bundle 'prerequisites'
foreach ($relative in @('prerequisites', 'installer-manifest.json', 'StackCabin-setup.exe', 'windows-prerequisites.json', 'Install-StackCabin.ps1', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.txt', 'Install.cmd', 'prerequisites/install-vc-runtime.ps1')) {
    $destination = Join-Path $bundle $relative
    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Bundle destination must not be a link: $destination" }
    if ($relative -ne 'prerequisites' -and (Test-Path -LiteralPath $destination -PathType Container)) { throw "Bundle destination must be a file: $destination" }
}
# A failed refresh must not leave the old bundle marked as complete.
$manifestPath = Join-Path $bundle 'installer-manifest.json'
if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath }
try {
    New-Item -ItemType Directory -Force -Path $prerequisites | Out-Null
    $sources = @{
        'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' = 'https://go.microsoft.com/fwlink/p/?LinkId=2124701'
        'vc_redist.x64.exe' = (Get-Content -LiteralPath (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -Raw | ConvertFrom-Json).visualCpp.url
    }
    foreach ($name in $sources.Keys) {
        $file = Join-Path $prerequisites $name
        if (!(Test-Path -LiteralPath $file)) {
            Write-Output "Downloading Microsoft prerequisite: $name"
            $partial = Join-Path $prerequisites "$([Guid]::NewGuid()).part.exe"
            try {
                Invoke-WebRequest -Uri $sources[$name] -OutFile $partial -UseBasicParsing -TimeoutSec 1800
                $signature = Get-AuthenticodeSignature -LiteralPath $partial
                if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw "Invalid Microsoft download signature: $name" }
                Move-Item -LiteralPath $partial -Destination $file
            } finally {
                if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
            }
        }
        if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Prerequisite must not be a link: $name" }
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
            throw "Invalid Microsoft Authenticode signature: $name ($($signature.Status))"
        }
    }
    & (Join-Path $workspace 'src-tauri/windows/install-vc-runtime.ps1') -PayloadDirectory $prerequisites -Manifest (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Visual C++ prerequisite verification failed' }
    Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri/windows/install-vc-runtime.ps1') -Destination $prerequisites -Force
    Copy-Item -LiteralPath (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -Destination $bundle -Force
    Copy-Item -LiteralPath $sourceInstaller -Destination (Join-Path $bundle 'StackCabin-setup.exe') -Force
    if ((Get-FileHash -LiteralPath (Join-Path $bundle 'StackCabin-setup.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceInstallerHash) { throw 'Copied installer checksum mismatch' }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-StackCabin.ps1') -Destination $bundle -Force
    Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination $bundle -Force
    Copy-Item -LiteralPath (Join-Path $workspace 'resources/THIRD_PARTY_NOTICES.txt') -Destination $bundle -Force
    @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-StackCabin.ps1"
if not errorlevel 1 exit /b 0
pause
exit /b 1
'@ | Set-Content -LiteralPath (Join-Path $bundle 'Install.cmd') -Encoding ASCII
    @'
StackCabin 0.1.0 Windows x64 development offline bundle

1. Keep this complete folder together and run Install.cmd.
2. The script checks all files and runtime archives before installing anything,
   installs Visual C++ (UAC may be requested),
   installs WebView2 if missing, and opens the StackCabin installer.
3. In StackCabin > Runtimes > Install from offline pack, choose this folder.

No PHP, Node.js, database server, Rust or npm system installation is required.
Framework dependencies must already be installed for Windows or available in cache.
This development build is unsigned. Clean-machine and upgrade VM certification
are still required before public distribution. Microsoft and runtime components
retain their own license terms; StackCabin source is licensed under MIT.

Prerequisites are downloaded and Microsoft signatures checked when this bundle
is built. This folder is not installed or executed by the bundler.

Read-only verification (Windows PowerShell 5.1; no Node.js required):
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-StackCabin.ps1 -CheckOnly
This returns JSON with payload integrity and installed prerequisite versions.
It does not launch installers, install runtimes or change the machine.
The local hash manifest detects damaged/mixed files; it is not a release signature.
The application separately verifies its trusted signed catalog before installing runtimes.

Optional setup flags: -Silent -InstallDirectory C:\chosen\folder
Use an absolute local Windows folder. Microsoft prerequisites may still need UAC
or a restart. Do not combine setup flags with -CheckOnly.
'@ | Set-Content -LiteralPath (Join-Path $bundle 'README.txt') -Encoding UTF8
    & node $manifestTool --write $bundle
    if ($LASTEXITCODE -ne 0) { throw 'Offline bundle manifest generation failed' }
    & (Join-Path $bundle 'Install-StackCabin.ps1') -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Offline bundle preflight failed' }
    Write-Output "Prepared offline bundle: $bundle"
} catch {
    if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath }
    throw
}
