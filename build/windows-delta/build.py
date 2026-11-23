"""Build the patch helper from digest-pinned sources. Requires Python 3 and CMake."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

SOURCES = (
    ("hdiff", "sisong/HDiffPatch", "v5.1.3", "435c46447e7a1ace0327b67da2ec50a06e7f02d19960a182b493ff2e3f91c2b0", ("libHDiffPatch/HPatch/", "decompress_plugin_demo.h", "LICENSE")),
    ("seven", "ip7z/7zip", "24.09", "e4757b307925227724a2044651193664ba3d04e9ac13b8e631f1667896014bbf", ("C/", "DOC/License.txt")),
    ("zstd", "facebook/zstd", "v1.5.7", "37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3", ("lib/", "LICENSE")),
)

def stage_sources(cache):
    for name, repo, version, expected, paths in SOURCES:
        dest = cache / name
        archive = cache / (name + ".tar.gz")
        if not archive.exists():
            url = f"https://codeload.github.com/{repo}/tar.gz/refs/tags/{version}"
            with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temp:
                try:
                    with urllib.request.urlopen(url, timeout=60) as reply:
                        shutil.copyfileobj(reply, temp)
                    temp.close()
                    os.replace(temp.name, archive)
                finally:
                    Path(temp.name).unlink(missing_ok=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Unexpected source digest for {repo}")
        with tarfile.open(archive) as source:
            for entry in source:
                parts = Path(entry.name).parts[1:]
                rel = "/".join(parts)
                if not entry.isfile() or not any(rel == p or (p.endswith("/") and rel.startswith(p)) for p in paths):
                    continue
                file = (dest / rel).resolve()
                file.relative_to(dest.resolve())
                file.parent.mkdir(parents=True, exist_ok=True)
                with file.open("wb") as output, source.extractfile(entry) as inp:
                    shutil.copyfileobj(inp, output)

def build(output):
    cache = output / "vendor"
    cache.mkdir(parents=True, exist_ok=True)
    stage_sources(cache)
    cmake = shutil.which("cmake")
    if not cmake and os.name == "nt":
        vswhere = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft Visual Studio/Installer/vswhere.exe"
        matches = subprocess.check_output([str(vswhere), "-latest", "-products", "*", "-find", "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"], text=True).splitlines()
        cmake = matches[0] if matches else None
    if not cmake:
        raise RuntimeError("CMake is required to build the Windows delta helper")
    obj = output / "obj"
    subprocess.run([cmake, "-S", str(Path(__file__).resolve().parent), "-B", str(obj),
                    "-DVENDOR=" + cache.as_posix(), "-DCMAKE_BUILD_TYPE=Release",
                    *(["-A", "x64"] if os.name == "nt" else [])], check=True)
    subprocess.run([cmake, "--build", str(obj), "--config", "Release", "--parallel", "4"], check=True)
    subprocess.run([cmake, "--install", str(obj), "--config", "Release", "--prefix", str(output / "bin")], check=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output.resolve())
