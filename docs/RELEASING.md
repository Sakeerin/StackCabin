# Release preparation

The application source can build local development installers. Publishing a
supported three-platform release additionally requires the following concrete
artifacts and validation; repository credentials and signing identities are not
embedded in this checkout.

The manual `Build and verify development installers` workflow prepares unsigned
preview `.exe`, `.dmg`, `.deb` and `.AppImage` artifacts with seven-day retention.
It installs the Windows/deb packages only on disposable CI runners and starts the
normal executables against isolated SQLite data. It does not publish a release.
Use `Verify an existing development installer on the baseline` with that run ID
to reuse the Ubuntu 22.04 packages on Ubuntu 24.04 or mount a macOS DMG on macOS 14.
The AppImage check uses extract-and-run without FUSE. These runners contain
preinstalled software and do not replace clean-machine installer certification.

For desktop testing of the complete Unix stack, use `Build Unix QA desktop
installers with offline runtimes`. It verifies an existing portable runtime kit,
embeds that kit's signed development catalog and tests installation, UI process
controls, HTTP and database backup/restore before packaging **StackCabin QA**.
The release build enables only `qa`; the `e2e` plugins are absent. Its separate
binary, Tauri identity, metadata directory and credential service preserve the
normal preview's namespace. Keep its installer and matching offline folder
together; see [QA desktop instructions](QA_DESKTOP.md).

`Verify an existing QA desktop installer on the baseline` mounts the same DMG on
macOS 14 or installs the Ubuntu 22.04 deb/AppImage on Ubuntu 24.04. The Linux check
also installs the normal preview first and checks its binary remains unchanged.
These artifacts expire after seven days and are unsigned internal builds.

## 1. Complete the verified runtime matrix

Use the `Build reviewed native runtime` GitHub Actions workflow for PHP 8.4/8.5,
MariaDB 12.3, and PostgreSQL 18 on Ubuntu x64, macOS x64, and macOS arm64. Supply
the exact publisher source URL and reviewed SHA-256. The workflow builds packages
and uploads artifacts without publishing them. It bundles non-system libraries,
rewrites loader paths, verifies required PHP extensions, and includes the source
archive and provenance alongside each binary archive.

Reviewed source inputs are recorded in `runtime-catalog/source-archives.json`.
Each new pack is extracted into a Thai/spaced path with the original install
prefix hidden. PHP must answer a real FastCGI request and read/write SQLite;
database servers must authenticate separate accounts and pass logical dump/restore.
The workflow then installs the archive using a temporary signed test catalog and
runs `native-smoke` against the actual Rust core and OS keychain. These temporary
keys/catalogs are confined to the CI checkout. The future release URL supplied to
the workflow is not an upload destination.

macOS provenance records the highest minimum OS version of all bundled Mach-O
files. The release gate rejects packs requiring a version above 14.0; setting the
main compiler deployment target does not lower the requirements of bundled
Homebrew libraries. Rebuild incompatible dependencies for the supported baseline
before publishing them.

The PostgreSQL macOS builder compiles pinned OpenSSL/zlib sources with a 14.0
deployment target and excludes Homebrew library flags. Their source archives,
checksums and licenses accompany the package provenance. The PHP builder likewise
compiles its required libraries from `runtime-catalog/php-macos-library-sources.json`,
including ICU, image libraries, curl and libpq. Source-build support is not evidence
of a passing build: inspect the measured minimum OS field and runtime verification
before signing any pack. MariaDB builds its OpenSSL/zlib/PCRE2 closure from pinned
sources with the same baseline. Its build-time library IDs resolve inside that
private prefix; the final pack rewrites them for relocation.

Windows PHP archives come from PHP's release manifest. Windows MariaDB and
PostgreSQL portable archives come from MariaDB and EDB respectively. Catalog
generation may fail when a publisher endpoint is unavailable; do not replace a
missing hash with a guessed value. Review the resulting executables and run the
native smoke suite before signing any package into the production catalog.

Merge native artifact JSON objects into one JSON array and pass it as
`--extra=artifacts.json` to the catalog builder. Host archives at the exact HTTPS
locations in those objects. Preserve required third-party notices and source
distribution obligations with the corresponding artifact release.

## 2. Establish the production trust root

Generate an Ed25519 signing key outside the repository. Supply its PEM content as
`STACKCABIN_CATALOG_PRIVATE_KEY`, run the builder without `--dev`, and review the
catalog/public-key change. The private key must remain in release secrets. Never
distribute the local development key.

```sh
node scripts/build-catalog.mjs --extra=artifacts.json
node scripts/verify-catalog.mjs --release
```

The release gate rejects the development catalog and requires PHP 8.4/8.5,
Node 22/24, Caddy, Composer, MariaDB, PostgreSQL, pnpm, and Yarn for every target.
Every target must run both the native runtime smoke suite and the desktop E2E
suite. A source build alone does not establish runtime compatibility.

## 3. Prepare installer variants

- Windows: sign the executable and installer using the release certificate;
  configure Tauri's Windows signing settings. NSIS packages embed the Microsoft
  Visual C++ v14 x64 payload pinned in `runtime-catalog/windows-prerequisites.json`.
  `beforeBundleCommand` verifies its hash, Microsoft signature and version without
  executing it. Setup rechecks the payload, detects the installed version and
  requests elevation only for Microsoft's installer when an upgrade is needed.
  WebView2 downloads when absent. The full offline folder installs its signed
  WebView2 payload before opening NSIS, so NSIS can detect the installed runtime.
  A separate single-file offline NSIS variant can instead use Tauri's
  `bundle.windows.webviewInstallMode: {"type":"offlineInstaller"}`.
- macOS: supply the Apple signing identity/certificate and notarization
  credentials. Build and test Intel and Apple Silicon separately.
- Ubuntu: build against the oldest supported Ubuntu baseline. Verify the
  `.deb` dependencies and AppImage on both 22.04 and 24.04. Include the required
  library packages for a clean offline machine or use the bundled AppImage with
  extraction-and-run fallback when FUSE is unavailable.

Create the offline pack with `scripts/offline-pack.mjs`. On Windows, run
`scripts/windows-offline-bundle.ps1` after building the installer; it downloads
and verifies Microsoft's signed full WebView2/Visual C++ payloads and generates
an offline install script with a checksum manifest. It does not execute installers.
Test the resulting complete folder with networking disabled.
The offline runtime pack by itself does not install OS prerequisites or arbitrary
framework dependencies.

`npm run licenses` generates the bundled npm/Cargo license texts and runtime
source inventory. Audit target-specific packages that are not cached on the build
machine, bundled runtime libraries, and corresponding-source obligations before
public distribution. For Microsoft prerequisites, review the publisher's
[WebView2 deployment terms](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
and [redistributable guidance](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).

The `Package reviewed release` workflow uploads installer artifacts only. It does
not create a public release or publish to GitHub automatically. App updater
distribution is not enabled until a maintained signed update endpoint and release
keys are configured; runtime catalog signing is a separate trust boundary.

## 4. Acceptance gate

On fresh VMs for every supported OS/architecture:

1. Install online and offline with no PHP/Node/database tools on PATH.
2. Start every preset; verify Vue/React/Next HMR and concurrent PHP/Node versions.
3. Exercise port conflicts, child crashes, app termination, and process-tree cleanup.
4. Provision database users, write data, back up, and restore into a new identity.
5. Test Thai/spaced paths, download cancellation, corrupted archives, and disk-full
   failure without publishing a valid receipt.
6. Upgrade the application and confirm existing manifests, credentials, and
   database data remain usable.

Only then mark that platform supported and publish its signed installer.
