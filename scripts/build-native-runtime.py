"""Build relocatable Unix PHP/MariaDB/PostgreSQL packs from publisher sources.

The release workflow supplies a reviewed source URL and SHA-256. No package is
published or added to the application catalog by this script.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import urllib.request
from native_runtime_smoke import verify
from postgres_macos_dependencies import build as build_postgres_dependencies
from php_macos_dependencies import build as build_php_dependencies
from mariadb_macos_dependencies import build as build_mariadb_dependencies


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True)


def unpack(archive, destination):
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise RuntimeError("Unsafe source archive")
        source.extractall(destination, filter="data")
    roots = [p for p in destination.iterdir() if p.is_dir()]
    if len(roots) != 1:
        raise RuntimeError("Source archive must contain one top-level directory")
    return roots[0]


def binary_files(prefix):
    magic = {b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",
             b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe"}
    for file in prefix.rglob("*"):
        if file.is_file():
            with file.open("rb") as stream:
                if stream.read(4) in magic:
                    yield file


def resolve_macho_dependency(binary, origin, dependency, prefix, rpaths):
    if dependency.startswith("/"):
        return Path(dependency).resolve()
    if dependency.startswith("@loader_path/"):
        candidates = [origin.parent / dependency.removeprefix("@loader_path/"),
                      binary.parent / dependency.removeprefix("@loader_path/")]
    elif dependency.startswith("@executable_path/"):
        tail = dependency.removeprefix("@executable_path/")
        candidates = [origin.parent / tail, prefix / "bin" / tail, prefix / "sbin" / tail]
    elif dependency.startswith("@rpath/"):
        tail = dependency.removeprefix("@rpath/")
        candidates = []
        for rpath in rpaths:
            expanded = rpath.replace("@loader_path", str(origin.parent)).replace("@executable_path", str(origin.parent))
            candidates.append(Path(expanded) / tail)
        candidates.extend(prefix.rglob(Path(tail).name))
        candidates.append(prefix.parent / "dependencies/lib" / Path(tail).name)
    elif Path(dependency).name == dependency and not dependency.startswith("."):
        # ICU source builds can use a bare dylib name for their install ID.
        candidates = [origin.parent / dependency, binary.parent / dependency,
                      prefix / "lib" / dependency, prefix.parent / "dependencies/lib" / dependency]
    else:
        raise RuntimeError(f"Unsupported Mach-O dependency: {dependency}")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(f"Unresolved Mach-O dependency {dependency} from {binary}")


def bundle_libraries(prefix, system):
    """Copy non-system dependencies and rewrite loader paths after relocation."""
    lib = prefix / "lib"
    lib.mkdir(exist_ok=True)
    queue = list(binary_files(prefix))
    origins = {p: p for p in queue}
    visited = set()
    while queue:
        binary = queue.pop()
        if binary.resolve() in visited:
            continue
        visited.add(binary.resolve())
        if system == "macos":
            dependencies = [line.strip().split(" (", 1)[0] for line in output(["otool", "-L", str(binary)]).splitlines()[1:]]
            rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", output(["otool", "-l", str(binary)]))
            origin = origins.get(binary, binary)
            binary.chmod(binary.stat().st_mode | 0o200)
            for dependency in dependencies:
                if dependency.startswith(("/usr/lib/", "/System/")):
                    continue
                original = resolve_macho_dependency(binary, origin, dependency, prefix, rpaths)
                if original == origin.resolve():
                    continue
                copied = original if original.is_relative_to(prefix) else lib / original.name
                if copied.resolve() != original.resolve() and not copied.exists():
                    shutil.copy2(original.resolve(), copied)
                    origins[copied] = original
                    queue.append(copied)
                elif copied.exists() and copied.resolve() != original.resolve():
                    previous = origins.get(copied, copied)
                    if hashlib.file_digest(previous.open("rb"), "sha256").hexdigest() != hashlib.file_digest(original.open("rb"), "sha256").hexdigest():
                        raise RuntimeError(f"Conflicting bundled libraries: {copied.name}")
                relative = os.path.relpath(copied, binary.parent)
                run(["install_name_tool", "-change", dependency, f"@loader_path/{relative}", binary])
            if binary.suffix in (".dylib", ".so"):
                run(["install_name_tool", "-id", f"@rpath/{binary.name}", binary])
            run(["codesign", "--force", "--sign", "-", binary])
        else:
            try:
                dependencies = output(["ldd", str(binary)])
            except subprocess.CalledProcessError:
                continue
            if "=> not found" in dependencies:
                raise RuntimeError(f"Unresolved ELF dependencies:\n{dependencies}")
            for soname, source in re.findall(r"\s*(\S+) => (/\S+)", dependencies):
                if re.match(r"^(libc|libm|libpthread|libdl|librt|ld-linux|libresolv)\.so", soname):
                    continue
                copied = lib / soname
                if not copied.exists():
                    shutil.copy2(Path(source).resolve(), copied)
                    queue.append(copied)
            relative = os.path.relpath(lib, binary.parent)
            run(["patchelf", "--set-rpath", f"$ORIGIN/{relative}:$ORIGIN", binary])


def minimum_macos(prefix, maximum=None):
    versions = []
    unsupported = []
    ceiling = tuple(map(int, (maximum or "0").split(".")))
    ceiling += (0,) * (3 - len(ceiling))
    for binary in binary_files(prefix):
        commands = output(["otool", "-l", binary])
        values = re.findall(r"\bminos (\d+(?:\.\d+)+)", commands)
        values += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)+)", commands)
        for value in values:
            version = tuple(map(int, value.split(".")))
            versions.append(version)
            normalized = version + (0,) * (3 - len(version))
            if maximum and normalized > ceiling:
                unsupported.append(f"{binary.relative_to(prefix)} requires {value}")
    if unsupported:
        raise RuntimeError(f"Native package exceeds macOS {maximum} baseline:\n" + "\n".join(unsupported))
    return ".".join(map(str, max(versions))) if versions else None


def strip_runtime_symbols(prefix, system):
    """Remove build debug information, then restore macOS code signatures."""
    for binary in binary_files(prefix):
        binary.chmod(binary.stat().st_mode | 0o200)
        if system == "macos":
            run(["strip", "-x", binary])
            run(["codesign", "--force", "--sign", "-", binary])
        else:
            run(["strip", "--strip-unneeded", binary])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", choices=["php", "mariadb", "postgres"], required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--release-base-url", required=True)
    parser.add_argument("--work", default=".local/native-build")
    args = parser.parse_args()
    if platform.system() not in ("Darwin", "Linux"):
        raise RuntimeError("Native source packages must be built on macOS or Linux")
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", args.version):
        raise RuntimeError("Use an exact numeric publisher version")
    if not re.fullmatch(r"[0-9a-f]{64}", args.source_sha256):
        raise RuntimeError("A reviewed publisher SHA-256 is required")
    if not args.source_url.startswith("https://") or not args.release_base_url.startswith("https://"):
        raise RuntimeError("HTTPS source and release URLs required")
    system = "macos" if platform.system() == "Darwin" else "linux"
    arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"
    identifier = f"{args.component}-{args.version}-{system}-{arch}"
    work = (Path(args.work) / identifier).resolve()
    if work.exists():
        raise RuntimeError(f"Use a clean build directory: {work}")
    work.mkdir(parents=True)
    archive = work / "source.tar.gz"
    with urllib.request.urlopen(args.source_url, timeout=120) as response, archive.open("wb") as file:
        shutil.copyfileobj(response, file)
    if hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != args.source_sha256:
        raise RuntimeError("Publisher source SHA-256 mismatch")
    output_dir = Path("artifacts/runtimes").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    # Keep the corresponding publisher source with diagnostic candidates too.
    shutil.copy2(archive, output_dir / f"{identifier}-source.tar.gz")
    source_dir = work / "source"
    source_dir.mkdir()
    source = unpack(archive, source_dir)
    prefix = work / "prefix"
    jobs = str(min(os.cpu_count() or 2, 4))
    dependencies = []
    if system == "macos" and args.component == "postgres":
        dependencies = build_postgres_dependencies(work, arch, unpack)
    elif system == "macos" and args.component == "php":
        dependencies = build_php_dependencies(work, arch, unpack)
    elif system == "macos" and args.component == "mariadb":
        dependencies = build_mariadb_dependencies(work, arch, unpack)
    if args.component == "php":
        flags = ["--enable-fpm", "--enable-mbstring", "--enable-intl", "--enable-bcmath", "--enable-exif", "--enable-opcache", "--enable-gd", "--with-jpeg", "--with-freetype", "--with-curl", "--with-openssl", "--with-sodium", "--with-zip", "--with-zlib", "--with-pdo-mysql=mysqlnd", "--with-mysqli=mysqlnd", "--with-pdo-pgsql", "--with-pgsql", "--with-pdo-sqlite", "--with-sqlite3"]
        if system == "macos":
            flags.append(f"--with-iconv={work / 'dependencies'}")
            # Apple's resolver symbols are not part of libSystem when linking
            # against the isolated library prefix instead of Homebrew flags.
            os.environ["LIBS"] = (os.environ.get("LIBS", "") + " -lresolv").strip()
        run([source / "configure", f"--prefix={prefix}", *flags], cwd=source)
        run(["make", "-j", jobs], cwd=source)
        run(["make", "install"], cwd=source)
        executables = {"php": "bin/php", "php-fpm": "sbin/php-fpm"}
        license_name = "PHP-3.01"
    elif args.component == "postgres":
        run([source / "configure", f"--prefix={prefix}", "--with-openssl", "--without-icu", "--without-readline"], cwd=source)
        run(["make", "-j", jobs], cwd=source)
        run(["make", "install"], cwd=source)
        executables = {tool: f"bin/{tool}" for tool in ["postgres", "initdb", "psql", "pg_dump", "pg_ctl"]}
        license_name = "PostgreSQL"
    else:
        build = work / "build"
        flags = []
        if system == "macos":
            flags = [f"-DCMAKE_OSX_SYSROOT={os.environ['SDKROOT']}", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
                     f"-DCMAKE_PREFIX_PATH={work / 'dependencies'}", "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local",
                     f"-DOPENSSL_ROOT_DIR={work / 'dependencies'}", "-DWITH_PCRE=system"]
        run(["cmake", "-S", source, "-B", build, f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DINSTALL_LAYOUT=STANDALONE", "-DCMAKE_BUILD_TYPE=Release", "-DWITH_SSL=system", "-DWITH_UNIT_TESTS=OFF", "-DWITH_EMBEDDED_SERVER=OFF", "-DWITH_WSREP=OFF", "-DPLUGIN_ROCKSDB=NO", "-DPLUGIN_MROONGA=NO", "-DWITH_NUMA=OFF", *flags])
        run(["cmake", "--build", build, "--parallel", jobs])
        run(["cmake", "--install", build])
        executables = {tool: f"bin/{tool}" for tool in ["mariadbd", "mariadb", "mariadb-dump"]}
        executables["install-db"] = "scripts/mariadb-install-db"
        license_name = "GPL-2.0-only"
    bundle_libraries(prefix, system)
    strip_runtime_symbols(prefix, system)
    for relative in executables.values():
        if not (prefix / relative).is_file():
            raise RuntimeError(f"Missing executable: {relative}")
    if args.component == "php":
        run([prefix / "bin/php", "-v"])
        modules = output([str(prefix / "bin/php"), "-m"])
        for required in ["curl", "mbstring", "intl", "pdo_mysql", "pdo_pgsql", "pdo_sqlite", "zip", "sodium", "gd", "bcmath"]:
            if required not in modules:
                raise RuntimeError(f"Missing PHP extension: {required}")
    package = output_dir / f"{identifier}.tar.gz"
    # Dereference links so the runtime installer never needs to trust archive symlinks.
    with tarfile.open(package, "w:gz", dereference=True) as bundle:
        bundle.add(prefix, arcname=identifier)
    relocated = work / "relocated package ทดสอบ"
    relocated.mkdir()
    relocated_prefix = unpack(package, relocated)
    moved = []
    try:
        for original in [prefix, work / "dependencies"]:
            if original.exists():
                hidden = work / (original.name + "-hidden")
                original.rename(hidden)
                moved.append((original, hidden))
        verification = verify(relocated_prefix, args.component, args.version)
    finally:
        for original, hidden in reversed(moved):
            hidden.rename(original)
    digest = hashlib.file_digest(package.open("rb"), "sha256").hexdigest()
    metadata = {"id": identifier, "component": args.component, "version": args.version, "platform": system, "arch": arch, "url": f"{args.release_base_url.rstrip('/')}/{package.name}", "sha256": digest, "archive": "tar.gz", "stripComponents": 1, "executables": executables, "license": license_name, "sourceUrl": args.source_url, "size": package.stat().st_size}
    if system == "macos":
        metadata["minimumOsVersion"] = minimum_macos(relocated_prefix, maximum="14.0")
    (output_dir / f"{identifier}.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output_dir / f"{identifier}-provenance.json").write_text(json.dumps({"sourceUrl": args.source_url, "sourceSha256": args.source_sha256, "platform": platform.platform(), "verification": verification, "minimumOsVersion": metadata.get("minimumOsVersion"), "dependencies": dependencies}, indent=2) + "\n")
    print(package)


if __name__ == "__main__":
    main()
