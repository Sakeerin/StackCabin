# Implementation and verification status

Development version: **0.1.0**, checked on **23 October 2026**.
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

## Verification evidence

Logs and screenshots are generated locally under ignored `artifacts/`.

| Check | Evidence |
|---|---|
| Production frontend | TypeScript and Vite build |
| Frontend tests | 5 tests: preview honesty, templates/trust, Thai/theme, process state and sizes |
| Rust core | 16 passed on Windows; 2 ignored tests are launched child-process fixtures |
| Core edge cases | Corrupted archives, traversal, signed catalog tampering, interrupted installation, Unicode registration, future schema, port conflicts, secret-free SQLite backup/restore and concurrent destination reservation |
| Native lifecycle | Real HTTP grandchild, stop of its process tree, and cleanup after its parent exits unexpectedly |
| Native Desktop E2E | 4 cases against real Rust IPC/SQLite; screenshot `stackcabin-desktop.png` |
| Cross-platform CI | [Run 39912586708](https://github.com/Sakeerin/StackCabin/actions/runs/39912586708): Windows, Ubuntu 22.04/24.04 and macOS Intel/Apple Silicon passed frontend/core tests, native builds and Desktop E2E |
| Normal Windows package | Release executable starts without E2E plugins and initializes real SQLite metadata in an isolated directory |
| Framework acceptance | Express, Vue, React, Nest, Next and Laravel dependency installation and actual HTTP; Laravel runs PHP and Vite together |
| Browser HMR on Windows | Actual React/Vue/Next browsers updated after source edits through Caddy while preserving a clicked counter. React/Vue WebSocket probes received HTTP 101 and module updates. React's starter now exports `App.jsx` to support Fast Refresh; screenshots `hmr-react.png` / `hmr-next.png` |
| Real databases | MariaDB/PostgreSQL provision, insert/select, dump, new-identity restore and select; SQLite consistent snapshot/restore |
| Windows Unicode data path | Actual PHP/Node/Caddy/MariaDB HTTP/data in a Thai/spaced path; PostgreSQL initialization and restore through the verified ASCII junction |
| Offline tools | Managed Node 22/24, PHP 8.4/8.5, npm/pnpm/Yarn, Composer, Caddy and databases from local archives; the test does not download framework dependencies |
| Managed Node toolchains | [Cross-platform smoke](https://github.com/Sakeerin/StackCabin/actions/runs/39951584400) passed installation, npm/pnpm/Yarn, concurrent Node 22/24 HTTP through Caddy and shutdown on Windows, Ubuntu 22.04/24.04, macOS ARM/Intel. Each server's response identifies its actual Node version |
| Node macOS 14 baseline | [ARM](https://github.com/Sakeerin/StackCabin/actions/runs/39951641290) and [x64 through Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/39951647274) passed the same real managed-toolchain smoke |
| Unix PHP acceptance | PHP 8.4/8.5 [native runs](https://github.com/Sakeerin/StackCabin/actions/workflows/native-runtime.yml): relocated PHP-FPM/SQLite and real Rust-core HTTP passed on Ubuntu 22.04 and macOS 15 Intel/Apple Silicon |
| PostgreSQL Unix acceptance | [Run 39916993042](https://github.com/Sakeerin/StackCabin/actions/runs/39916993042): PostgreSQL 18.6 SCRAM setup, private project account, insert/select, dump/restore and real Rust-core integration on Ubuntu 22.04 and macOS 15 Intel/Apple Silicon |
| PostgreSQL macOS 14 | [Source-library build](https://github.com/Sakeerin/StackCabin/actions/runs/39920049255) measures 14.0 on both architectures. [Actual macOS 14 ARM acceptance](https://github.com/Sakeerin/StackCabin/actions/runs/39922116967) passed real core provisioning/read/write/backup/restore in a Thai/spaced app-data path |
| MariaDB Ubuntu 24.04 | [Run 39923305298](https://github.com/Sakeerin/StackCabin/actions/runs/39923305298) passed real core installation, version check, provision/read/write/dump/restore using the Ubuntu 22.04 source-built package |
| MariaDB macOS core | [ARM source build](https://github.com/Sakeerin/StackCabin/actions/runs/39928392371) and [Intel source build](https://github.com/Sakeerin/StackCabin/actions/runs/39928396223) passed relocation and real core integration with dependencies built for 14.0. [Actual macOS 14 ARM verification](https://github.com/Sakeerin/StackCabin/actions/runs/39933188836) passed installation, provisioning, read/write, backup and restore |
| MariaDB macOS 14 x64 | [Compatibility verification](https://github.com/Sakeerin/StackCabin/actions/runs/39951635821) passed real core database operations on macOS 14 using preinstalled Rosetta; native Intel installer acceptance remains separate |
| Ubuntu 24.04 WSL2 | Downloaded/checksummed Ubuntu 22.04 PHP 8.4/8.5, PostgreSQL and MariaDB packs, removed debug symbols, then passed relocated FastCGI/SQLite and database dump/restore as unprivileged `nobody`; this is not a clean desktop installer VM |
| Project URLs | Readable `.localhost` hosts and dedicated loopback fallback routes verified for PHP, Node and static projects |

The native Desktop language test dispatches a DOM change event because the
embedded driver does not implement native option selection. The resulting UI
update and persistence still use the real application and database.

## Remaining production gates

1. Build and certify Unix PHP/MariaDB/PostgreSQL packages. The checked-in
   development catalog contains Node/Caddy/Composer/package managers/CA artifacts
   for all four platform/architecture targets, and PHP/database artifacts for
   Windows x64. Missing packages are shown as unavailable.
   The native pipeline checks relocation, Unicode paths, PHP-FPM/SQLite, authenticated
   database read/write/dump/restore, and installation through the actual Rust core.
   Source archives and publisher checksums are pinned in
   `runtime-catalog/source-archives.json`. CI uploads build artifacts only.
   Current macOS PHP packs pass on macOS 15 but bundled Homebrew libraries require
   macOS 15.0. They are blocked from the macOS 14 production catalog until the
   dependency closure is rebuilt for that baseline and tested there. MariaDB's
   optional Mroonga engine is excluded from native builds after its bundled
   Groonga source failed to compile with the current macOS SDK.
   PostgreSQL and MariaDB source builds pass with a measured 14.0 baseline;
   both also pass actual macOS 14 ARM runtime integration. PHP's library closure
   targets 14.0; its final build and baseline execution results remain pending.
   macOS 14 Intel
   PostgreSQL x64 compatibility [passed on macOS 14 under Rosetta](https://github.com/Sakeerin/StackCabin/actions/runs/39925179199); that does not replace a
   native Intel installer VM.
   MariaDB's upstream install script splits basedir paths on whitespace. The
   Unix core uses a verified symlink inside its private temporary directory for
   runtime tools and a private socket, retaining the real runtime/data locations.
2. Run native runtime, browser HMR, tray/Quit, abrupt-app-exit, disk-full,
   clean-machine online/offline installation and upgrade tests on every target VM.
   Local offline archive installation does not establish clean-OS compatibility.
3. Supply production catalog keys, Windows signing, Apple signing/notarization,
   a maintained signed app-update endpoint, and repository/release configuration.
   App self-update distribution is not enabled in this preview.
4. Complete license/corresponding-source and prerequisite redistribution review,
   along with the StackCabin name/domain/trademark checks specified in the plan.

The application never treats an unavailable runtime, browser preview, or missing
production signature as a successful certified release.
