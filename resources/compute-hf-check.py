"""Offline SDK check for the official Hugging Face device authorization bridge."""
import json
import logging
import os
import sys
from contextlib import redirect_stdout
from importlib.metadata import PackageNotFoundError, version

os.environ["HF_ENDPOINT"] = "https://huggingface.co"
for name in ("HUGGINGFACE_CO_STAGING", "HF_DEVICE_CODE_OAUTH_CLIENT_ID", "HF_DEBUG"):
    os.environ.pop(name, None)
logging.disable(logging.CRITICAL)
result = {"prefix": sys.prefix}
try:
    result["version"] = version("huggingface_hub")
    if result["version"] != "2.4.0":
        result["error"] = "version"
    else:
        with redirect_stdout(sys.stderr):
            from huggingface_hub.utils import get_session
            from huggingface_hub.utils._auth import _get_token_from_file_refreshed
            from huggingface_hub.utils._oauth_device import (
                poll_device_token,
                refresh_access_token,
                request_device_code,
            )

            # Constructing the SDK client checks its selected proxy support without a request.
            get_session().close()
except PackageNotFoundError:
    result["error"] = "missing"
except Exception:
    result["error"] = "imports"
print(json.dumps(result, separators=(",", ":")))
