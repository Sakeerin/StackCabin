$ErrorActionPreference = 'Stop'
$payloads = @('StackCabin-setup.exe', 'prerequisites/vc_redist.x64.exe', 'prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe')
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer-manifest.json') -Raw | ConvertFrom-Json
foreach ($relative in $payloads) {
    $entry = @($manifest | Where-Object { $_.file -eq $relative })
    if ($entry.Count -ne 1) { throw "Missing installer manifest entry: $relative" }
    $file = Join-Path $PSScriptRoot $relative
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $entry[0].sha256) {
        throw "Installer checksum mismatch: $relative"
    }
}
Write-Output 'Installing Microsoft Visual C++ runtime. Windows may request administrator approval.'
$vc = Start-Process -FilePath (Join-Path $PSScriptRoot $payloads[1]) -ArgumentList '/install', '/passive', '/norestart' -WindowStyle Hidden -Wait -PassThru
if ($vc.ExitCode -notin @(0, 1638, 3010)) { throw "Visual C++ installer failed: $($vc.ExitCode)" }
$client = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$hasWebView = @("HKCU:\$client", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}") | Where-Object {
    $version = (Get-ItemProperty -LiteralPath $_ -Name pv -ErrorAction SilentlyContinue).pv
    $version -and $version -ne '0.0.0.0'
}
if (!$hasWebView) {
    Write-Output 'Installing the bundled WebView2 runtime.'
    $webview = Start-Process -FilePath (Join-Path $PSScriptRoot $payloads[2]) -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait -PassThru
    if ($webview.ExitCode -ne 0) { throw "WebView2 installer failed: $($webview.ExitCode)" }
}
Write-Output 'Opening the StackCabin installer.'
Start-Process -FilePath (Join-Path $PSScriptRoot $payloads[0]) -Wait
if ($vc.ExitCode -eq 3010) { Write-Output 'Windows requested a restart after installing Visual C++. Restart before launching runtimes.' }
