import importlib.util
import json
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
import subprocess
import sys
import urllib.error
from source_download import download_verified

import native_runtime_smoke as smoke
import linux_runtime_sources as linux_sources

spec = importlib.util.spec_from_file_location("native_builder", Path(__file__).with_name("build-native-runtime.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
installer_spec = importlib.util.spec_from_file_location("installer_checksums", Path(__file__).with_name("verify-installer-checksums.py"))
installer_checksums = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installer_checksums)
packaged_spec = importlib.util.spec_from_file_location("packaged_smoke", Path(__file__).with_name("smoke-packaged.py"))
packaged_smoke = importlib.util.module_from_spec(packaged_spec)
packaged_spec.loader.exec_module(packaged_smoke)


class LinuxSourceTests(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        prefix, output, docs, common = (root / name for name in ("prefix", "output", "docs", "common"))
        (prefix / "lib").mkdir(parents=True)
        output.mkdir()
        (docs / "libexample1").mkdir(parents=True)
        (docs / "libexample1/copyright").write_bytes(b"Copyright and license reference")
        common.mkdir()
        (common / "GPL-3").write_bytes(b"Common license text")
        original, library = root / "external.so.1", prefix / "lib/libexample.so.1"
        original.write_bytes(b"original library")
        library.write_bytes(b"relocated stripped library")
        source_files = {"example_1.2.orig.tar.xz": b"original source", "example_1.2-3.debian.tar.xz": b"distribution patches"}
        checks = "".join(f" {hashlib.sha256(value).hexdigest()} {len(value)} {name}\n" for name, value in source_files.items())
        source_files["example_1.2-3.dsc"] = ("Format: 3.0 (quilt)\nSource: example\nVersion: 1:1.2-3\nChecksums-Sha256:\n" + checks).encode()
        def execute(arguments, cwd=None):
            if arguments[:2] == ["dpkg-query", "--search"]:
                return f"libexample1:amd64: {original.resolve()}\n"
            if arguments[:2] == ["dpkg-query", "--show"]:
                return "libexample1:amd64\t1:1.2-3\texample\t1:1.2-3\tamd64\tinstalled\n"
            self.assertEqual(arguments[-1], "example=1:1.2-3")
            self.assertIn("APT::Get::AllowUnauthenticated=false", arguments)
            self.assertIn("--download-only", arguments)
            self.assertIn("--only-source", arguments)
            if "--print-uris" in arguments:
                return "\n".join(f"'https://archive.ubuntu.com/ubuntu/pool/main/e/example/{name}' {name} {len(value)} MD5Sum:unused" for name, value in source_files.items())
            for name, value in source_files.items():
                (cwd / name).write_bytes(value)
            return "Downloaded sources without unpacking"
        return {"prefix": prefix, "output": output, "work": root, "component": "php",
                "origins": {library: original}, "execute": execute, "doc_root": docs, "common_root": common,
                "distribution_version": "22.04"}, source_files

    def test_exact_sources_and_licenses_are_bound_to_packaged_library_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            proof = linux_sources.collect(**options)
            self.assertEqual(proof["libraries"][0]["sourceVersion"], "1:1.2-3")
            self.assertEqual(proof["libraries"][0]["sha256"], hashlib.sha256(b"relocated stripped library").hexdigest())
            self.assertEqual(len(proof["packages"][0]["files"]), 3)
            runtime = Path(directory) / "runtime.tar.gz"
            with tarfile.open(runtime, "w:gz") as archive:
                archive.add(options["prefix"], arcname="runtime")
            linux_sources.verify_runtime(runtime, proof)
            self.assertEqual(proof["verification"]["result"], "passed")

    def test_source_uri_requires_official_https_safe_names_and_unique_entries(self):
        for line in ["'http://archive.ubuntu.com/a' a.dsc 1 x", "'https://evil.test/a' a.dsc 1 x",
                     "'https://user@archive.ubuntu.com/a' a.dsc 1 x", "'https://archive.ubuntu.com/a' ../a.dsc 1 x",
                     "'https://archive.ubuntu.com/a' a.dsc 0 x", "unavailable"]:
            with self.subTest(line=line), self.assertRaises(RuntimeError):
                linux_sources.source_uris(line)
        entry = "'https://archive.ubuntu.com/a' a.dsc 1 x"
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            linux_sources.source_uris(entry + "\n" + entry)

    def test_descriptor_requires_exact_identity_and_sha256_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            _, files = self.fixture(directory)
            content = files["example_1.2-3.dsc"]
            for changed in [content.replace(b"Source: example", b"Source: other"), content.replace(b"Version: 1:1.2-3", b"Version: 2.0"),
                            content.replace(b"Checksums-Sha256:", b"Not-checksums:"), content.replace(b"example_1.2.orig.tar.xz", b"../../other")]:
                with self.assertRaises(RuntimeError):
                    linux_sources.dsc_files(changed, "example", "1:1.2-3")
            signed = b"-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n" + content + b"\n-----BEGIN PGP SIGNATURE-----\nnot-verified-by-this-parser\n"
            self.assertEqual(len(linux_sources.dsc_files(signed, "example", "1:1.2-3")), 2)

    def test_download_rejects_corrupt_bytes_even_when_sizes_match(self):
        with tempfile.TemporaryDirectory() as directory:
            options, files = self.fixture(directory)
            execute = options["execute"]
            def corrupt(arguments, cwd=None):
                result = execute(arguments, cwd)
                if arguments[0] == "apt-get" and "--print-uris" not in arguments:
                    name = "example_1.2.orig.tar.xz"
                    (cwd / name).write_bytes(b"x" * len(files[name]))
                return result
            options["execute"] = corrupt
            with self.assertRaisesRegex(RuntimeError, "checksum/size"):
                linux_sources.collect(**options)

    def test_download_rejects_missing_source_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            execute = options["execute"]
            def missing(arguments, cwd=None):
                result = execute(arguments, cwd)
                if arguments[0] == "apt-get" and "--print-uris" not in arguments:
                    (cwd / "example_1.2.orig.tar.xz").unlink()
                return result
            options["execute"] = missing
            with self.assertRaisesRegex(RuntimeError, "source inventory"):
                linux_sources.collect(**options)

    def test_ambiguous_or_uninstalled_owners_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            original = next(iter(options["origins"].values()))
            with self.assertRaisesRegex(RuntimeError, "Ambiguous"):
                linux_sources.owner(original, lambda args: f"a: {original.resolve()}\nb: {original.resolve()}")
            execute = options["execute"]
            def uninstalled(arguments, cwd=None):
                return execute(arguments, cwd).replace("\tinstalled", "\tnot-installed")
            with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                linux_sources.owner(original, uninstalled)

    def test_missing_copyright_does_not_publish_a_source_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            (options["doc_root"] / "libexample1/copyright").unlink()
            with self.assertRaisesRegex(RuntimeError, "copyright"):
                linux_sources.collect(**options)
            self.assertEqual(list(options["output"].iterdir()), [])

    def test_source_bundle_substitution_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            proof = linux_sources.collect(**options)
            bundle = options["output"] / proof["packages"][0]["bundle"]["file"]
            bundle.write_bytes(b"x" * bundle.stat().st_size)
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                linux_sources.verify_bundles(options["output"], proof)

    def test_newer_build_baseline_is_rejected_before_writing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            options["distribution_version"] = "24.04"
            with self.assertRaisesRegex(RuntimeError, "Ubuntu 22.04"):
                linux_sources.collect(**options)
            self.assertEqual(list(options["output"].iterdir()), [])

    def test_builder_reads_the_real_os_release_api_when_no_test_override_is_set(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            options.pop("distribution_version")
            with patch.object(linux_sources.platform, "freedesktop_os_release", return_value={"ID": "ubuntu", "VERSION_ID": "22.04"}):
                proof = linux_sources.collect(**options)
            self.assertEqual(proof["distributionVersion"], "22.04")

    def test_source_bundle_cannot_omit_recorded_licenses(self):
        with tempfile.TemporaryDirectory() as directory:
            options, _ = self.fixture(directory)
            proof = linux_sources.collect(**options)
            bundle = options["output"] / proof["packages"][0]["bundle"]["file"]
            with tarfile.open(bundle, "w"):
                pass
            proof["packages"][0]["bundle"].update(sha256=linux_sources.digest(bundle), size=bundle.stat().st_size)
            with self.assertRaisesRegex(RuntimeError, "member inventory"):
                linux_sources.verify_bundles(options["output"], proof)

    def test_packaged_library_or_license_changes_fail_verification(self):
        for relative in ["lib/libexample.so.1", "share/licenses/ubuntu/libexample1/copyright"]:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                options, _ = self.fixture(directory)
                proof = linux_sources.collect(**options)
                (options["prefix"] / relative).write_bytes(b"changed")
                runtime = Path(directory) / "runtime.tar.gz"
                with tarfile.open(runtime, "w:gz") as archive:
                    archive.add(options["prefix"], arcname="runtime")
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    linux_sources.verify_runtime(runtime, proof)


class NativeReleasePinsTests(unittest.TestCase):
    def test_release_source_pins_match_the_native_builders(self):
        from postgres_macos_dependencies import SOURCES
        from mariadb_macos_dependencies import PCRE
        pins = json.loads((Path(__file__).resolve().parent.parent / ".github/native-release-sources.json").read_text())
        for actual, expected in [(pins["crypto"], SOURCES), ([pins["pcre2"]], [PCRE])]:
            self.assertEqual(len(actual), len(expected))
            for release, build in zip(actual, expected):
                for key in ("name", "version", "license", "url", "sha256"):
                    self.assertEqual(release[key], build[key], key)


class PackagedMetadataTests(unittest.TestCase):
    def test_verbose_startup_cannot_block_on_unread_output_pipes(self):
        real_popen = subprocess.Popen
        application = """import os, sqlite3, sys, time
sys.stdout.write('o' * 262144); sys.stdout.flush()
sys.stderr.write('e' * 262144); sys.stderr.flush()
with sqlite3.connect(os.path.join(os.environ['STACKCABIN_DATA_DIR'], 'stackcabin.sqlite')) as connection:
    connection.executescript('CREATE TABLE projects(id,path,payload); CREATE TABLE settings(id,payload); PRAGMA user_version=1;')
time.sleep(30)
"""
        def start(arguments, **options):
            return real_popen([sys.executable, "-c", application], **options)
        with patch.object(packaged_smoke.subprocess, "Popen", side_effect=start):
            packaged_smoke.verify(sys.executable)

    def test_startup_failure_keeps_bounded_output_and_read_only_diagnostics(self):
        real_popen = subprocess.Popen
        def start(arguments, **options):
            process = real_popen([sys.executable, "-c", "import sys; sys.stderr.write('known startup failure'); sys.exit(7)"], **options)
            process.wait(timeout=5)
            return process
        output = io.StringIO()
        with patch.object(packaged_smoke.subprocess, "Popen", side_effect=start), patch.object(packaged_smoke.sys, "stderr", output):
            with self.assertRaisesRegex(RuntimeError, "exited: 7"):
                packaged_smoke.verify(sys.executable)
        text = output.getvalue()
        self.assertIn('"returncode": 7', text)
        self.assertIn('"files": []', text)
        self.assertIn("known startup failure", text)
        self.assertLess(len(text), 10000)

    @unittest.skipUnless(os.name == "nt", "Windows handle and file attributes")
    def test_metadata_access_diagnostics_never_repair_or_create_files(self):
        import stat
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            before = database.read_bytes()
            original = database.stat().st_mode
            try:
                database.chmod(stat.S_IREAD)
                info = {item["name"]: item for item in packaged_smoke.windows_data_access(directory)}
                self.assertFalse(info["stackcabin.sqlite"]["writeHandle"])
                self.assertEqual(info["stackcabin.sqlite"]["writeHandleError"], 5)
                self.assertTrue(info["stackcabin.sqlite"]["attributes"] & 1)
                self.assertEqual(database.read_bytes(), before)
                self.assertTrue(database.stat().st_file_attributes & 1)
                for suffix in ("-wal", "-shm"):
                    self.assertFalse(database.with_name(database.name + suffix).exists())
            finally:
                database.chmod(original)

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

    def test_default_path_refuses_to_touch_data_without_an_existing_fixture(self):
        with patch.object(packaged_smoke.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "requires an existing preservation fixture"):
                packaged_smoke.verify(sys.executable, use_default_data_directory=True)
            launch.assert_not_called()

    def test_default_path_opens_the_real_database_despite_an_inherited_override(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            before = database.read_bytes()
            inherited = str(Path(directory) / "must not be created")
            real_popen = subprocess.Popen
            command = [str(Path(sys.executable).resolve())]

            def start_application(arguments, **options):
                if arguments == command:
                    # A real child emulates an app's default-path selection. Readiness
                    # still requires that child's actual SQLite file handle on each OS.
                    probe = ("import os, sqlite3, time; from pathlib import Path; "
                             "root = Path(os.environ.get('STACKCABIN_DATA_DIR', os.environ['TEST_DEFAULT_DATA'])); "
                             "connection = sqlite3.connect(root / 'stackcabin.sqlite'); "
                             "connection.execute('SELECT * FROM projects').fetchall(); time.sleep(30)")
                    arguments = [sys.executable, "-c", probe]
                return real_popen(arguments, **options)

            with patch.dict(os.environ, {"STACKCABIN_DATA_DIR": inherited, "TEST_DEFAULT_DATA": directory}), \
                    patch.object(packaged_smoke.subprocess, "Popen", side_effect=start_application):
                packaged_smoke.verify(sys.executable, directory, use_default_data_directory=True)
                self.assertEqual(os.environ["STACKCABIN_DATA_DIR"], inherited)
            self.assertFalse(Path(inherited).exists())
            self.assertEqual(database.read_bytes(), before)

    def test_a_real_open_database_handle_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))
            with closing(sqlite3.connect(database)):
                self.assertTrue(packaged_smoke.has_metadata_handle(os.getpid(), database))
            self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))

    def test_a_different_database_handle_does_not_prove_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            with closing(sqlite3.connect(Path(directory) / "different.sqlite")):
                self.assertFalse(packaged_smoke.has_metadata_handle(os.getpid(), database))

    def test_a_different_process_cannot_claim_an_open_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.fixture(Path(directory))
            with closing(sqlite3.connect(database)):
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
                try:
                    self.assertFalse(packaged_smoke.has_metadata_handle(child.pid, database))
                finally:
                    child.terminate()
                    child.wait(timeout=5)


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
