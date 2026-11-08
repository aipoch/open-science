"""Authenticate the desktop host. Only JSON protocol records go to its private stdout pipe."""
import asyncio
import json
import os
import sys
from contextlib import redirect_stdout
from importlib.metadata import PackageNotFoundError, version


def emit(record):
    print(json.dumps(record, separators=(",", ":")), file=sys.__stdout__, flush=True)


async def run(request):
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


if __name__ == "__main__":
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
            asyncio.run(run(request))
    except (ImportError, PackageNotFoundError):
        emit({"error": "dependency"})
    except Exception:
        # Provider exceptions can contain authentication data or local paths.
        emit({"error": "network"})
