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

Linux source builds now collect exact Ubuntu package/source versions and license
texts for their bundled external libraries. The builder verifies both descriptor
members and the final runtime's recorded library/license bytes. Release preparation
requires these records; earlier Linux candidates without them need a new reviewed
build. See [runtime source records](RUNTIME_SOURCES.md).

### Assemble a reviewed native release candidate

Dispatch **Prepare reviewed native release assets** (`prepare-native-release.yml`)
with an unused, versioned `native-*` tag. It consumes the exact twelve selections
in `.github/native-test-builds.json`, requires successful native-runtime producer
runs from this repository, and rejects missing/expired artifacts. Its token has
only contents/actions read permissions. It uploads an Actions artifact; it does
not create a GitHub release, publish assets, change the shipping catalog or read
catalog signing keys.

The preparation helper verifies runtime and publisher-source bytes, executable
layouts, relocation provenance and the measured macOS 14.0 ceiling. Every declared
macOS dependency must match the separately reviewed source/license pins and have
its matching source archive. A Python regression keeps the crypto/PCRE release
pins consistent with the native builders. Common source bytes are deduplicated
by checksum, while original build metadata/provenance remains intact.

The candidate contains `native-artifacts.json` with the future immutable HTTPS
URLs, original build records, `source-inventory.json`, corresponding source
archives, `SHA256SUMS.txt` and a final `release-manifest.json`. Verify all checksum
records before review. A failed local copy has no completion manifest; an existing
output directory is never replaced. The original metadata retains its producer's
future URL; only `native-artifacts.json` describes the proposed release location.

For previously downloaded artifacts, provide twelve input records with `id`,
`directory` and the full GitHub run API response as `run`:

```sh
node scripts/prepare-native-release.mjs --input=inputs.json --output=new-review-folder --repository=Sakeerin/StackCabin --tag=native-unique-version
```

Local verification on 4 November assembled twelve real runtimes, sixty unique
source archives and 109 files; all 108 checksum records passed independently.
These include 42 Ubuntu source bundles for 41 exact source-package versions.
The latest review payload is retained in `artifacts/native-transfer-review-20261104/payload/`.
The same preparation passed on GitHub in
[41803437796](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796).
Its [reviewed native candidate](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796/artifacts/13308263646)
has seven-day retention, 1,467,823,075 ZIP bytes and SHA-256
`a24c6f587178cb3117586e0a6c359d4356944cd31663ab800656d9059ee460e0`.
That ZIP digest is GitHub artifact metadata; the large ZIP was not downloaded
again locally. CI independently rechecked all staged files, including the
completion manifest. Logs/metadata are retained alongside the local payload. The
previous 3 November candidate is historical; its Linux archives lack the newly
required Ubuntu source records and are rejected by the current helper.
This is preparation evidence. Review bundled-library licenses, collected sources
and any remaining build/installation-information requirements before public
distribution. Baseline machine certification, actual immutable asset publication,
verification of hosted bytes and production catalog signing remain separate gates.

### Retain the review pin and verify hosted bytes

New preparation runs also upload `native-release-verification`. This small artifact
contains `candidate-verification.json`, the original JSON metadata/provenance,
source inventory, checksum lists and `ARTIFACT_RECEIPT.json`. The receipt binds the
full candidate ZIP's Actions ID/digest to its source commit, run and manifest hash.
Check `EVIDENCE_SHA256SUMS.txt` after downloading; retain the manifest SHA-256 from
this reviewed run separately before distributing the candidate. A checksum shipped
only beside a replaceable archive does not provide that independent reference.

The current [small review artifact](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796/artifacts/13308687671)
is 127,774 ZIP bytes and contains forty files. All 39 evidence checksum records
passed independently. Its receipt matches GitHub's full candidate ID/digest, and
an independent local assembly matches the retained manifest pin:
`710a618ee11e20cf1a6ed50968a2755971541aa4bbe49cb88b9fe41346032f39`.
The reviewed tag is `native-candidate-20261104-review`; evidence is retained under
`artifacts/native-transfer-review-20261104/`. Hosted verification remains pending
publication. A real Caddy archive passed the same HTTPS/redirect/hash transport,
and the unpublished StackCabin tag returned HTTP 404 without a completion report.
Those scoped checks do not certify a publicly hosted StackCabin release.

`.github/scripts/verify-native-release.mjs` checks every local candidate file against
that manifest pin, including the exact checksum/file inventories, runtime matrix,
catalog destinations and source references. It reads files without executing or
changing them. This transfer check supplements the builder's source/license and
relocation checks; it does not repeat compilation, approve redistribution or sign
the catalog. Reports explicitly distinguish local byte integrity from hosted
verification and production approval.

