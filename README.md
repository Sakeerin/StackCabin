# StackCabin

**Your development stack, ready to run.**

A local desktop workspace for PHP, Node.js, Vue, React, Laravel, NestJS, Next.js,
Express, and static sites. Built with Tauri 2, React, TypeScript, Rust, and SQLite.
No account, telemetry, Docker requirement, or global PATH modifications.

**Development preview:** see [implementation and verification status](docs/IMPLEMENTATION_STATUS.md)
for the tested behavior and the remaining three-platform release gates.

[คู่มือเริ่มใช้งานภาษาไทย](docs/QUICKSTART.th.md)

## Run the application

Development prerequisites: Node.js 22.16+ or 24 LTS, npm, stable Rust, and the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.
These are development prerequisites; packaged application users do not need Rust.

```sh
npm ci
npm run desktop
```

```sh
npm run build             # Compile TypeScript and the production frontend
npm run dev               # Browser preview on http://127.0.0.1:1420
npm run desktop:build     # Create local desktop installer packages
```

The browser preview explicitly disables native operations. File selection,
processes, runtimes, and databases are available in the desktop application.

Windows bundling downloads and verifies a pinned Microsoft Visual C++ x64
prerequisite and embeds it in NSIS. Setup checks the installed version and may
request administrator approval for Microsoft's installer. Full offline bundles
also include WebView2; see the Thai quickstart for installation steps.

## What is implemented

- Create and detect nine project presets, import existing folders, and persist
  projects in an application-owned SQLite database.
- Select PHP/Node versions per project. Execution requires explicit project trust.
- Install catalogued runtimes online or from a local offline pack, checking the
  Ed25519 catalog signature, SHA-256, archive paths, and required executables.
- Run managed Node/package-manager commands, PHP FastCGI, and static sites behind
  Caddy. Report real process state and stream stdout/stderr into the UI.
- Contain Windows child trees with Job Objects; Unix process groups have a
  parent-death watchdog. Quitting stops application-owned services.
- Provision separate MariaDB/PostgreSQL databases and users on shared servers,
  or attach an SQLite file. Credentials are stored in the OS keychain.
- Back up project files and consistent database snapshots. Restore into a new
  folder and database. Dependencies, `.env` files, private keys, and Git metadata
  are excluded by default.
- English/Thai interface, light/dark/system themes, tray behavior, and diagnostics.

## Runtime catalog and release status

This checkout contains a **signed development catalog**, not a production release
trust root. The development private key is in ignored `.local/`; it is never part
of the source distribution or installer. Production signing keys must be supplied
by the release maintainer. The release workflow rejects development catalogs and
missing platform packages.

Node.js, Caddy, Composer, pnpm, Yarn, and CA bundle catalog entries cover Windows
x64, macOS Intel/Apple Silicon, and Linux x64. PHP Windows packages are resolved
from the PHP publisher. Unix PHP and database packs can be built from reviewed
publisher source archives with the native runtime workflow. Only packages present
in the signed catalog are installable; the application does not substitute a
system installation or silently switch database engines.

```sh
node scripts/verify-catalog.mjs
node scripts/build-catalog.mjs --dev
# Append reviewed native artifacts using --extra=path/to/artifacts.json.
# Production: set STACKCABIN_CATALOG_PRIVATE_KEY and omit --dev.
node scripts/verify-catalog.mjs --release
```

The intended release matrix is Windows 10 22H2/11 x64, macOS 14+ Intel/Apple
Silicon, and Ubuntu 22.04/24.04 x64. Cross-platform source and CI are provided;
a platform is not considered certified until its native build, runtime smoke
tests, desktop tests, and clean-machine installer checks pass.
Source repository: [Sakeerin/StackCabin](https://github.com/Sakeerin/StackCabin).
Production releases remain subject to the release gates below.

## First project

1. Choose **New project** or **Import project** and select a folder.
2. Review the detected framework. Leave trust off for code you have not reviewed.
3. In the project overview choose **Set up runtimes**.
4. Trust the project in Configuration, then choose **Install dependencies**.
5. Choose **Start** and open its local URL. Use Logs for command output.
6. Optionally create an SQLite, MariaDB, or PostgreSQL database in the Database tab.

Framework installers may require an internet connection. Dependencies containing
native extensions may additionally need the platform's compiler toolchain; the
application does not claim to replace arbitrary third-party build tools.
Imported scripts execute with the current user's privileges and must be reviewed.

## Offline runtime packs

```sh
node scripts/offline-pack.mjs --platform=windows --arch=x64 --dev
```

Choose the resulting `artifacts/offline-windows-x64` folder in **Runtimes > Install
from offline pack**. It must match the catalog embedded in the application.
The pack contains runtime archives, not arbitrary npm/Composer dependencies.
Running an existing project offline requires its dependencies to already be
installed for the target OS. See [release preparation](docs/RELEASING.md) for
WebView2, Visual C++, Linux libraries, signing, and clean-machine checks.

After building the Windows installer, assemble the complete development bundle:

```powershell
./scripts/windows-offline-bundle.ps1
```

This adds the installer, Microsoft-signed WebView2 standalone/Visual C++ payloads,
an integrity manifest, notices, and `Install.cmd`. It prepares files without
installing software on the build machine. Run `Install.cmd` on the target computer,
then select the bundle folder in StackCabin's offline runtime picker.

## Tests

```sh
npm test
cargo test -p stackcabin-core
npm run types
npm run desktop:test:build
npm run test:desktop
npm run test:lifecycle    # Native close/tray/Quit/crash checks after the E2E build
```

The ignored `http_worker`, `http_parent`, and `lifecycle_fixture` Rust tests are
child-process fixtures launched by lifecycle tests. The owner-crash test starts
two independent process trees and a separate HTTP server, kills only their
supervisor host, then checks actual process exit, closed ports and the separate
server's continued health. Run it alone with
`cargo test -p stackcabin-core --test owner_lifecycle`.
Desktop WebDriver is compiled
only with the `e2e` feature and is absent from normal application builds.

The lifecycle probe opens three isolated application sessions. It checks native
close-to-tray and restore, close without tray, repeated Quit during pending
shutdown, and abrupt application termination while an owned HTTP service runs.
An unrelated server must remain healthy. Test commands, the shutdown barrier and
the bounded HTTP fixture exist only with the `e2e` feature. JSON evidence is saved
under `artifacts/desktop-lifecycle-*.json`; each temporary workspace is removed.
Actual tray-menu pointer interaction and clean-machine checks remain in the
[VM checklist](docs/VM_ACCEPTANCE.md).

Real runtime acceptance tests use an explicit disposable workspace:

```powershell
$env:STACKCABIN_SMOKE_DIR = "$PWD/.local/native-smoke"
$env:STACKCABIN_SMOKE_COMPONENTS = "node,caddy,php,cacert,composer"
cargo run -p stackcabin-core --example native-smoke
```

Add `mariadb,postgres` to test managed server provisioning and database backup/
restore once verified packages for the target platform are in the catalog.
`STACKCABIN_DATA_DIR` can isolate a desktop test session from your personal data.

For real browser HMR checks, run `framework-smoke` first, then run the
`hmr-session` example with the same disposable `STACKCABIN_SMOKE_DIR`.
Its `hmr-session.json` lists the React/Vue/Next URLs and fixture folders.
Edit their source and verify that browser state survives updates; Ctrl+C stops
all owned servers. Set `STACKCABIN_HMR_FRESH_REACT=1` to prepare a new React fixture.
The fixture directories must be trusted and inside that workspace's `projects/`.

To exercise all managed Windows tools from the offline pack in a fresh data directory:

```powershell
$env:STACKCABIN_SMOKE_DIR = "$PWD/.local/offline-acceptance"
$env:STACKCABIN_SMOKE_COMPONENTS = "node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres"
$env:STACKCABIN_OFFLINE_DIR = "$PWD/artifacts/offline-windows-x64"
cargo run -p stackcabin-core --example native-smoke
```

## Source layout

- `src/`: desktop UI, generated Rust/TypeScript interfaces, and frontend tests.
- `crates/core/`: projects, catalog verification, installer, process supervisor,
  Caddy routing, database adapters, backups, and native integration tests.
- `src-tauri/`: desktop commands, application lifecycle, capabilities, and tray.
- `scripts/`: catalog/offline tooling and relocatable Unix runtime builds.
- `.github/workflows/`: cross-platform checks, runtime builds, and gated packaging.

[Architecture and contracts](docs/ARCHITECTURE.md) ·
[Release preparation](docs/RELEASING.md) · [MIT license](LICENSE)

[Clean-machine VM acceptance and portable runtime QA kits](docs/VM_ACCEPTANCE.md)

[Unix QA desktop installers with matching offline runtimes](docs/QA_DESKTOP.md)
are built by the manual `Build Unix QA desktop installers with offline runtimes`
workflow. StackCabin QA has its own executable, metadata and credential namespace;
its internal development catalog includes the reviewed Unix PHP/database packs.
The normal preview catalog and production release gates remain unchanged.

[Packaged upgrade acceptance](docs/UPGRADE_ACCEPTANCE.md) checks existing project,
runtime, database, settings and backup preservation with an unpublished QA candidate.
