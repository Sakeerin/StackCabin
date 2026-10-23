"""Compile MariaDB's OpenSSL, zlib and PCRE2 dependencies for macOS 14."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

from postgres_macos_dependencies import build as build_crypto

PCRE = {
    "name": "pcre2", "version": "10.49", "license": "BSD-3-Clause",
    "url": "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.49/pcre2-10.49.tar.bz2",
    "sha256": "53c156e1ba416a20da8e65395daa132da0d80e76910424caca3fcdae7831d384",
    "checksumUrl": "https://formulae.brew.sh/api/formula/pcre2.json",
}


def build(work, arch, unpack):
    provenance = build_crypto(work, arch, unpack, component="mariadb")
    prefix = work / "dependencies"
    archive = work / "pcre2-10.49.tar.bz2"
    with urllib.request.urlopen(PCRE["url"], timeout=120) as response, archive.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != PCRE["sha256"]:
            raise RuntimeError("PCRE2 publisher source SHA-256 mismatch")
    directory = work / "pcre2-source"
    directory.mkdir()
    source = unpack(archive, directory)
    target = directory / "build"
    environment = {**os.environ, "CMAKE_PREFIX_PATH": str(prefix)}

    def run(arguments):
        subprocess.run([str(value) for value in arguments], env=environment, check=True)

    run(["cmake", "-S", source, "-B", target, f"-DCMAKE_INSTALL_PREFIX={prefix}",
         f"-DCMAKE_INSTALL_NAME_DIR={prefix / 'lib'}", "-DCMAKE_MACOSX_RPATH=OFF",
         f"-DCMAKE_OSX_SYSROOT={environment['SDKROOT']}", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
         "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=ON", "-DPCRE2_BUILD_PCRE2_8=ON",
         "-DPCRE2_BUILD_PCRE2_16=OFF", "-DPCRE2_BUILD_PCRE2_32=OFF", "-DPCRE2_BUILD_TESTS=OFF",
         "-DPCRE2_BUILD_PCRE2GREP=OFF", "-DPCRE2_SUPPORT_JIT=ON"])
    run(["cmake", "--build", target, "--parallel", str(min(os.cpu_count() or 2, 4))])
    run(["cmake", "--install", target])
    os.environ.update(environment)
    output = Path("artifacts/runtimes").resolve()
    shutil.copy2(archive, output / ("mariadb-dependency-" + archive.name))
    provenance.append({**PCRE, "deploymentTarget": "14.0"})
    (output / "mariadb-dependency-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance
