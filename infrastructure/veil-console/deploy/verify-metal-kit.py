#!/usr/bin/env python3
"""Qualify the full offline Metal environment without downloading a model."""
import argparse
import json
import os
from pathlib import Path
import posixpath
import signal
import subprocess
import sys
import tarfile

from metal_wheels import sha256


def run(arguments, env, log, timeout=300):
    with log.open("ab") as output:
        child = subprocess.Popen(arguments, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = child.wait(timeout=timeout)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    if status:
        raise RuntimeError(f"{Path(arguments[0]).name} failed; see {log}")


def require_patched_python():
    # These security releases include the 2025 and October 2026 tar-filter fixes.
    minimum_patch = {(3, 12): 16, (3, 13): 18, (3, 14): 10, (3, 15): 2}.get(sys.version_info[:2])
    if minimum_patch is None or sys.version_info[2] < minimum_patch or sys.version_info[3] != "final":
        raise RuntimeError("Kit qualification requires Python 3.12.16+, 3.13.18+, 3.14.10+ or 3.15.2+ in those release series")


def main():
    require_patched_python()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    kit, work = args.kit.resolve(), args.work.resolve()
    if work.exists():
        raise RuntimeError("qualification work directory must be fresh")
    manifest = json.loads((kit / "manifest.json").read_text())
    for name, digest in manifest["files"].items():
        path = kit / name
        if not path.resolve().is_relative_to(kit) or path.is_symlink() or sha256(path) != digest:
            raise RuntimeError("kit integrity check failed")
    work.mkdir(mode=0o700, parents=True)
    with tarfile.open(kit / "runtime/python.tar.gz") as archive:
        for member in archive:
            if (member.name.startswith("/") or ".." in Path(member.name).parts or "\\" in member.name
                    or not Path(member.name).parts or Path(member.name).parts[0] != "python"):
                raise RuntimeError("unsafe Python runtime archive")
            if member.issym() or member.islnk():
                target = member.linkname if member.islnk() else posixpath.join(posixpath.dirname(member.name), member.linkname)
                normalized = posixpath.normpath(target)
                if member.linkname.startswith("/") or not normalized.startswith("python/"):
                    raise RuntimeError("unsafe Python runtime link")
            elif not member.isfile() and not member.isdir():
                raise RuntimeError("unsupported Python runtime member")
        archive.extractall(work, filter="data")
    for directory in (work / "home", work / "tmp", work / "cache"):
        directory.mkdir()
    env = {"PATH": str(kit / "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work / "home"),
           "TMPDIR": str(work / "tmp"), "LANG": "en_US.UTF-8", "PYTHONNOUSERSITE": "1",
           "HF_HOME": str(work / "cache/hf"), "TORCH_HOME": str(work / "cache/torch"),
           "VLLM_CACHE_ROOT": str(work / "cache/vllm"), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
           "DO_NOT_TRACK": "1", "VLLM_NO_USAGE_STATS": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "OTEL_SDK_DISABLED": "true"}
    uv = str(kit / "bin/uv")
    python = work / "venv/bin/python"
    log = work / "qualification.log"
    run([uv, "--no-cache", "--no-python-downloads", "venv", "--offline", "--python",
         str(work / "python/bin/python3"), str(work / "venv")], env, log)
    run([uv, "--no-cache", "pip", "sync", "--offline", "--python", str(python), "--no-index",
         "--only-binary=:all:", "--require-hashes", "--find-links", str(kit / "runtime/wheels"),
         str(kit / "runtime/requirements.txt")], env, log, timeout=1800)
    run([uv, "--no-cache", "pip", "check", "--python", str(python)], env, log)
    env["PATH"] = str(work / "venv/bin") + ":" + env["PATH"]
    run([str(python), str(Path(__file__).with_name("metal_smoke.py")), str(work / "media")], env, log)
    run([str(work / "venv/bin/vllm"), "--help"], env, log)
    print("Full offline Metal imports, plugin, CLI and media checks passed:", log)


if __name__ == "__main__":
    main()
