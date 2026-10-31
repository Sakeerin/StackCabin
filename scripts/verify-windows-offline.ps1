# Installs software only on a disposable GitHub-hosted Windows runner.
param(
    [Parameter(Mandatory = $true)][string]$Bundle,
    [Parameter(Mandatory = $true)][string]$Python
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Offline installation acceptance requires a disposable GitHub-hosted Windows runner'
}
foreach ($module in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules/$module")
}
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceCommit = (& git -C $workspace rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify acceptance source' }
$temporary = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$bundlePath = (Resolve-Path -LiteralPath $Bundle).Path
$fixtureParent = [IO.Path]::GetFullPath((Join-Path $workspace '.local/windows-offline-installed'))
$fixture = Join-Path $fixtureParent 'projects and data ทดสอบ'
$destination = [IO.Path]::GetFullPath((Join-Path $temporary 'StackCabin offline installed ทดสอบ'))
if (!$destination.StartsWith($temporary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    !$fixtureParent.StartsWith($workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    !$bundlePath.StartsWith($workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Offline acceptance paths must stay inside dedicated runner directories' }
foreach ($directory in @($fixtureParent, $destination)) {
    if (Test-Path -LiteralPath $directory) { throw 'Offline acceptance requires new installation and fixture directories' }
}
$native = Join-Path $workspace 'target/debug/examples/native-smoke.exe'
if (!(Test-Path -LiteralPath $native -PathType Leaf)) { throw 'Build the native acceptance harness first' }
$evidence = Join-Path $workspace 'artifacts/offline-installation-evidence'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
Start-Transcript -LiteralPath (Join-Path $evidence 'installation.log') -Force | Out-Null
$variables = @('PATH', 'PSModulePath', 'STACKCABIN_SMOKE_DIR', 'STACKCABIN_SMOKE_COMPONENTS', 'STACKCABIN_OFFLINE_DIR', 'STACKCABIN_SMOKE_BRANCHES', 'STACKCABIN_PUBLISHER_CACHE', 'STACKCABIN_DATA_DIR', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'NO_PROXY')
$saved = @{}
foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'StandardUserAcceptance.cs')
    [StackCabinAcceptance.StandardUser]::VerifyIdentity()
    $ps5 = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $wrapper = Join-Path $bundlePath 'Install-StackCabin.ps1'
    $manifest = Get-Content -LiteralPath (Join-Path $bundlePath 'installer-manifest.json') -Raw | ConvertFrom-Json
    # This installer must be the one whose source/catalog was verified by packaging.
    foreach ($name in @('catalog.json', 'catalog.sig', 'public-key.txt')) {
        if ((Get-FileHash -LiteralPath (Join-Path $bundlePath $name) -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath (Join-Path $workspace "runtime-catalog/$name") -Algorithm SHA256).Hash) { throw "Acceptance catalog mismatch: $name" }
    }
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:PSModulePath = ''
    $before = & $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Pre-installation bundle verification failed' }
    $before = $before | ConvertFrom-Json
    $before | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'before.json') -Encoding utf8

    & $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper -Silent -InstallDirectory $destination
    if ($LASTEXITCODE -ne 0) { throw 'The complete offline installer wrapper failed' }
    $binary = Join-Path $destination 'stackcabin.exe'
    if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Application was not installed at the requested Thai/space path' }
    $version = (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion
    if ($version -notmatch ('^' + [regex]::Escape($manifest.appVersion) + '(\.0)?(\+.*)?$')) { throw 'Installed application version differs from the bundle' }
    $resourceHashes = @{}
    foreach ($name in @('catalog.json', 'catalog.sig', 'public-key.txt')) {
        $resources = @(Get-ChildItem -LiteralPath $destination -Recurse -File -Filter $name)
        if ($resources.Count -ne 1) { throw "Expected one installed resource: $name" }
        $expected = (Get-FileHash -LiteralPath (Join-Path $bundlePath $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ((Get-FileHash -LiteralPath $resources[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw "Installed resource mismatch: $name" }
        $resourceHashes[$name] = $expected
    }
    $after = & $ps5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Post-installation bundle verification failed' }
    $after = $after | ConvertFrom-Json
    if ($after.visualCpp.installationNeeded -or $after.webView2.installationNeeded) { throw 'Required OS prerequisites are still missing' }
    $after | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'after.json') -Encoding utf8
    Write-Output 'PASS real offline wrapper installed the normal application and required prerequisites at a Thai/space path'

    New-Item -ItemType Directory -Path $fixtureParent | Out-Null
    $acl = Get-Acl -LiteralPath $fixtureParent
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $fixtureParent -AclObject $acl
    $env:STACKCABIN_SMOKE_DIR = $fixture
    $env:STACKCABIN_SMOKE_COMPONENTS = 'node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres'
    $env:STACKCABIN_OFFLINE_DIR = $bundlePath
    $env:STACKCABIN_SMOKE_BRANCHES = '22.,24.,8.4.,8.5.'
    foreach ($name in @('STACKCABIN_PUBLISHER_CACHE', 'STACKCABIN_DATA_DIR')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    # This rejects accidental online fetches by the native harness. NICs stay enabled;
    # certificate trust and fresh-OS installation still require separate VM checks.
    $env:http_proxy = 'http://127.0.0.1:1'
    $env:https_proxy = 'http://127.0.0.1:1'
    $env:ALL_PROXY = 'http://127.0.0.1:1'
    $env:NO_PROXY = ''
    function Invoke-Standard([string]$Program, [string[]]$ToolArguments, [string]$Log) {
        $output = Join-Path $evidence $Log
        $code = [StackCabinAcceptance.StandardUser]::Run($Program, $ToolArguments, $workspace, $output)
        Get-Content -LiteralPath $output -Encoding utf8 | Write-Output
        if ($code -ne 0) { throw "Standard-user acceptance failed ($Log): $code" }
    }
    Invoke-Standard -Program $native -ToolArguments @() -Log 'native.log'
    Invoke-Standard -Program $native -ToolArguments @('record-persistence') -Log 'record.log'
    Copy-Item -LiteralPath (Join-Path $fixture 'preservation-baseline.json') -Destination $evidence
    Invoke-Standard -Program $native -ToolArguments @('verify-persistence') -Log 'verify-before-app.log'
    Invoke-Standard -Program $Python -ToolArguments @((Join-Path $PSScriptRoot 'smoke-packaged.py'), $binary, '--data-directory', (Join-Path $fixture 'app-data')) -Log 'application.log'
    Invoke-Standard -Program $native -ToolArguments @('verify-persistence') -Log 'verify-after-app.log'
    [ordered]@{
        schemaVersion = 1; sourceCommit = $sourceCommit
        runnerImage = $env:ImageOS; os = [Environment]::OSVersion.VersionString
        installedVersion = $version; installedApplication = $binary
        applicationSha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        bundleManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $bundlePath 'installer-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        installedResources = $resourceHashes; runtimeCount = $after.runtimeCount
        installerExecuted = $true; scope = 'installation-job'
        standardUser = $true; systemOnlyPath = $true; onlineProxy = 'unreachable'
        persistenceVerified = $true; cleanMachineAcceptance = 'pending'
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'acceptance.json') -Encoding utf8
    Write-Output 'PASS installed normal application opens the existing offline runtime/database fixture as a standard user and preserves its data'
} finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    Stop-Transcript | Out-Null
}
