"""Replace OpenCV's obsolete FFmpeg copies with the reviewed same-ABI build."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from metal_wheels import read_wheel, sha256, write_wheel

COMPONENTS = ("libavcodec", "libavformat", "libavutil", "libavdevice", "libavfilter",
              "libswscale", "libswresample", "libpostproc")


def dependencies(path):
    text = subprocess.check_output(["/usr/bin/otool", "-L", str(path)], text=True)
    return [line.strip().split(" (compatibility version", 1)[0] for line in text.splitlines()[1:] if line.strip()]


def checked_run(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{arguments[0]} failed")


def prepare_media_wheel(item, cache, runtime):
    source = cache / item["filename"]
    if sha256(source) != item["sha256"]:
        raise RuntimeError("media wheel source checksum mismatch")
    patch = item["native_patch"]
    provenance = json.loads((runtime / "provenance.json").read_text())
    pin = next(x for x in provenance["sources"] if x["name"] == "ffmpeg")
    if pin["sha256"] != patch["source_sha256"] or provenance["version"] != patch["version"]:
        raise RuntimeError("media wheel replacement source pin mismatch")
    for name, expected in provenance["files"].items():
        if sha256(runtime / name) != expected:
            raise RuntimeError("media wheel replacement build checksum mismatch")
    entries, attributes = read_wheel(source)
    prefix = "cv2/.dylibs/"
    targets = {}
    for component in COMPONENTS:
        names = [n for n in entries if n.startswith(prefix + component + ".") and n.endswith(".dylib")]
        if len(names) > 1:
            raise RuntimeError("ambiguous OpenCV media library")
        if names:
            targets[component] = names[0]
    if not all(name in targets for name in ("libavcodec", "libavformat", "libavutil", "libswscale")):
        raise RuntimeError("OpenCV wheel media library layout changed")
    replaced = {}
    with tempfile.TemporaryDirectory(prefix="opencv-media-", dir=cache) as temporary:
        work = Path(temporary)
        for name, data in entries.items():
            if name.endswith((".so", ".dylib")):
                target = work / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        for component, name in targets.items():
            # Preserve the wheel's major ABI and load paths. Only a same-series
            # FFmpeg security release can supply these replacement libraries.
            old_major = Path(name).name.split(".")[1]
            candidates = list((runtime / "lib").glob(component + "." + old_major + ".*.*.dylib"))
            if len(candidates) != 1:
                raise RuntimeError("FFmpeg replacement major ABI mismatch: " + component)
            replacement = work / name
            shutil.copy2(candidates[0], replacement)
            arguments = ["/usr/bin/install_name_tool", "-id", "@loader_path/" + Path(name).name]
            for dependency in dependencies(replacement)[1:]:
                dependency_component = Path(dependency).name.split(".")[0]
                if dependency_component in targets:
                    arguments += ["-change", dependency, "@loader_path/" + Path(targets[dependency_component]).name]
                elif not dependency.startswith(("/usr/lib/", "/System/Library/")):
                    raise RuntimeError("unreviewed external media dependency: " + dependency)
            checked_run(arguments + [str(replacement)])
            checked_run(["/usr/bin/codesign", "--force", "--sign", "-", str(replacement)])
            checked_run(["/usr/bin/codesign", "--verify", "--strict", str(replacement)])
            entries[name] = replacement.read_bytes()
            replaced[name] = sha256(replacement)
        # Remove obsolete codecs pulled in solely by the old FFmpeg build.
        # Roots include native package modules/plugins outside the library folder.
        native = {name: work / name for name in entries if name.endswith((".so", ".dylib"))}
        by_basename = {}
        for name in native:
            by_basename.setdefault(Path(name).name, []).append(name)
        pending = [name for name in native if not name.startswith(prefix)]
        retained = set()
        while pending:
            name = pending.pop()
            if name in retained:
                continue
            retained.add(name)
            links = dependencies(native[name])
            if name.endswith(".dylib"):
                links = links[1:]  # The first dylib load command is its own ID.
            for dependency in links:
                if dependency.startswith(("/usr/lib/", "/System/Library/")):
                    continue
                candidates = by_basename.get(Path(dependency).name, [])
                if len(candidates) != 1:
                    raise RuntimeError("unresolved packaged OpenCV dependency: " + dependency)
                pending.extend(candidates)
        removed = sorted(name for name in native if name.startswith(prefix) and name not in retained)
        for name in removed:
            del entries[name]
            del attributes[name]
        record = next(name for name in entries if name.endswith(".dist-info/RECORD"))
        notice = record.removesuffix("RECORD") + "licenses/umbratic-ffmpeg.json"
        details = dict(component="FFmpeg", version=patch["version"], source=pin,
                       recipe_sha256=provenance["recipe_sha256"], compiler=provenance["compiler"],
                       replaced={name: digest for name, digest in replaced.items() if name in retained},
                       removed=removed, source_bundle="runtime/sources/ffmpeg",
                       notices="runtime/notices/ffmpeg")
        entries[notice] = (json.dumps(details, indent=2, sort_keys=True) + "\n").encode()
        attributes[notice] = 0o100644 << 16
        result = write_wheel(entries, attributes, cache / patch["filename"])
    return result, details


def prepare_torchcodec_wheel(item, pyav, cache):
    """Bind adapter 8 to the locked PyAV runtime already in this environment."""
    import ctypes
    import email
    source = cache / item["filename"]
    av_source = cache / pyav["filename"]
    patch = item["native_patch"]
    if (sha256(source) != item["sha256"] or sha256(av_source) != pyav["sha256"]
            or pyav["sha256"] != patch["wheel_sha256"] or pyav["package_version"] != patch["wheel_version"]):
        raise RuntimeError("TorchCodec/PyAV source pin mismatch")
    entries, attributes = read_wheel(source)
    av_entries, _ = read_wheel(av_source)
    libraries = {Path(name).name.split(".")[0]: name for name in av_entries
                 if name.startswith("av/.dylibs/") and name.endswith(".dylib")
                 and Path(name).name.split(".")[0] in COMPONENTS}
    targets = ("torchcodec/libtorchcodec_core8.dylib", "torchcodec/libtorchcodec_custom_ops8.dylib")
    if not all(name in entries for name in targets):
        raise RuntimeError("TorchCodec FFmpeg8 adapter layout changed")
    replacements = {}
    with tempfile.TemporaryDirectory(prefix="torchcodec-media-", dir=cache) as temporary:
        work = Path(temporary)
        av_library = libraries.get("libavutil")
        if not av_library:
            raise RuntimeError("PyAV FFmpeg library layout changed")
        for name, data in av_entries.items():
            if name.startswith("av/.dylibs/") and name.endswith(".dylib"):
                target = work / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        loaded = ctypes.CDLL(str(work / av_library))
        loaded.av_version_info.restype = ctypes.c_char_p
        if loaded.av_version_info().decode() != patch["version"]:
            raise RuntimeError("PyAV embedded FFmpeg version changed")
        providers = {}
        pending = list(libraries.values())
        while pending:
            name = pending.pop()
            if name in providers:
                continue
            providers[name] = sha256(work / name)
            checked_run(["/usr/bin/codesign", "--verify", "--strict", str(work / name)])
            for dependency in dependencies(work / name)[1:]:
                if dependency.startswith(("/usr/lib/", "/System/Library/")):
                    continue
                if not dependency.startswith("@loader_path/"):
                    raise RuntimeError("unexpected PyAV provider load path: " + dependency)
                provider = "av/.dylibs/" + Path(dependency).name
                if provider not in av_entries:
                    raise RuntimeError("missing PyAV codec provider: " + dependency)
                pending.append(provider)
        for name in targets:
            binary = work / Path(name).name
            binary.write_bytes(entries[name])
            arguments = ["/usr/bin/install_name_tool"]
            for dependency in dependencies(binary)[1:]:
                component = Path(dependency).name.split(".")[0]
                if component not in COMPONENTS:
                    continue
                replacement = libraries.get(component)
                if not replacement or Path(dependency).name.split(".")[1] != Path(replacement).name.split(".")[1]:
                    raise RuntimeError("TorchCodec/PyAV FFmpeg major ABI mismatch")
                path = "@loader_path/../" + replacement
                arguments += ["-change", dependency, path]
                replacements[dependency] = path
            if len(arguments) > 1:
                checked_run(arguments + [str(binary)])
                checked_run(["/usr/bin/codesign", "--force", "--sign", "-", str(binary)])
                checked_run(["/usr/bin/codesign", "--verify", "--strict", str(binary)])
                entries[name] = binary.read_bytes()
    if not replacements:
        raise RuntimeError("TorchCodec adapter has no FFmpeg bindings")
    metadata = next(name for name in entries if name.endswith(".dist-info/METADATA"))
    value = entries[metadata]
    if b"\n\n" not in value:
        raise RuntimeError("TorchCodec metadata header separator changed")
    requirement = "av==" + pyav["package_version"]
    if any(x.split(";", 1)[0].strip().lower().startswith("av") for x in email.message_from_bytes(value).get_all("Requires-Dist", [])):
        raise RuntimeError("TorchCodec already declares a PyAV dependency")
    entries[metadata] = value.replace(b"\n\n", ("\nRequires-Dist: " + requirement + "\n\n").encode(), 1)
    details = dict(component="FFmpeg via PyAV", version=patch["version"], referenced_wheel=pyav,
                   adapter_major=8, replacements=replacements, providers=providers,
                   license="Existing PyAV native LGPL3 runtime; original wheel notices retained")
    record = next(name for name in entries if name.endswith(".dist-info/RECORD"))
    notice = record.removesuffix("RECORD") + "licenses/umbratic-pyav-ffmpeg.json"
    entries[notice] = (json.dumps(details, indent=2, sort_keys=True) + "\n").encode()
    attributes[notice] = 0o100644 << 16
    return write_wheel(entries, attributes, cache / patch["filename"]), details
