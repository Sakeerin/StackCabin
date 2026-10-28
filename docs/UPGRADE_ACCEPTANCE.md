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
The `data_location` input selects `custom`, `default`, or `both` (the default).
Each location runs on a separate disposable hosted machine.

The old installer runs first so that its Microsoft prerequisites are available.
Both installed versions must report the expected version and contain exactly the
same catalog, signature and trust root as the acceptance executable. The native
harness then prepares and records the same ten-project/five-database fixture
described above. After the old installed application opens that data, the real
core verifies the persisted data before the candidate replaces the installation
at the same Thai/spaced destination. Startup, actual metadata-file use, exact
project/settings rows, live HTTP/runtime pins and existing database reads are
checked again after replacement. No fixture is reset to make the candidate pass.

Hosted Windows runners use an administrative account. PostgreSQL refuses an
administrative server token, so acceptance launches the core and packaged-app
probe with a restricted token: the same user SID and credential identity, with
administrator/power-user groups and administrative privileges disabled. The helper
checks that identity before starting, quotes literal arguments without a shell,
and contains each process tree in its own kill-on-close Job Object before resuming
it. The new token's default ACL explicitly retains the current user, so disabling
the administrator group does not deny access to the child's own process/pipe
objects (the same requirement described by PostgreSQL's
[AddUserToTokenDacl](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/common/exec.c)).
Before downloading runtimes or compiling, an actual Python child must prove it
is non-administrative and receives literal Unicode, empty and quoted arguments.
Only the new disposable fixture parent receives an explicit user-SID write
grant. Installers keep the runner's normal prerequisite installation context.
This is an internal CI launcher, not a change to the product's process supervisor.

Custom mode uses a dedicated Thai/spaced directory. Default mode uses the real
Windows roaming application-data folder, obtained through Windows' known-folder
API, under `dev.stackcabin.desktop`. It refuses pre-existing data before installing
anything and creates a physical application-data directory. Only the native
acceptance workspace's `app-data` path is a junction to that directory; the
installed application is launched without `STACKCABIN_DATA_DIR` and must itself
open the exact populated default database. Inherited overrides are removed only
from the child's environment. Two Rust checks preserve the manifest's logical
`app-data` keys for either physical layout and reject unrelated file paths.

`upgrade-evidence-windows-x64-custom` and `upgrade-evidence-windows-x64-default`
contain only their transcript and credential-free preservation hashes. The first
custom-only run used the artifact name `upgrade-evidence-windows-x64`.

[Run 40654545909](https://github.com/Sakeerin/StackCabin/actions/runs/40654545909/job/122702304801)
passed on 28 October 2026. The previous installer came from source
`a9fd4767d859ca740777aa895d85fd9b0a1873de`; the candidate and acceptance executable
came from `0680f06bf75c0b1935748039c863a1273bb7e4c6`. Both installed versions opened
the same existing metadata, with actual file use confirmed through Restart
Manager. The final baseline retains ten projects, five database bindings, eleven
tools and 78 file hashes; Thai, dark theme and proxy port 18080 also remain intact.
The real core read every original/restored database and verified all ten projects'
HTTP/runtime versions after replacement.

## Limits

This establishes same-schema preview replacement on hosted developer machines.
It does not establish migration from a supported public release, upgrade across
metadata schema versions, preservation at the default OS app-data location,
AppImage replacement,
native macOS 14 Intel acceptance, or clean-machine certification. Repeat the
[VM checklist](VM_ACCEPTANCE.md) with actual signed supported release versions
before certifying an upgrade path. Runtime major-version migration remains an
explicit database dump/restore operation.

## Verification evidence

Populated 0.1.0 → unpublished 0.1.1 checks on 24 October 2026 (Unix) and
28 October 2026 (Windows):

| Target           | Result | Evidence                                                                                                       |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Windows x64      | Passed | [Actual NSIS upgrade](https://github.com/Sakeerin/StackCabin/actions/runs/40654545909/job/122702304801)        |
| Ubuntu 22.04 x64 | Passed | [Installed deb upgrade](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909714)      |
| macOS 14 ARM     | Passed | [Actual DMG app replacement](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909952) |
| macOS 15 Intel   | Passed | [Native Intel check](https://github.com/Sakeerin/StackCabin/actions/runs/40104040800/job/120901909920)         |

Each passing target retains all ten projects, their trust/settings/runtime pins, source and backup
hashes, executable hashes and readable original/restored MariaDB/PostgreSQL/SQLite
data. Normal packaged application startup was checked before and after replacement;
the native core probe checked actual runtime versions and database contents.
The installed process's metadata file handle was checked for both versions.
