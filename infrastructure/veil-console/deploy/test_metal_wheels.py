import base64
import csv
import io
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from metal_wheels import prepare_wheel, sha256

spec = importlib.util.spec_from_file_location("verify_metal_kit", Path(__file__).with_name("verify-metal-kit.py"))
verify_metal_kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_metal_kit)
verify_metal_kit.require_patched_python()


class WheelPatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.patch = {"from": "example @ git+https://example.test/source@commit", "to": "example==1.0"}
        (self.root / "patch.json").write_text(json.dumps(self.patch))
        self.metadata = b"Metadata-Version: 2.4\nName: fixture\nVersion: 1.0\nRequires-Dist: " + self.patch["from"].encode() + b"\n\n"
        self.item = {"filename": "fixture-1.0-py3-none-any.whl", "metadata_patch": {
            "path": "patch.json", "sha256": sha256(self.root / "patch.json"),
            "filename": "fixture-1.0-1umbratic-py3-none-any.whl", "wheel_sha256": "unreviewed"}}
        self.write_source()

    def write_source(self):
        with zipfile.ZipFile(self.root / self.item["filename"], "w") as source:
            source.writestr("fixture/__init__.py", b"untouched package code\n")
            source.writestr("fixture-1.0.dist-info/METADATA", self.metadata)
            source.writestr("fixture-1.0.dist-info/RECORD", b"old record\n")
        self.item["sha256"] = sha256(self.root / self.item["filename"])

    def test_unreviewed_output_is_rejected_and_not_published(self):
        with self.assertRaisesRegex(RuntimeError, "patched wheel checksum mismatch"):
            prepare_wheel(self.item, self.root, self.root)
        self.assertFalse((self.root / self.item["metadata_patch"]["filename"]).exists())
        self.assertFalse(list(self.root.glob("*.partial")))

    def test_source_and_patch_checksums_are_enforced(self):
        for field in ("source", "patch"):
            with self.subTest(field=field):
                target = self.root / (self.item["filename"] if field == "source" else "patch.json")
                original = target.read_bytes()
                target.write_bytes(original + b"tampering")
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    prepare_wheel(self.item, self.root, self.root)
                target.write_bytes(original)

    def test_requirement_must_match_exactly_once(self):
        identity = b"Metadata-Version: 2.4\nName: fixture\nVersion: 1.0\n"
        requirement = b"Requires-Dist: " + self.patch["from"].encode() + b"\n"
        for count in (0, 2):
            with self.subTest(count=count):
                self.metadata = identity + requirement * count + b"\n"
                self.write_source()
                with self.assertRaisesRegex(RuntimeError, "exactly one"):
                    prepare_wheel(self.item, self.root, self.root)

    def test_unsafe_archive_paths_and_symlinks_are_refused(self):
        for name, mode in (("../escape", 0o100644), ("fixture/link", 0o120777)):
            with self.subTest(name=name):
                self.write_source()
                with zipfile.ZipFile(self.root / self.item["filename"], "a") as source:
                    entry = zipfile.ZipInfo(name)
                    entry.create_system = 3
                    entry.external_attr = mode << 16
                    source.writestr(entry, b"outside")
                self.item["sha256"] = sha256(self.root / self.item["filename"])
                with self.assertRaisesRegex(RuntimeError, "unsafe wheel member"):
                    prepare_wheel(self.item, self.root, self.root)

    def test_remaining_git_requirements_are_refused(self):
        self.metadata = self.metadata.replace(b"\n\n", b"\nRequires-Dist: nested @ git+https://example.test/other\n\n")
        self.write_source()
        with self.assertRaisesRegex(RuntimeError, "still requires a Git package"):
            prepare_wheel(self.item, self.root, self.root)

    def test_patch_preserves_code_and_identity_with_valid_reproducible_record(self):
        self.item["metadata_patch"]["wheel_sha256"] = "36851e06a70558d57fe8442fd4ceda448e32256bc72bd662e96056251f32f19a"
        output = prepare_wheel(self.item, self.root, self.root)
        first = output.read_bytes()
        self.assertEqual(prepare_wheel(self.item, self.root, self.root).read_bytes(), first)
        with zipfile.ZipFile(output) as wheel:
            self.assertEqual(wheel.read("fixture/__init__.py"), b"untouched package code\n")
            metadata = wheel.read("fixture-1.0.dist-info/METADATA")
            self.assertIn(b"Name: fixture\nVersion: 1.0\n", metadata)
            self.assertIn(b"Requires-Dist: example==1.0\n", metadata)
            self.assertNotIn(b"git+", metadata)
            rows = csv.reader(io.StringIO(wheel.read("fixture-1.0.dist-info/RECORD").decode()))
            for name, digest, size in rows:
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, size), ("", ""))
                    continue
                data = wheel.read(name)
                self.assertEqual(int(size), len(data))
                expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
                self.assertEqual(digest, "sha256=" + expected)


class RuntimeArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.kit = self.root / "kit"
        (self.kit / "runtime").mkdir(parents=True)
        self.work = self.root / "work"

    def write_archive(self, members):
        archive_path = self.kit / "runtime/python.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            for name, kind, value in members:
                entry = tarfile.TarInfo(name)
                entry.mode = 0o755
                entry.type = kind
                if kind == tarfile.REGTYPE:
                    entry.size = len(value)
                    archive.addfile(entry, io.BytesIO(value))
                else:
                    entry.linkname = value
                    archive.addfile(entry)
        (self.kit / "manifest.json").write_text(json.dumps({"files": {"runtime/python.tar.gz": sha256(archive_path)}}))

    def qualify(self):
        with patch.object(sys, "argv", ["verify-metal-kit.py", "--kit", str(self.kit), "--work", str(self.work)]), \
                patch.object(verify_metal_kit, "run"):
            verify_metal_kit.main()

    def test_data_filter_preserves_safe_runtime_files_and_links(self):
        self.write_archive([
            ("python/bin/python3", tarfile.REGTYPE, b"runtime fixture"),
            ("python/bin/python", tarfile.SYMTYPE, "python3"),
            ("python/bin/python-hard", tarfile.LNKTYPE, "python/bin/python3"),
        ])
        self.qualify()
        for name in ("python3", "python", "python-hard"):
            self.assertEqual((self.work / "python/bin" / name).read_bytes(), b"runtime fixture")

    def test_composed_symlink_parent_traversal_cannot_escape_work(self):
        (self.root / "escaped").mkdir()
        self.write_archive([
            ("python/d", tarfile.DIRTYPE, ""),
            ("python/escaped", tarfile.DIRTYPE, ""),
            ("python/x/y/b", tarfile.SYMTYPE, "../../d"),
            ("python/x/y/a", tarfile.SYMTYPE, "b/../../../escaped"),
            ("python/x/y/a/proof", tarfile.REGTYPE, b"outside extraction root"),
        ])
        try:
            self.qualify()
        except tarfile.FilterError:
            pass
        self.assertFalse((self.root / "escaped/proof").exists())

    def test_old_python_fails_before_creating_the_work_directory(self):
        with patch.object(sys, "version_info", (3, 11, 18, "final", 0)):
            with self.assertRaisesRegex(RuntimeError, "requires Python 3.12.16"):
                self.qualify()
        self.assertFalse(self.work.exists())

    def test_security_floor_is_checked_for_each_python_release_series(self):
        for version in ((3, 12, 15), (3, 13, 17), (3, 14, 9), (3, 15, 1), (3, 16, 0)):
            with self.subTest(rejected=version), patch.object(sys, "version_info", (*version, "final", 0)):
                with self.assertRaisesRegex(RuntimeError, "requires Python 3.12.16"):
                    verify_metal_kit.require_patched_python()
        for version in ((3, 12, 16), (3, 13, 18), (3, 14, 10), (3, 15, 2)):
            with self.subTest(accepted=version), patch.object(sys, "version_info", (*version, "final", 0)):
                verify_metal_kit.require_patched_python()
        with patch.object(sys, "version_info", (3, 15, 2, "candidate", 1)):
            with self.assertRaisesRegex(RuntimeError, "requires Python 3.12.16"):
                verify_metal_kit.require_patched_python()


if __name__ == "__main__":
    unittest.main()
