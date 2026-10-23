# Architecture

React communicates with the Rust core through explicit Tauri commands. The UI
has no unrestricted shell/filesystem permission and no remote content is loaded
into the privileged webview. Caddy and database servers bind to loopback.

## Boundaries

`AppCore` coordinates `Store`, `RuntimeManager`, `Supervisor`, `DatabaseManager`,
and `BackupManager`. Core code has no dependency on Tauri, so persistence,
installation, process lifecycle, and backup behavior can be tested independently.
Tauri emits `stackcabin:event` messages; a bounded ring retains the last 2,000
events. Process environment values with password/token/secret names are redacted
from captured child output.

The supervisor launches executables from verified, application-owned runtime
directories. Package managers are JavaScript entry points executed by the
project's selected Node binary; Windows `.cmd` files and shell interpolation are
not used. Source projects can still execute arbitrary code after explicit trust.

## Project contract, schema version 1

`stackcabin.json` contains the project name/preset, runtime selections,
process definitions, environment, and optional database binding. Process entries
specify a supported tool, argument array, relative working directory, preferred
port, and health path. `${PORT}` is substituted with the actual selected port.
Working directories must resolve inside the project root.

`stackcabin.lock.json` records selected exact runtime versions. It is independent
of `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `composer.lock`.
Project path, trust, registration ID, and creation timestamp live in the app's
SQLite metadata, not in the portable project manifest. Trust therefore does not
travel with a copied repository.

The runtime catalog maps each component/version/OS/architecture to an HTTPS
archive, SHA-256, executable paths, source location, and license. Its exact JSON
bytes are Ed25519-signed against the embedded public key. Installation writes a
receipt only after verification/extraction succeeds. On Windows, a receipt-last
copy fallback handles file scanners that deny an otherwise safe directory move.
Catalog generation retains previously signed artifact versions and refuses to
change the bytes behind an existing artifact ID, preserving project runtime pins
when a later application catalog adds newer patch versions.

## Process and database lifecycle

Windows processes belong to a Job Object with `KILL_ON_JOB_CLOSE`. Unix children
have their own process group and a pipe-driven watchdog in that group. EOF on the
parent pipe kills the owned group; group membership prevents the guard from
targeting a reused PGID. No global process-name kills are used.

Caddy receives generated JSON configuration. Starting a project checks its
upstream and then the routed HTTP request before publishing Running. Removing a
project stops owned processes and removes metadata while retaining source files.

MariaDB and PostgreSQL each have an application-owned data directory and an OS
keychain administrator password. Project passwords are distinct and never stored
in either manifest. SQL identifiers are generated and validated. PostgreSQL uses
SCRAM authentication; MariaDB uses generated credentials and loopback binding.
Database connection variables are injected into project processes only.

The Windows PostgreSQL distribution cannot initialize UTF-8 databases when its
executable path contains certain non-ASCII characters. StackCabin verifies an
ASCII NTFS junction to its own storage and uses that path for PostgreSQL tools;
the underlying files stay in the selected data directory. The alias is retained
for subsequent launches. Creating it requires a writable ASCII ancestor. If no
such ancestor exists, the error explains how to select an ASCII data directory.

Major database upgrades are not automatic. Add and verify a new engine package,
export a logical snapshot, create the new instance, and restore into it.

## Backup contract

A ZIP archive contains `backup.json`, `project/`, and optionally `database.dump`.
The manifest includes hashes for every archived source/data file. Extraction
rejects traversal and symlinks, verifies listed hashes, and rejects unlisted
project files. Restore always targets a new folder and generates a new database
identity. A SQLite backup uses `VACUUM INTO`; server databases use their native
logical dump clients. The project's owned processes are paused during backup and
restarted afterwards if they were running.

Metadata migrations reject unknown future schema versions. Application updates
do not rewrite selected runtime versions or silently upgrade database files.
