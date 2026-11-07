# Implementation and verification status

Development version: **0.1.0**, checked on **7 November 2026**.
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
  The legacy CA bundle resolves to its official dated archive only when the signed
  component/URL/hash match; changed upstream latest bytes are never accepted.
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
- Native release byte verification requires a retained manifest SHA-256, checks
  the complete local inventory and offers bounded HTTPS streaming checks after
  public hosting. Small review evidence binds the candidate ZIP to its producer.
- Unsigned catalog proposals verify the pinned base trust root, preserve existing
  entries, reject metadata changes under immutable IDs, and check the complete
  target/version/executable matrix. Public-byte verification is a separate mode;
  neither mode signs the catalog or grants production approval.
- Exact-byte catalog signing validates a separately pinned, fully hosted handoff
  before accessing an Ed25519 key. It checks the independently selected public
  key, rejects the known development identity and writes a new staged catalog
  with a final signature receipt. Read-only preflight opens no key; signing does
  not change shipping resources or grant production approval.
- Packaging admission verifies the exact signing outputs against independently
  retained receipt/public-key hashes. Catalog-only preflight precedes the installer
  matrix; each exact checkout repeats it before build tools or certificate access.
  The gate never accesses a catalog private key or grants production approval.
- Publisher refresh preserves every existing ID's full metadata, rejects duplicate
  or malformed records before selecting a key, and retains newly resolved default
  priority. CA discovery bypasses the mutable URL cache and requires exact bytes
  from a dated official archive before proposing new records. Legacy signed URLs
  remain unchanged when the same CA bytes are resolved again.
- Separate internal Unix QA app/catalog/credential identities and matching offline
  runtime packs; distributed QA apps exclude E2E plugins. See [QA usage](QA_DESKTOP.md).

## Current verification

Hosted verification now uses macOS 15 ARM/Intel after the macOS 14 image's
retirement. Rosetta remains an explicit x64 compatibility check on ARM hosts;
Intel hosts always select x64 installer artifacts. Fourteen workflow-contract checks
cover platform selection and kit/desktop/upgrade artifact wiring. CI also runs
checksum-pinned actionlint 1.7.12 and rejects retired hosted runner labels.
QA build/upgrade workflows require an explicit producer `source_run` instead of
expired hardcoded IDs. Windows offline/upgrade and Linux coexistence inputs also
require explicit current producer selections. The four Linux packages were rebuilt
on 4 November: all eight build/integration/Ubuntu 24.04 jobs passed. Their source
bundles and final library/license bytes were independently rechecked locally.
The eight macOS packages retain the reviewed 2 November producers, with measured
minimum OS versions at most 14.0. CI selections
live in `.github/native-test-builds.json`, outside desktop resources. Temporary
QA catalog signing requires a passed relocation probe for the exact version and
the reviewed publisher source bytes. Twelve native-stack regression tests cover
corrupt/substituted archives, missing provenance and incompatible macOS baselines.

The normal application uses source `c763b6d`, including exact-byte recovery of the
pinned CA archive and the existing file-backed startup probes. The release-tool
increment `cb4bc1d` added packaging admission and synthetic test fixtures. The
7 November increment hardens the separate publisher-refresh builder; no new app
installer or offline bundle was built for that increment.
The independently reviewed native catalog handoff retains source `37ab4e5`.
The reviewed native selection is
`76955fa`; the downloadable Unix QA desktops below retain their earlier producers.
The app retains the same signed development catalog and reports
the metadata path and SQLite extended error code on initialization failure.
Its resource set excludes the unused CI selection file. The real source/catalog
compatibility check passed in
`artifacts/release-catalog-20261106/installer-source-compatibility.json`. The macOS 14
execution rows below explicitly concern the earlier `2b3836e` installers.
That compatibility report binds assembly `2b25154` to the 6 November installer.
The later publisher-builder script change is outside the source guard's closed
allowlist: assembling a fresh offline bundle from this checkout requires a new
normal installer first. The guard is unchanged; download links retain the exact
previously verified `c763b6d` packages.

