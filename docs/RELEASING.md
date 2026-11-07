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

The legacy CA bundle has an unversioned curl download URL. On 6 November the
Windows smoke check correctly rejected changed upstream bytes. The official
`cacert-2026-10-20.pem` archive still matches all four signed CA records exactly:
200,116 bytes, SHA-256
`796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe`.
The native downloader and offline-pack tool select this dated URL only for that
exact component/archive/URL/hash combination. Download checksums remain mandatory;
no catalog bytes, IDs or trust roots change. The selection does not authorize a
different or newer CA set. Use reviewed dated URLs for future CA catalog entries.
The real transport/metadata check is retained in
`artifacts/release-catalog-20261106/PINNED_CA_RECOVERY.json`.

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
The independently assembled review payload is retained in `artifacts/native-transfer-review-20261104/payload/`.
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

The earlier [small review artifact](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796/artifacts/13308687671)
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

### Prepare the unsigned catalog handoff

`.github/scripts/prepare-catalog-proposal.mjs` makes the proposed catalog concrete
before any signing operation. It verifies the candidate against the retained
manifest digest, checks the base catalog's Ed25519 signature against a separately
retained `public-key.txt` file hash, and preserves every existing artifact record.
An existing ID with a changed URL, executable path, extraction policy or any other
metadata fails even when its archive checksum is unchanged. The complete matrix
must include both Node and PHP branches on all four OS/architecture targets.
Native executable contracts, relative paths and the macOS 14.0 baseline are checked.
Legacy base entries may retain size `0` (unknown); every new native archive must
have the exact positive size verified against the candidate.

Run with a new output directory outside the candidate and base catalog:

```sh
node .github/scripts/prepare-catalog-proposal.mjs --directory=reviewed-candidate --repository=Sakeerin/StackCabin --tag=native-reviewed-version --manifest-sha256="$MANIFEST_SHA256" --catalog-directory=runtime-catalog --public-key-sha256="$TRUSTED_PUBLIC_KEY_FILE_SHA256" --output=catalog-proposal
```

The nine-file handoff contains `catalog.proposed.json`, the native additions and
source inventory, the original release manifest, byte verification, and the base
catalog/signature/public key. `CATALOG_HANDOFF.json` is written last and records
every output file's size/hash, the original trust root, manifest pin, added IDs and
remaining gates. Its `review-only-awaiting-public-hosting` status cannot establish
public availability. No signing key is opened; no shipping file is modified.

After immutable publication, repeat into a new output with `--hosted`. This streams
every public asset again before creating the output; a saved report cannot stand
in for transport checks. Only complete success yields
`hosted-bytes-verified-awaiting-release-review`. Both modes explicitly remain
unsigned and unapproved for production. The handoff is review evidence, not an
authenticated release authorization or a replacement for source/VM acceptance.

Native preparation now uploads a separate small `native-catalog-proposal` Actions
artifact. The hosted verification artifact includes the completed handoff alongside
its exact producer run. Both workflows pin the current checked-in trust root;
rotating that key requires a reviewed workflow pin change. They retain read-only
permissions and cannot publish or sign a catalog.

