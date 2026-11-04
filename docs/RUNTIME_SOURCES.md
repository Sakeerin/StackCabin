# Native runtime source records

The portable Linux builder runs on Ubuntu 22.04. It copies external ELF libraries
into each runtime, records their installed binary package and exact source-package
version, and keeps corresponding source files and license texts beside the binary
archive. These records support release review; they do not certify redistribution
terms or clean-machine compatibility.

## Collection and verification

`scripts/linux_runtime_sources.py` obtains ownership through `dpkg-query`,
including its `source:Package` and `source:Version` fields. It also handles
Ubuntu's `/lib` and `/usr/lib` aliases. Ambiguous or unowned libraries fail the
build. See the [dpkg-query reference](https://manpages.debian.org/bookworm/dpkg/dpkg-query.1.en.html).

The workflow enables official Ubuntu HTTPS `deb-src` indexes using the Ubuntu
archive keyring. APT downloads the exact `source-package=source-version` with
`--only-source --download-only`; unauthenticated/insecure repositories remain
disabled. Source is downloaded without unpacking, building or installing it.
See the [APT source options](https://manpages.ubuntu.com/manpages/jammy/man8/apt-get.8.html).

Hosted builders can have PGDG's newer `libpq` preinstalled. The disposable native
workflow pins only `libpq5` and `libpq-dev` to Ubuntu's Jammy release, permits that
specific downgrade, and checks exact source availability before compiling. This
keeps PHP linked to libraries covered by the configured Ubuntu source indexes;
the runtime source collector still rejects unavailable or foreign source files.
See [APT preference priorities](https://manpages.ubuntu.com/manpages/jammy/man5/apt_preferences.5.html).

For every source package, the collector requires:

- Exactly one `.dsc` whose package/version matches the installed library record.
- Every file in that descriptor's `Checksums-Sha256`, with matching size and hash.
- The owning binary packages' copyright files and Ubuntu's common license texts.
- A source-only `.tar` containing the original descriptor/source filenames and
  license texts. Extracting this review archive preserves the names needed by
  source-package tools; the collector does not run those tools on its contents.

Archive members are regular files. The collector independently reopens its source
bundles and verifies their complete member inventory. After runtime packaging, it
also verifies that the final archived libraries and license texts match their
recorded SHA-256 values. A later library rewrite or missing license fails the
build before successful provenance can be emitted.

## Provenance and release preparation

Each Linux `*-provenance.json` includes `linuxSources` with its Ubuntu baseline,
library ownership, exact binary/source versions, package copyright records,
source download URLs/hashes, source bundles and passed verification checks.
The source bundles accompany the runtime in the native workflow artifact.

`scripts/linux-source-release.mjs` checks the mapping and bundle bytes during
release preparation. A Linux runtime without these verified records is rejected.
The release candidate retains the original provenance and names the source-only
assets by checksum. Its `source-inventory.json` distinguishes Ubuntu source bundles
from upstream tarballs and records their descriptors, original filenames and
license inventory. macOS retains its separately reviewed dependency-source pins.

The source collector and release helper only change build/output folders. The
desktop's signed shipping catalog and private signing keys are separate. Current
application downloads keep their own source/run evidence; a new runtime candidate
does not silently update existing projects or installed runtime versions.

## Verified development packages

On 4 November 2026 the Linux PHP
[8.4](https://github.com/Sakeerin/StackCabin/actions/runs/41796142648) and
[8.5](https://github.com/Sakeerin/StackCabin/actions/runs/41796146248),
[MariaDB](https://github.com/Sakeerin/StackCabin/actions/runs/41765946994) and
[PostgreSQL](https://github.com/Sakeerin/StackCabin/actions/runs/41765727571) producers
passed on Ubuntu 22.04 and 24.04. The four archives contain 139 library records,
with 42 source bundles covering 41 distinct Ubuntu source-package versions. The
same source package can have separate bundles for different binary-package notices.
Downloaded bundles, descriptor members, final libraries and license bytes were
independently verified again without executing the downloaded binaries.

The [combined Linux stack](https://github.com/Sakeerin/StackCabin/actions/runs/41798068081)
then passed concurrent web/database checks on both Ubuntu versions. The
[twelve-runtime candidate](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796)
retains eight previously reviewed macOS packages and the four new Linux packages.
It includes sixty unique source archives; all 108 checksum records passed in
hosted preparation and independent local assembly. Previous Linux inputs without
Ubuntu records fail the current release gate before creating an output folder.

The [small review artifact](https://github.com/Sakeerin/StackCabin/actions/runs/41803437796/artifacts/13308687671)
is 127,774 ZIP bytes. Its forty files passed all 39 evidence checksum records and
its retained manifest hash matches independent local assembly. It retains
source/provenance JSON, a pinned manifest hash and the full candidate ZIP receipt.
This lets reviewers inspect the mappings before downloading large source archives.
After publication, the read-only hosted verification workflow checks every public
asset against that retained manifest without credentials. Local integrity, hosted
integrity and production approval are recorded separately; see the
[review and hosted-byte checks](RELEASING.md#retain-the-review-pin-and-verify-hosted-bytes).

The unsigned [catalog handoff](RELEASING.md#prepare-the-unsigned-catalog-handoff)
keeps this same source inventory and manifest alongside the proposed complete
catalog. It preserves the signed base inventory and records the pending hosted
check. Only a fresh successful stream of every public asset can produce the hosted
handoff status; source/license review and production signing remain separate.

## Review still required

Inspect the recorded package/source mapping, included notices, bundled libraries,
distribution terms and any required build or installation information before
publication. Authentication and complete recorded files establish which bytes
were collected; they do not replace that review. Publish reviewed assets at
immutable HTTPS locations, check hosted bytes, then separately review/sign the
complete production catalog. Baseline VM acceptance and application signing remain
separate release gates. See [release preparation](RELEASING.md).
