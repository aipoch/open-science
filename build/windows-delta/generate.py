"""Create a version-pair WEX1 only after reconstructing the final signed NSIS bytes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import subprocess
import tempfile
import zlib


class UnsupportedPair(Exception):
    """Keep the stock update feed when this installer layout cannot be reproduced."""


def sha512(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha512").digest()


def segments(data):
    """Walk independent dictionary resets in the first LZMA2 stream of a 7z folder."""
    pos = start = expanded = 0
    while pos < len(data):
        control = data[pos]
        if control == 0 or (pos > start and (control == 1 or control >= 224)):
            if pos - start >= 256 and 1024 <= expanded <= 8 << 20:
                yield start, pos, expanded
            start, expanded = pos, 0
        if control == 0:
            return
        if control in (1, 2):
            size = 1 + int.from_bytes(data[pos + 1:pos + 3], "big")
            pos += 3 + size
        elif control >= 128:
            size = 1 + ((control & 31) << 16) + int.from_bytes(data[pos + 1:pos + 3], "big")
            packed = 1 + int.from_bytes(data[pos + 3:pos + 5], "big")
            pos += 5 + (control >= 192) + packed
        else:
            raise UnsupportedPair("Invalid LZMA2 control byte")
        expanded += size
    raise UnsupportedPair("Truncated LZMA2 stream")


def inventory(installer, tool, scratch):
    data = installer.read_bytes()
    magic = bytes.fromhex("37 7a bc af 27 1c")
    cursor = 0
    while (offset := data.find(magic, cursor)) >= 0:
        cursor = offset + 1
        if offset + 32 > len(data):
            continue
        crc, packed_size, header_size, next_crc = struct.unpack_from("<IQQI", data, offset + 8)
        start = offset + 32 + packed_size
        end = start + header_size
        if end > len(data) or crc != zlib.crc32(data[offset + 12:offset + 32]) or next_crc != zlib.crc32(data[start:end]):
            continue
        archive = scratch / "payload.7z"
        archive.write_bytes(data[offset:end])
        listing = subprocess.check_output([tool, "l", "-slt", "-sccUTF-8", str(archive)]).decode("utf-8")
        records = [dict(line.split(" = ", 1) for line in part.splitlines() if " = " in line)
                   for part in re.split(r"\r?\n\r?\n", listing.split("----------")[-1].strip())]
        if not any(r.get("Path", "").replace("\\", "/") == "resources/app.asar" for r in records):
            continue
        blocks = sorted((r for r in records if r.get("Block") and r.get("Packed Size")), key=lambda r: int(r["Block"]))
        at = offset + 32
        chosen = []
        for index, record in enumerate(blocks):
            if int(record["Block"]) != index:
                raise UnsupportedPair("Expected non-solid NSIS archive")
            size = int(record["Packed Size"])
            method = record.get("Method", "")
            if size >= 256 and ("LZMA2:" in method and ("BCJ2" in method or method.startswith("LZMA2:"))):
                region = memoryview(data)[at:at + size]
                for a, b, n in segments(region):
                    chosen.append(((at + a, b - a, n), hashlib.sha256(region[a:b]).digest()))
            at += size
        return chosen
    raise UnsupportedPair("Missing NSIS application archive")


def generate(args, temp):
    old = inventory(args.old, args.seven, temp)
    new = inventory(args.new, args.seven, temp)
    old_keys, new_keys = {key for _, key in old}, {key for _, key in new}
    old_plan = [row for row, key in old if key not in new_keys]
    new_plan = [row for row, key in new if key not in old_keys]
    old_view, new_view = temp / "old.view", temp / "new.view"
    def run(*command):
        subprocess.run(command, check=True)
    for file, plan, view in ((args.old, old_plan, old_view), (args.new, new_plan, new_view)):
        recipe = temp / "regions"
        recipe.write_bytes(b"".join(struct.pack("<III", *row) for row in plan))
        run(args.worker, "basis", file, recipe, view)
    body = temp / "delta"
    run(args.hdiff, "-m-8", "-block-4k", "-SD", "-c-zstd-21-25", "-p-1", old_view, new_view, body)
    old_size, new_size = old_view.stat().st_size, new_view.stat().st_size
    new_view.unlink()
    run(args.worker, "patch", old_view, body, new_view)
    old_view.unlink()
    rebuilt = temp / "setup.exe"
    # A different encoder may legitimately produce different lengths. Publish only exact pairs.
    try:
        run(args.worker, "restore", new_view, rebuilt, str(args.new.stat().st_size))
    except subprocess.CalledProcessError as error:
        raise UnsupportedPair("Target compression settings are not reproducible") from error
    source_hash, target_hash = sha512(args.old), sha512(args.new)
    if sha512(rebuilt) != target_hash:
        raise UnsupportedPair("Windows delta failed exact signed installer round trip")
    header = b"WEX1" + source_hash + target_hash + zlib.compress(json.dumps(old_plan, separators=(",", ":")).encode(), 9)
    size = 4 + len(header) + body.stat().st_size
    if size > 64 << 20 or size >= args.new.stat().st_size:
        raise UnsupportedPair("Windows delta exceeds download budget")
    args.output.write_bytes(struct.pack("<I", len(header)) + header + body.read_bytes())
    args.metadata.write_text(json.dumps(dict(format=1, size=size, oldViewSize=old_size, newViewSize=new_size,
                                             sha512=base64.b64encode(sha512(args.output)).decode(),
                                             sourceSha512=base64.b64encode(source_hash).decode())), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("old", "new", "output", "metadata"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--hdiff", required=True)
    parser.add_argument("--seven", default="7z")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(dir=args.output.parent) as directory:
        try:
            generate(args, Path(directory))
        except UnsupportedPair as error:
            print(f"Using blockmap for this version pair: {error}", file=sys.stderr)
            sys.exit(3)