The first [hosted preparation of this handoff](https://github.com/Sakeerin/StackCabin/actions/runs/41810673728)
passed using source `37ab4e5` and tag `native-candidate-20261104-catalog`.
Its [nine-file proposal](https://github.com/Sakeerin/StackCabin/actions/runs/41810673728/artifacts/13311399496)
is 38,834 ZIP bytes, SHA-256
`51a970b76dd25c8ddeb493ea64367a52299506821b175173df0b5760e63ff135`.
The separate [small review evidence](https://github.com/Sakeerin/StackCabin/actions/runs/41810673728/artifacts/13312346986)
retains manifest pin
`a69cacb9733da6beeececf20aebc904ab093ad2f61c98dacc042b8152d1d3fa4`.
Both small ZIPs were downloaded and hash-checked. Independent comparison preserved
all 32 signed base entries, added the exact twelve native records, checked eight
handoff file hashes and all 39 review checksums, and matched the 109-file candidate
inventory. All twelve producers and 106 unchanged assets match the previously
verified local candidate; only the proposed catalog URLs and associated control
files change with the new tag. Evidence is in `artifacts/catalog-handoff-20261104/`.
The full candidate ZIP receipt matches GitHub metadata without another large local
download. These Actions artifacts expire after seven days. A real unpublished-URL
probe returned HTTP 404 and created no hosted handoff; publication remains pending.

## 2. Establish the production trust root

Generate an Ed25519 signing key outside the repository. The private key must remain
in the approved signing environment, supplied as `STACKCABIN_CATALOG_PRIVATE_KEY`.
Never distribute the local development key. Select and review the production
public key separately; its pinned SHA-256 is for the exact canonical
`public-key.txt` bytes (base64 of the raw 32-byte Ed25519 key followed by one LF).

After public hosting and source/clean-machine review, use
`.github/scripts/sign-catalog-proposal.mjs` to sign the exact proposed bytes. It
requires the separately retained SHA-256 of `CATALOG_HANDOFF.json`, the trusted
base public-key file hash, and the independently selected production public-key
file hash. Retain the handoff hash from the reviewed successful hosted workflow;
do not trust a replacement hash supplied only alongside a downloadable folder.
A JSON status by itself is not release authorization. Source/license review and
baseline acceptance remain operator decisions, not conclusions of the signer.

First check the complete input and unused destination without accessing any key:

```sh
node .github/scripts/sign-catalog-proposal.mjs --directory=hosted-catalog-handoff --handoff-sha256="$REVIEWED_HANDOFF_SHA256" --base-public-key-sha256="$TRUSTED_BASE_PUBLIC_KEY_FILE_SHA256" --public-key-sha256="$PRODUCTION_PUBLIC_KEY_FILE_SHA256" --output=signed-catalog --check-only
```

In the approved signing environment, repeat that command without `--check-only`.
The tool rejects review-only/pending handoffs, altered or additional control files,
invalid base signatures, changed immutable runtime metadata, incomplete native or
public-byte inventories, unsafe destinations and the known development key.
It validates every input before opening the private key, requires Ed25519, matches
the derived public key to the independently selected hash, and self-verifies the
signature. It performs no publisher refresh or network request. The existing
`build-catalog.mjs --extra=...` path remains a publisher-refresh tool and does not
guarantee the exact reviewed bytes.

The new output contains `catalog.json`, `catalog.sig`, `public-key.txt`, and
`provenance.json`. The catalog is byte-for-byte identical to
`catalog.proposed.json`; timestamps, whitespace and record ordering are preserved.
`SIGNING_RECEIPT.json` is written last and binds those four hashes to the selected
review/trust-root pins. Neither the private key nor its PEM text is written or
logged. The receipt explicitly covers only the catalog signature and retains
`productionApproved: false`. A signature does not certify VM, legal or installer
acceptance. Existing destinations and the checkout's shipping resources are never
replaced by this tool.

Verify the staged signed catalog before reviewing the shipping catalog/public-key
change:

```sh
node --input-type=module -e "import { verifyCatalog } from './scripts/catalog-lib.mjs'; await verifyCatalog('signed-catalog', true);"
```

Once the approved four files are deliberately incorporated into `runtime-catalog/`,
retain their original `SIGNING_RECEIPT.json` at `.github/release/SIGNING_RECEIPT.json`
outside the bundled resources. Retain that receipt's SHA-256 independently from
the checkout, together with the selected production public-key file hash. Run
`node scripts/verify-catalog.mjs --release` against the final shipping files.
The signature tool is not wired to the preparation or packaging workflows; they
do not receive a catalog private key. Tests use ephemeral keys and a child
environment that does not inherit the operator's secrets.

The 5 November implementation uses source `048c052`. Fifteen signing regressions
passed on all five code-CI targets, including the actual CLI with an allowlisted
child environment. Tests sign only synthetic transfer fixtures with ephemeral
keys; their successful signatures are not production-release evidence.
Separately, the real 4 November proposal ZIP was rechecked against its retained
GitHub digest and the original handoff pin
`ef9acf44138b363d1a6b57ef22d9d9d7442acf0db07ca469918690f8231846df`.
The signer rejected that still-pending handoff with zero private-key accesses and
no output directory. This probe used a clearly recorded placeholder target-key
hash to test admission order; no production key was selected. Evidence is retained
under `artifacts/catalog-signing-20261105/`.

The release gate rejects the development catalog and requires PHP 8.4/8.5,
Node 22/24, Caddy, Composer, MariaDB, PostgreSQL, pnpm, and Yarn for every target.
Every target must run both the native runtime smoke suite and the desktop E2E
suite. A source build alone does not establish runtime compatibility.

### Refresh publisher metadata without changing existing identities

The publisher-refresh builder now uses `.github/scripts/catalog-updates.mjs` to
merge new records. Every field of an existing ID must remain identical, including
URL, executable paths, extraction policy, source/license, size and future metadata.
Matching archive bytes alone cannot authorize a metadata replacement. Duplicate
IDs in either input, invalid IDs/hashes and missing HTTPS URL prefixes fail before
selecting a signing key. Freshly resolved records retain their default-selection priority;
older identities remain in the catalog with their original fields.

For CA discovery, `build-catalog.mjs` bypasses the mutable latest-URL cache. It
parses the PEM conversion timestamp as a checked UTC calendar date and downloads
the official dated archive. Both byte sequences must match exactly before any
records are returned. New CA records use that dated URL, with their verified
checksum and size. A signed legacy latest URL is retained only when every other
field already agrees; the builder cannot silently rewrite its URL under the same
ID. Invalid/ambiguous dates, non-PEM input, substituted/truncated dated bytes and
publisher errors stop resolution. PEM shape and transport checks do not review
the root certificates' trust policy.

The builder still refreshes publishers and signs a new catalog when explicitly
invoked with a signing identity. Use the exact-byte handoff signer for reviewed
release proposals. The new helper itself never opens a private key or modifies
shipping files. Fifteen new regressions include real CLI executions in copied,
isolated workspaces with Thai/space paths, allowlisted environments and ephemeral
keys; rejection cases preserve all four original signed controls and create no
development key. Together with the existing catalog/workflow cases, all forty
related local tests and actionlint passed on 7 November 2026.
All eleven code-CI jobs passed on source `cf75cc4` in
[42376648599](https://github.com/Sakeerin/StackCabin/actions/runs/42376648599),
including the fifteen new cases on all five code targets. At that checkpoint,
normal installer/offline downloads retained their verified `c763b6d` producer.
The unchanged source guard required fresh normal installers for the later
publisher-tool checkout. The runtime-pack increment below built that fresh set.

A separate read-only check downloaded the real current and dated curl CA bundles:
200,116 identical bytes, SHA-256
`427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285`,
dated 5 November. It proposed four additional CA identities while preserving all
32 base records. Replaying independently downloaded 20 October bytes also retained
the four exact legacy CA records. The five shipping catalog/prerequisite files
remain unchanged. Evidence is under `artifacts/catalog-refresh-20261107/`;
this check did not sign or install the proposed CA records or approve their policy.
This 36-record publisher proposal is separate from the existing native handoff.

### Admit the exact signed catalog to packaging

The read-only `.github/scripts/verify-release-catalog.mjs` requires both held
hashes. It verifies the receipt's complete four-file inventory, exact Ed25519
signature, canonical public-key/signature encodings, review/source pins and
provenance. It also checks the complete target/version matrix, safe executable
paths and the macOS 14.0 ceiling. The known development key is rejected even when
its whitespace or self-reported development marker changes. Replacing the
catalog, receipt and their local checksums together cannot replace either held
hash. Select those hashes from the approved signing review, not from an untrusted
replacement folder.

```sh
node .github/scripts/verify-release-catalog.mjs --directory=runtime-catalog --receipt=.github/release/SIGNING_RECEIPT.json --receipt-sha256="$REVIEWED_SIGNING_RECEIPT_SHA256" --public-key-sha256="$PRODUCTION_PUBLIC_KEY_FILE_SHA256" --repository=Sakeerin/StackCabin --report=release-catalog-verification.json
```

The optional report is written only after success, outside the catalog and receipt,
without replacing an existing file. Linked/non-regular files, unknown resources
and additional signing files are rejected. The three existing source/prerequisite
JSON resources are allowed and their actual hashes are included in the report;
they remain subject to their existing builder/prerequisite checks and are not
covered by the four-file signing receipt. No private key is accessed. Successful
reports explicitly retain `productionApproved: false`: this gate binds reviewed
signing bytes; source/license approval, clean-machine certification, installer
certificates and notarization remain separate release decisions.

Dispatch **Package reviewed release** (`release.yml`) with required
`signing_receipt_sha256` and `public_key_sha256`; neither has a default. Leave
`build_installers` false for catalog verification only. With it true, a successful
preflight admits the four-platform packaging matrix. Each job checks out the exact
dispatch commit and repeats the receipt/key checks before installing build tools
or accessing installer certificate secrets. The existing release catalog gate
also runs before the Tauri build. Verification reports are retained for seven days.
The workflow has contents-read permission and does not publish a release or receive
a catalog private key. The current development catalog cannot pass this workflow;
no placeholder production receipt is checked in.

Twelve regression cases exercise exact signing output admission, independent pins,
all four altered files, disguised development identities, invalid signatures,
incomplete/unsafe matrices, provenance substitution, linked paths and CLI output
rules. They use ephemeral keys and synthetic metadata independent of the shipping
catalog, so a reviewed production catalog/key promotion does not change the test
fixtures. Fourteen workflow contracts keep the packaging dependency and repeated
preflight ahead of certificate access. All 92 related local cases and actionlint
passed on 6 November 2026.

The following CA recovery source `c763b6d` passed all eleven code-CI jobs in
[42163894785](https://github.com/Sakeerin/StackCabin/actions/runs/42163894785),
including these twelve cases on all five targets. Its four normal development
installer jobs passed in
[42163918516](https://github.com/Sakeerin/StackCabin/actions/runs/42163918516).
The same deb/AppImage passed on Ubuntu 24.04 in
[42164712886](https://github.com/Sakeerin/StackCabin/actions/runs/42164712886);
the matching Windows offline package/installation passed both jobs in
[42165094208](https://github.com/Sakeerin/StackCabin/actions/runs/42165094208).
The small five-file verification ZIP was downloaded and hash-checked; its source,
preflight and full-bundle receipt match GitHub metadata. The large bundle ZIP was
not downloaded locally. The source guard correctly rejects the earlier `7097c79`
installer because the CA recovery changes application code. The current source
compatibility report retains the unchanged five catalog/prerequisite hashes.
These 18 successful jobs, the separate expected rejection and the earlier failed
CA job are recorded under `artifacts/release-catalog-20261106/`.

A real negative dispatch on source `cb4bc1d`,
[42163322680](https://github.com/Sakeerin/StackCabin/actions/runs/42163322680),
selected the known development public-key hash and an explicitly placeholder
all-zero receipt hash with `build_installers=true`. The catalog job failed with
the expected development-identity rejection, the report upload was skipped, and
the packaging job was skipped with no steps. No installer build or certificate
access occurred. This expected failure proves early rejection of that identity;
it is not a successful production release or evidence for a selected production
key. The verifier/workflow are unchanged by the following CA recovery.

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

Runtime pack assembly requires a new output directory (`--output=<new-folder>`;
its parent must exist). It never refreshes or overwrites an existing pack, even
an empty directory. A sibling staging directory holds a snapshot of the four
signed-catalog controls and deduplicated, checksum/size-verified archives. Before
publication the original controls must still match; final copies are hashed
again. The output directory is created exclusively, and the completion receipt
is written last after every verified copy. Publication is not an atomic directory
rename. Failure/cancellation removes only owned files with matching identities;
foreign/replaced files are retained. Avoid consuming a folder while it is being
built. The whole operation has a 30-minute cancellation deadline.

`--offline --cache=<folder>` disables downloads and accepts archive-SHA filenames
or the publisher cache's URL-SHA filenames. Missing/damaged entries fail without
replacement; source cache files are read-only. Cached copies are streamed, with
an 8-GiB per-archive bound and signed size checks when known. Network downloads
still use the shared buffered download helper, with cancellation propagated to
fetch; this is not a streaming-network-memory guarantee.

`RUNTIME_PACK_RECEIPT.json` covers exactly the four catalog controls and runtime
archives. README is excluded because the complete Windows wrapper replaces it.
It excludes installers, Microsoft prerequisites, arbitrary dependencies and
secrets. The Windows builder verifies a present receipt against independently
verified bytes, while legacy packs remain accepted by the original catalog and
archive checks. This optional completion record has no production/signing
authority; the complete Windows integrity manifest remains a separate layer.

Twenty new cases cover all supported pack targets, cache layouts, interruption,
archive/catalog changes, cancellation, late output ownership, linked inputs,
receipt tampering and the real CLI with Thai/space paths. They run in code CI on
all five targets and before Windows offline assembly. On 7 November 2026 all 75
related local cases and actionlint passed. A real cache-only CLI run verified all
11 Windows archives (621,294,545 bytes), rejected subsequent overwrite, and
preserved 28 source/cache and shipping inputs. Evidence is under
`artifacts/offline-pack-20261107/`; no software was installed locally.

Source `300dc74` then passed all eleven code-CI jobs in
[42381344342](https://github.com/Sakeerin/StackCabin/actions/runs/42381344342),
including the twenty new cases on every code target. All four normal installer
jobs passed in
[42381361969](https://github.com/Sakeerin/StackCabin/actions/runs/42381361969),
and the same deb/AppImage passed Ubuntu 24.04 startup in
[42381875969](https://github.com/Sakeerin/StackCabin/actions/runs/42381875969).
Both Windows offline assembly/installation jobs passed in
[42382025371](https://github.com/Sakeerin/StackCabin/actions/runs/42382025371),
including all eleven tools, five concurrent HTTP projects, both database
dump/restores and preserved app data under a restricted standard-user token.
The small verification ZIP passed independent digest/source/receipt checks;
the large bundle was not downloaded locally. These eighteen successful jobs and
the unchanged five catalog/prerequisite hashes are bound in
`artifacts/offline-pack-20261107/ACCEPTANCE_SUMMARY.json`.
The old producer was rejected without changing the source guard. The generated
local test pack's seventeen duplicate files (621,326,424 bytes) were removed only
after inventory/hash checks, retaining the receipt and all 28 original inputs.
This does not certify a clean desktop or select a production signing identity.

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
