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
import os, sys, warnings
warnings.filterwarnings("ignore", message=".*is non-interactive, and thus cannot be shown")

_protected_dirs = [
    os.path.abspath(entry)
    for entry in os.environ.get("OPEN_SCIENCE_PROTECTED_DIRS", "").split(os.pathsep)
    if entry
]

def _protected_paths_audit(event, args):
    if event != "open" or not _protected_dirs or not args:
        return
    target = args[0]
    if target is None or isinstance(target, int):
        return
    try:
        resolved = os.path.abspath(os.fspath(target))
    except (TypeError, ValueError):
        return
    for directory in _protected_dirs:
        if resolved == directory or resolved.startswith(directory + os.sep):
            raise PermissionError("Access to protected application files is not allowed.")

sys.addaudithook(_protected_paths_audit)
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
            "result": result, "cwd": os.getcwd(), "figures": figures}


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
                        "result": None, "cwd": os.getcwd(), "figures": [], "req_id": req_id}
            try:
                _protocol_out.write(json.dumps(fallback) + "\n")
                _protocol_out.flush()
            except Exception:
                # The fallback write itself failed (e.g. the pipe is gone). Nothing more we can safely
                # do, so drop this response and keep serving the next request.
                pass


if __name__ == "__main__":
    main()
