"""Check electron-builder's block checksums against each ZIP selected for publication."""

import base64
import gzip
import hashlib
import json
import sys
from pathlib import Path


def verify(zip_path):
    with gzip.open(str(zip_path) + ".blockmap", "rt") as stream:
        blockmap = json.load(stream)
    [entry] = blockmap["files"]
    if blockmap["version"] != "2" or entry["name"] != "file" or entry["offset"] != 0:
        raise ValueError(f"Invalid ZIP blockmap for {zip_path}")
    if not entry["sizes"] or len(entry["sizes"]) != len(entry["checksums"]):
        raise ValueError(f"Incomplete ZIP blockmap for {zip_path}")
    with zip_path.open("rb") as archive:
        for size, expected in zip(entry["sizes"], entry["checksums"]):
            if not isinstance(size, int) or not 0 < size <= 32768:
                raise ValueError(f"Invalid block size for {zip_path}")
            block = archive.read(size)
            checksum = base64.b64encode(hashlib.blake2b(block, digest_size=18).digest()).decode()
            if len(block) != size or checksum != expected:
                raise ValueError(f"Blockmap differs from final ZIP: {zip_path}")
        if archive.read(1):
            raise ValueError(f"Blockmap ends before final ZIP: {zip_path}")


for filename in sys.argv[1:]:
    verify(Path(filename))
