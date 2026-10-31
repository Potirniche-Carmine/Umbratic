#!/usr/bin/env python3
"""Build the reviewed Metal media runtime and its same-ABI OpenCV replacements."""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import tarfile
import tempfile

from metal_wheels import sha256

ROOT = Path(__file__).resolve().parent
PINS = [item for item in json.loads((ROOT / "metal-native.lock.json").read_text()) if item.get("build") == "ffmpeg"]


def run(args, cwd, env, log):
    with log.open("ab") as output:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=1200)
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    if status:
        raise RuntimeError(f"{Path(args[0]).name} failed; see {log}")


def unpack(archive, destination):
    destination.mkdir()
    total = 0
    with tarfile.open(archive) as source:
        for member in source:
            parts = Path(member.name).parts
            if (not parts or member.name.startswith("/") or ".." in parts
                    or "\\" in member.name or ":" in member.name):
                raise RuntimeError("unsafe media source archive path")
            if len(parts) == 1:
                continue
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                total += member.size
                if member.size > 64 * 1024 * 1024 or total > 512 * 1024 * 1024:
                    raise RuntimeError("media source archive is oversized")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as input_file, target.open("xb") as output:
                    shutil.copyfileobj(input_file, output)
                target.chmod(member.mode & 0o777)
            else:
                raise RuntimeError("media source archive contains a link or special file")


def verify(directory):
    metadata = json.loads((directory / "provenance.json").read_text())
    for name, expected in metadata["files"].items():
        if sha256(directory / name) != expected:
            raise RuntimeError("cached media build checksum mismatch")
    version = subprocess.check_output([str(directory / "bin/ffmpeg"), "-version"], text=True)
    if not version.startswith("ffmpeg version 7.1.5 "):
        raise RuntimeError("unexpected media runtime version")
    library = next((directory / "lib").glob("libavutil.*.*.*.dylib"))
    loaded = ctypes.CDLL(str(library))
    loaded.av_version_info.restype = ctypes.c_char_p
    if loaded.av_version_info() != b"7.1.5":
        raise RuntimeError("unexpected embedded media library version")
    return metadata


def build_locked(cache):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("the Metal media runtime requires an Apple Silicon build host")
    for item in PINS:
        source = cache / item["filename"]
        if source.stat().st_size != item["size"] or sha256(source) != item["sha256"]:
            raise RuntimeError("media source checksum mismatch: " + item["filename"])
    compiler = subprocess.check_output(["/usr/bin/clang", "--version"], text=True)
    recipe = {"sources": PINS, "compiler": compiler, "recipe": sha256(Path(__file__))}
    identity = hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()
    result = cache / "ffmpeg-builds" / identity
    if result.exists():
        verify(result)
        return result
    result.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ffmpeg-", dir=result.parent) as temporary:
        work = Path(temporary)
        prefix = work / "prefix"
        prefix.mkdir()
        (work / "tmp").mkdir()
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME": str(work),
               "TMPDIR": str(work / "tmp"), "LC_ALL": "C", "CC": "/usr/bin/clang",
               "CXX": "/usr/bin/clang++", "MACOSX_DEPLOYMENT_TARGET": "15.0",
               "CFLAGS": f"-O2 -fPIC -mmacosx-version-min=15.0 -ffile-prefix-map={work}=.",
               "LDFLAGS": "-mmacosx-version-min=15.0", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1",
               "PKG_CONFIG": str(prefix / "bin/pkgconf"),
               "PKG_CONFIG_LIBDIR": str(prefix / "lib/pkgconfig"), "PKG_CONFIG_PATH": "",
               "GIT_CEILING_DIRECTORIES": str(work)}
        log = cache / "ffmpeg-build.log"
        for item in PINS:
            source = work / item["name"]
            unpack(cache / item["filename"], source)
        for name, options in [
            ("pkgconf", ["--disable-shared", "--enable-static"]),
            ("lame", ["--disable-shared", "--enable-static", "--disable-frontend", "--disable-decoder", "--with-pic"]),
            ("opus", ["--disable-shared", "--enable-static", "--disable-doc", "--disable-extra-programs", "--with-pic"]),
            ("x264", ["--disable-cli", "--enable-static", "--enable-pic"]),
        ]:
            source = work / name
            print("Building reviewed media codec:", name, flush=True)
            run([str(source / "configure"), "--prefix=" + str(prefix), *options], source, env, log)
            run(["/usr/bin/make", "-j2"], source, env, log)
            run(["/usr/bin/make", "install"], source, env, log)
        source = work / "ffmpeg"
        options = ["--prefix=" + str(prefix), "--disable-autodetect", "--disable-doc", "--disable-debug",
                   "--disable-ffplay", "--enable-ffprobe", "--disable-static", "--enable-shared",
                   "--enable-gpl", "--enable-libx264", "--enable-libmp3lame", "--enable-libopus",
                   "--enable-videotoolbox", "--enable-audiotoolbox", "--enable-securetransport",
                   "--enable-zlib", "--enable-bzlib", "--disable-lzma", "--install-name-dir=@rpath",
                   "--pkg-config=" + str(prefix / "bin/pkgconf"),
                   "--extra-cflags=-I" + str(prefix / "include"),
                   "--extra-ldflags=-L" + str(prefix / "lib") + " -Wl,-rpath,@loader_path/../lib -Wl,-headerpad_max_install_names"]
        print("Building reviewed FFmpeg 7.1.5 (two compiler jobs)", flush=True)
        run([str(source / "configure"), *options], source, env, log)
        run(["/usr/bin/make", "-j2"], source, env, log)
        run(["/usr/bin/make", "install"], source, env, log)
        # Keep the CLI and complete shared library set; no static codec copies
        # or headers enter the deployment runtime.
        output = work / "runtime"
        (output / "bin").mkdir(parents=True)
        (output / "lib").mkdir()
        for name in ("ffmpeg", "ffprobe"):
            shutil.copy2(prefix / "bin" / name, output / "bin" / name)
        for library in (prefix / "lib").glob("*.dylib"):
            if not library.is_symlink():
                shutil.copy2(library, output / "lib" / library.name)
        # The loader references major-version aliases. Materialize regular files
        # because server ZIPs forbid symbolic links.
        for library in (prefix / "lib").glob("*.dylib"):
            if library.is_symlink():
                shutil.copy2(library.resolve(), output / "lib" / library.name)
        files = {p.relative_to(output).as_posix(): sha256(p) for p in sorted(output.rglob("*")) if p.is_file()}
        metadata = dict(version="7.1.5", sources=PINS, compiler=compiler, configure=options,
                        recipe_sha256=sha256(Path(__file__)), files=files)
        (output / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n")
        verify(output)
        output.rename(result)
    return result


def build(cache):
    with (cache / "ffmpeg-build.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return build_locked(cache)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    built = build(args.cache.resolve())
    args.output.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built, args.output, dirs_exist_ok=True)
    verify(args.output)
    print("Verified reviewed FFmpeg runtime:", args.output)


if __name__ == "__main__":
    main()
