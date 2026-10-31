#!/usr/bin/env python3
"""Build the reviewed Caddy graph with a patched Go toolchain for the Metal kit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
MODULE = Path(__file__).with_name("caddy")
GO_VERSION = "go1.26.10"
VERSION = "v2.11.7+umbratic.1"
REPLACEMENT = "../../../../third_party/go-jose-v3"
EXPECTED = {
    "github.com/caddyserver/caddy/v2": "v2.11.7",
    "github.com/go-chi/chi/v5": "v5.4.0",
    "github.com/go-jose/go-jose/v4": "v4.1.6",
    "golang.org/x/net": "v0.62.0",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments, environment, input_text=None):
    result = subprocess.run(arguments, cwd=MODULE, env=environment, input=input_text,
                            text=True, capture_output=True, timeout=1200)
    if result.returncode:
        detail = (result.stdout + result.stderr).strip()[-8000:]
        raise RuntimeError(f"Caddy verification failed ({arguments[0]}): {detail}")
    return result.stdout


def verify_vendor():
    policy = json.loads((ROOT / "supply-chain-policy.json").read_text())
    records = policy["reviewedVendoredGoPackages"]
    if len(records) != 1 or records[0]["path"] != "third_party/go-jose-v3":
        raise RuntimeError("Unexpected Caddy source replacement policy")
    record = records[0]
    source = ROOT / record["path"]
    manifest = source / "SHA256SUMS.json"
    if digest(manifest) != record["manifestSha256"]:
        raise RuntimeError("Caddy JOSE source manifest changed without review")
    checksums = json.loads(manifest.read_text())
    files = set()
    for file in source.rglob("*"):
        if file.is_symlink():
            raise RuntimeError("Caddy JOSE source cannot contain symbolic links")
        if file.is_file() and file != manifest:
            name = file.relative_to(source).as_posix()
            files.add(name)
            if digest(file) != checksums.get(name):
                raise RuntimeError("Caddy JOSE source changed without review: " + name)
    if files != set(checksums):
        raise RuntimeError("Caddy JOSE source file set changed without review")
    return record


def check_build_info(info):
    if info.get("GoVersion") != GO_VERSION:
        raise RuntimeError("Caddy was not built with the reviewed Go toolchain")
    settings = {entry["Key"]: entry["Value"] for entry in info.get("Settings", [])}
    if any(settings.get(key) != value for key, value in
           {"GOOS": "darwin", "GOARCH": "arm64", "GOARM64": "v8.0", "CGO_ENABLED": "0"}.items()):
        raise RuntimeError("Caddy has the wrong architecture or native build configuration")
    modules = {entry["Path"]: entry for entry in info.get("Deps", [])}
    if any(entry.get("Replace") and name != "github.com/go-jose/go-jose/v3" for name, entry in modules.items()):
        raise RuntimeError("Caddy contains an unreviewed source replacement")
    for name, version in EXPECTED.items():
        if modules.get(name, {}).get("Version") != version or modules[name].get("Replace"):
            raise RuntimeError("Caddy contains an unexpected module: " + name)
    jose = modules.get("github.com/go-jose/go-jose/v3", {})
    if jose.get("Version") != "v3.0.5" or jose.get("Replace", {}).get("Path") != REPLACEMENT:
        raise RuntimeError("Caddy does not contain the reviewed JOSE security backport")
    return modules


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.cache = args.cache.resolve()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("The Metal-kit Caddy build requires an Apple Silicon Mac")
    record = verify_vendor()
    environment = dict(os.environ, GOTOOLCHAIN=GO_VERSION, GOOS="darwin", GOARCH="arm64", GOARM64="v8.0",
                       CGO_ENABLED="0", GOWORK="off", GOFLAGS="-mod=readonly", GOPROXY="https://proxy.golang.org",
                       GOSUMDB="sum.golang.org", GOPRIVATE="", GONOSUMDB="", GONOPROXY="", GOVCS="off")
    if run(["go", "env", "GOVERSION"], environment).strip() != GO_VERSION:
        raise RuntimeError("The reviewed Go toolchain is unavailable")
    run(["go", "mod", "verify"], environment)
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    lock_digests = {name: digest(MODULE / name) for name in ("main.go", "go.mod", "go.sum")}
    with tempfile.TemporaryDirectory(prefix="caddy-build-", dir=args.cache) as temporary:
        binary = Path(temporary) / "caddy"
        run(["go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags",
             "-X github.com/caddyserver/caddy/v2.CustomVersion=" + VERSION, "-o", str(binary), "."], environment)
        info = json.loads(run(["go", "version", "-m", "-json", str(binary)], environment))
        modules = check_build_info(info)
        if not run([str(binary), "version"], environment).startswith(VERSION):
            raise RuntimeError("Caddy does not report the reviewed source version")
        # Adapt parses the same features used by Console without opening ports,
        # contacting a CA, installing trust, or changing system configuration.
        config = "{\n admin off\n}\nhttps://localhost:7443 {\n bind 127.0.0.1\n tls internal\n reverse_proxy 127.0.0.1:8080\n}\n"
        adapted = json.loads(run([str(binary), "adapt", "--config", "-", "--adapter", "caddyfile"], environment, config))
        if not adapted.get("admin", {}).get("disabled") or "tls" not in adapted.get("apps", {}):
            raise RuntimeError("Caddy cannot adapt Console's HTTPS configuration")
        scanner = json.loads((ROOT / "supply-chain-policy.json").read_text())["govulncheckVersion"]
        run(["go", "run", "golang.org/x/vuln/cmd/govulncheck@v" + scanner, "-mode=binary", str(binary)], environment)
        run(["go", "mod", "verify"], environment)
        if any(digest(MODULE / name) != expected for name, expected in lock_digests.items()):
            raise RuntimeError("Caddy build changed its locked source graph")
        if verify_vendor() != record:
            raise RuntimeError("Caddy JOSE source policy changed during the build")
        # Only verified bytes enter the kit. The temporary name is on the same
        # filesystem so replacement cannot leave a partially copied executable.
        with tempfile.NamedTemporaryFile(prefix=".caddy-", dir=args.output.parent, delete=False) as staged:
            staged_path = Path(staged.name)
            try:
                with binary.open("rb") as source:
                    shutil.copyfileobj(source, staged)
                staged.flush()
                os.fsync(staged.fileno())
            except BaseException:
                staged_path.unlink(missing_ok=True)
                raise
        staged_path.chmod(0o755)
        os.replace(staged_path, args.output)
        provenance = {"name": "caddy", "release": VERSION, "go_version": GO_VERSION,
                      "sha256": digest(args.output), "source_files": lock_digests,
                      "jose_backport": record, "modules": list(modules.values())}
        args.output.with_name(args.output.name + ".build.json").write_text(json.dumps(provenance, indent=2) + "\n")
        # Keep original module notices with the executable's provenance.
        listed = run(["go", "list", "-m", "-json", "all"], environment).strip()
        entries = [json.loads(value) for value in re.split(r"\n(?=\{)", listed)]
        for entry in entries:
            if entry["Path"] not in modules:
                continue
            directory = Path(entry.get("Replace", {}).get("Dir", entry.get("Dir", "")))
            if not directory.is_dir():
                raise RuntimeError("Caddy module notice source unavailable: " + entry["Path"])
            target = args.output.parent.parent / "runtime/notices/caddy" / entry["Path"]
            for notice in directory.iterdir():
                if notice.is_file() and notice.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                    target.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(notice, target / notice.name)
        target = args.output.parent.parent / "runtime/notices/caddy/go-jose-backport"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("PROVENANCE.json", "SECURITY.patch", "json/LICENSE"):
            shutil.copyfile(ROOT / "third_party/go-jose-v3" / name, target / name.replace("/", "-"))
        toolchain = Path(run(["go", "env", "GOROOT"], environment).strip())
        if not (toolchain / "LICENSE").is_file():
            raise RuntimeError("Reviewed Go toolchain license is missing")
        target = args.output.parent.parent / "runtime/notices/caddy/go-toolchain"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("LICENSE", "PATENTS"):
            if (toolchain / name).is_file():
                shutil.copyfile(toolchain / name, target / name)
    print("Verified Caddy source build:", args.output)


if __name__ == "__main__":
    main()
