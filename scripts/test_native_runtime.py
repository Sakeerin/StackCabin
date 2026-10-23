import importlib.util
import io
from pathlib import Path
import socket
import struct
import tarfile
import tempfile
import threading
import unittest

import native_runtime_smoke as smoke

spec = importlib.util.spec_from_file_location("native_builder", Path(__file__).with_name("build-native-runtime.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NativePackagingTests(unittest.TestCase):
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
