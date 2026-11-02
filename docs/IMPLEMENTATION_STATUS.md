# Implementation and verification status

Development version: **0.1.0**, checked on **2 November 2026**.
This is a working development preview. The simultaneous Windows/macOS/Ubuntu
production acceptance gate remains open.

## Implemented

- Tauri 2/React desktop UI: dashboard, projects/details/logs, runtimes, shared
  services, SQL console, backups and settings; English/Thai and light/dark/system.
- Nine create/detect presets: static, PHP, Laravel, Node, Express, Vue, React,
  Nest and Next. Imports inspect framework and npm/pnpm/Yarn lock files.
- Explicit project trust, read-only setup plans, generated typed Rust/TypeScript
  IPC, SQLite metadata, portable project manifests and separate runtime locks.
  Setup previews share command builders with execution; unavailable runtime pins
  block installation before the first download. Stale UI reviews are discarded.
- Managed per-project PHP/Node versions and package managers; Caddy reverse proxy
  and FastCGI, multiple processes/projects, port fallback, readiness checks and
  streamed logs. Loopback health checks ignore machine proxies and redirects.
- Signed catalog and checksum verification, archive traversal checks, bounded
  transport retries, cancellation, offline archives and receipt-last installation.
  Official PHP archive and Node distribution aliases retain exact versions/hashes.
- Windows Job Objects and Unix process groups/watchdogs contain owned children.
  Shutdown closes admission, cancels preparation/downloads, drains accepted
  backup/database work and waits for real cleanup before exit. Repeated Quit
  cannot bypass shutdown; closing a window can keep projects running in the tray.
- Shared MariaDB/PostgreSQL with separate project accounts, OS keychain
  credentials, per-project SQLite and logical database dump/restore.
- Backup/restore into new project/database identities; source files remain when
  forgetting a project. Secrets, dependencies and runtime folders are excluded
  by default. Staging cleanup preserves unrelated files; archive export never
  replaces an existing destination, including one created during the copy.
- Atomic configuration publication syncs a complete staged file on the destination
  filesystem, cleans failed staging and retries Windows access/sharing locks for
  up to one second while preserving the last good document.
- Normal Windows NSIS, Ubuntu deb/AppImage and separate macOS ARM/Intel DMGs.
  Windows online/offline setup verifies pinned Microsoft prerequisites; offline
  `-CheckOnly` validates the complete payload without executing an installer.
- Separate internal Unix QA app/catalog/credential identities and matching offline
  runtime packs; distributed QA apps exclude E2E plugins. See [QA usage](QA_DESKTOP.md).

## Current verification

Hosted verification now uses macOS 15 ARM/Intel after the macOS 14 image's
retirement. Rosetta remains an explicit x64 compatibility check on ARM hosts;
Intel hosts always select x64 installer artifacts. Four workflow-contract checks
cover platform selection and kit/desktop/upgrade artifact wiring. CI also runs
checksum-pinned actionlint 1.7.12 and rejects retired hosted runner labels.
QA build/upgrade workflows require an explicit producer `source_run` instead of
expired hardcoded IDs. Old native/QA artifact selections need reviewed rebuilds
before full Unix QA runs; these changes do not replace or certify those packages.

The distributed normal application is source `2b3836e`. The current acceptance
harness is source `44a082b`; its changes are confined to documentation, workflows
and reviewed test/packaging helpers. The real source/catalog compatibility check
passed in `artifacts/baseline-upgrade-20261101/current-installer-compatibility.json`.