For a previously downloaded candidate, run the following with the manifest hash
retained from its own review evidence and an unused report path outside the pack:

```sh
node .github/scripts/verify-native-release.mjs --directory=reviewed-candidate --repository=Sakeerin/StackCabin --tag=native-reviewed-version --manifest-sha256="$MANIFEST_SHA256" --report=candidate-verification.json
```

After the exact assets are publicly hosted, add `--hosted`. The tool streams every
asset, including manifests, source archives and notices, without credentials. It
checks size and SHA-256, permits only HTTPS redirects among GitHub release hosts,
and rejects redirects to other hosts, truncated/extra data and unexpected content
encoding. Header/body deadlines and cancellation cover each asset; a complete run
has a 30-minute deadline. It writes a completion report only after all files pass
and never replaces an existing report.

The read-only **Verify published native release bytes** workflow offers the same
check. Supply the successful preparation `candidate_run`, exact `tag`, and retained
`manifest_sha256`. It checks repository/head repository, workflow, successful run
identity and artifact expiry before downloading the candidate. GitHub credentials
are used only to retrieve that Actions artifact; public asset verification uses no
credentials. Its successful `hosted-native-release-verification` artifact records
which producer and manifest were checked. It neither publishes a release nor signs
or updates the shipping catalog. An unpublished tag correctly fails this gate.

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
For a downloaded installer from the matching source/catalog, pass `-Installer`
and `-InstallerSha256` using the independently verified installer checksum.
Assembly verifies the pack against the checkout's trusted signed catalog and
hashes every Windows x64 archive before changing installer files. A refresh
invalidates its old manifest; failed assembly leaves no completion manifest.
The replacement manifest covers all control files, prerequisites and archives.

Before installing on a target, use Windows PowerShell 5.1:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./Install-StackCabin.ps1 -CheckOnly
```

This verifies the complete manifest, binds every selected runtime archive to its
catalog hash, checks Microsoft's prerequisite signatures and the pinned Visual
C++ version, and returns a JSON report without launching installers. It requires
no system Node.js. The install path uses the same preflight and checks the app
installer's exit status. The unsigned local manifest detects accidental corruption
and mixed payloads, not a replaced distribution; release signing is still required.
The app verifies its own trusted signed catalog when installing runtime archives.
Test the resulting complete folder with networking disabled.

For a downloadable development pack, dispatch **Build and verify the Windows
offline bundle** with a successful normal installer's Actions run ID. It verifies
the run identity, workflow, repository/head repository, and source commit before
downloading payloads. Reuse is allowed only for a closed set of packaging,
test/documentation changes; application input changes require a fresh normal
installer even when the application version is unchanged. Catalog, signature,
trust root, provenance and pinned prerequisite metadata must match byte for byte.
The workflow verifies the distributed installer checksum, assembles all Windows
archives/prerequisites and runs the real target `-CheckOnly` under Windows
PowerShell 5.1 with system-only PATH. Its seven-day
`development-offline-windows-x64` artifact contains `offline-windows-x64/` and a
sibling `offline-evidence/` with both source commits, manifest hash and preflight.
No installer is executed by the packaging job. Its `installerExecuted: false`
record is scoped to that job. Expired source artifacts require a new installer run.
The separate small `windows-offline-verification` artifact includes an
`ARTIFACT_RECEIPT.json` with the uploaded bundle ID, URL and ZIP SHA-256 reported
by [GitHub's artifact action](https://github.com/actions/upload-artifact/tree/v4#outputs).

A second job downloads the produced ZIP and runs `verify-windows-offline.ps1`
only on a disposable GitHub-hosted Windows runner. The actual wrapper installs
silently at a new Thai/space path, checks the installed version/catalog/trust
root, then opens the normal application through a restricted standard-user
launcher. All eleven managed tools install from that same pack; concurrent
PHP/Node HTTP, authenticated MariaDB/PostgreSQL dump/restore, and unchanged
project/database persistence are checked with system-only PATH and unreachable
online proxies. Evidence is in `windows-offline-installation-evidence`.
The script refuses local/self-hosted use before resolving payload paths.
These runners have preinstalled tools and enabled network interfaces; this does
not certify a fresh OS or physically disconnected VM.

The wrapper's `-Silent` passes NSIS `/S`; `-InstallDirectory` validates a local
absolute path and passes `/D` last, following the
[NSIS installer argument rules](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage).
Prerequisites retain their own UAC/restart behavior. Read-only verification rejects
installation options instead of silently ignoring them.
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
