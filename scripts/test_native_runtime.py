import importlib.util
from contextlib import closing
import io
from pathlib import Path
import socket
import struct
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch
import hashlib
import os
import sqlite3
import sys
import urllib.error
from source_download import download_verified

import native_runtime_smoke as smoke

spec = importlib.util.spec_from_file_location("native_builder", Path(__file__).with_name("build-native-runtime.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
installer_spec = importlib.util.spec_from_file_location("installer_checksums", Path(__file__).with_name("verify-installer-checksums.py"))
installer_checksums = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installer_checksums)
packaged_spec = importlib.util.spec_from_file_location("packaged_smoke", Path(__file__).with_name("smoke-packaged-unix.py"))
packaged_smoke = importlib.util.module_from_spec(packaged_spec)
packaged_spec.loader.exec_module(packaged_smoke)


class PackagedMetadataTests(unittest.TestCase):
    def fixture(self, root, schema=1, count=10):
        database = root / "stackcabin.sqlite"
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript(f"PRAGMA user_version={schema}; CREATE TABLE projects(id,path,payload); CREATE TABLE settings(id,payload);")
            connection.executemany("INSERT INTO projects VALUES(?,?,?)", [(str(i), str(root / f"โปรเจกต์ {i}"), '{"trusted":true}') for i in range(count)])
            connection.execute("INSERT INTO settings VALUES(1,?)", ['{"language":"th","theme":"dark"}'])
            connection.commit()
        return database

    def test_existing_metadata_is_read_without_changing_unicode_paths_or_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            before = database.read_bytes()
            state = packaged_smoke.metadata(database)
            self.assertEqual(len(state["projects"]), 10)
            self.assertIn("โปรเจกต์", state["projects"][0][1])
            self.assertIn('"language":"th"', state["settings"][0][1])
            self.assertEqual(database.read_bytes(), before)

    def test_future_schema_is_never_launched_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory), schema=99)
            before = database.read_bytes()
            with patch.object(packaged_smoke.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(RuntimeError, "preservation fixture"):
                    packaged_smoke.verify(sys.executable, directory)
                launch.assert_not_called()
            self.assertEqual(database.read_bytes(), before)

    def test_incomplete_existing_fixture_is_never_reinitialized(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory), count=9)
            before = database.read_bytes()
            with patch.object(packaged_smoke.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(RuntimeError, "preservation fixture"):
                    packaged_smoke.verify(sys.executable, directory)
                launch.assert_not_called()
            self.assertEqual(database.read_bytes(), before)

    @unittest.skipIf(os.name == "nt", "Unix packaged process inspection")
    def test_a_real_open_database_handle_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))
            with closing(sqlite3.connect(database)):
                self.assertTrue(packaged_smoke.has_metadata_handle(os.getpid(), database))
            self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))

    @unittest.skipIf(os.name == "nt", "Unix packaged process inspection")
    def test_a_different_database_handle_does_not_prove_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            with closing(sqlite3.connect(Path(directory) / "different.sqlite")):
                self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))


class InstallerChecksumTests(unittest.TestCase):
    def fixtures(self, root):
        records = []
        for name in ["deb/StackCabin.deb", "appimage/StackCabin.AppImage"]:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(name.encode())
            records.append(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {name}")
        return records

    def test_legacy_staging_records_do_not_hide_required_installer_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.fixtures(root)
            records += ["0" * 64 + "  deb/StackCabin/control.tar.gz", "0" * 64 + "  deb/StackCabin/data.tar.gz"]
            (root / "SHA256SUMS.txt").write_text("\n".join(records))
            installer_checksums.verify(root, "linux")

    def test_a_missing_distributed_installer_is_never_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.fixtures(root)
            (root / "deb/StackCabin.deb").unlink()
            (root / "SHA256SUMS.txt").write_text("\n".join(records))
            with self.assertRaisesRegex(RuntimeError, "Missing"):
                installer_checksums.verify(root, "linux")

    def test_staging_only_manifests_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "SHA256SUMS.txt").write_text("0" * 64 + "  deb/StackCabin/data.tar.gz")
            with self.assertRaisesRegex(RuntimeError, "Expected exactly"):
                installer_checksums.verify(root, "linux")

    def test_a_changed_installer_fails_its_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.fixtures(root)
            (root / "deb/StackCabin.deb").write_bytes(b"modified")
            (root / "SHA256SUMS.txt").write_text("\n".join(records))
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                installer_checksums.verify(root, "linux")

    def test_checksum_paths_cannot_escape_the_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["../outside.exe", "deb/../data.tar.gz", "C:/outside.exe", "deb\\outside.deb"]:
                (root / "SHA256SUMS.txt").write_text("0" * 64 + "  " + name)
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    installer_checksums.verify(root, "linux")

    def test_duplicate_installer_records_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = self.fixtures(root)
            (root / "SHA256SUMS.txt").write_text("\n".join([*records, records[0]]))
            with self.assertRaisesRegex(RuntimeError, "Duplicate"):
                installer_checksums.verify(root, "linux")


