import base64
import csv
import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from metal_wheels import prepare_wheel, sha256


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


if __name__ == "__main__":
    unittest.main()
