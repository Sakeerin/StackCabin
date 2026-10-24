$ErrorActionPreference = 'Stop'
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$module")
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$specification = (Get-Content -LiteralPath (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -Raw | ConvertFrom-Json).visualCpp
if ([Uri]$specification.url -notmatch '^https://download\.visualstudio\.microsoft\.com/') { throw 'Expected the pinned Microsoft HTTPS source' }
$directory = Join-Path $workspace 'artifacts/windows-prerequisites'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$payload = Join-Path $directory 'vc_redist.x64.exe'
$partial = "$payload.part"
try {
    if (!(Test-Path -LiteralPath $payload)) {
        $cache = Join-Path $workspace 'artifacts/offline-windows-x64/prerequisites/vc_redist.x64.exe'
        if ((Test-Path -LiteralPath $cache) -and (Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash.ToLowerInvariant() -eq $specification.sha256) {
            Copy-Item -LiteralPath $cache -Destination $partial
        } else {
            Invoke-WebRequest -Uri $specification.url -OutFile $partial -UseBasicParsing -TimeoutSec 180
        }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $specification.sha256) { throw 'Visual C++ prerequisite checksum mismatch' }
        Move-Item -LiteralPath $partial -Destination $payload
    }
    # Check authenticity on every build, including when a cached payload is used.
    & (Join-Path $workspace 'src-tauri/windows/install-vc-runtime.ps1') -PayloadDirectory $directory -Manifest (Join-Path $workspace 'runtime-catalog/windows-prerequisites.json') -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Visual C++ prerequisite verification failed' }
} finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
}
