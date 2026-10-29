# Implementation and verification status

Development version: **0.1.0**, checked on **29 October 2026**.
This is a working development preview. It has not passed the plan's simultaneous
Windows/macOS/Ubuntu production acceptance gate.

## Implemented

- Tauri 2 desktop shell and React interface: dashboard, projects/details/logs,
  runtimes, shared services, database SQL console, backups and settings.
- English/Thai, light/dark/system, SQLite metadata, tray lifecycle, explicit trust,
  project manifests and separate runtime lock files, generated Rust/TypeScript IPC.
- Nine create/detect presets: static, PHP, Laravel, Node, Express, Vue, React,
  Nest and Next. Imports detect framework and npm/pnpm/Yarn lock files.
- Managed, versioned PHP/Node and package-manager execution; Caddy FastCGI/reverse
  proxy; concurrent projects; port conflict handling; real readiness checks and
  process state; streamed logs; Windows Job Objects and Unix group watchdogs.
- Signature/checksum-verified runtime installation, cancellation, offline archives,
  traversal rejection, incomplete-install recovery and receipt-last publication.
- Shared MariaDB/PostgreSQL instances, separate project accounts, OS keychain
  credentials, per-project SQLite, logical dumps, and verified restore into a new
  project/database. Source folders remain when removing a project.
- Windows online installer and offline bundle assembly including verified
  Microsoft WebView2/Visual C++ prerequisites. Bundled third-party notice inventory.
- CI for Windows, Ubuntu 22.04/24.04 and macOS Intel/Apple Silicon, Unix native
  runtime build pipeline, and a release catalog gate.
- Internal Unix QA desktop packaging with the complete matching offline catalog,
  separate application/binary/metadata/credential identities, and native QA
  banner. Distributed QA installers exclude the E2E plugins.

## Verification evidence

Logs and screenshots are generated locally under ignored `artifacts/`.

