#!/usr/bin/env python3
"""Build the reviewed, offline Apple Silicon dependency kit on a release machine."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

from metal_media import prepare_media_wheel, prepare_torchcodec_wheel
from metal_wheels import prepare_wheel, sha256

ROOT = Path(__file__).resolve().parent
NATIVE = json.loads((ROOT / "metal-native.lock.json").read_text())


def download(item, cache):
    path = cache / item["filename"]
    if path.exists() and path.stat().st_size == item["size"] and sha256(path) == item["sha256"]:
        return path
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".partial", dir=cache)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output, urllib.request.urlopen(item["url"], timeout=180) as source:
            total, digest = 0, hashlib.sha256()
            while block := source.read(1 << 20):
                total += len(block)
                if total > item["size"]:
                    raise RuntimeError("download exceeds reviewed size: " + item["filename"])
                digest.update(block)
                output.write(block)
        if total != item["size"] or digest.hexdigest() != item["sha256"]:
            raise RuntimeError("checksum or size mismatch: " + item["filename"])
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def assemble(output, cache, wheels):
    for directory in (output / "bin", output / "runtime/wheels"):
        directory.mkdir(parents=True, exist_ok=True)
    items = NATIVE + wheels
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda item: download(item, cache), items))
    dependencies = {item["name"]: item.get("release", item.get("package_version")) for item in items}
    sources = {item["filename"]: {key: item[key] for key in ("url", "sha256", "size")} for item in items}
    for item in NATIVE:
        archive = cache / item["filename"]
        if item.get("build"):
            continue
        if item["name"] == "python":
            shutil.copyfile(archive, output / "runtime/python.tar.gz")
            continue
        destination = output / "bin" / item["name"]
        with tarfile.open(archive) as source:
            member = source.getmember(item["member"])
            if not member.isfile():
                raise RuntimeError("native executable is not a regular file")
            with source.extractfile(member) as binary, destination.open("wb") as target:
                shutil.copyfileobj(binary, target)
            for entry in source.getmembers():
                if entry.isfile() and Path(entry.name).name.upper().startswith(("LICENSE", "NOTICE", "COPYING")):
                    notices = output / "runtime/notices" / item["name"]
                    notices.mkdir(parents=True, exist_ok=True)
                    (notices / Path(entry.name).name).write_bytes(source.extractfile(entry).read())
        destination.chmod(0o755)
    subprocess.run([sys.executable, str(ROOT / "build-caddy.py"), "--output", str(output / "bin/caddy"),
                    "--cache", str(cache / "caddy")], check=True)
    caddy = json.loads((output / "bin/caddy.build.json").read_text())
    dependencies["caddy"] = caddy["release"]
    media = output / "runtime/ffmpeg"
    subprocess.run([sys.executable, str(ROOT / "build-ffmpeg.py"), "--cache", str(cache),
                    "--output", str(media)], check=True)
    # The CLI's reviewed rpath is ../lib. Keep one executable entry in bin and
    # the same regular shared libraries beside the source-built runtime.
    for name in ("ffmpeg", "ffprobe"):
        shutil.copy2(media / "bin" / name, output / "bin" / name)
        subprocess.run(["/usr/bin/install_name_tool", "-rpath", "@loader_path/../lib",
                        "@loader_path/../runtime/ffmpeg/lib", str(output / "bin" / name)],
                       check=True, capture_output=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(output / "bin" / name)],
                       check=True, capture_output=True)
    source_bundle = output / "runtime/sources/ffmpeg"
    source_bundle.mkdir(parents=True)
    for item in NATIVE:
        if item.get("build") == "ffmpeg":
            shutil.copy2(cache / item["filename"], source_bundle / item["filename"])
            with tarfile.open(cache / item["filename"]) as archive:
                for member in archive:
                    if member.isfile() and Path(member.name).name.upper().startswith(("COPYING", "LICENSE", "NOTICE")):
                        destination = output / "runtime/notices/ffmpeg" / item["name"] / Path(member.name).name
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(archive.extractfile(member).read())
    for name in ("build-ffmpeg.py", "metal_wheels.py", "metal-native.lock.json"):
        shutil.copy2(ROOT / name, source_bundle / name)
    requirements, wheel_changes = [], {}
    for item in wheels:
        wheel = prepare_wheel(item, cache, ROOT)
        if item.get("native_patch"):
            if item["name"] == "torchcodec":
                pyav = next(value for value in wheels if value["name"] == "av")
                wheel, details = prepare_torchcodec_wheel(item, pyav, cache)
            else:
                wheel, details = prepare_media_wheel(item, cache, media)
            wheel_changes[item["name"]] = details
        if item.get("metadata_patch"):
            wheel_changes[item["name"]] = item["metadata_patch"]
        shutil.copyfile(wheel, output / "runtime/wheels" / wheel.name)
        requirements.append(f'{item["name"]}=={item["package_version"]} --hash=sha256:{sha256(wheel)}')
    (output / "runtime/requirements.txt").write_text("\n".join(sorted(requirements)) + "\n")
    (output / "runtime/sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    (output / "runtime/wheel-changes.json").write_text(json.dumps(wheel_changes, indent=2) + "\n")
    files = {}
    for path in sorted(output.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("dependency kits cannot contain symbolic links")
        if path.is_file() and path.name != "manifest.json":
            files[path.relative_to(output).as_posix()] = sha256(path)
    manifest = dict(version="metal-0.32.0", dependencies=dependencies, files=files)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    output, cache = args.output.resolve(), args.cache.resolve()
    # Reusing an output folder could retain old vulnerable wheels or binaries.
    # Require a fresh destination; the download/build cache remains reusable.
    if output.exists():
        raise RuntimeError("kit output must not exist; select a fresh output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    wheels = json.loads((ROOT / "metal-wheels.lock.json").read_text())
    if any("git+" in item["url"] or not item["filename"].endswith(".whl") for item in wheels):
        raise RuntimeError("only reviewed release wheels may enter a dependency kit")
    with tempfile.TemporaryDirectory(prefix=output.name + ".", dir=output.parent) as temporary:
        stage = Path(temporary) / "kit"
        assemble(stage, cache, wheels)
        stage.rename(output)
    print("Verified offline Metal dependency kit:", output)


if __name__ == "__main__":
    main()
