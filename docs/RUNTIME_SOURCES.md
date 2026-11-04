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

## Review still required

Inspect the recorded package/source mapping, included notices, bundled libraries,
distribution terms and any required build or installation information before
publication. Authentication and complete recorded files establish which bytes
were collected; they do not replace that review. Publish reviewed assets at
immutable HTTPS locations, check hosted bytes, then separately review/sign the
complete production catalog. Baseline VM acceptance and application signing remain
separate release gates. See [release preparation](RELEASING.md).
