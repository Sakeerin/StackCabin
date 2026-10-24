param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [string]$OfflinePack = ''
)
$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'native-smoke.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Keep native-smoke.exe beside this acceptance script' }
$target = [IO.Path]::GetFullPath($Workspace)
if ((Test-Path -LiteralPath $target) -and @(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) { throw 'Choose a new or empty dedicated acceptance workspace' }
if ($OfflinePack) {
    $OfflinePack = [IO.Path]::GetFullPath($OfflinePack)
    if (!(Test-Path -LiteralPath $OfflinePack -PathType Container)) { throw 'Offline pack directory not found' }
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
$previous = @{}
$variables = @('STACKCABIN_SMOKE_DIR', 'STACKCABIN_SMOKE_COMPONENTS', 'STACKCABIN_OFFLINE_DIR', 'STACKCABIN_SMOKE_BRANCHES', 'STACKCABIN_PUBLISHER_CACHE')
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$encoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $env:STACKCABIN_SMOKE_DIR = $target
    $env:STACKCABIN_SMOKE_COMPONENTS = 'node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres'
    [Environment]::SetEnvironmentVariable('STACKCABIN_OFFLINE_DIR', $OfflinePack, 'Process')
    [Environment]::SetEnvironmentVariable('STACKCABIN_SMOKE_BRANCHES', $null, 'Process')
    [Environment]::SetEnvironmentVariable('STACKCABIN_PUBLISHER_CACHE', $null, 'Process')
    & $binary 2>&1 | Tee-Object -FilePath (Join-Path $target 'acceptance.log')
    if ($LASTEXITCODE -ne 0) { throw "Native acceptance failed: $LASTEXITCODE. Inspect acceptance.log and the disposable workspace" }
    Write-Output "PASS managed runtime acceptance. Evidence retained at $target"
} finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    [Console]::OutputEncoding = $encoding
}
