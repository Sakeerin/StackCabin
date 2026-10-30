param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$module")
}
if (![Environment]::Is64BitOperatingSystem) { throw 'This bundle requires Windows x64' }

function Get-BundleFile([string]$Relative) {
    if ($Relative -cnotmatch '^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)*$' -or @($Relative.Split('/') | Where-Object { $_ -in @('.', '..') }).Count) {
        throw "Invalid bundle path: $Relative"
    }
    $file = $PSScriptRoot
    foreach ($part in @('') + $Relative.Split('/')) {
        if ($part) { $file = Join-Path $file $part }
        $item = Get-Item -LiteralPath $file -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Bundle links are not supported: $Relative" }
    }
    if ($item.PSIsContainer) { throw "Expected a bundle file: $Relative" }
    return $item
}

$manifestFile = Get-BundleFile 'installer-manifest.json'
$manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -cne 'windows' -or $manifest.arch -cne 'x64' -or !$manifest.appVersion -or $manifest.files -isnot [array]) {
    throw 'Unsupported offline bundle manifest; rebuild the complete bundle'
}
$entries = @{}
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.file
    if ($entries.ContainsKey($relative)) { throw "Duplicate bundle manifest entry: $relative" }
    if ($entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or ($entry.bytes -isnot [int] -and $entry.bytes -isnot [long]) -or $entry.bytes -le 0) {
        throw "Invalid bundle integrity metadata: $relative"
    }
    $item = Get-BundleFile $relative
    if ($item.Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
        throw "Bundle checksum mismatch: $relative"
    }
    $entries[$relative] = $entry
}

# Check the entire pack before running a helper or installing any prerequisite.
$required = @('catalog.json', 'catalog.sig', 'public-key.txt', 'provenance.json',
    'StackCabin-setup.exe', 'Install-StackCabin.ps1', 'Install.cmd', 'README.txt',
    'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'windows-prerequisites.json',
    'prerequisites/install-vc-runtime.ps1', 'prerequisites/vc_redist.x64.exe',
    'prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe')
foreach ($relative in $required) {
    if (!$entries.ContainsKey($relative)) { throw "Missing bundle manifest entry: $relative" }
}
$catalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($catalog.schemaVersion -ne 1 -or $catalog.artifacts -isnot [array]) { throw 'Unsupported offline runtime catalog' }
$runtimes = @($catalog.artifacts | Where-Object { $_.platform -ceq 'windows' -and $_.arch -ceq 'x64' })
if (!$runtimes.Count) { throw 'No Windows x64 runtimes in catalog' }
$runtimeIds = @{}
foreach ($runtime in $runtimes) {
    if ($runtime.id -cnotmatch '^[a-zA-Z0-9._-]+$' -or $runtimeIds.ContainsKey($runtime.id) -or $runtime.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid offline runtime catalog entry' }
    $runtimeIds[$runtime.id] = $true
    if (!$entries.ContainsKey($runtime.sha256) -or $entries[$runtime.sha256].sha256 -cne $runtime.sha256) { throw "Missing or mismatched runtime archive: $($runtime.id)" }
    if ($runtime.sha256 -cnotin $required) { $required += $runtime.sha256 }
}
foreach ($relative in $entries.Keys) {
    if ($relative -cnotin $required) { throw "Unexpected bundle manifest entry: $relative" }
}

$webViewPayload = Join-Path $PSScriptRoot 'prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $webViewPayload
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'WebView2 prerequisite has no valid Microsoft signature' }
$vcHelper = Join-Path $PSScriptRoot 'prerequisites/install-vc-runtime.ps1'
$vcArguments = @{ PayloadDirectory = (Join-Path $PSScriptRoot 'prerequisites'); Manifest = (Join-Path $PSScriptRoot 'windows-prerequisites.json') }
$vcReport = & $vcHelper @vcArguments -CheckOnly
if ($LASTEXITCODE -ne 0) { throw 'Visual C++ prerequisite verification failed' }
$vcReport = $vcReport | ConvertFrom-Json

function Get-WebViewVersion {
    $client = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($location in @("HKCU:\$client", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")) {
        $value = (Get-ItemProperty -LiteralPath $location -Name pv -ErrorAction SilentlyContinue).pv
        $version = $null
        if ([Version]::TryParse([string]$value, [ref]$version) -and $version -gt [Version]'0.0.0.0') { return $version.ToString() }
    }
}
$webViewVersion = Get-WebViewVersion
if ($CheckOnly) {
    [ordered]@{
        bundleVerified = $true; appVersion = $manifest.appVersion; runtimeCount = $runtimes.Count; fileCount = $entries.Count
        installerSha256 = $entries['StackCabin-setup.exe'].sha256
        visualCpp = $vcReport
        webView2 = @{ payloadVerified = $true; installedVersion = [string]$webViewVersion; installationNeeded = !$webViewVersion }
    } | ConvertTo-Json -Depth 5
    exit 0
}

& $vcHelper @vcArguments
$vcExitCode = $LASTEXITCODE
if ($vcExitCode -notin @(0, 3010)) { throw "Visual C++ setup failed: $vcExitCode" }
if (!$webViewVersion) {
    Write-Output 'Installing the bundled WebView2 runtime.'
    $webview = Start-Process -FilePath $webViewPayload -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait -PassThru
    if ($webview.ExitCode -ne 0) { throw "WebView2 installer failed: $($webview.ExitCode)" }
    if (!(Get-WebViewVersion)) { throw 'WebView2 installation did not register a runtime' }
}
Write-Output 'Opening the StackCabin installer.'
$setup = Start-Process -FilePath (Join-Path $PSScriptRoot 'StackCabin-setup.exe') -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "StackCabin installer failed or was cancelled: $($setup.ExitCode)" }
if ($vcExitCode -eq 3010) { Write-Output 'Windows requested a restart after installing Visual C++. Restart before launching runtimes.' }