class NativePackagingTests(unittest.TestCase):
    def test_source_download_uses_an_explicit_mirror_after_network_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            data = b"verified publisher source"
            response = io.BytesIO(data)
            response.geturl = lambda: "https://mirror.example/source"
            with patch("source_download.urllib.request.urlopen", side_effect=[
                urllib.error.URLError("temporary timeout"), urllib.error.URLError("temporary timeout"),
                urllib.error.URLError("temporary timeout"), response,
            ]) as request, patch("source_download.time.sleep"):
                target = Path(directory) / "source.tar.gz"
                selected = download_verified(["https://publisher.example/source", "https://mirror.example/source"],
                                             target, hashlib.sha256(data).hexdigest())
            self.assertEqual(selected, "https://mirror.example/source")
            self.assertEqual(request.call_args.args[0], selected)
            self.assertEqual(target.read_bytes(), data)
            self.assertFalse(target.with_name(target.name + ".part").exists())

    def test_source_checksum_failure_never_replaces_a_verified_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.tar.gz"
            target.write_bytes(b"previous verified source")
            response = io.BytesIO(b"tampered source")
            response.geturl = lambda: "https://publisher.example/source"
            with patch("source_download.urllib.request.urlopen", return_value=response) as request:
                with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                    download_verified([response.geturl()], target, hashlib.sha256(b"expected source").hexdigest())
            self.assertEqual(request.call_count, 1)
            self.assertEqual(target.read_bytes(), b"previous verified source")
            self.assertFalse(target.with_name(target.name + ".part").exists())

    def test_source_https_downgrade_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            response = io.BytesIO(b"source")
            response.geturl = lambda: "http://publisher.example/source"
            target = Path(directory) / "source.tar.gz"
            with patch("source_download.urllib.request.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                    download_verified(["https://publisher.example/source"], target, "0" * 64)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_name(target.name + ".part").exists())

    def test_source_credentials_are_rejected_before_network_access(self):
        with patch("source_download.urllib.request.urlopen") as request:
            with self.assertRaises(ValueError):
                download_verified(["https://secret@publisher.example/source"], Path("unused"), "0" * 64)
        request.assert_not_called()

    def archive(self, directory, name, content=b"source", link=None):
        file = directory / "source.tar.gz"
        with tarfile.open(file, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            if link:
                member.type, member.linkname = tarfile.SYMTYPE, link
            else:
                member.size = len(content)
            archive.addfile(member, None if link else io.BytesIO(content))
        return file

    def test_source_archive_keeps_unicode_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root, "source/ไฟล์ ทดสอบ.txt")
            target = root / "out"
            target.mkdir()
            extracted = builder.unpack(archive, target)
            self.assertEqual((extracted / "ไฟล์ ทดสอบ.txt").read_bytes(), b"source")

    def test_source_traversal_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root, "../escape.txt")
            target = root / "out"
            target.mkdir()
            with self.assertRaises(RuntimeError):
                builder.unpack(archive, target)
            self.assertFalse((root / "escape.txt").exists())

    def test_source_links_cannot_escape_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self.archive(root, "source/link", link="../../outside")
            target = root / "out"
            target.mkdir()
            with self.assertRaises((RuntimeError, tarfile.FilterError)):
                builder.unpack(archive, target)

    def test_macho_loader_paths_resolve_from_original_library_location(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "publisher"
            prefix = root / "relocated"
            original.mkdir()
            (prefix / "lib").mkdir(parents=True)
            dependency = original / "dependency.dylib"
            dependency.write_bytes(b"original library")
            resolved = builder.resolve_macho_dependency(prefix / "lib/main.dylib", original / "main.dylib",
                                                        "@loader_path/dependency.dylib", prefix, [])
            self.assertEqual(resolved, dependency.resolve())

    def test_macho_rpath_finds_a_bundled_library(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory)
            (prefix / "lib").mkdir()
            dependency = prefix / "lib/dependency.dylib"
            dependency.write_bytes(b"bundled library")
            resolved = builder.resolve_macho_dependency(prefix / "bin/tool", prefix / "bin/tool",
                                                        "@rpath/dependency.dylib", prefix, [])
            self.assertEqual(resolved, dependency.resolve())

    def test_unresolved_macho_dependencies_fail_instead_of_being_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "Unresolved"):
                builder.resolve_macho_dependency(root / "tool", root / "tool", "@rpath/missing.dylib", root, [])

    def test_icu_bare_install_name_resolves_from_its_original_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "libraries"
            original.mkdir()
            library = original / "libicuio.78.dylib"
            library.write_bytes(b"ICU library")
            result = builder.resolve_macho_dependency(root / "prefix/lib/libicuio.78.dylib", library,
                                                       "libicuio.78.dylib", root / "prefix", [])
            self.assertEqual(result, library.resolve())

    def test_source_built_rpath_library_is_found_before_packaging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            libraries = root / "dependencies/lib"
            libraries.mkdir(parents=True)
            library = libraries / "libpq.5.dylib"
            library.write_bytes(b"PostgreSQL client library")
            prefix = root / "prefix"
            prefix.mkdir()
            self.assertEqual(builder.resolve_macho_dependency(prefix / "bin/php", prefix / "bin/php",
                                                              "@rpath/libpq.5.dylib", prefix, []), library.resolve())

    def test_unqualified_macho_names_cannot_traverse_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "Unsupported"):
                builder.resolve_macho_dependency(root / "tool", root / "tool", "../foreign/library.dylib", root, [])

    def test_shell_scripts_are_not_misidentified_as_native_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "executable-script"
            script.write_bytes(b"#!/bin/sh\nexit 0\n")
            script.chmod(0o755)
            binary = root / "native"
            binary.write_bytes(b"\x7fELFexample")
            self.assertEqual(list(builder.binary_files(root)), [binary])

    def test_native_package_rejects_a_library_above_macos_baseline(self):
        root = Path('/package')
        library = root / 'lib/newer.dylib'
        with patch.object(builder, 'binary_files', return_value=[library]), patch.object(builder, 'output', return_value='cmd LC_BUILD_VERSION\ncmdsize 32\nminos 15.0\n'):
            with self.assertRaisesRegex(RuntimeError, r'lib[/\\]newer.dylib requires 15.0'):
                builder.minimum_macos(root, maximum='14.0')

    def test_native_package_accepts_equivalent_and_older_macos_minimums(self):
        root = Path('/package')
        binaries = [root / 'bin/server', root / 'lib/older.dylib']
        commands = ['cmd LC_BUILD_VERSION\ncmdsize 32\nminos 14.0.0\n', 'cmd LC_VERSION_MIN_MACOSX\ncmdsize 16\nversion 13.0\n']
        with patch.object(builder, 'binary_files', return_value=binaries), patch.object(builder, 'output', side_effect=commands):
            self.assertEqual(builder.minimum_macos(root, maximum='14.0'), '14.0.0')

    def test_fastcgi_reads_fragmented_unicode_responses(self):
        errors = []
        script = Path("/project") / ("ทดสอบ" * 40) / "index.php"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(5)
            port = listener.getsockname()[1]

            def peer():
                try:
                    with listener.accept()[0] as client:
                        client.settimeout(5)
                        parameters = b""
                        for _ in range(10):
                            version, kind, request_id, length, padding, _ = struct.unpack("!BBHHBB", smoke.receive(client, 8))
                            self.assertEqual((version, request_id), (1, 1))
                            content = smoke.receive(client, length)
                            smoke.receive(client, padding)
                            if kind == 4:
                                parameters += content
                            if kind == 5:
                                break
                        self.assertIn(str(script).encode("utf8"), parameters)
                        response = "Content-Type: text/plain\r\n\r\nสวัสดี".encode("utf8")
                        for chunk in [response[:-2], response[-2:]]:
                            client.sendall(struct.pack("!BBHHBB", 1, 6, 1, len(chunk), 0, 0) + chunk)
                        client.sendall(struct.pack("!BBHHBB", 1, 3, 1, 8, 0, 0) + bytes(8))
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=peer, daemon=True)
            thread.start()
            response = smoke.fastcgi(port, script)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            if errors:
                raise errors[0]
            self.assertIn("สวัสดี", response)


if __name__ == "__main__":
    unittest.main()
