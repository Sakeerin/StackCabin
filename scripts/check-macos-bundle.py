"""Reject build-machine library dependencies and unsupported Mach-O baselines."""
import argparse
from pathlib import Path
import re
import subprocess


def check(bundle):
    bundle = Path(bundle).resolve(strict=True)
    executable_directory = bundle / "Contents/MacOS"
    magic = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe"}
    count = 0
    for binary in bundle.rglob("*"):
        if not binary.is_file():
            continue
        with binary.open("rb") as stream:
            if stream.read(4) not in magic:
                continue
        count += 1
        commands = subprocess.check_output(["otool", "-l", str(binary)], text=True)
        minimums = re.findall(r"\bminos (\d+(?:\.\d+)+)", commands)
        minimums += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)+)", commands)
        if not minimums or any(tuple(map(int, value.split("."))) > (14, 0, 0) for value in minimums):
            raise RuntimeError(f"Unsupported or unknown macOS baseline in {binary}: {minimums}")
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", commands)

        def expand(value):
            if value.startswith("@loader_path/"):
                return binary.parent / value.removeprefix("@loader_path/")
            if value.startswith("@executable_path/"):
                return executable_directory / value.removeprefix("@executable_path/")
            return Path(value)

        libraries = subprocess.check_output(["otool", "-L", str(binary)], text=True).splitlines()[1:]
        for line in libraries:
            library = line.strip().split(" (", 1)[0]
            if library.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if library.startswith("/"):
                raise RuntimeError(f"Absolute non-system dependency {library} in {binary}")
            candidates = ([expand(path) / library.removeprefix("@rpath/") for path in rpaths]
                          if library.startswith("@rpath/") else [expand(library)])
            if not any(path.resolve().is_relative_to(bundle) and path.is_file() for path in candidates):
                raise RuntimeError(f"Unbundled dependency {library} in {binary}")
    if not count:
        raise RuntimeError("No Mach-O binaries found in the application bundle")
    print(f"PASS {count} Mach-O binaries: macOS 14 baseline and no external non-system libraries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle")
    check(parser.parse_args().bundle)
