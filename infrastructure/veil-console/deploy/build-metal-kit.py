#!/usr/bin/env python3
"""Build the reviewed, offline Apple Silicon dependency kit on a release machine."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import urllib.request
import zipfile

NATIVE = [
    dict(name="caddy", release="2.11.4", filename="caddy.tar.gz", member="caddy",
         url="https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_mac_arm64.tar.gz",
         sha256="9efb0af2d6cf09cfb5053c0e51721b9b3d4956d346234f39368d943d25a3c9a7"),
    dict(name="qdrant", release="1.19.0", filename="qdrant.tar.gz", member="qdrant",
         url="https://github.com/qdrant/qdrant/releases/download/v1.19.0/qdrant-aarch64-apple-darwin.tar.gz",
         sha256="4e279a80cc1ebe73e859318ff86375af54c123887dd7ae46605c0eb6cb7c44e8"),
    dict(name="uv", release="0.12.1", filename="uv.tar.gz", member="uv-aarch64-apple-darwin/uv",
         url="https://github.com/astral-sh/uv/releases/download/0.12.1/uv-aarch64-apple-darwin.tar.gz",
         sha256="77d2906988e8074fd43f2f329ec452ebbf9b0c257ba1c66451c71de70a6baf42"),
    dict(name="python", release="3.12.12+20260211", filename="python.tar.gz",
         url="https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-3.12.12%2B20260211-aarch64-apple-darwin-install_only_stripped.tar.gz",
         sha256="22625deaf5757e7c266cf1a096c9151a06b598b1e14632a2ec9993d58ec5fe84"),
    dict(name="ffmpeg", release="7.1 (imageio-ffmpeg 0.6.0)", filename="ffmpeg.whl",
         url="https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl",
         sha256="b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742"),
]


def digest(path):
    with path.open("rb") as source:
        result = hashlib.sha256()
        for block in iter(lambda: source.read(1 << 20), b""):
            result.update(block)
        return result.hexdigest()


def download(item, cache):
    path = cache / item["filename"]
    if path.exists() and digest(path) == item["sha256"]:
        return path
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        with urllib.request.urlopen(item["url"], timeout=180) as source, temporary.open("wb") as output:
            shutil.copyfileobj(source, output)
        if digest(temporary) != item["sha256"]:
            raise RuntimeError("checksum mismatch: " + item["filename"])
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    output, cache = args.output.resolve(), args.cache.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    for directory in (output / "bin", output / "runtime/wheels"):
        directory.mkdir(parents=True, exist_ok=True)
    wheels = json.loads(Path(__file__).with_name("metal-wheels.lock.json").read_text())
    if any("git+" in item["url"] or not item["filename"].endswith(".whl") for item in wheels):
        raise RuntimeError("only reviewed release wheels may enter a dependency kit")
    items = NATIVE + wheels
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda item: download(item, cache), items))
    dependencies, sources = {}, {}
    for item in items:
        dependencies[item["name"]] = item.get("release", item.get("package_version"))
        sources[item["filename"]] = {key: item[key] for key in ("url", "sha256")}
    for item in NATIVE:
        archive = cache / item["filename"]
        if item["name"] == "python":
            shutil.copyfile(archive, output / "runtime/python.tar.gz")
            continue
        destination = output / "bin" / item["name"]
        if item["name"] == "ffmpeg":
            with zipfile.ZipFile(archive) as source:
                names = [name for name in source.namelist() if "/binaries/ffmpeg-" in name and not name.endswith("/")]
                if len(names) != 1:
                    raise RuntimeError("unexpected FFmpeg wheel layout")
                destination.write_bytes(source.read(names[0]))
                notices = output / "runtime/notices/ffmpeg"
                notices.mkdir(parents=True, exist_ok=True)
                for name in source.namelist():
                    if name.endswith("/LICENSE") or name.endswith("/binaries/README.md"):
                        (notices / Path(name).name).write_bytes(source.read(name))
        else:
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
    requirements = []
    for item in wheels:
        shutil.copyfile(cache / item["filename"], output / "runtime/wheels" / item["filename"])
        requirements.append(f'{item["name"]}=={item["package_version"]} --hash=sha256:{item["sha256"]}')
    (output / "runtime/requirements.txt").write_text("\n".join(sorted(requirements)) + "\n")
    # Keep provenance alongside notices and the original wheel closure.
    (output / "runtime/sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    files = {}
    for path in sorted(output.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("dependency kits cannot contain symbolic links")
        if path.is_file() and path.name != "manifest.json":
            files[path.relative_to(output).as_posix()] = digest(path)
    manifest = dict(version="metal-0.28.0", dependencies=dependencies, files=files)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Verified offline Metal dependency kit:", output)


if __name__ == "__main__":
    main()
