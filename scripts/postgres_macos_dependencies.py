"""Build PostgreSQL's non-system libraries for macOS 14 from pinned sources."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request


SOURCES = [
    {"name": "openssl", "version": "3.5.9", "license": "Apache-2.0",
     "url": "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
     "checksumUrl": "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz.sha256",
     "sha256": "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"},
    {"name": "zlib", "version": "1.3.2", "license": "Zlib",
     "url": "https://zlib.net/zlib-1.3.2.tar.gz",
     "checksumUrl": "https://formulae.brew.sh/api/formula/zlib.json",
     "sha256": "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"},
]


def build(work, arch, unpack, component="postgres"):
    prefix = work / "dependencies"
    environment = dict(os.environ)
    for key in ["CPPFLAGS", "CFLAGS", "CXXFLAGS", "LDFLAGS", "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "CMAKE_PREFIX_PATH"]:
        environment.pop(key, None)
    # Do not inherit Homebrew library flags: those bottles can require macOS 15.
    environment.update({"MACOSX_DEPLOYMENT_TARGET": "14.0",
                        "CFLAGS": "-O2 -mmacosx-version-min=14.0",
                        "CXXFLAGS": "-O2 -mmacosx-version-min=14.0"})
    jobs = str(min(os.cpu_count() or 2, 4))
    provenance = []
    output = Path("artifacts/runtimes").resolve()
    output.mkdir(parents=True, exist_ok=True)

    def run(arguments, source):
        subprocess.run([str(value) for value in arguments], cwd=source, env=environment, check=True)

    for dependency in SOURCES:
        archive = work / f"{dependency['name']}-{dependency['version']}-source.tar.gz"
        with urllib.request.urlopen(dependency["url"], timeout=120) as response, archive.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        with archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != dependency["sha256"]:
                raise RuntimeError(f"Dependency source SHA-256 mismatch: {dependency['name']}")
        target = work / (dependency["name"] + "-source")
        target.mkdir()
        source = unpack(archive, target)
        if dependency["name"] == "openssl":
            platform = "darwin64-arm64-cc" if arch == "arm64" else "darwin64-x86_64-cc"
            run(["perl", source / "Configure", platform, "shared", "no-tests", f"--prefix={prefix}",
                 "--libdir=lib", f"--openssldir={prefix / 'ssl'}"], source)
            run(["make", "-j", jobs], source)
            run(["make", "install_sw"], source)
        else:
            run([source / "configure", f"--prefix={prefix}", "--shared"], source)
            run(["make", "-j", jobs], source)
            run(["make", "install"], source)
        shutil.copy2(archive, output / (component + "-dependency-" + archive.name))
        provenance.append({**dependency, "deploymentTarget": "14.0"})
    environment.update({"CPPFLAGS": f"-I{prefix / 'include'}",
                        "LDFLAGS": f"-L{prefix / 'lib'} -mmacosx-version-min=14.0",
                        "PKG_CONFIG_PATH": str(prefix / "lib/pkgconfig"),
                        "PKG_CONFIG_LIBDIR": str(prefix / "lib/pkgconfig")})
    os.environ.update(environment)
    # os.environ.update does not remove the old values that were intentionally dropped.
    os.environ.pop("CMAKE_PREFIX_PATH", None)
    (output / (component + "-dependency-provenance.json")).write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance
