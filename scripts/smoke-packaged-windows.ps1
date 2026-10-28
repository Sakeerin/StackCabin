param(
    [string]$Application = 'target/release/stackcabin.exe',
    [Parameter(Mandatory = $true)][string]$Python,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = if ([IO.Path]::IsPathRooted($Application)) { [IO.Path]::GetFullPath($Application) } else { [IO.Path]::GetFullPath((Join-Path $workspace $Application)) }
$probeArguments = @((Join-Path $PSScriptRoot 'smoke-packaged.py'), $binary)
if ($PSBoundParameters.ContainsKey('DataDirectory')) {
    if ([string]::IsNullOrWhiteSpace($DataDirectory)) { throw 'An existing data directory is required' }
    $probeArguments += @('--data-directory', $DataDirectory)
}
& $Python @probeArguments
if ($LASTEXITCODE -ne 0) { throw 'Packaged application metadata check failed' }
