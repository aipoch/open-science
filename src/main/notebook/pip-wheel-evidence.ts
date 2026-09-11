// Read-only recovery for older pip installs that predate install reports. A version pin alone
// is insufficient: accept a public wheel only when all its payload bytes match this environment.
const PIP_WHEEL_EVIDENCE_SCRIPT = String.raw`
import csv, hashlib, io, json, os, pathlib, sys, time, urllib.request, zipfile
from email.parser import Parser

prefix = pathlib.Path(sys.argv[1]).resolve()
requested = set(json.loads(sys.argv[2]))
deadline = time.monotonic() + 15
limit = 64 * 1024 * 1024
result = []

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def fetch(url, maximum):
    if time.monotonic() >= deadline:
        raise TimeoutError()
    with opener.open(url, timeout=min(5, max(0.1, deadline - time.monotonic()))) as response:
        from urllib.parse import urlsplit
        endpoint = urlsplit(response.url)
        if endpoint.scheme != "https" or endpoint.hostname not in ("pypi.org", "files.pythonhosted.org"):
            raise ValueError("unsupported wheel origin")
        content = response.read(maximum + 1)
        if len(content) > maximum:
            raise ValueError("wheel evidence budget exceeded")
        return content

def normalize(name):
    import re
    return re.sub(r"[-_.]+", "-", name).lower()

def generated_scripts(dist, site, payload):
    entry_points = dist.name + "/entry_points.txt"
    if entry_points not in payload:
        return set()
    # Reuse the bound pip's generator in memory. A changed installer template fails closed.
    import configparser
    from pip._internal.operations.install.wheel import PipScriptMaker
    from pip._vendor.distlib.util import get_export_entry
    generated = {}
    class EvidenceScriptMaker(PipScriptMaker):
        def _write_script(self, names, shebang, script_bytes, filenames, ext):
            for name in names:
                if name in generated:
                    raise ValueError("conflicting generated entry point")
                generated[name] = shebang + script_bytes
    config = configparser.ConfigParser(interpolation=None)
    config.optionxform = str
    config.read_string((dist / "entry_points.txt").read_text())
    maker = EvidenceScriptMaker(None, str(prefix / "bin"))
    maker.variants = {""}
    for group in ("console_scripts", "gui_scripts"):
        for name, value in (config.items(group) if config.has_section(group) else []):
            # Windows launchers embed a timestamped ZIP and need separate verification.
            if os.name == "nt":
                raise ValueError("unsupported generated launcher")
            if not name or name in (".", "..") or "/" in name or "\\" in name or len(generated) >= 128:
                raise ValueError("unsupported entry point name")
            specification = name + " = " + value
            entry = get_export_entry(specification)
            if entry is None or not entry.suffix:
                raise ValueError("invalid generated entry point")
            maker.make(specification, {"gui": group == "gui_scripts"})
    paths = set()
    for name, expected in generated.items():
        target = prefix / "bin" / name
        if not target.resolve().is_relative_to(prefix) or not target.is_file() or target.stat().st_size != len(expected) or target.read_bytes() != expected:
            raise ValueError("generated entry point differs")
        paths.add(pathlib.PurePath(os.path.relpath(target, site)).as_posix())
    return paths

sites = [prefix / "Lib" / "site-packages", *prefix.glob("lib/python*/site-packages")]
sites = list({site.resolve() for site in sites if site.is_dir()})
if len(sites) == 1 and sites[0].is_relative_to(prefix):
    site = sites[0]
    for dist in sorted(site.glob("*.dist-info")):
        try:
            if time.monotonic() >= deadline:
                break
            if dist.is_symlink() or not dist.resolve().is_relative_to(prefix):
                continue
            metadata = (dist / "METADATA").read_text()
            identity = Parser().parsestr(metadata)
            name, version = normalize(identity["Name"]), identity["Version"]
            if "python:" + name not in requested:
                continue
            if (dist / "INSTALLER").read_text().strip() != "pip" or (dist / "direct_url.json").exists():
                continue
            wheel_metadata = Parser().parsestr((dist / "WHEEL").read_text())
            tags = set(wheel_metadata.get_all("Tag", []))
            if not tags:
                continue
            from urllib.parse import quote, urlsplit
            release = json.loads(fetch("https://pypi.org/pypi/" + quote(name, safe="") + "/" + quote(version, safe="") + "/json", 2 * 1024 * 1024))
            for item in release.get("urls", []):
                filename, url = item.get("filename", ""), item.get("url", "")
                endpoint = urlsplit(url)
                if item.get("packagetype") != "bdist_wheel" or item.get("yanked") or endpoint.scheme != "https" or endpoint.hostname != "files.pythonhosted.org" or endpoint.username or endpoint.password or endpoint.port or endpoint.query or endpoint.fragment:
                    continue
                parts = filename.removesuffix(".whl").rsplit("-", 3)
                if len(parts) != 4:
                    continue
                candidate_tags = {p + "-" + a + "-" + t for p in parts[-3].split(".") for a in parts[-2].split(".") for t in parts[-1].split(".")}
                if not tags.intersection(candidate_tags) or item.get("size", limit + 1) > limit:
                    continue
                content = fetch(url, limit)
                digest = hashlib.sha256(content).hexdigest()
                if digest != item.get("digests", {}).get("sha256"):
                    continue
                with zipfile.ZipFile(io.BytesIO(content)) as wheel:
                    entries = wheel.infolist()
                    if len({entry.filename for entry in entries}) != len(entries) or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
                        continue
                    matched = True
                    payload = set()
                    for entry in entries:
                        if entry.is_dir() or entry.filename.endswith(".dist-info/RECORD"):
                            continue
                        path = pathlib.PurePosixPath(entry.filename)
                        if path.is_absolute() or ".." in path.parts:
                            matched = False
                            break
                        if path.parts[0].endswith(".data"):
                            # PEP 427 spreads library payloads into site-packages. Scripts,
                            # headers and prefix data still need installer-specific mapping.
                            if path.parts[0] != dist.name.removesuffix(".dist-info") + ".data" or len(path.parts) < 3 or path.parts[1] not in ("purelib", "platlib"):
                                matched = False
                                break
                            path = pathlib.PurePosixPath(*path.parts[2:])
                        target = site.joinpath(*path.parts)
                        if path.as_posix() in payload or not target.resolve().is_relative_to(prefix) or not target.is_file() or target.stat().st_size != entry.file_size:
                            matched = False
                            break
                        if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(wheel.read(entry)).digest():
                            matched = False
                            break
                        payload.add(path.as_posix())
                    installed = {row[0] for row in csv.reader(io.StringIO((dist / "RECORD").read_text())) if row}
                    # Installation-only metadata and generated bytecode do not belong to the wheel.
                    installed = {path for path in installed if not path.endswith(".pyc") and path not in {dist.name + "/" + leaf for leaf in ("RECORD", "INSTALLER", "REQUESTED")}}
                    if not matched or dist.name + "/METADATA" not in payload:
                        continue
                    payload.update(generated_scripts(dist, site, payload))
                    if installed != payload:
                        continue
                result.append({"metadata": {"name": name, "version": version}, "download_info": {"url": url, "archive_info": {"hashes": {"sha256": digest}}}})
                break
        except Exception:
            continue
print(json.dumps({"version": "1", "install": result}))
`

export { PIP_WHEEL_EVIDENCE_SCRIPT }
