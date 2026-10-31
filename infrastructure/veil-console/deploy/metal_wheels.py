"""Seal reviewed wheel changes without executing package code."""
import base64
import csv
import email
import hashlib
import io
import json
from pathlib import Path
import stat
import zipfile


def sha256(path):
    with path.open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
        return digest.hexdigest()


def read_wheel(source):
    entries, attributes, total = {}, {}, 0
    with zipfile.ZipFile(source) as wheel:
        for entry in wheel.infolist():
            name = entry.filename
            if entry.is_dir():
                continue
            if (name in entries or name.startswith(("/", "\\")) or "\\" in name
                    or ".." in Path(name).parts or ":" in name
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise RuntimeError("unsafe wheel member")
            total += entry.file_size
            if entry.file_size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024:
                raise RuntimeError("reviewed patch wheel is oversized")
            entries[name] = wheel.read(entry)
            attributes[name] = entry.external_attr
    records = [name for name in entries if name.endswith(".dist-info/RECORD")]
    if len(records) != 1 or any(name in entries for name in (records[0] + ".jws", records[0] + ".p7s")):
        raise RuntimeError("wheel RECORD is missing or signed")
    return entries, attributes


def write_wheel(entries, attributes, destination, expected_sha256=None):
    record = next(name for name in entries if name.endswith(".dist-info/RECORD"))
    rows = []
    for name, data in sorted(entries.items()):
        if name != record:
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
            rows.append((name, "sha256=" + digest, str(len(data))))
    rows.append((record, "", ""))
    text = io.StringIO(newline="")
    csv.writer(text, lineterminator="\n").writerows(rows)
    entries[record] = text.getvalue().encode()
    temporary = destination.with_suffix(".partial")
    try:
        with zipfile.ZipFile(temporary, "w") as wheel:
            for name, data in sorted(entries.items()):
                # Stored members avoid compressor-version differences. File
                # permissions remain those of the verified source wheel.
                entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = attributes[name]
                wheel.writestr(entry, data, compress_type=zipfile.ZIP_STORED)
        if expected_sha256 and sha256(temporary) != expected_sha256:
            raise RuntimeError("patched wheel checksum mismatch")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def prepare_wheel(item, cache, patch_root):
    source = cache / item["filename"]
    if sha256(source) != item["sha256"]:
        raise RuntimeError("wheel source checksum mismatch: " + item["filename"])
    patch = item.get("metadata_patch")
    if not patch:
        return source
    patch_path = patch_root / patch["path"]
    if sha256(patch_path) != patch["sha256"]:
        raise RuntimeError("wheel metadata patch checksum mismatch")
    replacement = json.loads(patch_path.read_text())
    if any(character in replacement["from"] + replacement["to"] for character in "\r\n"):
        raise RuntimeError("metadata patch requirements must be single lines")
    entries, attributes = read_wheel(source)
    metadata = [name for name in entries if name.endswith(".dist-info/METADATA")]
    if len(metadata) != 1:
        raise RuntimeError("wheel must have one METADATA file")
    metadata = metadata[0]
    before = email.message_from_bytes(entries[metadata])
    old = ("Requires-Dist: " + replacement["from"] + "\n").encode()
    new = ("Requires-Dist: " + replacement["to"] + "\n").encode()
    if entries[metadata].count(old) != 1:
        raise RuntimeError("metadata patch must replace exactly one requirement")
    entries[metadata] = entries[metadata].replace(old, new)
    after = email.message_from_bytes(entries[metadata])
    if before["Name"] != after["Name"] or before["Version"] != after["Version"]:
        raise RuntimeError("metadata patch changed package identity")
    if any("git+" in value.lower() for value in after.get_all("Requires-Dist", [])):
        raise RuntimeError("patched wheel still requires a Git package")
    return write_wheel(entries, attributes, cache / patch["filename"], patch["wheel_sha256"])
