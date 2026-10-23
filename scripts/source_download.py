"""Download pinned build sources from explicit HTTPS origins and optional mirrors."""
import hashlib
import http.client
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request


def download_verified(urls, destination, sha256):
    destination = Path(destination)
    for url in urls:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("Explicit HTTPS source URLs without credentials are required")
    if not urls:
        raise ValueError("At least one source URL is required")
    partial = destination.with_name(destination.name + ".part")
    failure = None
    for url in urls:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=45) as response, partial.open("wb") as stream:
                    if urllib.parse.urlsplit(response.geturl()).scheme != "https":
                        raise RuntimeError("Source download redirected outside HTTPS")
                    shutil.copyfileobj(response, stream)
                with partial.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != sha256:
                        raise RuntimeError(f"Publisher source SHA-256 mismatch: {destination.name}")
                partial.replace(destination)
                return url
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as error:
                failure = error
                print(f"Source download unavailable: {url} (attempt {attempt + 1}/3)", flush=True)
                if attempt < 2:
                    time.sleep(2)
            finally:
                partial.unlink(missing_ok=True)
    raise RuntimeError(f"All explicit source locations failed for {destination.name}") from failure
