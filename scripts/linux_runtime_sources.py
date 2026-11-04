"""Record Ubuntu library ownership and archive exact authenticated source packages.

Only the disposable native builder calls APT. No source is unpacked or executed.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
from email.parser import Parser
from urllib.parse import urlparse


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def describe(file, **extra):
    file = Path(file)
    if not file.is_file() or file.is_symlink():
        raise RuntimeError(f"Expected a regular source file: {file}")
    return {"name": file.name, "size": file.stat().st_size, "sha256": digest(file), **extra}


def command(arguments, cwd=None):
    return subprocess.check_output(arguments, cwd=cwd, text=True, timeout=600,
                                   env={**os.environ, "LC_ALL": "C", "LANG": "C"})


def owner(file, execute=command):
    file = Path(file).resolve(strict=True)
    candidates = [file]
    if str(file).startswith("/usr/lib/"):
        candidates.append(Path(str(file).removeprefix("/usr")))
    if str(file).startswith("/lib/"):
        candidates.append(Path("/usr" + str(file)))
    for candidate in candidates:
        try:
            lines = execute(["dpkg-query", "--search", str(candidate)]).splitlines()
        except subprocess.CalledProcessError:
            continue
        matches = [line.rsplit(": ", 1)[0] for line in lines
                   if ": " in line and line.rsplit(": ", 1)[1] == str(candidate)]
        if len(matches) != 1:
            raise RuntimeError(f"Ambiguous Ubuntu ownership: {file}")
        fields = execute(["dpkg-query", "--show", "--showformat=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\t${db:Status-Status}\n", matches[0]]).strip().split("\t")
        if len(fields) != 6 or fields[5] != "installed" or not all(fields[:5]):
            raise RuntimeError(f"Incomplete installed package identity: {file}")
        binary, version, source, source_version, arch, _ = fields
        if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?", binary) or not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", source):
            raise RuntimeError("Unsafe Ubuntu package identity")
        if not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]*", source_version):
            raise RuntimeError("Unsafe Ubuntu source version")
        return {"binaryPackage": binary, "binaryVersion": version, "sourcePackage": source,
                "sourceVersion": source_version, "architecture": arch}
    raise RuntimeError(f"Unowned external Linux library: {file}")


def safe_name(name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+._~-]*", name) or name in (".", ".."):
        raise RuntimeError(f"Unsafe source filename: {name}")
    return name


def source_uris(output):
    result = {}
    for line in output.splitlines():
        if not line.startswith("'"):
            continue
        fields = shlex.split(line)
        if len(fields) < 3:
            raise RuntimeError("Incomplete APT source URI")
        url, name, size = fields[:3]
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("archive.ubuntu.com", "security.ubuntu.com") or parsed.username or parsed.password:
            raise RuntimeError("Source URI must use the configured official Ubuntu HTTPS archive")
        safe_name(name)
        if name in result or not size.isdecimal() or int(size) <= 0:
            raise RuntimeError("Duplicate/invalid APT source entry")
        result[name] = {"url": url, "size": int(size)}
    if not result:
        raise RuntimeError("APT returned no exact source files; enable authenticated deb-src indexes")
    return result


def dsc_files(content, package, version):
    text = content.decode("utf8")
    if text.startswith("-----BEGIN PGP SIGNED MESSAGE-----"):
        text = text.split("\n\n", 1)[1].split("\n-----BEGIN PGP SIGNATURE-----", 1)[0]
        text = re.sub(r"(?m)^- ", "", text)
    control = Parser().parsestr(text)
    for field, expected in (("Source", package), ("Version", version)):
        if control.get_all(field) != [expected]:
            raise RuntimeError(f"Source descriptor identity mismatch: {package}={version}")
    if len(control.get_all("Checksums-Sha256", [])) != 1:
        raise RuntimeError("Source descriptor requires one SHA-256 inventory")
    result = {}
    for line in control["Checksums-Sha256"].splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 3 or not re.fullmatch(r"[a-f0-9]{64}", fields[0]) or not fields[1].isdecimal():
            raise RuntimeError("Invalid descriptor SHA-256 entry")
        sha256, size, name = fields
        safe_name(name)
        if name in result:
            raise RuntimeError("Duplicate source descriptor member")
        result[name] = {"sha256": sha256, "size": int(size)}
    if not result:
        raise RuntimeError("Empty source descriptor inventory")
    return result


def download_source(package, version, directory, execute=command):
    directory.mkdir()
    arguments = ["apt-get", "-o", "APT::Get::AllowUnauthenticated=false", "-o",
                 "Acquire::AllowInsecureRepositories=false", "-o",
                 "Acquire::AllowDowngradeToInsecureRepositories=false", "--download-only",
                 "--only-source", "source", f"{package}={version}"]
    uris = source_uris(execute([*arguments[:1], "--print-uris", *arguments[1:]], cwd=directory))
    execute(arguments, cwd=directory)
    descriptors = [name for name in uris if name.endswith(".dsc")]
    if len(descriptors) != 1 or {entry.name for entry in directory.iterdir()} != set(uris):
        raise RuntimeError("APT download does not match its source inventory")
    descriptor = directory / descriptors[0]
    expected = dsc_files(descriptor.read_bytes(), package, version)
    if set(expected) != set(uris) - {descriptor.name}:
        raise RuntimeError("Incomplete corresponding source files")
    files = []
    for name, transport in sorted(uris.items()):
        record = describe(directory / name, url=transport["url"])
        if record["size"] != transport["size"] or (name in expected and
                (record["sha256"] != expected[name]["sha256"] or record["size"] != expected[name]["size"])):
            raise RuntimeError(f"Ubuntu source checksum/size mismatch: {name}")
        files.append(record)
    return files, next(file for file in files if file["name"] == descriptor.name)


def write_bundle(destination, members):
    with tarfile.open(destination, "w", format=tarfile.PAX_FORMAT) as archive:
        for name, file in sorted(members.items()):
            info = tarfile.TarInfo(name)
            info.size = file.stat().st_size
            info.mode = 0o644
            with file.open("rb") as stream:
                archive.addfile(info, stream)


def verify_bundles(folder, proof):
    for package in proof["packages"]:
        bundle = package["bundle"]
        file = Path(folder) / safe_name(bundle["file"])
        if describe(file)["sha256"] != bundle["sha256"] or file.stat().st_size != bundle["size"]:
            raise RuntimeError("Linux source bundle checksum mismatch")
        records = {item["name"]: item for item in package["files"]}
        expected = {**records, **{item["name"]: item for item in package["licenses"]}}
        with tarfile.open(file, "r:") as archive:
            members = archive.getmembers()
            if len(members) != len(expected) or {item.name for item in members} != set(expected):
                raise RuntimeError("Source bundle member inventory mismatch")
            for member in members:
                record = expected[member.name]
                if not member.isfile() or member.size != record["size"]:
                    raise RuntimeError("Unexpected source bundle member")
                with archive.extractfile(member) as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != record["sha256"]:
                        raise RuntimeError("Source bundle member checksum mismatch")
            descriptor = package["descriptor"]
            with archive.extractfile(descriptor["name"]) as stream:
                inventory = dsc_files(stream.read(), package["name"], package["version"])
            if set(inventory) != set(records) - {descriptor["name"]}:
                raise RuntimeError("Source bundle descriptor closure mismatch")
            for name, record in inventory.items():
                if any(record[key] != records[name][key] for key in ("size", "sha256")):
                    raise RuntimeError("Source bundle descriptor checksum mismatch")


def collect(prefix, output, work, component, origins, execute=command,
            doc_root=Path("/usr/share/doc"), common_root=Path("/usr/share/common-licenses"),
            distribution_version=None):
    if distribution_version is None:
        release = os.freedesktop_os_release()
        if release.get("ID") != "ubuntu":
            raise RuntimeError("Portable Linux source packages require Ubuntu 22.04")
        distribution_version = release.get("VERSION_ID")
    if distribution_version != "22.04":
        raise RuntimeError("Portable Linux source packages require Ubuntu 22.04")
    prefix, output, work = Path(prefix), Path(output), Path(work)
    libraries, packages = [], {}
    common = []
    for file in sorted(common_root.iterdir()):
        if file.is_file():
            target = prefix / "share/licenses/ubuntu/common" / safe_name(file.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
            common.append({**describe(target), "path": target.relative_to(prefix).as_posix()})
    for target, original in sorted(origins.items(), key=lambda item: str(item[0])):
        identity = owner(original, execute)
        record = {**identity, "path": Path(target).relative_to(prefix).as_posix(), "sha256": digest(target)}
        binary = identity["binaryPackage"].split(":")[0]
        copyright_file = doc_root / binary / "copyright"
        if not copyright_file.is_file():
            raise RuntimeError(f"Missing Ubuntu copyright file: {binary}")
        copyright_target = prefix / f"share/licenses/ubuntu/{binary}/copyright"
        copyright_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(copyright_file, copyright_target)
        record["copyright"] = {**describe(copyright_target), "path": copyright_target.relative_to(prefix).as_posix()}
        libraries.append(record)
        key = (identity["sourcePackage"], identity["sourceVersion"])
        packages.setdefault(key, {})[identity["binaryPackage"]] = copyright_target
    if not libraries or not common:
        raise RuntimeError("A Linux runtime requires library provenance and common license texts")
    source_packages = []
    for (name, version), binaries in sorted(packages.items()):
        identifier = hashlib.sha256(f"{name}={version}".encode()).hexdigest()[:24]
        directory = work / f"ubuntu-source-{identifier}"
        files, descriptor = download_source(name, version, directory, execute)
        members = {item["name"]: directory / item["name"] for item in files}
        license_records = []
        for binary, file in sorted(binaries.items()):
            member = f"licenses/{binary.split(':')[0]}/copyright"
            members[member] = file
            license_records.append({**describe(file), "name": member})
        for item in common:
            member = f"licenses/common/{item['name']}"
            members[member] = prefix / item["path"]
            license_records.append({"name": member, "sha256": item["sha256"], "size": item["size"]})
        destination = output / f"{component}-linux-source-{identifier}.tar"
        write_bundle(destination, members)
        source_packages.append({"name": name, "version": version, "binaryPackages": sorted(binaries),
                                "files": files, "descriptor": descriptor, "licenses": license_records,
                                "bundle": {"file": destination.name, "size": destination.stat().st_size,
                                           "sha256": digest(destination)}})
    proof = {"schemaVersion": 1, "distribution": "ubuntu", "distributionVersion": distribution_version, "libraries": libraries,
             "commonLicenses": common, "packages": source_packages}
    verify_bundles(output, proof)
    return proof


def verify_runtime(archive, proof):
    expected = {entry["path"]: entry["sha256"] for entry in proof["libraries"]}
    expected.update({entry["copyright"]["path"]: entry["copyright"]["sha256"] for entry in proof["libraries"]})
    expected.update({entry["path"]: entry["sha256"] for entry in proof["commonLicenses"]})
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            relative = member.name.partition("/")[2]
            if relative not in expected:
                continue
            if relative in seen or not member.isfile():
                raise RuntimeError("Unexpected Linux provenance payload member")
            with bundle.extractfile(member) as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected[relative]:
                    raise RuntimeError("Linux runtime library/license checksum mismatch")
            seen.add(relative)
    if seen != set(expected):
        raise RuntimeError("Linux runtime omits a recorded library/license")
    proof["verification"] = {"result": "passed", "checks": ["exact Ubuntu source versions", "descriptor SHA-256 closure", "source bundle members", "packaged library and license bytes"]}


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory(prefix="stackcabin-source-probe-") as temporary:
        root = Path(temporary)
        for name in ("libstdc++.so.6", "libgcc_s.so.1"):
            identity = owner(Path("/lib/x86_64-linux-gnu") / name)
            source_uris(command(["apt-get", "--print-uris", "--download-only", "--only-source", "source",
                                 f"{identity['sourcePackage']}={identity['sourceVersion']}"], cwd=root))
        prefix, output = root / "prefix", root / "output"
        (prefix / "lib").mkdir(parents=True)
        output.mkdir()
        library = Path("/lib/x86_64-linux-gnu/libz.so.1").resolve(strict=True)
        target = prefix / "lib/libz.so.1"
        shutil.copyfile(library, target)
        proof = collect(prefix, output, root, "probe", {target: library})
        print(json.dumps({"sourceProbe": "passed", "packages": len(proof["packages"])}))
