param(
    [string]$PayloadDirectory = $PSScriptRoot,
    [string]$Manifest = (Join-Path $PSScriptRoot 'windows-prerequisites.json'),
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$module")
}

function Get-InstalledVisualCpp {
    $versions = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
        try {
            $key = $base.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
            if ($key) {
                try {
                    if ($key.GetValue('Installed') -eq 1) {
                        $parsed = $null
                        if ([Version]::TryParse(([string]$key.GetValue('Version') -replace '^v', ''), [ref]$parsed)) { $versions += $parsed }
                    }
                } finally { $key.Dispose() }
            }
        } finally { $base.Dispose() }
    }
    $versions | Sort-Object -Descending | Select-Object -First 1
}

$specification = (Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json).visualCpp
$required = [Version]$specification.version
$payload = Join-Path $PayloadDirectory 'vc_redist.x64.exe'
if ((Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $specification.sha256) { throw 'Visual C++ prerequisite checksum mismatch' }
$signature = Get-AuthenticodeSignature -LiteralPath $payload
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Visual C++ prerequisite has no valid Microsoft signature' }
if ([Version](Get-Item -LiteralPath $payload).VersionInfo.ProductVersion -ne $required) { throw 'Visual C++ prerequisite version mismatch' }
$installed = Get-InstalledVisualCpp
$needed = !$installed -or $installed -lt $required
if ($CheckOnly) {
    [ordered]@{ payloadVerified = $true; requiredVersion = $required.ToString(); installedVersion = [string]$installed; installationNeeded = $needed } | ConvertTo-Json -Compress
    exit 0
}
if (!$needed) { Write-Output "Microsoft Visual C++ x64 $installed is already installed"; exit 0 }

Write-Output "Installing bundled Microsoft Visual C++ x64 $required; Windows may request administrator approval"
$arguments = @{ FilePath = $payload; ArgumentList = @('/install', '/passive', '/norestart'); WindowStyle = 'Hidden'; Wait = $true; PassThru = $true }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $arguments.Verb = 'RunAs' }
$process = Start-Process @arguments
if ($process.ExitCode -notin @(0, 1638, 3010)) { throw "Microsoft Visual C++ installer failed: $($process.ExitCode)" }
$installed = Get-InstalledVisualCpp
if (!$installed -or $installed -lt $required) { throw 'Microsoft Visual C++ installation did not register the required version' }
Write-Output "Microsoft Visual C++ x64 $installed is ready"
if ($process.ExitCode -eq 3010) { exit 3010 }
exit 0
