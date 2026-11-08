"""Authenticate the desktop host. Only JSON protocol records go to its private stdout pipe."""
import asyncio
import json
import os
import socket
import stat
import sys
from contextlib import contextmanager, redirect_stdout
from importlib.metadata import PackageNotFoundError, version


@contextmanager
def protocol_writer():
    # Node supplies a pipe on Windows and can use a local socketpair on Unix.
    with os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n") as channel:
        mode = os.fstat(channel.fileno()).st_mode
        if stat.S_ISSOCK(mode):
            with socket.socket(fileno=os.dup(channel.fileno())) as peer:
                if peer.family != socket.AF_UNIX:
                    raise SystemExit("Modal authentication requires a local IPC channel.")
        elif not stat.S_ISFIFO(mode):
            raise SystemExit("Modal authentication requires a local IPC channel.")

        def emit(record):
            channel.write(json.dumps(record, separators=(",", ":")) + "\n")
            channel.flush()

        yield emit


async def run(request, emit):
    from modal.client import _Client
    from modal.config import DEFAULT_SERVER_URL, config
    from modal.exception import AuthError, InvalidError, PermissionDeniedError
    from modal.token_flow import _TokenFlow
    from google.protobuf.empty_pb2 import Empty

    try:
        if request["action"] == "authorize":
            async with _Client.anonymous(DEFAULT_SERVER_URL) as client:
                flow = _TokenFlow(client)
                async with flow.start() as (_, url, code):
                    emit({"url": url, "userCode": code})
                    while True:
                        receipt = await flow.finish()
                        if receipt is not None:
                            emit({"tokenId": receipt.token_id, "tokenSecret": receipt.token_secret})
                            return
        elif request["action"] == "probe":
            if not all(endpoint in DEFAULT_SERVER_URL.split(",") for endpoint in config["server_url"].split(",")):
                emit({"error": "authorization"})
                return
            keys = ("token_id", "token_secret", "oauth_refresh_token", "oauth_client_id",
                    "oauth_client_secret", "oauth_jwt_key")
            if not any(config.get(key) for key in keys):
                emit({"error": "missing"})
                return
            client = await _Client.from_env()
            info = await client._stub.WorkspaceNameLookup(Empty(), retry=None, timeout=10)
            emit({"workspace": info.username})
        else:
            emit({"error": "authorization"})
    except (AuthError, InvalidError, PermissionDeniedError):
        emit({"error": "authorization"})


def main(emit):
    try:
        request = json.load(sys.stdin)
        if request["action"] == "authorize" or "material" in request:
            # Prevent ambient tokens, selected profiles or API endpoints from overriding this source.
            for key in list(os.environ):
                if key.startswith("MODAL_"):
                    del os.environ[key]
            os.environ["MODAL_CONFIG_PATH"] = os.devnull
            if "material" in request:
                os.environ["MODAL_TOKEN_ID"] = request["material"]["tokenId"]
                os.environ["MODAL_TOKEN_SECRET"] = request["material"]["tokenSecret"]
        if version("modal") != "1.6.3":
            raise PackageNotFoundError()
        with redirect_stdout(sys.stderr):
            asyncio.run(run(request, emit))
    except (ImportError, PackageNotFoundError):
        emit({"error": "dependency"})
    except Exception:
        # Provider exceptions can contain authentication data or local paths.
        emit({"error": "network"})


if __name__ == "__main__":
    with protocol_writer() as emit:
        main(emit)
