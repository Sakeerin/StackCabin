"""Start the normal packaged executable with disposable metadata, without E2E IPC."""
import argparse
import json
from contextlib import closing, nullcontext
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time


def metadata(path):
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as connection:
        return {
            "schema": connection.execute("PRAGMA user_version").fetchone()[0],
            "projects": connection.execute("SELECT id,path,payload FROM projects ORDER BY id").fetchall(),
            "settings": connection.execute("SELECT id,payload FROM settings ORDER BY id").fetchall(),
        }


def windows_metadata_handle(pid, database):
    """Query Restart Manager's file users; never request shutdown or restart."""
    import ctypes
    from ctypes import wintypes

    class UniqueProcess(ctypes.Structure):
        _fields_ = [("pid", wintypes.DWORD), ("started", wintypes.FILETIME)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [("process", UniqueProcess), ("name", wintypes.WCHAR * 256),
                    ("service", wintypes.WCHAR * 64), ("kind", ctypes.c_int),
                    ("status", wintypes.ULONG), ("session", wintypes.DWORD),
                    ("restartable", wintypes.BOOL)]

    manager = ctypes.WinDLL("Rstrtmgr.dll")
    manager.RmStartSession.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD, wintypes.LPWSTR]
    manager.RmRegisterResources.argtypes = [wintypes.DWORD, wintypes.UINT, ctypes.POINTER(wintypes.LPCWSTR),
                                          wintypes.UINT, ctypes.POINTER(UniqueProcess),
                                          wintypes.UINT, ctypes.POINTER(wintypes.LPCWSTR)]
    manager.RmGetList.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT),
                                 ctypes.POINTER(ProcessInfo), ctypes.POINTER(wintypes.DWORD)]
    manager.RmEndSession.argtypes = [wintypes.DWORD]
    for name in ("RmStartSession", "RmRegisterResources", "RmGetList", "RmEndSession"):
        getattr(manager, name).restype = wintypes.DWORD

    def check(error):
        if error:
            raise ctypes.WinError(error)

    session = wintypes.DWORD()
    check(manager.RmStartSession(ctypes.byref(session), 0, ctypes.create_unicode_buffer(33)))
    try:
        paths = (wintypes.LPCWSTR * 1)(str(database.resolve(strict=True)))
        check(manager.RmRegisterResources(session, 1, paths, 0, None, 0, None))
        processes = None
        for _ in range(3):
            needed = wintypes.UINT()
            count = wintypes.UINT(len(processes) if processes is not None else 0)
            reasons = wintypes.DWORD()
            error = manager.RmGetList(session, ctypes.byref(needed), ctypes.byref(count),
                                      processes, ctypes.byref(reasons))
            if error == 0:
                return any(processes[index].process.pid == pid for index in range(count.value))
            if error != 234:  # ERROR_MORE_DATA: the file's users may change during enumeration.
                check(error)
            processes = (ProcessInfo * needed.value)()
        raise RuntimeError("Windows metadata file users did not stabilize")
    finally:
        check(manager.RmEndSession(session))


def has_metadata_handle(pid, database):
    """Confirm the installed process opened this existing database inode."""
    if os.name == "nt":
        return windows_metadata_handle(pid, database)
    expected = database.stat()
    if sys.platform == "darwin":
        result = subprocess.run(
            ["/usr/sbin/lsof", "-a", "-p", str(pid), "-Fpi", "--", str(database)],
            capture_output=True, text=True, timeout=5, check=False,
        )
        fields = result.stdout.splitlines()
        return result.returncode == 0 and f"p{pid}" in fields and f"i{expected.st_ino}" in fields
    for descriptor in Path(f"/proc/{pid}/fd").iterdir():
        try:
            actual = descriptor.stat()
        except OSError:
            continue  # A transient descriptor may close during enumeration.
        if (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino):
            return True
    return False


