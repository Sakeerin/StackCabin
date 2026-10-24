"""Start the normal packaged executable with disposable metadata, without E2E IPC."""
import argparse
from contextlib import closing, nullcontext
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import time


def metadata(path):
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as connection:
        return {
            "schema": connection.execute("PRAGMA user_version").fetchone()[0],
            "projects": connection.execute("SELECT id,path,payload FROM projects ORDER BY id").fetchall(),
            "settings": connection.execute("SELECT id,payload FROM settings ORDER BY id").fetchall(),
        }


def verify(application, data_directory=None):
    application = Path(application).resolve(strict=True)
    if not application.is_file():
        raise RuntimeError("An executable file is required")
    existing = Path(data_directory).resolve(strict=True) if data_directory else None
    expected = metadata(existing / "stackcabin.sqlite") if existing else None
    if existing and (expected["schema"] != 1 or len(expected["projects"]) != 10 or not expected["settings"]):
        raise RuntimeError("An existing ten-project preservation fixture is required")
    context = nullcontext(str(existing)) if existing else tempfile.TemporaryDirectory(prefix="stackcabin packaged ทดสอบ ")
    with context as directory:
        environment = {**os.environ, "STACKCABIN_DATA_DIR": directory}
        child = subprocess.Popen([str(application)], env=environment,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        try:
            database = Path(directory) / "stackcabin.sqlite"
            deadline = time.monotonic() + 45
            ready = False
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    stdout, stderr = child.communicate()
                    raise RuntimeError(f"Packaged application exited: {child.returncode}\n"
                                       + (stdout + stderr).decode(errors="replace")[-6000:])
                if database.is_file():
                    try:
                        actual = metadata(database)
                        ready = actual == expected if expected else actual["schema"] == 1 and not actual["projects"]
                        if expected and not ready:
                            raise RuntimeError("Packaged application changed existing metadata during startup")
                    except sqlite3.Error:
                        pass  # The process may still be committing its initial migration.
                if ready:
                    break
                time.sleep(0.1)
            if not ready:
                raise RuntimeError("Packaged application did not initialize its SQLite metadata")
            time.sleep(2)
            if child.poll() is not None:
                raise RuntimeError("Packaged application exited after initialization")
            if expected and metadata(database) != expected:
                raise RuntimeError("Packaged application changed preserved metadata")
            print("PASS normal packaged application remains alive with "
                  + ("all existing project metadata and settings unchanged" if expected else "real SQLite metadata in a Unicode/spaced directory"))
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            child.communicate()
        if expected and metadata(database) != expected:
            raise RuntimeError("Packaged application changed metadata during shutdown")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("application")
    parser.add_argument("--data-directory", help="Existing native-smoke preservation fixture; never deleted")
    args = parser.parse_args()
    verify(args.application, args.data_directory)
