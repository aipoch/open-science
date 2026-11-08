"""Host-only bridge to huggingface_hub's device authorization and refresh flow."""

import json
import logging
import os
import sys
import time


def emit(value):
    print(json.dumps(value), flush=True)


def run():
    # Device codes and refresh tokens may only travel to the official issuer.
    issuer = "https://huggingface.co"
    os.environ["HF_ENDPOINT"] = issuer
    os.environ.pop("HUGGINGFACE_CO_STAGING", None)
    os.environ.pop("HF_DEVICE_CODE_OAUTH_CLIENT_ID", None)
    os.environ.pop("HF_DEBUG", None)
    logging.disable(logging.CRITICAL)
    from huggingface_hub import constants
    from huggingface_hub.utils import get_session
    from huggingface_hub.utils._oauth_device import (
        poll_device_token,
        refresh_access_token,
        request_device_code,
    )

    if constants.ENDPOINT != issuer:
        emit({"error": "authorization"})
        return
    # Redirects with status 307 or 308 can replay a token in the POST body.
    get_session().follow_redirects = False

    request = json.load(sys.stdin)
    if request["action"] == "authorize":
        challenge = request_device_code()
        emit({
            "url": challenge["verification_uri_complete"],
            "userCode": challenge["user_code"],
            "expiresAt": int((time.time() + challenge["expires_in"]) * 1000),
        })
        result = poll_device_token(challenge)
    elif request["action"] == "refresh":
        result = refresh_access_token(request["refreshToken"])
    elif request["action"] == "local":
        from huggingface_hub.utils._auth import _get_token_from_file_refreshed

        token = _get_token_from_file_refreshed()
        emit({"material": {"accessToken": token}} if token else {"error": "missing"})
        return
    else:
        raise ValueError("Unsupported operation")

    material = {"accessToken": result["access_token"]}
    if result.get("refresh_token"):
        material["refreshToken"] = result["refresh_token"]
    if result.get("expires_in"):
        material["expiresAt"] = int((time.time() + result["expires_in"]) * 1000)
    emit({"material": material})


if __name__ == "__main__":
    try:
        run()
    except ImportError:
        emit({"error": "dependency"})
    except Exception as exc:
        code = getattr(exc, "error_code", None)
        if code == "expired_token":
            emit({"error": "timeout"})
        elif code in ("invalid_grant", "access_denied", "invalid_token", "invalid_client"):
            emit({"error": "authorization"})
        else:
            emit({"error": "network"})