| Check | Latest evidence and scope |
| --- | --- |
| Cross-platform CI | [41271196197](https://github.com/Sakeerin/StackCabin/actions/runs/41271196197): all ten jobs passed on Windows x64, Ubuntu 22.04/24.04 x64, native macOS 15 ARM and Intel. |
| Core/frontend | 48 Windows / 44 Unix core tests; four ignored entries are separately invoked child-process fixtures. Fourteen frontend tests, formatting, Clippy and generated IPC checks passed. |
| Desktop | Four real IPC/SQLite E2E cases and four lifecycle sessions on each CI target, plus two desktop exit-coordination tests. Actual tray pointer interaction remains a clean-VM check. |
| Native tools | Managed Node 22/24, npm/pnpm/Yarn, Caddy and concurrent HTTP passed on all five targets; Windows also exercises PHP 8.4/8.5. Unreachable machine proxies do not redirect loopback health checks. |
| Normal installers | [41209952479](https://github.com/Sakeerin/StackCabin/actions/runs/41209952479): all four packaging jobs passed, with actual installed Windows/deb startup and both macOS bundles. Builds exclude E2E features. |
| Ubuntu 24.04 | [41210382919](https://github.com/Sakeerin/StackCabin/actions/runs/41210382919): the same Ubuntu 22.04 deb/AppImage passed checksums and real startup; AppImage used extract-and-run without FUSE. |
| macOS 14 ARM | [41270976722](https://github.com/Sakeerin/StackCabin/actions/runs/41270976722): the same ARM DMG passed checksums, mount/copy, binary dependency/minimum-OS checks and normal app startup on macOS 14.8.9. |
| macOS 14 x64 | [41270979416](https://github.com/Sakeerin/StackCabin/actions/runs/41270979416): the same Intel DMG passed those checks through Rosetta on the ARM runner. Native Intel macOS 14 remains a separate gate. |
| Actual disk exhaustion | [41209951170](https://github.com/Sakeerin/StackCabin/actions/runs/41209951170), Ubuntu 24.04: bounded 32 MiB tmpfs produced real ENOSPC for settings writes and runtime extraction; old data survived, staging was cleaned, and retries succeeded after freeing owned space. |
| Windows offline installation | [41210773901](https://github.com/Sakeerin/StackCabin/actions/runs/41210773901): real wrapper/NSIS installation, eleven tools, five concurrent HTTP projects, both database dump/restores and existing-data preservation passed under a restricted standard-user token. |

Six atomic-write regressions exercise released/persistent Windows sharing locks,
read-only files, failed publication cleanup, Thai/space paths and complete reads
during replacement. The disk-full probe retains the native I/O error code rather
than weakening its ENOSPC assertion.

Lifecycle coverage includes native close/restore, close without tray, abrupt
app termination and repeated Quit while accepted work is pending. Owned process
trees stop while an unrelated HTTP server stays healthy. Real owner-crash tests
bypass Rust destructors and verify descendant exit and closed ports.

The local acceptance guards and source-policy suite passed sixteen checks on
1 November. App-input changes still require a new normal installer; the explicit
allowlist now includes the upgrade-only Windows test helper.

## Windows installation and upgrade

The current offline ZIP installed through its own wrapper at a Thai/spaced path.
The installed catalog, signature and trust root matched the bundle. Eleven tools
came from its archives with system-only PATH and unreachable online proxies.
Static, Node 22/24 and PHP 8.4/8.5 stayed reachable concurrently; npm/pnpm/Yarn
ran against both Node branches. MariaDB/PostgreSQL provision, SQL read/write,
logical dump and restore passed.

The installed normal app opened the populated metadata database. Ten projects,
five database bindings, eleven tools and 78 file hashes retained identities,
settings, trust, runtime pins, source files and backups under the restricted
standard-user token. The runner was `win25-vs2026`, Windows build 26100, with
Microsoft prerequisites already installed and network interfaces enabled.
This establishes hosted installation/preservation rather than fresh-OS or
physically disconnected-machine certification.

Both Windows upgrade jobs passed in
[41271196566](https://github.com/Sakeerin/StackCabin/actions/runs/41271196566).
It uses previous normal source `7b4dbda` from installer run `41081836769` and an
unpublished 0.1.1 test candidate from source `44a082b`. The distributed version
remains 0.1.0. Separate hosted jobs verified the physical default application-data
directory and a custom Thai/spaced directory. Both old/new installed apps held
the original metadata database open; all ten projects, five databases, eleven
tools and 78 file hashes remained valid, including real HTTP/runtime versions
and existing SQL rows. The core harness performs HTTP/SQL verification; packaged
apps are checked for real startup and metadata-file use. Default mode also proved
that both apps resolve Windows' real application-data directory without an
override. See [upgrade scope](UPGRADE_ACCEPTANCE.md).
The wrapper explicitly selects all four PHP/Node branches despite an intentionally
unsupported inherited filter, then restores the caller's environment. Curated
transcripts/baselines are in `artifacts/baseline-upgrade-20261101/windows/`.

## Downloads and retained evidence

Download the normal `development-installers-*` artifacts from
[41209952479](https://github.com/Sakeerin/StackCabin/actions/runs/41209952479)
and verify their `SHA256SUMS.txt`. All five downloaded installer files also
matched those checksums locally. Windows NSIS is 23,017,758 bytes, SHA-256
`59cc2edc17c451b6e1a4aaed491c3318eb99234cc917fe21fe197e0ac4f60a7e`.

The complete `development-offline-windows-x64` ZIP is in
[41210773901](https://github.com/Sakeerin/StackCabin/actions/runs/41210773901),
881,309,997 bytes, SHA-256
`fb5ea21785d1e8c3f88c2acc5e5bb6c4a588d388ac49ba56678eda0ddc4a5850`.
Its receipt matched GitHub artifact metadata; the full ZIP was not downloaded
locally. The installed normal executable SHA-256 is
`da2aacec8997993485d8835965a1a21351135a0a2c8d1980001fc8c2112ebbd8`.
These development artifacts have seven-day retention.

Local logs and metadata are ignored under `artifacts/`: current CI/macOS evidence
in `baseline-upgrade-20261101/`; installer/offline/disk-full evidence in
`atomic-write-20261031/`. The current fourteen-job summary is
`baseline-upgrade-20261101/BUILD_VERIFICATION.json`. The older aggregate binds its seventeen successful jobs
to the exact app source and bundle/catalog hashes. The local offline folder also
passed complete read-only verification of 25 files, eleven runtimes and Microsoft
signature/version checks without executing an installer on this computer.

Earlier framework, HMR, full Unix PHP/database, QA-desktop and upgrade results are
retained in the
[historical report](https://github.com/Sakeerin/StackCabin/blob/44a082bde38134d49e0aa1e0ab1242c3aec1e6c8/docs/IMPLEMENTATION_STATUS.md).
That report preserves source/run-specific evidence and earlier failed attempts;
its old test counts and download links are historical. Local evidence, projects,
databases and runtime archives were retained when consolidating this report.

Earlier Windows framework checks installed Express/Vue/React/Nest/Next/Laravel
dependencies and served real HTTP; Laravel ran PHP and Vite together. React/Vue/
Next browser HMR preserved a clicked counter, including WebSocket upgrades.
Earlier isolated Unix QA desktops exercised all eleven runtimes through IPC,
PHP/Node start/stop, SQL and new-identity backup restore, then produced normal
QA installers. These QA catalogs remain separate from the shipping catalog.

## Remaining production gates

1. **Complete the shipping runtime catalog.** Its signed development catalog has
   32 entries: cross-platform Node/Caddy/Composer/package managers/CA artifacts,
   with PHP and database packages for Windows x64. Normal Unix previews correctly
   mark missing PHP/MariaDB/PostgreSQL packages unavailable. Publish reviewed Unix
   packs at stable HTTPS URLs and certify them before signing the complete
   production catalog. Source/checksum pins are in
   `runtime-catalog/source-archives.json`; `native-test-builds.json` selects
   temporary CI archives for internal tests. Every macOS library must measure at
   most 14.0; earlier incompatible PHP/Intel MariaDB archives stay excluded.
   Native MariaDB omits optional Mroonga/CONNECT ODBC; its reviewed replacement
   avoids the newer Homebrew libltdl dependency. Unix runtime aliases/sockets
   preserve Unicode database paths.
2. **Certify clean machines.** Run online/offline setup, missing-prerequisite/UAC,
   upgrades, runtime/database, HMR, tray pointer, crash and disk-full checks on
   Windows 10 22H2/11 x64, native macOS 14 Intel/ARM, and Ubuntu Desktop 22.04/24.04
   x64. Hosted runners, WSL2, system-only PATH and Rosetta supplement those checks.
   [The VM guide](VM_ACCEPTANCE.md) covers the matrix and portable acceptance kits;
   [upgrade acceptance](UPGRADE_ACCEPTANCE.md) defines default/custom preservation.
   GitHub's [macOS 14 runner schedule](https://github.com/actions/runner-images/issues/13518)
   retires that hosted image on 2 November 2026. A maintained macOS 14 machine is
   required afterward; a newer runner cannot certify the older baseline.
3. **Configure production signing/distribution.** Supply catalog keys, Windows
   signing, Apple signing/notarization, a maintained signed app-update endpoint
   and release configuration. Self-update distribution remains disabled.
4. **Complete release review.** Review component licenses, corresponding source
   and prerequisite redistribution, plus the StackCabin name/domain/trademark.

Unavailable runtimes and browser-only previews are shown explicitly. Passing
development checks does not mark the production gate complete.
