# Clean-machine acceptance

Hosted CI runners contain developer tools. Their passing results do not certify
installation on a clean desktop. Record the OS/build, architecture, source commit,
installer SHA-256, catalog SHA-256, date, outcome and evidence for each VM.

Required machines are Windows 10 22H2 x64, Windows 11 x64, macOS 14 Intel and
Apple Silicon, and Ubuntu Desktop 22.04/24.04 x64. Rosetta checks supplement a
native Intel VM; they do not replace it.

## Windows runtime test kit

The manual **Build the Windows VM acceptance tool** workflow packages the existing
Rust `native-smoke` acceptance executable with a PowerShell wrapper. This is an
internal QA harness, separate from the product UI. It needs no system Rust, npm,
PHP, Node or database installation. Install StackCabin first so its Microsoft
prerequisites are available. Verify the kit's binary against `SHA256SUMS.txt`.
The wrapper also checks that hash automatically and rejects file, junction and
symlink workspaces before creating acceptance data.

On a clean VM with internet access, use a new dedicated workspace:

```powershell
./Invoke-StackCabinAcceptance.ps1 -Workspace "$env:LOCALAPPDATA/StackCabin QA/online ทดสอบ"
```

Restore a clean snapshot, copy the complete Windows offline bundle and test kit,
disconnect networking, run the bundle's `Install.cmd`, then use another workspace:

```powershell
./Invoke-StackCabinAcceptance.ps1 -Workspace "$env:LOCALAPPDATA/StackCabin QA/offline ทดสอบ" -OfflinePack 'D:/offline-windows-x64'
```

The harness uses the compiled signed catalog, verifies archive hashes, runs PHP
8.4/8.5 and Node 22/24 concurrently through Caddy, checks the PHP/Node version reported
by each server, executes npm/pnpm/Yarn, provisions project databases, reads/writes,
backs up and restores MariaDB/PostgreSQL, and stops its owned servers. It retains
the disposable project/data folders and `acceptance.log` for inspection. It does
not delete an existing workspace or install system development tools.

## Combined Unix runtime verification

The manual **Verify the combined native stack** workflow downloads the four
reviewed native packages listed in `runtime-catalog/native-test-builds.json`.
It verifies component/version/platform/architecture/source identity, archive size
and SHA-256, and the macOS 14.0 minimum before signing a temporary test catalog.
Both Ubuntu versions use the same Ubuntu 22.04 packages. macOS checks run on
14 ARM, 14 x64 through preinstalled Rosetta, and native Intel 15.

In an ephemeral checkout, it assembles matching offline runtime archives and
runs the real core with those archives in a new Thai/spaced workspace. Static,
Node 22/24 and PHP 8.4/8.5 projects stay running while both databases are
provisioned and backed up/restored. Afterward every readable-host and loopback
route is checked again, including the actual runtime reported by the server.
This catches changes that redirect an already-running project to another runtime.

This workflow does not publish a catalog or change the shipping application's
trusted key. It downloads dependencies during pack preparation and does not
establish clean-machine or disconnected-desktop certification. CI artifacts
expire after seven days: update the reviewed run selections after rebuilding;
missing/expired packages must fail rather than silently use another build.

To prepare a VM kit, select the platform and enable `package_qa` on that workflow.
After the combined tests pass, it builds the real acceptance executable in release
mode and packages it with the matching offline archives, source commit, checksums,
component notices and this guide. Download the `native-qa-*.tar.gz` artifact and
its `.sha256`, verify the archive, then extract it to preserve executable modes.
The temporary catalog's private key and CI keychain are excluded.

Install the matching StackCabin preview first for system prerequisites, log in as
an ordinary desktop user, and unlock the normal credential store (login Keychain
on macOS or the desktop Secret Service on Linux). Disconnect the VM's network,
then run from the extracted kit with a new workspace:

```bash
bash ./Run-StackCabinAcceptance.sh "$HOME/StackCabin QA/offline ทดสอบ" ./offline
```

The script verifies its executable hash and refuses nonempty or symlink
workspaces. It installs no system development tools and keeps `acceptance.log`.
This is an internal runtime harness with a development catalog compiled into it;
its offline pack matches that harness and cannot add Unix packages to the normal
preview UI. Test the actual desktop installer and UI separately using the checks
below. Framework dependency installation still needs platform-specific caches.

## Desktop checks on every target

1. Start from a clean snapshot without development runtimes. Test installation
   online, then repeat from a fresh snapshot with the complete offline payload
   while disconnected. Record prerequisite prompts and reboot requests.
2. Create/import all nine presets. Framework dependencies require an internet
   connection or a cache prepared for that OS; runtime archives alone do not
   include arbitrary npm/Composer packages.
3. Run concurrent PHP/Node versions, Laravel with Vite, readable localhost URLs
   and loopback fallbacks. Verify Vue/React/Next source edits update the browser
   while preserving a clicked state counter. Record WebSocket/HMR failures.
4. Occupy a preferred port using a separate program, then start a project. Verify
   StackCabin chooses another port and leaves the separate program running.
5. Test Stop/Restart, closing to tray and Quit. Terminate the app abruptly during
   a running project; verify no owned children remain and unrelated processes
   remain alive. Inspect addresses to confirm services bind only to loopback.
6. Test interrupted installation, insufficient space and retry. Verify a partial
   runtime never appears installed. Linux's bounded tmpfs ENOSPC CI result is
   complementary evidence; include platform-specific installer/storage failures.
7. Back up and restore source plus each database into a new project. Check secret
   exclusions, original project preservation, Thai/spaced paths and restored data.
8. Upgrade from the previous supported installer while retaining actual project
   data, selected runtimes, settings and backups. Record the source/target versions.

Keep failed checks open. Production signing, notarization, runtime hosting and
the corresponding-source/license review remain separate release requirements.
