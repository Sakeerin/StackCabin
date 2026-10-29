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
Use `linux-baseline` to build the Linux kit on Ubuntu 22.04; `linux` runs both
Ubuntu versions. Keep the Ubuntu 22.04 executable for testing the older baseline.
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

**Verify an existing Unix acceptance kit** reuses a previously built artifact on
another supported hosted runner without invoking Cargo/npm or rebuilding it.
On Linux it verifies the archive, enters a new network namespace containing only
loopback, then runs the entire portable harness as the ordinary runner user with
a fresh OS credential store. It refuses a namespace with any external interface.
This establishes runtime installation and operation without an external network;
it still does not replace installation on a clean desktop VM.

Internal kit evidence from 24 October 2026 (artifacts expire after seven days):

| Target       | Build and verification                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64  | [Release harness and five wrapper safeguard checks](https://github.com/Sakeerin/StackCabin/actions/runs/40056740193); use the matching Windows offline pack from the normal catalog                                             |
| macOS 14 ARM | [Build, package, extract and run](https://github.com/Sakeerin/StackCabin/actions/runs/40057001216)                                                                                                                              |
| macOS x64    | [Native Intel 15 and macOS 14 through Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/40057509499); select the matching artifact, including the macOS 14 x64 kit for baseline testing                              |
| Ubuntu x64   | [Ubuntu 22.04 kit](https://github.com/Sakeerin/StackCabin/actions/runs/40057065876), reused successfully on [Ubuntu 24.04 with no external network interfaces](https://github.com/Sakeerin/StackCabin/actions/runs/40057428684) |

Use `SOURCE_COMMIT.txt` and the included checksums to identify the exact kit.
These internal runtime tests complement the desktop/installer VM record below.

## Unix QA desktop installers

The manual **Build Unix QA desktop installers with offline runtimes** workflow
builds the real **StackCabin QA** desktop application with the verified catalog
from an existing runtime kit. Select `linux`, `macos-arm64`, `macos-x64`, or `all`.
It verifies the catalog signature and every archive before building. A native
WebDriver session installs all eleven target runtimes, uses the UI Start/Stop
buttons for PHP and Node, verifies actual HTTP runtime versions, writes both
server databases and restores each backup into a distinct project/database.
Long IPC operations are polled without holding the driver's 30-second eval call.

After acceptance, it rebuilds without E2E plugins and packages `.deb`/`.AppImage`
or `.dmg` with the matching `offline` folder, checksums, notices and source commit
IDs. Download the `desktop-qa-*` artifact, verify/extract the `.tar.gz` and follow
its README, also available as [QA_DESKTOP.md](QA_DESKTOP.md). The application has
its own binary, application ID, metadata and OS credential namespace, with a QA
banner. Its development catalog does not change the normal preview catalog.

**Verify an existing QA desktop installer on the baseline** reuses these exact
installer files on Ubuntu 24.04 or macOS 14 without rebuilding the application.
It checks checksums, package identity and actual normal application startup in
an isolated data directory. On Linux it first installs the normal preview and
confirms the QA installation preserves that executable, then starts the QA deb
and AppImage. This startup check is separate from runtime acceptance and does
not certify a clean desktop, offline system prerequisites or upgrades.

## Desktop checks on every target

The [packaged preservation workflow](UPGRADE_ACCEPTANCE.md) provides automated
same-schema preview 0.1.0 → unpublished 0.1.1 replacement checks with real project,
runtime, credential, database and backup data. It complements the supported-release
and clean-desktop upgrade checks below.

The core owner-crash regression launches two real process trees and an unrelated
HTTP process, kills only their supervisor host, and checks descendant process
exit, closed ports and the unrelated server's continued health. It runs with the
core tests on every CI target. Record actual desktop crash and tray/Quit behavior
on each VM as required below.

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
   data, selected runtimes, settings and backups. Exercise both the OS default
   data location without `STACKCABIN_DATA_DIR` and an explicit Thai/spaced custom
   directory. Record the actual data paths and source/target versions.

Keep failed checks open. Production signing, notarization, runtime hosting and
the corresponding-source/license review remain separate release requirements.
