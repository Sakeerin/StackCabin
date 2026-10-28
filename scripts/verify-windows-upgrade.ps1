# Installs preview packages only on a disposable GitHub-hosted Windows runner.
param(
    [Parameter(Mandatory = $true)][string]$PreviousInstaller,
    [Parameter(Mandatory = $true)][string]$CandidateInstaller,
    [Parameter(Mandatory = $true)][string]$Python
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installer upgrade acceptance requires a disposable GitHub-hosted Windows runner'
}
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runnerTemporary = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$destination = [IO.Path]::GetFullPath((Join-Path $runnerTemporary 'installed upgrade ทดสอบ'))
$fixtureParent = [IO.Path]::GetFullPath((Join-Path $workspace '.local/windows-upgrade'))
$fixture = Join-Path $fixtureParent 'data ทดสอบ'
if (-not $destination.StartsWith($runnerTemporary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    -not $fixture.StartsWith($workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Upgrade paths must remain inside the dedicated runner directories'
}
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $fixtureParent)) {
    throw 'Upgrade acceptance requires new installation and fixture directories'
}
$previous = (Resolve-Path -LiteralPath $PreviousInstaller).Path
$candidate = (Resolve-Path -LiteralPath $CandidateInstaller).Path
if ($previous -eq $candidate) { throw 'Two different installer files are required' }
$native = Join-Path $workspace 'target/debug/examples/native-smoke.exe'
$binary = Join-Path $destination 'stackcabin.exe'
$offline = Join-Path $workspace 'artifacts/offline-windows-x64'
$evidence = Join-Path $workspace 'artifacts'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
Start-Transcript -LiteralPath (Join-Path $evidence 'windows-upgrade-acceptance.log') -Force | Out-Null
$savedEnvironment = @{}
foreach ($name in @('STACKCABIN_SMOKE_DIR', 'STACKCABIN_SMOKE_COMPONENTS', 'STACKCABIN_OFFLINE_DIR')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'StandardUserAcceptance.cs')
    [StackCabinAcceptance.StandardUser]::VerifyIdentity()
    Write-Output 'PASS standard desktop token keeps the current Windows user/credential identity with administrator groups disabled'
    Write-Output "Hosted runner: $env:RUNNER_OS / $env:RUNNER_ARCH"
    Write-Output "Source: $(git -C $workspace rev-parse HEAD)"
    Write-Output "Previous application source: $env:STACKCABIN_PREVIOUS_SOURCE"
    foreach ($installer in @($previous, $candidate)) {
        Write-Output "Installer SHA-256: $((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash) $installer"
    }

    function Install-Version([string]$Installer, [string]$ExpectedVersion) {
        $setup = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$destination" -WindowStyle Hidden -Wait -PassThru
        if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
        $version = (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion
        if ($version -notmatch ('^' + [regex]::Escape($ExpectedVersion) + '(\.0)?(\+.*)?$')) {
            throw "Installed application version $version does not match $ExpectedVersion"
        }
        foreach ($name in @('catalog.json', 'catalog.sig', 'public-key.txt')) {
            $resources = @(Get-ChildItem -LiteralPath $destination -Recurse -File -Filter $name)
            if ($resources.Count -ne 1) { throw "Expected one installed resource: $name" }
            $expectedHash = (Get-FileHash -LiteralPath (Join-Path $workspace "runtime-catalog/$name") -Algorithm SHA256).Hash
            $actualHash = (Get-FileHash -LiteralPath $resources[0].FullName -Algorithm SHA256).Hash
            if ($actualHash -ne $expectedHash) { throw "Installed catalog/trust root differs from the fixture: $name" }
        }
        Write-Output "PASS installed normal application $version at the same Unicode/spaced destination with matching catalog and trust root"
    }

    function Invoke-StandardProgram([string]$Program, [string[]]$ToolArguments) {
        $output = Join-Path $evidence ('standard-user-' + [Guid]::NewGuid().ToString() + '.log')
        try {
            $status = [StackCabinAcceptance.StandardUser]::Run($Program, $ToolArguments, $workspace, $output)
            if ($status -ne 0) { throw "Standard-user acceptance failed: $status" }
        } finally {
            if (Test-Path -LiteralPath $output) {
                Get-Content -LiteralPath $output -Encoding utf8 | Write-Output
                Remove-Item -LiteralPath $output -Force
            }
        }
    }

    function Invoke-Core([string]$Mode) {
        [string[]]$coreArguments = @()
        if ($Mode) { $coreArguments = @($Mode) }
        Invoke-StandardProgram $native $coreArguments
    }

    function Invoke-InstalledApplication {
        Invoke-StandardProgram $Python @((Join-Path $PSScriptRoot 'smoke-packaged.py'), $binary, '--data-directory', (Join-Path $fixture 'app-data'))
    }

    # The actual old installer supplies OS prerequisites before any runtime is executed.
    Install-Version $previous '0.1.0'
    # Only this newly created test parent becomes writable by the limited token.
    # Its ASCII path also owns PostgreSQL's compatibility junction for Thai data paths.
    New-Item -ItemType Directory -Path $fixtureParent | Out-Null
    $fixtureAcl = Get-Acl -LiteralPath $fixtureParent
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $access = [Security.AccessControl.FileSystemAccessRule]::new($userSid, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $fixtureAcl.SetAccessRule($access)
    Set-Acl -LiteralPath $fixtureParent -AclObject $fixtureAcl
    $env:STACKCABIN_SMOKE_DIR = $fixture
    $env:STACKCABIN_SMOKE_COMPONENTS = 'node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres'
    $env:STACKCABIN_OFFLINE_DIR = $offline
    Invoke-Core
    Invoke-Core 'record-persistence'
    Copy-Item -LiteralPath (Join-Path $fixture 'preservation-baseline.json') -Destination (Join-Path $evidence 'preservation-baseline-windows.json')
    Invoke-Core 'verify-persistence'
    Invoke-InstalledApplication
    Invoke-Core 'verify-persistence'

    Install-Version $candidate '0.1.1'
    Invoke-InstalledApplication
    Invoke-Core 'verify-persistence'
    Write-Output 'PASS actual Windows NSIS 0.1.0 -> unpublished 0.1.1 upgrade preserves all real fixture data'
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Stop-Transcript | Out-Null
}