def windows_data_access(directory):
    """Inspect handles/attributes with the caller's token; never write or repair files."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    kernel.GetFileAttributesW.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    result = []
    for path in [Path(directory), *(Path(directory) / name for name in
                  ("stackcabin.sqlite", "stackcabin.sqlite-wal", "stackcabin.sqlite-shm"))]:
        attributes = kernel.GetFileAttributesW(str(path))
        attribute_error = ctypes.get_last_error() if attributes == 0xFFFFFFFF else None
        handle = kernel.CreateFileW(str(path), 0x40000000, 7, None, 3, 0x02000000, None)
        failed = handle == wintypes.HANDLE(-1).value
        error = ctypes.get_last_error() if failed else None
        if not failed:
            kernel.CloseHandle(handle)
        result.append({"name": path.name, "attributes": attributes,
                       "attributeError": attribute_error, "writeHandle": not failed,
                       "writeHandleError": error})
    return result


def verify(application, data_directory=None, use_default_data_directory=False):
    application = Path(application).resolve(strict=True)
    if not application.is_file():
        raise RuntimeError("An executable file is required")
    existing = Path(data_directory).resolve(strict=True) if data_directory else None
    if use_default_data_directory and existing is None:
        raise RuntimeError("Default-path acceptance requires an existing preservation fixture")
    expected = metadata(existing / "stackcabin.sqlite") if existing else None
    if existing and (expected["schema"] != 1 or len(expected["projects"]) != 10 or not expected["settings"]):
        raise RuntimeError("An existing ten-project preservation fixture is required")
    context = nullcontext(str(existing)) if existing else tempfile.TemporaryDirectory(prefix="stackcabin packaged ทดสอบ ")
    with context as directory:
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() != "STACKCABIN_DATA_DIR"}
        if not use_default_data_directory:
            environment["STACKCABIN_DATA_DIR"] = directory
        launch = {"start_new_session": True}
        if os.name == "nt":
            hidden = subprocess.STARTUPINFO()
            hidden.dwFlags = subprocess.STARTF_USESHOWWINDOW
            hidden.wShowWindow = 0
            launch = {"startupinfo": hidden, "creationflags": subprocess.CREATE_NO_WINDOW}
        child = subprocess.Popen([str(application)], env=environment,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, **launch)
        try:
            database = Path(directory) / "stackcabin.sqlite"
            deadline = time.monotonic() + 45
            ready = False
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    stdout, stderr = child.communicate()
                    if os.name == "nt":
                        print("Metadata access diagnostics: " + json.dumps(windows_data_access(directory)), file=sys.stderr)
                    raise RuntimeError(f"Packaged application exited: {child.returncode}\n"
                                       + (stdout + stderr).decode(errors="replace")[-6000:])
                if database.is_file():
                    try:
                        actual = metadata(database)
                        ready = actual == expected if expected else actual["schema"] == 1 and not actual["projects"]
                        if expected and not ready:
                            raise RuntimeError("Packaged application changed existing metadata during startup")
                        if expected and ready:
                            ready = has_metadata_handle(child.pid, database)
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
            if expected and not has_metadata_handle(child.pid, database):
                raise RuntimeError("Packaged application released the preserved metadata connection")
            print("PASS normal packaged application remains alive with "
                  + ("all existing project metadata and settings unchanged" if expected else "real SQLite metadata in a Unicode/spaced directory"))
            if expected:
                print("PASS installed application process holds the existing metadata database open")
            if use_default_data_directory:
                print("PASS installed application uses the OS default data location without STACKCABIN_DATA_DIR")
        finally:
            if child.poll() is None:
                if os.name == "nt":
                    child.terminate()
                else:
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        child.kill()
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            child.communicate()
        if expected and metadata(database) != expected:
            raise RuntimeError("Packaged application changed metadata during shutdown")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("application")
    parser.add_argument("--data-directory", help="Existing native-smoke preservation fixture; never deleted")
    parser.add_argument("--use-default-data-directory", action="store_true",
                        help="Check the existing fixture without overriding the application's OS default path")
    args = parser.parse_args()
    verify(args.application, args.data_directory, args.use_default_data_directory)
