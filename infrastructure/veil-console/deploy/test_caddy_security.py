"""Boundary checks for the Caddy source/binary provenance verifier."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("build_caddy", Path(__file__).with_name("build-caddy.py"))
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class CaddySecurityTests(unittest.TestCase):
    def test_binary_metadata_rejects_old_toolchain_wrong_arch_and_source_replacements(self):
        good = {"GoVersion": BUILDER.GO_VERSION,
                "Settings": [{"Key": key, "Value": value} for key, value in
                             {"GOOS": "darwin", "GOARCH": "arm64", "GOARM64": "v8.0", "CGO_ENABLED": "0"}.items()],
                "Deps": [{"Path": name, "Version": version} for name, version in BUILDER.EXPECTED.items()] +
                        [{"Path": "github.com/go-jose/go-jose/v3", "Version": "v3.0.5", "Replace": {"Path": BUILDER.REPLACEMENT}}]}
        BUILDER.check_build_info(good)
        mutants = []
        old = copy.deepcopy(good)
        old["GoVersion"] = "go1.26.8"
        mutants.append(old)
        for name, value in [("GOARCH", "amd64"), ("GOARM64", "v8.7"), ("CGO_ENABLED", "1")]:
            wrong = copy.deepcopy(good)
            next(entry for entry in wrong["Settings"] if entry["Key"] == name)["Value"] = value
            mutants.append(wrong)
        missing_patch = copy.deepcopy(good)
        missing_patch["Deps"][-1].pop("Replace")
        mutants.append(missing_patch)
        old_dependency = copy.deepcopy(good)
        old_dependency["Deps"][1]["Version"] = "v5.3.2"
        mutants.append(old_dependency)
        replaced = copy.deepcopy(good)
        replaced["Deps"].append({"Path": "unreviewed/module", "Version": "v1.0.0", "Replace": {"Path": "../unreviewed"}})
        mutants.append(replaced)
        for mutant in mutants:
            with self.subTest(mutant=mutant), self.assertRaises(RuntimeError):
                BUILDER.check_build_info(mutant)

    def test_vendor_checksum_gate_rejects_changed_and_added_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "third_party/go-jose-v3"
            vendor.mkdir(parents=True)
            source = vendor / "source.go"
            source.write_text("package reviewed\n")
            sums = vendor / "SHA256SUMS.json"
            sums.write_text(json.dumps({"source.go": hashlib.sha256(source.read_bytes()).hexdigest()}))
            record = {"path": "third_party/go-jose-v3", "manifestSha256": hashlib.sha256(sums.read_bytes()).hexdigest()}
            (root / "supply-chain-policy.json").write_text(json.dumps({"reviewedVendoredGoPackages": [record]}))
            with patch.object(BUILDER, "ROOT", root):
                BUILDER.verify_vendor()
                source.write_text("package changed\n")
                with self.assertRaises(RuntimeError):
                    BUILDER.verify_vendor()
                source.write_text("package reviewed\n")
                (vendor / "extra.go").write_text("package extra\n")
                with self.assertRaises(RuntimeError):
                    BUILDER.verify_vendor()


if __name__ == "__main__":
    unittest.main()
