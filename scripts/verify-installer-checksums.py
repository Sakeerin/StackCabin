"""Verify every distributed installer; tolerate only known legacy deb intermediates."""
import argparse
import hashlib
from pathlib import Path
import re


def verify(root, platform):
    root = Path(root).resolve(strict=True)
    records = set()
    counts = {"windows": 0, "deb": 0, "appimage": 0, "macos": 0}
    for line in (root / "SHA256SUMS.txt").read_text(encoding="utf-8-sig").splitlines():
        if not line:
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](.+)", line)
        if not match:
            raise RuntimeError("Invalid installer checksum record")
        checksum, relative = match.groups()
        if relative.startswith("/") or "\\" in relative or ":" in relative or any(part in (".", "..", "") for part in relative.split("/")):
            raise RuntimeError(f"Unsafe installer checksum path: {relative}")
        if relative in records:
            raise RuntimeError(f"Duplicate installer record: {relative}")
        records.add(relative)
        if re.fullmatch(r"deb/[^/]+/(?:control|data)\.tar\.gz", relative):
            # Older checksum generators included Tauri's unpacked deb staging.
            # These are never distributed; actual deb/AppImage files remain mandatory.
            continue
        patterns = {"windows": r"nsis/[^/\\:]+\.exe", "deb": r"deb/[^/\\:]+\.deb",
                    "appimage": r"appimage/[^/\\:]+\.AppImage", "macos": r"dmg/[^/\\:]+\.dmg"}
        kind = next((kind for kind, pattern in patterns.items() if re.fullmatch(pattern, relative, re.IGNORECASE)), None)
        if not kind:
            raise RuntimeError(f"Unexpected installer record: {relative}")
        file = root / relative
        if not file.resolve().is_relative_to(root) or not file.is_file():
            raise RuntimeError(f"Missing or unsafe distributed installer: {relative}")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != checksum.lower():
                raise RuntimeError(f"Installer checksum mismatch: {relative}")
        counts[kind] += 1
        print(f"PASS SHA-256 {relative}")
    required = {"windows": ["windows"], "linux": ["deb", "appimage"], "macos": ["macos"]}[platform]
    if any(counts[kind] != 1 for kind in required) or any(value for kind, value in counts.items() if kind not in required):
        raise RuntimeError(f"Expected exactly the distributed {platform} installers: {counts}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--platform", type=str.lower, choices=["windows", "linux", "macos"], required=True)
    args = parser.parse_args()
    verify(args.root, args.platform)
