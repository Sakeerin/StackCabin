# Packaged application preservation

The manual **Verify QA installer upgrade preserves real data** workflow checks
an existing QA 0.1.0 installer against an unpublished 0.1.1 test candidate.
Select Ubuntu 22.04 x64, macOS 14 ARM, native Intel macOS 15, or all three.
The repository's product version stays 0.1.0; this workflow does not publish a
release or enable application self-update.

The separate **Verify Windows installer upgrade preserves real data** workflow
uses normal Windows installers and the normal credential namespace. It is limited
to disposable GitHub-hosted runners; local and self-hosted execution is rejected
before an installer can run.

## Existing data fixture

The workflow verifies a previous QA pack's checksums, signature and every matching
runtime archive, then compiles the real core against that exact catalog and QA
credential namespace. The existing `native-smoke` executable installs eleven
tools from those archives and prepares five concurrent static/PHP/Node projects,
both runtime branches, two server databases and restored copies of both.

`native-smoke record-persistence` adds a SQLite project and records ten real projects,
five existing database bindings, selected runtime IDs, trust, settings, source
files, runtime executable/receipt hashes and logical backup archives. It selects
Thai, dark theme and a nondefault proxy port. Recording refuses an existing
baseline or an incomplete fixture. It never records credentials in the manifest.

Verification opens the same SQLite metadata and compares every recorded field
and file. It reads the original/restored MariaDB and PostgreSQL rows through the
existing OS keychain credentials, reads SQLite, starts every stored project and
checks real HTTP content and PHP/Node version response headers. It does not
install tools, re-provision project accounts or repopulate the expected table.
Missing rows or accounts fail verification. Database listening ports
may change after a restart; database/user identity and all other manifest fields
remain checked. Owned services stop after each verification.

Preparation and verification use the same executable, avoiding cross-program
Keychain access in the unsigned macOS CI harness. This does not relax credential
access controls or establish signed-application trust migration across updates.
The workflow creates/unlocks its private keychain after compilation, sets a
one-hour lock timeout for the bounded acceptance step, and deletes that keychain
after evidence collection. It does not alter the user's login keychain settings.

## Installer replacement

The normal packaged QA executables contain no WebDriver plugins. Both versions
must open the populated data directory and preserve exact SQLite project/settings
rows through startup and process shutdown. The deeper runtime/database probe
runs in the current core acceptance executable after each application closes.
It supplements native UI E2E; it does not claim that the packaged UI itself was
driven to start all databases during this upgrade test.

For an existing data directory, readiness also requires an actual metadata file
handle in the installed process: `/proc` inode/device matching on Linux or
`lsof` process/inode matching on macOS. Windows queries the file's actual users
through [Restart Manager's RmGetList](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist),
without requesting process shutdown or restart. This proves the application opened
the existing database before the check succeeds. Three regressions exercise a real
SQLite open/close lifecycle and reject a different database or a different process.

- Ubuntu installs the actual previous `.deb`, then uses `dpkg` to upgrade the
  same package from 0.1.0 to 0.1.1 and checks the installed version.
- macOS mounts the actual DMGs, checks application identity/version and every
  Mach-O dependency/minimum OS, and replaces the app at the same Thai/spaced
  destination. The old bundle is retained beside the candidate for inspection.

Both applications use the same dedicated existing data directory. Their startup
helper reads metadata in SQLite read-only mode, refuses unknown/incomplete
fixtures, and never deletes an existing data directory. Three helper regressions
check Unicode/settings preservation, future-schema refusal and incomplete-fixture
refusal before launching a process.

`upgrade-evidence-*` artifacts contain the acceptance log and baseline hashes
for seven days. They exclude installed runtime archives, databases, OS keychains
and catalog private keys. The candidate installers are not published.

## Windows NSIS acceptance

The Windows workflow downloads and checksums an existing normal 0.1.0 installer
(the successful build run is an explicit input). It assembles the eleven matching
Windows offline runtimes from the shipping development catalog and builds an
unpublished normal 0.1.1 NSIS candidate without E2E plugins. The source version and
catalog remain unchanged. Actual installer hashes and both source commits are logged.

The old installer runs first so that its Microsoft prerequisites are available.
Both installed versions must report the expected version and contain exactly the
same catalog, signature and trust root as the acceptance executable. The native
harness then prepares and records the same ten-project/five-database fixture
described above. After the old installed application opens that data, the real
core verifies the persisted data before the candidate replaces the installation
at the same Thai/spaced destination. Startup, actual metadata-file use, exact
project/settings rows, live HTTP/runtime pins and existing database reads are
checked again after replacement. No fixture is reset to make the candidate pass.

The installed application uses a dedicated custom data directory, preserving the
runner's ordinary app-data location. `upgrade-evidence-windows-x64` contains only
the transcript and credential-free preservation hashes. This workflow still needs
a passing hosted run before Windows installer upgrade is recorded as verified.

## Limits

This establishes same-schema preview replacement on hosted developer machines.
It does not establish migration from a supported public release, upgrade across
metadata schema versions, preservation at the default OS app-data location,
Windows installer upgrade, AppImage replacement,
native macOS 14 Intel acceptance, or clean-machine certification. Repeat the
[VM checklist](VM_ACCEPTANCE.md) with actual signed supported release versions
before certifying an upgrade path. Runtime major-version migration remains an
explicit database dump/restore operation.

## Verification evidence

Populated 0.1.0 → unpublished 0.1.1 checks on 24 October 2026:

| Target           | Result | Evidence                                                                                                       |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Ubuntu 22.04 x64 | Passed | [Installed deb upgrade](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909714)      |
| macOS 14 ARM     | Passed | [Actual DMG app replacement](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909952) |
| macOS 15 Intel   | Passed | [Native Intel check](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909920)         |

Each passing target retains all ten projects, their trust/settings/runtime pins, source and backup
hashes, executable hashes and readable original/restored MariaDB/PostgreSQL/SQLite
data. Normal packaged application startup was checked before and after replacement;
the native core probe checked actual runtime versions and database contents.
The installed process's metadata file handle was checked for both versions.
