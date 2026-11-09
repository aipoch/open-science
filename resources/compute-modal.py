"""One host-side Modal SDK operation. JSON on stdin/stdout, no credentials in a job."""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import redirect_stdout
from functools import partial
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

SDK_VERSION = "1.6.3"
MOUNT = "/mnt/openscience"
OWNER = ".open-science-owner"
MAX_ENTRIES = 10000


def filename(name):
    if (not name or name in (".", "..") or name.endswith((".", " "))
        or len(name.encode()) > 255 or any(ord(c) < 32 or ord(c) == 127 for c in name)
        or re.search(r'[\\/:*?"<>|]', name)
        or re.match(r'^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)', name, re.I)):
        raise ValueError("unsafe file name")
    return name


def digest_file(source, dest, limit):
    h = hashlib.sha256()
    size = 0
    while chunk := source.read(min(65536, limit - size + 1)):
        size += len(chunk)
        if size > limit:
            raise ValueError("file exceeded bound")
        dest.write(chunk)
        h.update(chunk)
    return size, h.hexdigest()


def upload(vol, req):
    # The SDK opens paths lazily. Keep verified private copies until its batch commits.
    with tempfile.TemporaryDirectory() as directory:
        remaining = min(req["maxBytes"], 2 * 1024**3)
        frozen = []
        for index, item in enumerate(req["files"]):
            name = filename(item["path"])
            size = item["bytes"]
            if size < 0 or size > remaining:
                raise ValueError("input budget")
            fd = os.open(item["localPath"], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
            copy = Path(directory) / str(index)
            with os.fdopen(fd, "rb") as source, copy.open("xb") as dest:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError("invalid input")
                if digest_file(source, dest, size) != (size, item["sha256"]):
                    raise ValueError("input content changed")
            remaining -= size
            frozen.append((copy, "/inputs/" + name))
        with vol.batch_upload(force=True) as batch:
            for path, remote in frozen:
                batch.put_file(path, remote)
            batch.put_file(io.BytesIO(req["nonce"].encode()), "/" + OWNER)


def check_owner(vol, nonce):
    marker = bytearray()
    for chunk in vol.read_file("/" + OWNER):
        if len(marker) + len(chunk) > len(nonce):
            raise ValueError("ownership mismatch")
        marker.extend(chunk)
    if marker != nonce.encode():
        raise ValueError("ownership mismatch")


def completed_outputs(vol, nonce):
    # The Volume can expose an earlier background commit after the Sandbox exits.
    # Use the driver's final inventory to distinguish a subset or stale file generation.
    manifest = bytearray()
    for chunk in vol.read_file("/.open-science-complete"):
        if len(manifest) + len(chunk) > 4 * 1024**2:
            raise ValueError("output inventory exceeds limit")
        manifest.extend(chunk)
    lines = manifest.decode().split("\n")
    if len(lines) < 2 or lines[-2:] != ["complete " + nonce, ""]:
        raise ValueError("incomplete output inventory")
    hashes = {}
    for line in lines[:-2]:
        if not line:
            continue
        match = re.fullmatch(r"([0-9a-f]{64})  \./(.+)", line)
        if not match or len(hashes) >= MAX_ENTRIES:
            raise ValueError("invalid output inventory")
        digest, path = match.groups()
        if path in hashes:
            raise ValueError("duplicate output inventory entry")
        for part in path.split("/"):
            filename(part)
        hashes[path] = digest
    return hashes


def list_outputs(vol, hashes):
    from modal.types import FileEntryType
    files = []
    seen = set()
    import unicodedata
    for index, entry in enumerate(vol.iterdir("/", recursive=True)):
        if index >= MAX_ENTRIES:
            raise ValueError("too many entries in volume")
        path = entry.path.removeprefix("/")
        if path == "outputs" and entry.type != FileEntryType.DIRECTORY:
            raise ValueError("unsafe output root")
        if not path.startswith("outputs/"):
            continue
        path = path[len("outputs/"):]
        parts = path.split("/")
        if len(path) > 1024 or len(parts) > 32:
            raise ValueError("unsafe output path")
        for part in parts:
            filename(part)
        key = unicodedata.normalize("NFC", path).casefold()
        if key in seen:
            raise ValueError("conflicting paths")
        seen.add(key)
        if entry.type == FileEntryType.DIRECTORY:
            continue
        if entry.type != FileEntryType.FILE or entry.size < 0:
            raise ValueError("unsafe volume entry")
        files.append({"path": path, "size_bytes": entry.size})
    if {file["path"] for file in files} != hashes.keys():
        raise ValueError("final output inventory is not visible yet")
    return sorted(files, key=lambda f: f["path"])


def download(vol, req):
    hashes = completed_outputs(vol, req["nonce"])
    entries = {f["path"]: f["size_bytes"] for f in list_outputs(vol, hashes)}
    results = []
    remaining = req["maxBytes"]
    for index, item in enumerate(req["files"]):
        path, expected = item["path"], item["bytes"]
        if expected != entries.get(path) or expected > remaining:
            raise ValueError("output changed")
        local = Path(req["stagingDirectory"]) / str(index)
        h = hashlib.sha256()
        size = 0
        with local.open("xb") as dest:
            for chunk in vol.read_file("/outputs/" + path):
                size += len(chunk)
                if size > expected:
                    raise ValueError("output exceeds its size")
                dest.write(chunk)
                h.update(chunk)
            if size != expected or h.hexdigest() != hashes[path]:
                raise ValueError("incomplete output")
            dest.flush()
            os.fsync(dest.fileno())
        results.append({"path": path, "bytes": size, "sha256": h.hexdigest()})
        remaining -= size
    return results


def lookup_app(req, verify_id):
    # Image and anonymous Secret resolution also consult the environment default.
    os.environ["MODAL_ENVIRONMENT"] = req["environmentName"]
    import modal
    from modal.config import DEFAULT_SERVER_URL, config
    if any(url not in DEFAULT_SERVER_URL.split(",") for url in config["server_url"].split(",")):
        raise ValueError("untrusted Modal endpoint")

    app = modal.App.lookup(req["appName"], environment_name=req["environmentName"], create_if_missing=False)
    if verify_id and app.app_id != req["appId"]:
        raise ValueError("approved app changed")

    return app


class SandboxLaunchNotStarted(Exception):
    pass


def prepare_sandbox(req):
    app = lookup_app(req, verify_id=True)
    import modal
    vol = modal.Volume.from_id(req["volumeId"])
    check_owner(vol, req["nonce"])
    script = """set -eu
umask 077
work=$(mktemp -d)
if [ -d /mnt/openscience/inputs ]; then cp -R /mnt/openscience/inputs/. "$work/"; fi
mkdir -p "$MODAL_JOB_OUTPUT_DIR"
cd "$work"
status=0
/bin/sh -c "$1" || status=$?
cd "$MODAL_JOB_OUTPUT_DIR"
receipt=$(mktemp /mnt/openscience/.complete-XXXXXXXX)
(ulimit -f 8192 && find . -type f -exec sha256sum {} +) > "$receipt"
printf 'complete %s\\n' "$2" >> "$receipt"
mv "$receipt" /mnt/openscience/.open-science-complete
exit "$status" """
    return partial(modal.Sandbox.create, "/bin/sh", "-c", script, "job", req["command"], req["nonce"],
            name="os-" + req["nonce"], app=app,
            image=modal.Image.from_registry(req["image"]), volumes={MOUNT: vol},
            cpu=req["cpus"], memory=req["memoryMiB"], gpu=req.get("gpu"), timeout=req["timeoutSeconds"],
            env={"MODAL_JOB_OUTPUT_DIR": MOUNT + "/outputs", "OUTPUT_DIR": MOUNT + "/outputs"},
            tags={"reservation": req["nonce"], "volume": req["volumeId"]})


def main(action, req):
    if action == "launch":
        try:
            create = prepare_sandbox(req)
        except Exception:
            raise SandboxLaunchNotStarted() from None
        # Even an authentication error raised by create() may follow a successful remote launch.
        return {"sandboxId": create().object_id}

    app = lookup_app(req, verify_id=action != "target")
    if action == "target":
        return {"appId": app.app_id}
    import modal
    from modal_proto import api_pb2
    from modal.client import _Client

    # The public Volume manager discards the create receipt and resolves a name again
    # when deleting. Use the pinned SDK's ID-based RPCs for these two operations.
    if action in ("create-volume", "cleanup"):
        from modal._utils.async_utils import synchronize_api

        # App.lookup opened the host client on Modal's own event loop.
        @synchronize_api
        async def mutate():
            client = await _Client.from_env()
            if action == "create-volume":
                response = await client._stub.VolumeGetOrCreate(api_pb2.VolumeGetOrCreateRequest(
                    deployment_name=req["volumeName"], environment_name=req["environmentName"],
                    object_creation_type=api_pb2.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS), retry=None)
                return {"volumeId": response.volume_id}
            try:
                await client._stub.VolumeDelete(api_pb2.VolumeDeleteRequest(volume_id=req["volumeId"]))
            except modal.exception.NotFoundError:
                pass
        return mutate()

    vol = modal.Volume.from_id(req["volumeId"])
    if action == "stage":
        upload(vol, req)
    elif action in ("list", "download"):
        check_owner(vol, req["nonce"])
        if action == "list":
            return list_outputs(vol, completed_outputs(vol, req["nonce"]))
        return download(vol, req)
    elif action in ("inspect", "terminate"):
        sb = modal.Sandbox.from_id(req["sandboxId"])
        # from_id already ran SandboxWait(timeout=0). Preserve the provider status:
        # setup failures can carry the protobuf default exit code of zero.
        metadata = sb._get_metadata()
        if metadata.app_id != req["appId"]:
            raise ValueError("sandbox app mismatch")
        tags = sb.get_tags()
        if tags.get("reservation") != req["nonce"] or tags.get("volume") != req["volumeId"]:
            raise ValueError("sandbox identity mismatch")
        if action == "terminate":
            sb.terminate()
            return
        code = sb.returncode
        state = metadata.result.status
        outcome = api_pb2.GenericResult
        if state == outcome.GENERIC_STATUS_UNSPECIFIED:
            status = "running"
        elif state in (outcome.GENERIC_STATUS_TIMEOUT, outcome.GENERIC_STATUS_IDLE_TIMEOUT):
            status = "timeout"
        elif state == outcome.GENERIC_STATUS_TERMINATED:
            status = "cancelled"
        elif state == outcome.GENERIC_STATUS_SUCCESS and code == 0:
            status = "succeeded"
        else:
            status = "failed"
            if code == 0:
                code = None
        result = {"status": status, "exitCode": code}
        try:
            for source in ("stdout", "stderr"):
                tail = "".join(entry.message[-8192:] for entry in sb.logs.tail(16, source=source))
                if tail:
                    result[source + "Tail"] = tail[-8192:]
        except modal.exception.Error:
            pass
        return result
    else:
        raise ValueError("unknown operation")


if __name__ == "__main__":
    try:
        if version("modal") != SDK_VERSION:
            raise PackageNotFoundError()
        with redirect_stdout(sys.stderr):
            envelope = json.load(sys.stdin)
            material = envelope.get("managedIdentity")
            if material is not None:
                for key in list(os.environ):
                    if key.startswith("MODAL_"):
                        del os.environ[key]
                os.environ["MODAL_CONFIG_PATH"] = os.devnull
                os.environ["MODAL_TOKEN_ID"] = material["tokenId"]
                os.environ["MODAL_TOKEN_SECRET"] = material["tokenSecret"]
            result = main(sys.argv[1], envelope["request"])
        print(json.dumps({"result": result}, separators=(",", ":")))
    except SandboxLaunchNotStarted:
        print(json.dumps({"error": "sandbox-not-started"}))
    except PackageNotFoundError:
        print(json.dumps({"error": "sdk-version"}))
    except Exception as error:
        # SDK exception text can contain commands or credential details.
        print(json.dumps({"error": type(error).__name__}))
