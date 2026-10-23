"""Compile PHP's required library closure with the macOS 14 deployment target."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.parse
import urllib.request

from postgres_macos_dependencies import build as build_crypto


def build(work, arch, unpack):
    provenance = build_crypto(work, arch, unpack, component="php")
    prefix = work / "dependencies"
    environment = dict(os.environ)
    environment.update({"PATH": str(prefix / "bin") + os.pathsep + environment["PATH"],
                        "CMAKE_PREFIX_PATH": str(prefix)})
    root = Path(__file__).resolve().parent.parent
    libraries = json.loads((root / "runtime-catalog/php-macos-library-sources.json").read_text())["libraries"]
    pg = next(source for source in json.loads((root / "runtime-catalog/source-archives.json").read_text())["sources"]
              if source["component"] == "postgres")
    libraries.append({"name": "libpq", "version": pg["version"], "license": "PostgreSQL",
                      "url": pg["sourceUrl"], "sha256": pg["sourceSha256"], "checksumUrl": pg["checksumUrl"]})
    output = Path("artifacts/runtimes").resolve()
    jobs = str(min(os.cpu_count() or 2, 4))

    def run(arguments, source):
        subprocess.run([str(value) for value in arguments], cwd=source, env=environment, check=True)

    cmake_flags = {
        "libxml2": ["-DLIBXML2_WITH_PYTHON=OFF", "-DLIBXML2_WITH_TESTS=OFF", "-DLIBXML2_WITH_LZMA=OFF", "-DLIBXML2_WITH_ICU=OFF"],
        "libpng": ["-DPNG_STATIC=OFF", "-DPNG_TESTS=OFF", "-DPNG_TOOLS=OFF", "-DPNG_FRAMEWORK=OFF"],
        "jpeg-turbo": ["-DENABLE_STATIC=OFF", "-DWITH_TURBOJPEG=OFF", "-DWITH_SIMD=OFF"],
        "freetype": ["-DFT_DISABLE_BZIP2=TRUE", "-DFT_DISABLE_BROTLI=TRUE", "-DFT_DISABLE_HARFBUZZ=TRUE"],
        "libzip": ["-DENABLE_COMMONCRYPTO=OFF", "-DENABLE_GNUTLS=OFF", "-DENABLE_MBEDTLS=OFF", "-DENABLE_OPENSSL=ON",
                   "-DENABLE_BZIP2=OFF", "-DENABLE_LZMA=OFF", "-DENABLE_ZSTD=OFF", "-DBUILD_TOOLS=OFF",
                   "-DBUILD_REGRESS=OFF", "-DBUILD_EXAMPLES=OFF", "-DBUILD_DOC=OFF"],
    }
    for dependency in libraries:
        # Preserve the publisher's archive suffix, including xz/bz2/tgz sources.
        filename = Path(urllib.parse.urlparse(dependency["url"]).path).name
        archive = work / filename
        with urllib.request.urlopen(dependency["url"], timeout=120) as response, archive.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        with archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != dependency["sha256"]:
                raise RuntimeError(f"PHP dependency source SHA-256 mismatch: {dependency['name']}")
        directory = work / (dependency["name"].replace("@", "-") + "-source")
        directory.mkdir()
        source = unpack(archive, directory)
        name = dependency["name"]
        if name in cmake_flags:
            target = directory / "build"
            run(["cmake", "-S", source, "-B", target, f"-DCMAKE_INSTALL_PREFIX={prefix}",
                 f"-DCMAKE_PREFIX_PATH={prefix}", f"-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local",
                 f"-DCMAKE_OSX_SYSROOT={environment['SDKROOT']}", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
                 f"-DCMAKE_INSTALL_NAME_DIR={prefix / 'lib'}", "-DCMAKE_MACOSX_RPATH=OFF",
                 "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=ON", *cmake_flags[name]], source)
            run(["cmake", "--build", target, "--parallel", jobs], source)
            run(["cmake", "--install", target], source)
        else:
            arguments = [f"--prefix={prefix}"]
            if name.startswith("icu4c"):
                source = source / "source"
                arguments += ["--disable-tests", "--disable-samples", "--disable-static"]
            elif name == "sqlite":
                arguments += ["--disable-readline", "--disable-static"]
            elif name == "libpq":
                arguments += ["--with-openssl", "--without-icu", "--without-readline"]
            elif name == "curl":
                arguments += [f"--with-openssl={prefix}", f"--with-zlib={prefix}", "--disable-static",
                              "--without-brotli", "--without-zstd", "--without-libpsl", "--without-libidn2",
                              "--without-libssh2", "--without-libssh", "--without-nghttp2", "--without-nghttp3",
                              "--without-ngtcp2", "--without-gssapi", "--disable-ldap", "--disable-ldaps"]
            else:
                arguments += ["--disable-static"]
            run([source / "configure", *arguments], source)
            run(["make", "-j", jobs], source)
            run(["make", "install"], source)
        if name.startswith("icu4c"):
            # ICU installs bare dylib IDs. PHP executes its CLI while building
            # phar, before the final relocatable bundle has been assembled.
            for library in sorted({p.resolve() for p in (prefix / "lib").glob("libicu*.dylib")}):
                dependencies = subprocess.check_output(["otool", "-L", str(library)], text=True)
                run(["install_name_tool", "-id", library, library], source)
                for line in dependencies.splitlines()[1:]:
                    dylib_reference = line.strip().split(" (", 1)[0]
                    if "/" not in dylib_reference and (prefix / "lib" / dylib_reference).is_file():
                        run(["install_name_tool", "-change", dylib_reference, prefix / "lib" / dylib_reference, library], source)
                run(["codesign", "--force", "--sign", "-", library], source)
        shutil.copy2(archive, output / ("php-dependency-" + filename))
        provenance.append({**dependency, "deploymentTarget": "14.0"})
    os.environ.update(environment)
    (output / "php-dependency-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    return provenance
