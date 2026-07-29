# Persistent Python exec-loop kernel: one process per environment, reads one JSON request per line,
# runs it against a persistent namespace, and returns one JSON response per line. Not Jupyter.
# Node -> loop:  { "req_id", "code" }
# loop -> Node:  { "req_id", "stdout", "stderr", "error", "result", "cwd", "figures":[{"mime","path"}] }
import ast
import hashlib
import io
import json
import os
import sys
import traceback

# Protocol output must survive user code that reassigns fd 1; keep a private handle to the real stdout.
_protocol_out = os.fdopen(os.dup(1), "w", buffering=1)
_figures_dir = os.environ.get("OPEN_SCIENCE_KERNEL_FIGURES_DIR", "")

# Protected-dirs audit hook, injected once into the persistent namespace. This is a DATA kernel with
# NO outbound connector access: host.mcp lives only in the control-plane REPL kernel, and connector
# data reaches python via the ./handoff channel. The namespace intentionally exposes no `host` symbol.
_BOOTSTRAP = r'''
import os, re, sys, warnings
warnings.filterwarnings("ignore", message=".*is non-interactive, and thus cannot be shown")

def _guard_path(value):
    return os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(value))))

_protected_dirs = [
    _guard_path(entry)
    for entry in os.environ.get("OPEN_SCIENCE_PROTECTED_DIRS", "").split(os.pathsep)
    if entry
]
_runtime_dir_value = os.environ.get("OPEN_SCIENCE_RUNTIME_DIR", "")
_managed_runtime_dir = _guard_path(_runtime_dir_value) if _runtime_dir_value else ""

_package_mutation_command = re.compile(
    r"(?:\b(?:micromamba|mamba|conda|pip|pip3|pipx|uv|poetry)(?:\.exe)?\b.{0,160}"
    r"\b(?:install|uninstall|update|upgrade|remove|create|sync|add|venv)\b|"
    r"\b(?:python|python3|py)(?:\.\d+)?(?:\.exe)?\b.{0,80}\s-m\s+"
    r"(?:pip|venv|virtualenv|ensurepip)\b)",
    re.IGNORECASE | re.DOTALL,
)

def _command_text(value):
    if isinstance(value, (list, tuple)):
        return " ".join(str(part) for part in value)
    if isinstance(value, (str, bytes)):
        return value.decode(errors="replace") if isinstance(value, bytes) else value
    return str(value)

def _blocked_environment_mutation(*_args, **_kwargs):
    raise PermissionError(
        "Package/environment mutation is not allowed in a Python cell; use manage_packages."
    )

def _protected_paths_audit(event, args):
    if event in ("subprocess.Popen", "os.system") and args:
        command = args[1] if event == "subprocess.Popen" and len(args) > 1 else args[0]
        if _package_mutation_command.search(_command_text(command)):
            _blocked_environment_mutation()
        return
    if event in ("os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown") and args:
        targets = [args[0]]
    elif event in ("os.rename", "os.link", "os.symlink") and len(args) > 1:
        targets = [args[0], args[1]]
    else:
        targets = []
    for target in targets:
        try:
            resolved = _guard_path(target)
        except (TypeError, ValueError):
            continue
        if _managed_runtime_dir and (
            resolved == _managed_runtime_dir or resolved.startswith(_managed_runtime_dir + os.sep)
        ):
            _blocked_environment_mutation()

    if event != "open" or not args:
        return
    target = args[0]
    if target is None or isinstance(target, int):
        return
    try:
        resolved = _guard_path(target)
    except (TypeError, ValueError):
        return
    if os.path.basename(resolved).casefold() == "pyvenv.cfg":
        _blocked_environment_mutation()
    mode = args[1] if len(args) > 1 else None
    flags = args[2] if len(args) > 2 else 0
    write_open = (
        isinstance(mode, str) and any(marker in mode for marker in ("w", "a", "x", "+"))
    ) or (
        isinstance(flags, int)
        and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
    )
    if write_open and _managed_runtime_dir and (
        resolved == _managed_runtime_dir or resolved.startswith(_managed_runtime_dir + os.sep)
    ):
        _blocked_environment_mutation()
    for directory in _protected_dirs:
        if resolved == directory or resolved.startswith(directory + os.sep):
            raise PermissionError("Access to protected application files is not allowed.")

sys.addaudithook(_protected_paths_audit)

# `venv.create` is pure Python and can otherwise be reached through dynamically assembled names that
# no source scanner can recognize. Patch both public entry points inside this persistent process; the
# audit hook above independently rejects the characteristic pyvenv.cfg write and installer subprocesses.
import venv as _open_science_venv
_open_science_venv.create = _blocked_environment_mutation
_open_science_venv.EnvBuilder.create = _blocked_environment_mutation
try:
    import ensurepip as _open_science_ensurepip
    _open_science_ensurepip.bootstrap = _blocked_environment_mutation
except ImportError:
    pass
try:
    import pip._internal as _open_science_pip_internal
    import pip._internal.cli.main as _open_science_pip_cli
    _open_science_pip_internal.main = _blocked_environment_mutation
    _open_science_pip_cli.main = _blocked_environment_mutation
except ImportError:
    pass
'''

