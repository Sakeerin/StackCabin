"""Start the normal packaged executable with disposable metadata, without E2E IPC."""
import argparse
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tempfile
import time


def verify(application):
    application = Path(application).resolve(strict=True)
    if not application.is_file():
        raise RuntimeError("An executable file is required")
    with tempfile.TemporaryDirectory(prefix="stackcabin packaged ทดสอบ ") as directory:
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
                        with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as connection:
                            ready = (connection.execute("PRAGMA user_version").fetchone()[0] == 1
                                     and connection.execute("SELECT count(*) FROM projects").fetchone()[0] == 0
                                     and connection.execute("SELECT count(*) FROM sqlite_master WHERE name='settings'").fetchone()[0] == 1)
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
            print("PASS normal packaged application remains alive and initializes real SQLite metadata in a Unicode/spaced directory")
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            child.communicate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("application")
    verify(parser.parse_args().application)