| Check                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production frontend        | TypeScript and Vite build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Frontend tests             | 5 tests: preview honesty, templates/trust, Thai/theme, process state and sizes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Rust core                  | 24 passed on Windows; 2 ignored tests are launched child-process fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Core edge cases            | Corrupted archives, traversal, signed catalog tampering, interrupted installation, Unicode registration, future schema, port conflicts, secret-free SQLite backup/restore and concurrent destination reservation                                                                                                                                                                                                                                                                                                                    |
| Native lifecycle           | Real HTTP grandchild, stop of its process tree, and cleanup after its parent exits unexpectedly                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Native Desktop E2E         | 4 cases against real Rust IPC/SQLite; screenshot `stackcabin-desktop.png`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cross-platform CI          | [Run 40678439282](https://github.com/Sakeerin/StackCabin/actions/runs/40678439282): Windows, Ubuntu 22.04/24.04 and macOS Intel/Apple Silicon passed frontend/core tests, native builds, Desktop E2E and managed toolchains, including the unreachable-proxy regression                                                                                                                                                                                                                                                             |
| Normal Windows package     | [Run 40056742523](https://github.com/Sakeerin/StackCabin/actions/runs/40056742523): release NSIS includes the loopback/proxy fix and pinned Microsoft prerequisite; normal application startup initializes isolated SQLite without E2E plugins                                                                                                                                                                                                                                                                                      |
| Installed preview packages | [Run 40047451505](https://github.com/Sakeerin/StackCabin/actions/runs/40047451505): Windows NSIS, Ubuntu 22.04 deb, and macOS ARM/Intel DMGs built successfully; normal application startup used isolated SQLite metadata. macOS bundle checks reject external non-system library paths and unsupported minimum OS versions                                                                                                                                                                                                         |
| Windows prerequisites      | The NSIS installer embeds pinned Microsoft Visual C++ 14.51.36247 x64, verifies SHA-256/Authenticode/version, detects existing runtime versions, and elevates only Microsoft's installer when needed. Four read-only integrity tests passed. [Installed-package verification](https://github.com/Sakeerin/StackCabin/actions/runs/40048115886) confirmed the required version and application startup in a Thai/spaced installation path; that runner already had 14.51, so missing-runtime/UAC acceptance remains a clean-VM check |
| macOS 14 installers        | Fixed the Intel bundle's external Homebrew liblzma dependency by linking xz statically. DMG mount/copy, strict binary dependency/minimum-OS checks and actual application startup passed for [ARM](https://github.com/Sakeerin/StackCabin/actions/runs/40048119819) and [x64 via Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/40048533899)                                                                                                                                                                          |
| Ubuntu 24.04 installers    | [Run 40048741905](https://github.com/Sakeerin/StackCabin/actions/runs/40048741905): the same Ubuntu 22.04 deb and AppImage passed complete distributed-installer checksums and real application startup on Ubuntu 24.04; AppImage used extract-and-run without FUSE                                                                                                                                                                                                                                                                 |
| Actual disk exhaustion     | [Ubuntu 24.04 acceptance](https://github.com/Sakeerin/StackCabin/actions/runs/39960665443): dedicated 32 MiB tmpfs produced ENOSPC during installation; no installed receipt or executable resolution, staging cleaned, same archive installed after freeing owned space                                                                                                                                                                                                                                                            |
| Packaging verification     | 31 cross-platform Python checks cover explicit HTTPS mirror recovery, checksum/HTTPS-downgrade failures, traversal, FastCGI fragmentation, macOS library baseline rejection and complete installer checksum verification. Seven JavaScript stack checks reject incorrect source/architecture/identity, corrupt or truncated archives, duplicates and unsupported macOS requirements                                                                                                                                                 |
| Framework acceptance       | Express, Vue, React, Nest, Next and Laravel dependency installation and actual HTTP; Laravel runs PHP and Vite together                                                                                                                                                                                                                                                                                                                                                                                                             |
| Browser HMR on Windows     | Actual React/Vue/Next browsers updated after source edits through Caddy while preserving a clicked counter. React/Vue WebSocket probes received HTTP 101 and module updates. React's starter now exports `App.jsx` to support Fast Refresh; screenshots `hmr-react.png` / `hmr-next.png`                                                                                                                                                                                                                                            |
| Real databases             | MariaDB/PostgreSQL provision, insert/select, dump, new-identity restore and select; SQLite consistent snapshot/restore                                                                                                                                                                                                                                                                                                                                                                                                              |
| Windows Unicode data path  | Actual PHP/Node/Caddy/MariaDB HTTP/data in a Thai/spaced path; PostgreSQL initialization and restore through the verified ASCII junction                                                                                                                                                                                                                                                                                                                                                                                            |
| Offline tools              | Managed Node 22/24, PHP 8.4/8.5, npm/pnpm/Yarn, Composer, Caddy and databases from local archives; the test does not download framework dependencies                                                                                                                                                                                                                                                                                                                                                                                |
| Managed Node toolchains    | [Cross-platform smoke](https://github.com/Sakeerin/StackCabin/actions/runs/39951584400) passed installation, npm/pnpm/Yarn, concurrent Node 22/24 HTTP through Caddy and shutdown on Windows, Ubuntu 22.04/24.04, macOS ARM/Intel. Each server's response identifies its actual Node version                                                                                                                                                                                                                                        |
| Node macOS 14 baseline     | [ARM](https://github.com/Sakeerin/StackCabin/actions/runs/39951641290) and [x64 through Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/39951647274) passed the same real managed-toolchain smoke                                                                                                                                                                                                                                                                                                                      |
| Unix PHP acceptance        | PHP 8.4/8.5 [native runs](https://github.com/Sakeerin/StackCabin/actions/workflows/native-runtime.yml): relocated PHP-FPM/SQLite and real Rust-core HTTP passed on Ubuntu 22.04 and macOS 15 Intel/Apple Silicon                                                                                                                                                                                                                                                                                                                    |
| PHP ARM source libraries   | PHP [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/39960104209) and [8.5](https://github.com/Sakeerin/StackCabin/actions/runs/39960117212) rebuilt their library closure from source, passed relocated FPM/SQLite and real core HTTP with a measured macOS 14.0 minimum. Baseline execution is checked separately                                                                                                                                                                                                        |
| PHP macOS 14 ARM execution | PHP [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/39962667129) and [8.5](https://github.com/Sakeerin/StackCabin/actions/runs/39962594228) passed real Rust-core installation and Caddy/FPM HTTP on macOS 14 using the same source-built archives                                                                                                                                                                                                                                                                        |
| PHP macOS 14 x64 execution | Source-built PHP [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/39961891973) and [8.5](https://github.com/Sakeerin/StackCabin/actions/runs/39960124131) passed on native Intel macOS 15. The same packs passed installation/Caddy/FPM HTTP on macOS 14 through Rosetta for [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/40046616930) and [8.5](https://github.com/Sakeerin/StackCabin/actions/runs/40046620479)                                                                                             |
| PostgreSQL Unix acceptance | [Run 39916993042](https://github.com/Sakeerin/StackCabin/actions/runs/39916993042): PostgreSQL 18.6 SCRAM setup, private project account, insert/select, dump/restore and real Rust-core integration on Ubuntu 22.04 and macOS 15 Intel/Apple Silicon                                                                                                                                                                                                                                                                               |
| PostgreSQL macOS 14        | [Source-library build](https://github.com/Sakeerin/StackCabin/actions/runs/39920049255) measures 14.0 on both architectures. [Actual macOS 14 ARM acceptance](https://github.com/Sakeerin/StackCabin/actions/runs/39922116967) passed real core provisioning/read/write/backup/restore in a Thai/spaced app-data path                                                                                                                                                                                                               |
| MariaDB Ubuntu 24.04       | [Run 39923305298](https://github.com/Sakeerin/StackCabin/actions/runs/39923305298) passed real core installation, version check, provision/read/write/dump/restore using the Ubuntu 22.04 source-built package                                                                                                                                                                                                                                                                                                                      |
| MariaDB macOS core         | [ARM source build](https://github.com/Sakeerin/StackCabin/actions/runs/39928392371) and [corrected Intel source build](https://github.com/Sakeerin/StackCabin/actions/runs/40055522282) passed relocation and real core database operations with a measured 14.0 minimum. The Intel replacement excludes the optional CONNECT ODBC adapter that pulled in newer Homebrew libltdl                                                                                                                                                    |
| MariaDB macOS 14 x64       | [Compatibility verification](https://github.com/Sakeerin/StackCabin/actions/runs/39951635821) passed real core database operations on macOS 14 using preinstalled Rosetta; native Intel installer acceptance remains separate                                                                                                                                                                                                                                                                                                       |
| Ubuntu 24.04 WSL2          | Downloaded/checksummed Ubuntu 22.04 PHP 8.4/8.5, PostgreSQL and MariaDB packs, removed debug symbols, then passed relocated FastCGI/SQLite and database dump/restore as unprivileged `nobody`; this is not a clean desktop installer VM                                                                                                                                                                                                                                                                                             |
| Project URLs               | Readable `.localhost` hosts and dedicated loopback fallback routes verified for PHP, Node and static projects                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Portable Windows QA kit    | [Run 40056740193](https://github.com/Sakeerin/StackCabin/actions/runs/40056740193) builds the release harness with actual PHP/Node HTTP version checks and loopback isolation; five wrapper tests verify checksum failures and preservation of existing files, hidden data and junction targets                                                                                                                                                                                                                                     |

Portable Unix kits passed compilation, archive extraction and execution of the
release harness in fresh workspaces on [macOS 14 ARM](https://github.com/Sakeerin/StackCabin/actions/runs/40057001216)
and [Ubuntu 22.04](https://github.com/Sakeerin/StackCabin/actions/runs/40057065876).
The corrected Intel stack also passed the same tests on
[native Intel macOS 15 and macOS 14 through Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/40057509499),
including both PHP branches, both Node branches and both database restores.
The same Ubuntu 22.04 kit passed on [Ubuntu 24.04 with only loopback available](https://github.com/Sakeerin/StackCabin/actions/runs/40057428684),
as an ordinary user: all runtime installations, five concurrent web projects,
package-manager version checks, both database dumps/restores and owned shutdown
completed without external network interfaces. This is runtime/offline evidence,
not clean-desktop installer certification.

The real Unix QA desktop installs all eleven target runtimes through IPC, starts
PHP and Node using UI buttons, checks their actual HTTP versions, writes both
database servers, and restores backups into distinct project/database identities.
Packaging only follows passing native E2E checks; the distributed application is
rebuilt without WebDriver plugins. The signed development catalog and matching
offline archives stay together in each internal QA pack. Five helper tests reject
incomplete stacks, corrupted archives, altered catalog signatures and unmarked
production catalogs. See [QA desktop usage](QA_DESKTOP.md) and
[installer acceptance](VM_ACCEPTANCE.md#unix-qa-desktop-installers).

Six desktop cases passed for the full stack on
[Ubuntu 22.04](https://github.com/Sakeerin/StackCabin/actions/runs/40075038598),
[macOS ARM](https://github.com/Sakeerin/StackCabin/actions/runs/40074337734/job/120814387895)
and [native Intel macOS](https://github.com/Sakeerin/StackCabin/actions/runs/40075333416),
followed by successful installer builds, checksums and actual application startup.
The later Ubuntu and Intel runs also assert that UI Stop reaches the exact source
project ID and that restored database identities differ from their source databases.
The embedded driver's direct-eval endpoint has a separate 30-second deadline;
long QA IPC calls now continue in the WebView while the test polls their result,
preserving actual native work without extending a single driver evaluation.

The Ubuntu QA deb/AppImage passed on
[Ubuntu 24.04](https://github.com/Sakeerin/StackCabin/actions/runs/40075035942),
including installation alongside the normal preview and preservation of its
executable. The QA DMG passed mount/copy, identity, binary dependency/minimum-OS
checks and application startup on
[macOS 14 ARM](https://github.com/Sakeerin/StackCabin/actions/runs/40074974206).
The same checks passed for the Intel QA DMG on
[macOS 14 through preinstalled Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/40076438073).
These are hosted-runner startup checks; clean desktop and supported-release upgrade
checks remain.

The [populated QA upgrade workflow](UPGRADE_ACCEPTANCE.md) tests the previous
0.1.0 package against an unpublished 0.1.1 candidate in the same dedicated custom
data directory. It records ten projects, five original/restored server/SQLite
database bindings, language/theme/trust/runtime selections and source, backup,
receipt and executable hashes. Both normal packaged applications must hold the
existing metadata database open and preserve its exact project/settings rows.
After each closes, the real core reads the existing databases through OS keychain
credentials and starts every stored project, checking actual HTTP/runtime versions.
The mode refuses to overwrite a baseline, reinstall tools or repopulate expected
rows to make verification pass. A private CI keychain is created after compilation
with a bounded timeout and deleted after evidence collection. This is same-schema
preview replacement, separate from default-data-path and clean-VM release
certification.

[Run 40104040800](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800)
passed these complete checks on Ubuntu 22.04 x64, macOS 14 ARM and native Intel
macOS 15. Each verified eleven installed runtimes, ten projects, five existing
database bindings and 78 file hashes, plus the packaged process's open metadata
handle for both versions. All 28 Python helper tests passed on these Unix runners.

The shared packaged-application startup helper now also verifies actual Windows
metadata file use through Restart Manager. Its 31 helper regressions pass on
Windows and Ubuntu WSL, including real SQLite open/close, wrong-file and wrong-PID
checks, plus real default-path selection despite an inherited override. Two Rust
manifest checks cover the default and custom physical layouts. Seven Windows
wrapper tests include refusal to run upgrade installers on
local or self-hosted machines, and the fixtures clean themselves after testing.
The additional check verifies restricted-token identity and actual literal
Unicode/empty/quoted argument round-tripping through a real Windows child process.
The [Windows NSIS preservation run](https://github.com/Sakeerin/StackCabin/actions/runs/40654545909/job/122702304801)
passed on 28 October: an actual normal 0.1.0 installation was upgraded in place to
an unpublished 0.1.1 candidate. Both installed applications opened the same existing
metadata, with actual file use verified through Restart Manager. All ten projects,
five original/restored MariaDB/PostgreSQL/SQLite bindings, eleven installed tools,
78 file hashes and Thai/dark/nondefault-port settings survived. After replacement,
the core read existing database rows and verified all ten projects' actual
HTTP/runtime versions without resetting the fixture.

The hosted runner's restricted-process launcher now explicitly retains user
access in the new token's default ACL while disabling administrator membership.
An early real Python child confirms non-administrative membership and literal
Unicode/empty/quoted arguments before installer compilation. This is scoped to the
CI helper, with the same user SID/credential identity; the product's process
supervisor is unchanged. Hosted success does not certify a clean VM.

Default OS application-data preservation now also passes without
`STACKCABIN_DATA_DIR`: [normal Windows NSIS](https://github.com/Sakeerin/StackCabin/actions/runs/40668451630/job/122748871893),
[Ubuntu 22.04 QA deb](https://github.com/Sakeerin/StackCabin/actions/runs/40668991214/job/122750675963),
[macOS 14 ARM QA DMG](https://github.com/Sakeerin/StackCabin/actions/runs/40668991214/job/122750676266),
[native macOS 15 Intel QA DMG](https://github.com/Sakeerin/StackCabin/actions/runs/40668991214/job/122750676400)
and [macOS 15 ARM QA DMG](https://github.com/Sakeerin/StackCabin/actions/runs/40670379025/job/122755339817).
Every target retained ten projects, five existing database bindings, eleven tools,
78 hashes and exact settings; both installed versions held the original metadata
file open and the core verified existing SQL rows and live HTTP/runtime versions.
The default folder is physical; only the fixture workspace links to it for the
native probe. Windows custom-path acceptance also passed independently on a
separate runner. All new installer modes reject local and self-hosted execution.
The upgrade workflow keeps a current Apple Silicon runner available while
retaining an explicit macOS 14 baseline option; that hosted image retires on
2 November 2026. See [upgrade acceptance](UPGRADE_ACCEPTANCE.md) for scope and evidence.

Local Windows acceptance on 28 October retained all ten projects, five database
bindings, eleven runtimes and 78 file hashes after the normal desktop executable
opened the populated Thai/spaced directory. Both fresh and existing metadata
startup passed; the core then verified real HTTP versions and existing SQL rows.

On 28 October the pinned Windows PHP URLs began returning 404 at the ordinary
release location. Both the native installer and offline-pack downloader now try
the exact same filename in the [official PHP archive](https://downloads.php.net/~windows/releases/archives/)
after 404/410. The existing signed catalog, selected versions and SHA-256 remain
unchanged; other hosts, credentials, query-bearing URLs and HTTPS downgrades are
not substituted. Actual downloads of both pinned archives matched their hashes,
and fresh online installation plus PHP 8.4/8.5 HTTP through Caddy passed on Windows.
The current Rust suite passes 24 tests (two process-fixture entry points are
ignored when run directly), and all ten JavaScript catalog regressions pass.

An online macOS smoke observed a truncated Node.js response after a long stalled
transfer. Runtime downloads now use a 30-second connection timeout, a 60-second
read timeout and up to three attempts for interrupted transports, with short
cancellable backoff and a shared thirty-minute total budget. Each retry starts
from fresh partial bytes; HTTP status errors, disk errors and checksum failures
do not trigger transfer retries. Exhaustion and cancellation remove partial data.
HTTPS, the signed catalog, selected versions and final SHA-256 checks are unchanged.
Five real local TCP regressions cover truncated streams, exhausted retries,
non-retried HTTP 404, stalled-body recovery and cancellation cleanup. Actual online
installation, npm/pnpm/Yarn and concurrent Node 22/24 HTTP passed on
[current Apple Silicon](https://github.com/Sakeerin/StackCabin/actions/runs/40678440459).
Retries for official Node.js distribution URLs may use the same publisher's
`/download/release/` alias with the exact version/filename after a transport
interruption. A real 53 MB ARM archive from that alias matched the original signed
SHA-256; a separate URL regression rejects other origins, credentials, queries,
version mismatches and path traversal. No catalog was changed or re-signed.
The native acceptance log now identifies download, retry and extraction phases.

Internal health checks, Caddy reloads and routed readiness now use direct
loopback clients with finite timeouts and no redirect following. An isolated
child-process regression passed with an unreachable machine proxy and an
unreachable redirect target. Real Windows offline acceptance also passed with
that proxy while all five projects and both database restores ran.

The native Desktop language test dispatches a DOM change event because the
embedded driver does not implement native option selection. The resulting UI
update and persistence still use the real application and database.

## Remaining production gates

1. Publish and certify the reviewed Unix PHP/MariaDB/PostgreSQL packages at stable
   HTTPS locations, then sign a complete production catalog. The checked-in
   development catalog still contains 32 entries: Node/Caddy/Composer/package
   managers/CA artifacts for all targets, and PHP/database artifacts for Windows
   x64. Normal Unix preview UI correctly shows the missing native packages as
   unavailable. Temporary QA catalogs do not change that shipping catalog.
   Source archives/checksums are pinned in `runtime-catalog/source-archives.json`;
   `native-test-builds.json` selects existing CI artifacts for internal tests.
   Native builds verify relocation, Unicode paths, FPM/SQLite, authenticated SQL,
   dump/restore and real core installation. Every macOS library must measure at
   most 14.0 before approved metadata is written. Replacement PHP/PostgreSQL/
   MariaDB packages meet that baseline; the earlier incompatible PHP and Intel
   MariaDB archives remain excluded.
   Native MariaDB excludes optional Mroonga and CONNECT ODBC support. The latter
   previously pulled in host Intel libltdl requiring 15.0; native SQL accounts and
   logical backups do not use that adapter. A private Unix runtime alias/socket
   accommodates the upstream bootstrap script while retaining Unicode data paths.
   Rosetta checks still do not replace a native macOS 14 Intel installer VM.
2. Run native runtime, browser HMR, tray/Quit, abrupt-app-exit, disk-full,
   clean-machine online/offline installation and upgrade tests on every target VM.
   Local offline archive installation does not establish clean-OS compatibility.
   Actual ENOSPC recovery passed on an isolated Linux tmpfs. Installed Windows/deb
   packages and Ubuntu 24.04 AppImage startup passed on hosted CI runners, which
   contain preinstalled software and do not replace clean-machine certification.
   `docs/VM_ACCEPTANCE.md` records the target matrix and manual desktop checks;
   portable acceptance kits package the real native harness for Windows,
   macOS ARM/x64 and Ubuntu x64, with matching Unix offline archives. A VM does
   not need global Rust/Node/PHP to run these harnesses once OS prerequisites
   and the normal desktop credential store are ready.
3. Supply production catalog keys, Windows signing, Apple signing/notarization,
   a maintained signed app-update endpoint, and repository/release configuration.
   App self-update distribution is not enabled in this preview.
4. Complete license/corresponding-source and prerequisite redistribution review,
   along with the StackCabin name/domain/trademark checks specified in the plan.

The application never treats an unavailable runtime, browser preview, or missing
production signature as a successful certified release.