_globals = {"__name__": "__main__"}
exec(compile(_BOOTSTRAP, "<bootstrap>", "exec"), _globals)


# Renders every open matplotlib figure to a content-addressed PNG (inline-backend semantics), then
# closes them. No-op when matplotlib was never imported, so a pure-compute cell pays nothing.
def _capture_figures():
    figures = []
    module = sys.modules.get("matplotlib")
    if module is None or not _figures_dir:
        return figures
    try:
        from matplotlib._pylab_helpers import Gcf
    except Exception:
        return figures
    for manager in list(Gcf.get_all_fig_managers()):
        try:
            buf = io.BytesIO()
            manager.canvas.figure.savefig(buf, format="png", bbox_inches="tight")
            data = buf.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            path = os.path.join(_figures_dir, digest + ".png")
            with open(path, "wb") as handle:
                handle.write(data)
            figures.append({"mime": "image/png", "path": path})
        except Exception:
            continue
    try:
        import matplotlib.pyplot as plt
        plt.close("all")
    except Exception:
        # Best-effort cleanup only: figures were already captured above, so if matplotlib is
        # unimportable or close() fails there is nothing more to do.
        return figures
    return figures


def _capture_environment():
    packages = []
    seen = set()
    for module_name, module in list(sys.modules.items()):
        root_name = module_name.split(".", 1)[0]
        if not root_name or root_name.startswith("_") or root_name in seen or module is None:
            continue
        seen.add(root_name)
        root_module = sys.modules.get(root_name, module)
        version = getattr(root_module, "__version__", None)
        if version is not None:
            try:
                version = str(version)
            except Exception:
                version = None
        packages.append({
            "name": root_name,
            "version": version,
            "version_status": "known" if version else "unavailable",
            "ecosystem": "python",
            "evidence_sources": ["python-kernel-modules"],
            "loaded_state": "loaded",
        })
    packages.sort(key=lambda package: package["name"].casefold())
    return {
        "runtime_version": ".".join(str(part) for part in sys.version_info[:3]),
        "packages": packages,
    }


# Runs one request against the persistent namespace: execs all but a trailing bare expression, then
# evals that expression so its repr echoes like a REPL. KeyboardInterrupt (from a SIGINT timeout) is
# caught so the process survives and the driver can map the reply to a timeout.
def _run(code):
    out, err = io.StringIO(), io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    error = None
    result = None
    try:
        parsed = ast.parse(code, mode="exec")
        body = parsed.body
        tail = None
        if body and isinstance(body[-1], ast.Expr):
            tail = ast.Expression(body.pop().value)
        if body:
            exec(compile(ast.Module(body, type_ignores=[]), "<cell>", "exec"), _globals)
        if tail is not None:
            value = eval(compile(tail, "<cell>", "eval"), _globals)
            if value is not None:
                result = repr(value)
    except KeyboardInterrupt:
        error = "KeyboardInterrupt\n" + traceback.format_exc()
    except SystemExit:
        # A cell calling sys.exit()/exit() raises SystemExit (a BaseException, not Exception). Report
        # it as a normal cell error so the kernel survives instead of the process exiting.
        error = traceback.format_exc()
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    figures = _capture_figures()
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "error": error,
            "result": result, "cwd": os.getcwd(), "figures": figures,
            "environment": _capture_environment()}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue
        req_id = request.get("req_id")
        try:
            # The emit (dumps/write/flush) stays inside this guard too: a soft-timeout
            # SIGINT (KeyboardInterrupt) can land at any point while handling a request,
            # including during figure capture or the response write itself. Catching it
            # here means the loop always survives instead of dying mid-request.
            response = _run(request.get("code", ""))
            response["req_id"] = req_id
            _protocol_out.write(json.dumps(response) + "\n")
            _protocol_out.flush()
        except (KeyboardInterrupt, Exception):
            # A soft-timeout SIGINT (KeyboardInterrupt) can land during figure capture or the response
            # write; catching it here keeps the loop alive. SystemExit from user code is already turned
            # into an error inside _run, so it doesn't reach this guard.
            fallback = {"stdout": "", "stderr": "", "error": traceback.format_exc(),
                        "result": None, "cwd": os.getcwd(), "figures": [],
                        "environment": _capture_environment(), "req_id": req_id}
            try:
                _protocol_out.write(json.dumps(fallback) + "\n")
                _protocol_out.flush()
            except Exception:
                # The fallback write itself failed (e.g. the pipe is gone). Nothing more we can safely
                # do, so drop this response and keep serving the next request.
                pass


if __name__ == "__main__":
    main()
