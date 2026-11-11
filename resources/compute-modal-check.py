"""Offline dependency check; isolated Python, no credentials, no network, bounded JSON."""
import json
import os
import sys
from contextlib import redirect_stdout
from importlib.metadata import PackageNotFoundError, version
from urllib.parse import urlsplit

# Match browser authorization: SDK readiness must not depend on ambient account profiles.
for name in list(os.environ):
    if name.startswith("MODAL_"):
        del os.environ[name]
os.environ["MODAL_CONFIG_PATH"] = os.devnull

result = {"prefix": sys.prefix}
try:
    result["version"] = version("modal")
    if result["version"] != "1.6.3":
        result["error"] = "version"
    else:
        with redirect_stdout(sys.stderr):
            from modal import App, Image, Sandbox, Volume
            from modal.client import _Client
            from modal.config import DEFAULT_SERVER_URL, config
            from modal.exception import AuthError, InvalidError, PermissionDeniedError
            from modal.token_flow import _TokenFlow
            from google.protobuf.empty_pb2 import Empty
            from modal.types import FileEntryType
            from modal._utils.async_utils import synchronize_api
            from modal_proto import api_pb2
            from modal._utils.proxy_support import get_proxy_url

            # Modal imports these optional modules only when connecting through a proxy.
            # Test the actual selected proxy without opening a network connection.
            if any(get_proxy_url(urlsplit(endpoint).hostname, use_ssl=True)
                   for endpoint in DEFAULT_SERVER_URL.split(",")):
                try:
                    from python_socks.async_.asyncio import Proxy
                    from aiohttp_socks import ProxyConnector
                except ImportError:
                    result["error"] = "proxy"
except PackageNotFoundError:
    result["error"] = "missing"
except Exception:
    result["error"] = "imports"
print(json.dumps(result, separators=(",", ":")))
