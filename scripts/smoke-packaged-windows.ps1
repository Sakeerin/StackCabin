param(
    [string]$Application = 'target/release/stackcabin.exe',
    [Parameter(Mandatory = $true)][string]$Python
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = [IO.Path]::GetFullPath((Join-Path $workspace $Application))
$data = Join-Path $workspace ('.local/packaged-smoke/' + [Guid]::NewGuid().ToString())
$previous = $env:STACKCABIN_DATA_DIR
$env:STACKCABIN_DATA_DIR = $data
$process = $null
try {
    $process = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
    $metadata = Join-Path $data 'stackcabin.sqlite'
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($process.HasExited) { throw "Packaged application exited during startup: $($process.ExitCode)" }
        if (Test-Path -LiteralPath $metadata) { break }
        Start-Sleep -Milliseconds 100
    }
    if (!(Test-Path -LiteralPath $metadata)) { throw 'Native application did not initialize its data directory' }
    $verify = @'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute('PRAGMA user_version').fetchone()[0] == 1
    assert db.execute('SELECT count(*) FROM projects').fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM sqlite_master WHERE name='settings'").fetchone()[0] == 1
print('PASS normal packaged application initializes real SQLite metadata')
'@
    & $Python -c $verify $metadata
    if ($LASTEXITCODE -ne 0) { throw 'Packaged application metadata check failed' }
    Start-Sleep -Seconds 2
    if ($process.HasExited) { throw 'Packaged application exited after startup' }
    Write-Output 'PASS normal application stays alive without E2E plugins'
} finally {
    if ($process -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $env:STACKCABIN_DATA_DIR = $previous
}