| Check                        | Latest evidence and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-platform CI            | [42163894785](https://github.com/Sakeerin/StackCabin/actions/runs/42163894785): all eleven jobs passed on source `c763b6d`: Windows x64, Ubuntu 22.04/24.04 x64, native macOS 15 ARM and Intel. Fourteen workflow contracts, twelve release-catalog cases per target and actionlint 1.7.12 passed.                                                                                                                                                                                                                 |
| Core/frontend                | 50 Windows / 45 Unix core tests; four ignored entries are separately invoked child-process fixtures. Fourteen frontend tests, formatting, Clippy and generated IPC checks passed. Forty-seven packaging helper cases include Ubuntu source/license verification, Windows access diagnostics, release source pins, verbose startup and failure output.                                                                                                                                                              |
| Desktop                      | Four real IPC/SQLite E2E cases and four lifecycle sessions on each CI target, plus two desktop exit-coordination tests. Actual tray pointer interaction remains a clean-VM check.                                                                                                                                                                                                                                                                                                                                  |
| Native tools                 | Managed Node 22/24, npm/pnpm/Yarn, Caddy and concurrent HTTP passed on all five targets; Windows also exercises PHP 8.4/8.5. Unreachable machine proxies do not redirect loopback health checks.                                                                                                                                                                                                                                                                                                                   |
| Native transfer checks       | [41803437796](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796): all 109 candidate files passed the retained manifest pin; 40 small evidence files passed 39 checksum records and match independent local assembly. Thirteen corruption/redirect/timeout/cancellation regressions passed on each code-CI target. Full public StackCabin URL verification remains pending publication.                                                                                                               |
| Unsigned catalog handoff     | [41810673728](https://github.com/Sakeerin/StackCabin/actions/runs/41810673728): the nine-file proposal preserves all 32 signed base entries and adds twelve native records. Both small ZIP digests, eight handoff file hashes, 39 evidence checksums and the 109-file candidate inventory passed independent comparison. The proposal remains review-only; an actual unpublished URL returned HTTP 404 without creating a hosted handoff.                                                                          |
| Catalog signature checks     | [41958236096](https://github.com/Sakeerin/StackCabin/actions/runs/41958236096): fifteen signing regressions passed on all five code targets using ephemeral keys and synthetic transfer fixtures. They cover exact-byte preservation, separate trust pins, corrupted/incomplete handoffs, wrong keys, CLI secret handling, read-only preflight and destination races. The real retained review-only handoff was rejected before any key access or output creation. No production catalog was signed.               |
| Normal installers            | [42163918516](https://github.com/Sakeerin/StackCabin/actions/runs/42163918516): all four packaging jobs passed on source `c763b6d`, with ten fresh installed Windows starts, installed deb startup and both macOS bundles. Builds exclude E2E features.                                                                                                                                                                                                                                                            |
| Ubuntu 24.04                 | [42164712886](https://github.com/Sakeerin/StackCabin/actions/runs/42164712886): the same fresh `c763b6d` Ubuntu 22.04 deb/AppImage passed checksums and real startup; AppImage used extract-and-run without FUSE.                                                                                                                                                                                                                                                                                                  |
| Reviewed Linux packages      | PHP [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/41796142648)/[8.5](https://github.com/Sakeerin/StackCabin/actions/runs/41796146248), [MariaDB](https://github.com/Sakeerin/StackCabin/actions/runs/41765946994) and [PostgreSQL](https://github.com/Sakeerin/StackCabin/actions/runs/41765727571): all eight jobs passed on Ubuntu 22.04/24.04. The four archives retain 139 library records with exact source/license evidence; 42 source bundles cover 41 distinct Ubuntu source-package versions. |
| Reviewed macOS packages      | The 2 November PHP [8.4](https://github.com/Sakeerin/StackCabin/actions/runs/41382380346)/[8.5](https://github.com/Sakeerin/StackCabin/actions/runs/41382383140), [MariaDB](https://github.com/Sakeerin/StackCabin/actions/runs/41382386213) and [PostgreSQL](https://github.com/Sakeerin/StackCabin/actions/runs/41382389092) ARM/Intel packages remain selected. Their source-built runtimes and bundled libraries measured at most 14.0.                                                                        |
| Combined Unix stack          | [41798068081](https://github.com/Sakeerin/StackCabin/actions/runs/41798068081): the new Linux packages passed both Ubuntu versions with eleven tools, five simultaneous web projects and both database dump/restores. The unchanged macOS packages retain [41387839639](https://github.com/Sakeerin/StackCabin/actions/runs/41387839639), including native ARM/Intel and Rosetta checks and extracted release harnesses.                                                                                           |
| Unix QA desktop              | [41389144691](https://github.com/Sakeerin/StackCabin/actions/runs/41389144691): all three desktop/runtime/database E2E and packaging jobs passed. QA installers exclude E2E plugins and retain a separate identity. [41391205967](https://github.com/Sakeerin/StackCabin/actions/runs/41391205967) verified Ubuntu 24.04 deb/AppImage startup and coexistence without changing the normal executable.                                                                                                              |
| Unix upgrades                | [Default](https://github.com/Sakeerin/StackCabin/actions/runs/41390907584) and [custom](https://github.com/Sakeerin/StackCabin/actions/runs/41390910274) data locations: all six jobs passed on Ubuntu 22.04, native macOS 15 ARM and Intel. Real previous QA 0.1.0 installers were replaced with unpublished 0.1.1 candidates while preserving ten projects, five databases, eleven tools and 78 hashes per fixture.                                                                                              |
| Earlier macOS 14 ARM         | [41270976722](https://github.com/Sakeerin/StackCabin/actions/runs/41270976722): the `2b3836e` ARM DMG passed checksums, mount/copy, dependency/minimum-OS checks and startup on macOS 14.8.9.                                                                                                                                                                                                                                                                                                                      |
| Earlier macOS 14 x64         | [41270979416](https://github.com/Sakeerin/StackCabin/actions/runs/41270979416): the `2b3836e` Intel DMG passed those checks through Rosetta on the ARM runner. Current installers and native Intel macOS 14 still need maintained-machine acceptance.                                                                                                                                                                                                                                                              |
| Actual disk exhaustion       | [41209951170](https://github.com/Sakeerin/StackCabin/actions/runs/41209951170), Ubuntu 24.04: bounded 32 MiB tmpfs produced real ENOSPC for settings writes and runtime extraction; old data survived, staging was cleaned, and retries succeeded after freeing owned space.                                                                                                                                                                                                                                       |
| Windows offline installation | [42165094208](https://github.com/Sakeerin/StackCabin/actions/runs/42165094208): both jobs passed on source `c763b6d`: real wrapper/NSIS installation, eleven tools, five concurrent HTTP projects, both database dump/restores and existing-data preservation under a restricted standard-user token.                                                                                                                                                                                                              |

Six atomic-write regressions exercise released/persistent Windows sharing locks,
read-only files, failed publication cleanup, Thai/space paths and complete reads
during replacement. The disk-full probe retains the native I/O error code rather
than weakening its ENOSPC assertion.

The prebuilt Linux kits also passed with only loopback networking inside isolated
network namespaces on [Ubuntu 22.04](https://github.com/Sakeerin/StackCabin/actions/runs/41389157621)
and [24.04](https://github.com/Sakeerin/StackCabin/actions/runs/41389160575), as an
ordinary user. Three independent native Intel kit repeats passed:
[41389148214](https://github.com/Sakeerin/StackCabin/actions/runs/41389148214),
[41389151417](https://github.com/Sakeerin/StackCabin/actions/runs/41389151417) and
[41389154642](https://github.com/Sakeerin/StackCabin/actions/runs/41389154642).

Two earlier attempts are retained as intermittent findings. The first combined
run [41386358538](https://github.com/Sakeerin/StackCabin/actions/runs/41386358538)
had one native Intel HTTP recheck timeout after successful web/database checks.
Windows [41386419016](https://github.com/Sakeerin/StackCabin/actions/runs/41386419016)
had one default-data candidate startup report SQLite readonly; its preceding
HTTP/SQL/data checks passed. Their causes are unconfirmed. Bounded live Caddy/
process/raw-HTTP diagnostics and non-mutating Windows file-access diagnostics
were added without relaxing assertions. The subsequent full native suite,
three Intel repeats and twenty Windows candidate startups passed. A local real
Rust Store stress probe also passed 1,000 reopen/migrations alongside 5,530
read-only checks from a separate process. Keep both observations in VM soak work.

The 3 November normal installer attempt
[41563800420](https://github.com/Sakeerin/StackCabin/actions/runs/41563800420)
adds a third observation: Windows NSIS/prerequisite installation succeeded but
fresh metadata readiness timed out after 45 seconds. The three Unix packaging
jobs and all eleven code-CI jobs passed. The timeout's cause is unconfirmed.
Failure-only file/process/SQLite diagnostics now retain bounded application
output. The harness uses file-backed stdout/stderr to prevent an unread output
pipe from blocking startup; a real child emitting 512 KiB before creating metadata
regresses that separate harness defect. Assertions retain the 45-second deadline.
Normal Windows installer checks now require ten consecutive fresh-metadata starts.
The same failed-run installer then passed all ten fresh starts in
[41565485124](https://github.com/Sakeerin/StackCabin/actions/runs/41565485124)
with the updated probe. This does not establish the original timeout's cause.

The migrated managed-tool workflow passed on native ARM
[41379324406](https://github.com/Sakeerin/StackCabin/actions/runs/41379324406),
x64 through Rosetta
[41379327016](https://github.com/Sakeerin/StackCabin/actions/runs/41379327016),
and native Intel
[41379329653](https://github.com/Sakeerin/StackCabin/actions/runs/41379329653).
Each ran npm/pnpm/Yarn with managed Node 22/24 and kept all three static/Node
projects reachable. The native Intel installer check
[41379332348](https://github.com/Sakeerin/StackCabin/actions/runs/41379332348)
used the default `arch=arm64` dispatch value, correctly downloaded the x64 DMG,
verified it and started the normal app on the Intel host. Its compatibility step
does not use Rosetta on native Intel. Logs/metadata are retained under
`artifacts/hosted-runners-20261102/`.

Lifecycle coverage includes native close/restore, close without tray, abrupt
app termination and repeated Quit while accepted work is pending. Owned process
trees stop while an unrelated HTTP server stays healthy. Real owner-crash tests
bypass Rust destructors and verify descendant exit and closed ports.

Eight local Windows acceptance safeguards, eight workflow contracts and
checksum-pinned actionlint passed. The source policy still requires new normal
installers for changed application inputs; no source-policy exception was added
for this rebuild. All five current downloaded installer files matched their
published checksums.

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
[41390154940](https://github.com/Sakeerin/StackCabin/actions/runs/41390154940).
It uses previous normal source `2b3836e` from installer run `41209952479` and an
unpublished 0.1.1 test candidate from source `57c61a4`. The distributed version
remains 0.1.0. Separate hosted jobs verified the physical default application-data
directory and a custom Thai/spaced directory. Both old/new installed apps held
the original metadata database open; all ten projects, five databases, eleven
tools and 78 file hashes remained valid, including real HTTP/runtime versions
and existing SQL rows. The core harness performs HTTP/SQL verification; packaged
apps are checked for real startup and metadata-file use. Default mode also proved
that both apps resolve Windows' real application-data directory without an
override. See [upgrade scope](UPGRADE_ACCEPTANCE.md).
Each mode required ten consecutive successful post-upgrade candidate starts;
any failed launch would stop the job. All twenty passed before final core checks.
The wrapper explicitly selects all four PHP/Node branches despite an intentionally
unsupported inherited filter, then restores the caller's environment. Curated
transcripts/baselines are in `artifacts/native-refresh-20261102/windows-soak/`.

## Downloads and retained evidence

Download the normal `development-installers-*` artifacts from
[42163918516](https://github.com/Sakeerin/StackCabin/actions/runs/42163918516)
and verify their `SHA256SUMS.txt`. These four successful producer jobs built five
package files from `c763b6d` and verified installed Windows/deb and macOS bundle
startup. The new installer ZIPs were not downloaded again locally.

The matching 6 November Windows offline ZIP is in
[42165094208](https://github.com/Sakeerin/StackCabin/actions/runs/42165094208),
881,225,329 bytes, SHA-256
`1cc611e85852cb6638114606798d6d06ed97d4a800ab201487088335557da4b1`.
The small verification ZIP was downloaded and checked against GitHub's digest;
all five JSON files passed source/preflight/receipt comparison, including eleven
runtimes and the unchanged five catalog/prerequisite hashes. Its full bundle
receipt matches GitHub metadata; the large ZIP was not downloaded locally. Both
the package and actual hosted installation jobs passed. Evidence is retained in
`artifacts/release-catalog-20261106/` with seven-day Actions retention.

The earlier 4 November files from
[41765896134](https://github.com/Sakeerin/StackCabin/actions/runs/41765896134)
were downloaded and matched their checksums locally. That Windows NSIS is
23,018,543 bytes, SHA-256
`a5663cad6f933f1647abd529dc9ed16005f24371f8c8bb8240de553e1b0683a3`.

The earlier 4 November `development-offline-windows-x64` ZIP is in
[41796262008](https://github.com/Sakeerin/StackCabin/actions/runs/41796262008),
881,311,081 bytes, SHA-256
`00dab3f98c174fcafe179dfdd494672f2f1f0414d3e515dee44028473b07b4fc`.
Its receipt matched GitHub artifact metadata; the full ZIP was not downloaded
locally. The installed normal executable SHA-256 is
`f8dc19c6ae30267ee01c27b32cbfc84984be441cd3f684842dce35d3d4213c6b`.
These development artifacts have seven-day retention.

Download current Unix offline desktops from
[41389144691](https://github.com/Sakeerin/StackCabin/actions/runs/41389144691);
the [QA guide](QA_DESKTOP.md) identifies their three artifacts and source commits.

Local logs and metadata are ignored under `artifacts/`. The 2 November
`native-refresh-20261102/ACCEPTANCE_SUMMARY.json` binds **56 successful jobs in
19 canonical runs**, twelve verified runtime/source pairs and nine preservation
baselines to the exact commits and hashes. Earlier failed attempts remain separate
in the report; they are not counted as successful runs. Earlier installer bytes
and checksums are retained in `development-installers-41765896134/`. The local
offline folder passed read-only verification of 25 files, eleven runtimes and
Microsoft signature/version checks with the new installer, without executing it.
Prior runner, macOS 14, disk-full and upgrade evidence remains in
`hosted-runners-20261102/`, `baseline-upgrade-20261101/` and `atomic-write-20261031/`.

The 3 November `native-release-review-20261103/ACCEPTANCE_SUMMARY.json` binds **31
successful jobs in seven canonical runs** to the exact source commits, reviewed
native candidate, that day's normal installers and Windows offline ZIP. It retains
the failed Windows readiness attempt separately; its three successful Unix jobs
are not included in that total. Both the old-installer reproduction and the new
Windows installer passed ten consecutive fresh metadata starts. The new offline
installation preserved ten projects, five databases, eleven tools and 78 file
hashes. The local offline folder was refreshed and passed `-CheckOnly` without
executing its installers. The large candidate/offline ZIP digests come from
GitHub metadata/receipts; those ZIPs were not downloaded again locally.

The 4 November `linux-sources-20261104/ACCEPTANCE_SUMMARY.json` binds **29
successful jobs in ten canonical runs** to exact producer commits, four rebuilt
Linux packages, the twelve-runtime candidate, five current normal installers and
the Windows offline pack. All four downloaded Linux source/library inventories
passed independent checks. The candidate contains 109 files and sixty unique
source archives; all 108 checksum records passed locally and in hosted preparation.
Earlier failed attempts remain separate and do not count toward that total.

The follow-up `native-transfer-review-20261104/ACCEPTANCE_SUMMARY.json` binds
**twelve successful jobs in two runs** to source `9dee7f3`: the eleven-job code CI
and one native preparation job. The new thirteen verifier cases passed on all five
CI targets, alongside eleven workflow contracts. Forty small review files passed
all 39 evidence checksums. The independently assembled 109-file candidate matches
the manifest pin retained by the hosted preparation; its ZIP receipt matches GitHub
metadata without downloading that large ZIP again. The small review artifact is
[available here](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796/artifacts/13308687671),
127,774 ZIP bytes with seven-day retention.

The current `catalog-handoff-20261104/ACCEPTANCE_SUMMARY.json` binds **twelve
successful jobs in two runs** to source `37ab4e5`: full code CI and unsigned native
preparation. Eleven new proposal regressions passed on all five CI targets,
alongside twelve workflow contracts; all 63 related local release/helper cases
passed. The nine-file proposal preserves the signed 32-entry base and adds twelve
native entries. Both downloaded small ZIP digests, eight handoff file hashes,
39 evidence checksums and the 109-file candidate inventory passed independent
comparison. The [proposal ZIP](https://github.com/Sakeerin/StackCabin/actions/runs/41810673728/artifacts/13311399496)
is 38,834 bytes with seven-day retention. It remains unsigned and review-only;
an actual unpublished native URL failed with HTTP 404 before any hosted handoff
was created. Production keys, baseline acceptance and public hosting remain open.

The earlier `catalog-signing-20261105/ACCEPTANCE_SUMMARY.json` binds **eleven
successful code-CI jobs** to source `048c052`. All fifteen signing regressions
passed on five targets, along with thirteen workflow contracts; all 79 related
local helper cases passed. Real CLI tests use an allowlisted environment and
ephemeral keys. Exact catalog bytes, trust pins, immutable metadata, complete byte
inventories, safe destinations and key-error redaction are covered. The original
review-only proposal was independently pinned from its verified ZIP and correctly
rejected before private-key access. The shipping catalog and all five installer
catalog/prerequisite inputs remain byte-identical to normal installer source
`7097c79`. Production signing was not performed; the current native URLs still
await publication and complete hosted verification.

On 6 November the read-only packaging gate added twelve regression cases; all
92 related local cases and actionlint passed. It requires separately retained
signing-receipt and production public-key file hashes, verifies the exact four
signing outputs and rejects the known development identity before build admission.
The release workflow defaults to catalog-only verification and repeats the checks
in every packaging checkout before build tools or certificate access. Test base
catalogs are now synthetic and independent of shipping catalog/key promotion.
No production receipt, signature, installer or publication was created by these
tests. All eleven code-CI jobs passed on `c763b6d`, including the twelve new
catalog cases on all five targets and fourteen workflow contracts. The real
[release preflight rejection](https://github.com/Sakeerin/StackCabin/actions/runs/42163322680)
used the unchanged verifier/workflow from `cb4bc1d`: a known development public
key and an explicit all-zero placeholder receipt pin failed before packaging;
the package job had no steps. This expected failure is separate from successful
code CI and does not constitute production approval.

The first code run for this increment found a real upstream CA change: Windows
native-smoke rejected `cacert.pem` with a SHA-256 mismatch. The official dated
20 October archive was independently downloaded and exactly matches the signed
200,116-byte record on all four targets. Native/offline download selection now
uses that historical copy for the exact legacy identity, preserving mandatory
checksum validation and the signed shipping catalog. Forty-one related catalog,
source-compatibility and offline preflight cases passed locally. Fresh normal
installers from `c763b6d` passed all four packaging jobs; the earlier `7097c79`
packages do not contain the recovery. The unchanged source guard rejected reusing
that earlier installer. Its earlier byte-compatibility report applies only to
the CI-tool-only `cb4bc1d` increment and is retained as
`release-catalog-20261106/pre-recovery-installer-source-compatibility.json`.

The current `release-catalog-20261106/ACCEPTANCE_SUMMARY.json` binds **18
successful jobs** to application source `c763b6d`: eleven code-CI, four normal
installer, one Ubuntu 24.04 verification and two Windows offline jobs. The 92
local release cases and 41 catalog/offline/source cases passed. The actual dated
CA transport matched every legacy signed record; fresh normal installers and the
offline installation retained all five unchanged catalog/prerequisite inputs.
The independently checked five-file offline evidence also matches the full ZIP
receipt to GitHub metadata. The earlier `cb4bc1d` run retains its Windows CA
mismatch and subsequent cancellation separately; no failed/cancelled job is
counted in the 18. The expected release-gate failure also remains separate and
explicitly used no production identity or installer certificate. These results
do not close public hosting, source/license approval or clean-machine gates.

On 7 November, fifteen publisher-refresh regressions and the existing catalog
and workflow cases passed locally (forty total). Real CLI cases use copied
workspaces, mock transports and ephemeral signing keys; no operator key is
inherited. The read-only real transport check matched current curl bytes to the
5 November dated archive, proposed four new CA records and preserved all 32 base
records. A replay of the real 20 October archive preserved every legacy CA field.
All five shipping catalog/prerequisite hashes remain unchanged. This is publisher
resolution evidence, with no catalog signature, shipping update or trust-policy
approval. It is retained in `artifacts/catalog-refresh-20261107/`.

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

Native release preparation now requires verified Ubuntu source/version ownership,
descriptor contents, complete source bundles and matching packaged library/license
bytes. Fifteen preparation regressions, twelve native-stack checks, eleven workflow
contracts, thirteen transfer-verification cases, 47 Python packaging-helper cases
and actionlint passed. Linux source
collection initially failed on an incorrect OS API call; the corrected API has a
regression case. Two subsequent PHP builds correctly rejected preinstalled PGDG
libpq sources absent from the configured Ubuntu indexes. The disposable builder
now selects Ubuntu libpq and checks exact source availability before compilation.
All six failed attempts remain excluded from accepted results.

The twelve reviewed runtimes assembled into 109 candidate files with sixty unique
source archives, including 42 Ubuntu bundles for 41 source-package versions. All
108 checksum records passed independently. Original metadata remains intact;
proposed immutable URLs do not sign or publish a catalog. Evidence is in
`artifacts/native-transfer-review-20261104/independent-reviewed-candidate.json` and
`payload/`. The new small evidence also retains the exact producer identities,
source JSON and a separately retained manifest hash.
The read-only hosted preparation passed in
[41803437796](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796),
source `9dee7f3`. Its unsigned, unpublished artifact has seven-day retention.
The previous 3 November Linux inputs are now rejected before staging because they
lack Ubuntu source records; their historical evidence remains preserved.
See [source records](RUNTIME_SOURCES.md) and [release preparation](RELEASING.md).
Publication, redistribution review and baseline-machine acceptance remain below.

The post-publication verifier streams every public asset against that retained pin
without credentials, rejects foreign/non-HTTPS redirects and truncated/changed
bytes, and writes completion only after all files pass. A real upstream Caddy
archive passed its HTTPS/redirect/hash transport. The unpublished StackCabin tag
returned HTTP 404 and created no hosted completion report. Full public StackCabin
hosted verification therefore remains pending actual publication; local integrity
does not set production approval.

1. **Complete the shipping runtime catalog.** Its signed development catalog has
   32 entries: cross-platform Node/Caddy/Composer/package managers/CA artifacts,
   with PHP and database packages for Windows x64. Normal Unix previews correctly
   mark missing PHP/MariaDB/PostgreSQL packages unavailable. Publish reviewed Unix
   packs at stable HTTPS URLs and certify them before signing the complete
   production catalog. Source/checksum pins are in
   `runtime-catalog/source-archives.json`; `.github/native-test-builds.json` selects
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
