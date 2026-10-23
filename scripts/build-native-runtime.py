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
    return next(p for p in destination.iterdir() if p.is_dir())


def bundle_libraries(prefix, system):
    """Copy non-system dependencies and rewrite loader paths after relocation."""
    lib = prefix / "lib"
    lib.mkdir(exist_ok=True)
    queue = [p for p in prefix.rglob("*") if p.is_file() and (os.access(p, os.X_OK) or ".so" in p.name or p.suffix == ".dylib")]
    visited = set()
    while queue:
        binary = queue.pop()
        if binary in visited:
            continue
        visited.add(binary)
        if system == "macos":
            try:
                dependencies = [line.strip().split(" (", 1)[0] for line in output(["otool", "-L", str(binary)]).splitlines()[1:]]
            except subprocess.CalledProcessError:
                continue
            binary.chmod(binary.stat().st_mode | 0o200)
            for dependency in dependencies:
                if dependency.startswith(("/usr/lib/", "/System/", "@")):
                    continue
                original = Path(dependency)
                if not original.is_file() or original == binary:
                    continue
                copied = lib / original.name
                if copied.resolve() != original.resolve() and not copied.exists():
                    shutil.copy2(original.resolve(), copied)
                    queue.append(copied)
                relative = os.path.relpath(copied, binary.parent)
                run(["install_name_tool", "-change", dependency, f"@loader_path/{relative}", binary])
            if binary.suffix == ".dylib":
                run(["install_name_tool", "-id", f"@rpath/{binary.name}", binary])
            run(["codesign", "--force", "--sign", "-", binary])
        else:
            try:
                dependencies = output(["ldd", str(binary)])
            except subprocess.CalledProcessError:
                continue
            for soname, source in re.findall(r"\s*(\S+) => (/\S+)", dependencies):
                if re.match(r"^(libc|libm|libpthread|libdl|librt|ld-linux|libresolv)\.so", soname):
                    continue
                copied = lib / soname
                if not copied.exists():
                    shutil.copy2(Path(source).resolve(), copied)
                    queue.append(copied)
            relative = os.path.relpath(lib, binary.parent)
            run(["patchelf", "--set-rpath", f"$ORIGIN/{relative}:$ORIGIN", binary])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", choices=["php", "mariadb", "postgres"], required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--release-base-url", required=True)
    parser.add_argument("--work", default=".local/native-build")
    args = parser.parse_args()
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
    source_dir = work / "source"
    source_dir.mkdir()
    source = unpack(archive, source_dir)
    prefix = work / "prefix"
    jobs = str(min(os.cpu_count() or 2, 4))
    if args.component == "php":
        flags = ["--enable-fpm", "--enable-mbstring", "--enable-intl", "--enable-bcmath", "--enable-exif", "--enable-opcache", "--enable-gd", "--with-jpeg", "--with-freetype", "--with-curl", "--with-openssl", "--with-sodium", "--with-zip", "--with-zlib", "--with-pdo-mysql=mysqlnd", "--with-mysqli=mysqlnd", "--with-pdo-pgsql", "--with-pgsql", "--with-pdo-sqlite", "--with-sqlite3"]
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
        run(["cmake", "-S", source, "-B", build, f"-DCMAKE_INSTALL_PREFIX={prefix}", "-DINSTALL_LAYOUT=STANDALONE", "-DCMAKE_BUILD_TYPE=Release", "-DWITH_SSL=system", "-DWITH_UNIT_TESTS=OFF", "-DWITH_EMBEDDED_SERVER=OFF", "-DWITH_WSREP=OFF", "-DPLUGIN_ROCKSDB=NO", "-DWITH_NUMA=OFF"])
        run(["cmake", "--build", build, "--parallel", jobs])
        run(["cmake", "--install", build])
        executables = {tool: f"bin/{tool}" for tool in ["mariadbd", "mariadb", "mariadb-dump"]}
        executables["install-db"] = "scripts/mariadb-install-db"
        license_name = "GPL-2.0-only"
    bundle_libraries(prefix, system)
    for relative in executables.values():
        if not (prefix / relative).is_file():
            raise RuntimeError(f"Missing executable: {relative}")
    if args.component == "php":
        run([prefix / "bin/php", "-v"])
        modules = output([str(prefix / "bin/php"), "-m"])
        for required in ["curl", "mbstring", "intl", "pdo_mysql", "pdo_pgsql", "pdo_sqlite", "zip", "sodium", "gd", "bcmath"]:
            if required not in modules:
                raise RuntimeError(f"Missing PHP extension: {required}")
    output_dir = Path("artifacts/runtimes").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    package = output_dir / f"{identifier}.tar.gz"
    # Dereference links so the runtime installer never needs to trust archive symlinks.
    with tarfile.open(package, "w:gz", dereference=True) as bundle:
        bundle.add(prefix, arcname=identifier)
    digest = hashlib.file_digest(package.open("rb"), "sha256").hexdigest()
    metadata = {"id": identifier, "component": args.component, "version": args.version, "platform": system, "arch": arch, "url": f"{args.release_base_url.rstrip('/')}/{package.name}", "sha256": digest, "archive": "tar.gz", "stripComponents": 1, "executables": executables, "license": license_name, "sourceUrl": args.source_url, "size": package.stat().st_size}
    (output_dir / f"{identifier}.json").write_text(json.dumps(metadata, indent=2) + "\n")
    shutil.copy2(archive, output_dir / f"{identifier}-source.tar.gz")
    (output_dir / f"{identifier}-provenance.json").write_text(json.dumps({"sourceUrl": args.source_url, "sourceSha256": args.source_sha256, "platform": platform.platform()}, indent=2) + "\n")
    print(package)


if __name__ == "__main__":
    main()
