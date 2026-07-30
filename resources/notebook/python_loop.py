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
import os, re, shlex, sys, warnings
warnings.filterwarnings("ignore", message=".*is non-interactive, and thus cannot be shown")

def _guard_path(value):
    if isinstance(value, int):
        if sys.platform == "darwin":
            try:
                import fcntl
                descriptor_path = fcntl.fcntl(value, 50, bytes(1024)).split(bytes([0]), 1)[0]
                if descriptor_path:
                    return os.path.normcase(os.path.realpath(os.fsdecode(descriptor_path)))
            except (ImportError, OSError):
                pass
        for directory in ("/proc/self/fd", "/dev/fd"):
            descriptor_path = os.path.join(directory, str(value))
            if os.path.exists(descriptor_path):
                return os.path.normcase(os.path.realpath(descriptor_path))
        raise TypeError("the file descriptor cannot be resolved to a path")
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
    r"(?:(?:venv|virtualenv|ensurepip)\b|pip\b.{0,100}\b(?:install|uninstall|wheel)\b)|"
    r"\bR(?:script)?(?:\.exe)?\b.{0,120}(?:\bCMD\s+INSTALL\b|"
    r"(?:install|remove|update)\.packages\b))",
    re.IGNORECASE | re.DOTALL,
)
_runtime_write_command = re.compile(
    r"(?:\b(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)\b|"
    r"\b(?:open|write_text|write_bytes|writeFile|writeFileSync|mkdtemp|mkdtempSync)\s*\(|"
    r"\b(?:os|shutil)\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|"
    r"chmod|chown|truncate|copy|copy2|copytree|move|rmtree)\s*\(|"
    r"\b(?:unlink|file\.remove|file\.rename|file\.create|dir\.create|writeLines|writeBin|"
    r"save|saveRDS)\s*\(|"
    r"\b(?:New-Item|Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File)\b|"
    r"\[IO\.File\]::(?:WriteAllText|AppendAllText|WriteAllBytes|Create|Delete)\s*\()",
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

def _command_name(value):
    return os.path.basename(str(value).strip("\"'")).casefold()

def _package_words_mutate(words):
    if not words:
        return False
    normalized = [part.decode(errors="replace") if isinstance(part, bytes) else str(part) for part in words]
    command_index = 0
    while command_index < len(normalized):
        name = _command_name(normalized[command_index]).removesuffix(".exe")
        if name not in ("sudo", "env", "command", "exec"):
            break
        command_index += 1
        while command_index < len(normalized) and (
            normalized[command_index].startswith("-") or "=" in normalized[command_index]
        ):
            command_index += 1
    if command_index >= len(normalized):
        return False
    executable = _command_name(normalized[command_index]).removesuffix(".exe")
    argv = normalized[command_index:]
    if executable in ("sh", "bash", "zsh") and "-c" in argv:
        index = argv.index("-c")
        return _command_mutates_packages(argv[index + 1] if index + 1 < len(argv) else "")
    if executable in ("cmd",) and any(part.casefold() == "/c" for part in argv):
        index = next(i for i, part in enumerate(argv) if part.casefold() == "/c")
        return _command_mutates_packages(" ".join(argv[index + 1:]))
    if executable in ("powershell", "pwsh"):
        flags = [part.casefold() for part in argv]
        if "-command" in flags or "-c" in flags:
            index = flags.index("-command") if "-command" in flags else flags.index("-c")
            return _command_mutates_packages(" ".join(argv[index + 1:]))
    installers = {
        "micromamba", "mamba", "conda", "pip", "pip3", "pipx", "uv", "poetry",
        "python", "python3", "py", "r", "rscript", "node", "nodejs",
    }
    is_installer = executable in installers or bool(re.fullmatch(r"python\d+(?:\.\d+)*", executable))
    return is_installer and bool(_package_mutation_command.search(" ".join(argv)))

def _command_mutates_packages(command):
    if isinstance(command, (list, tuple)):
        return _package_words_mutate(command)
    lexer = shlex.shlex(_command_text(command), posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    current = []
    for token in lexer:
        if token in (";", "&&", "||", "|"):
            if _package_words_mutate(current):
                return True
            current = []
        else:
            current.append(token)
    return _package_words_mutate(current)

def _text_references_managed_runtime(text):
    comparable = os.path.normcase(str(text)).replace("\\", "/")
    root = os.path.normcase(_managed_runtime_dir).replace("\\", "/")
    return bool(root and root in comparable) or "OPEN_SCIENCE_RUNTIME_DIR" in str(text)

def _runtime_target_is_managed(value):
    text = str(value).strip().strip("\"'")
    if _text_references_managed_runtime(text):
        return True
    try:
        resolved = _guard_path(text)
    except (TypeError, ValueError):
        return False
    return bool(_managed_runtime_dir) and (
        resolved == _managed_runtime_dir or resolved.startswith(_managed_runtime_dir + os.sep)
    )

def _runtime_write_targets(words, redirections=()):
    if not words:
        return None
    executable = _command_name(words[0])
    args = [str(value) for value in words[1:]]
    supported = {
        "rm", "mv", "cp", "install", "mkdir", "touch", "truncate", "chmod", "chown",
        "ln", "tee", "sed", "perl", "dd",
    }
    if executable.removesuffix(".exe") not in supported:
        return None
    executable = executable.removesuffix(".exe")
    target_directory = next(
        (value.split("=", 1)[1] for value in args if value.startswith("--target-directory=")),
        None,
    )
    if target_directory:
        return [*redirections, target_directory]
    if "-t" in args and args.index("-t") + 1 < len(args):
        return [*redirections, args[args.index("-t") + 1]]
    if executable == "dd":
        return [*redirections, *(value[3:] for value in args if value.startswith("of="))]
    positional = [value for value in args if not value.startswith("-")]
    if executable == "ln":
        return [*redirections, *positional]
    if executable in ("cp", "install"):
        return [*redirections, *positional[-1:]]
    if executable == "mv":
        return [*redirections, *positional]
    if executable in ("chmod", "chown"):
        return [*redirections, *positional[1:]]
    if executable in ("sed", "perl"):
        return [*redirections, *positional[-1:]] if any(
            value.startswith("-") and "i" in value for value in args
        ) else list(redirections)
    return [*redirections, *positional]

def _shell_writes_managed_runtime(source):
    lexer = shlex.shlex(str(source), posix=True, punctuation_chars=";&|>")
    lexer.whitespace_split = True
    lexer.commenters = ""
    commands, current = [], []
    for token in lexer:
        if token in (";", "&&", "||", "|"):
            if current:
                commands.append(current)
                current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    for words in commands:
        redirections, argv, index = [], [], 0
        while index < len(words):
            token = words[index]
            if token.startswith(">"):
                if token == ">" or set(token) == {">"}:
                    if index + 1 < len(words):
                        redirections.append(words[index + 1])
                        index += 2
                        continue
                else:
                    redirections.append(token.lstrip(">"))
                    index += 1
                    continue
            argv.append(token)
            index += 1
        targets = _runtime_write_targets(argv, redirections)
        if targets is not None:
            if any(_runtime_target_is_managed(target) for target in targets):
                return True
            if _text_references_managed_runtime(" ".join(words)) and any(
                "$" in str(target) or "%" in str(target) for target in targets
            ):
                return True
            continue
        text = " ".join(words)
        if _text_references_managed_runtime(text) and _runtime_write_command.search(text):
            return True
    return False

def _command_writes_managed_runtime(command):
    if isinstance(command, (list, tuple)):
        words = [part.decode(errors="replace") if isinstance(part, bytes) else str(part) for part in command]
        if not words:
            return False
        executable = _command_name(words[0]).removesuffix(".exe")
        if executable in ("sh", "bash", "zsh") and "-c" in words:
            index = words.index("-c")
            return _shell_writes_managed_runtime(words[index + 1] if index + 1 < len(words) else "")
        targets = _runtime_write_targets(words)
        if targets is not None:
            return any(_runtime_target_is_managed(target) for target in targets)
        text = _command_text(words)
        return _text_references_managed_runtime(text) and bool(_runtime_write_command.search(text))
    return _shell_writes_managed_runtime(_command_text(command))

def _protected_paths_audit(event, args):
    if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.exec") and args:
        command = args[1] if event in ("subprocess.Popen", "os.posix_spawn", "os.exec") and len(args) > 1 else args[0]
        if _command_mutates_packages(command):
            _blocked_environment_mutation()
        if _command_writes_managed_runtime(command):
            _blocked_environment_mutation()
        return
    if event in (
        "os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.truncate"
    ) and args:
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
    mode = args[1] if len(args) > 1 else None
    flags = args[2] if len(args) > 2 else 0
    write_open = (
        isinstance(mode, str) and any(marker in mode for marker in ("w", "a", "x", "+"))
    ) or (
        isinstance(flags, int)
        and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
    )
    if write_open and os.path.basename(resolved).casefold() == "pyvenv.cfg":
        _blocked_environment_mutation()
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
    import pip._internal.commands as _open_science_pip_commands
    _open_science_pip_internal.main = _blocked_environment_mutation
    _open_science_pip_cli.main = _blocked_environment_mutation

    # `pip._internal.commands.create_command()` bypasses both public `main` functions and returns a
    # command object whose `main()` can mutate the current interpreter in-process. Guard the factory
    # as well as the concrete mutation command methods: the latter also covers direct construction of
    # InstallCommand/UninstallCommand without going through the factory. Inspection commands such as
    # `pip list` remain available.
    _open_science_pip_create_command = _open_science_pip_commands.create_command
    def _guarded_pip_create_command(name, *args, **kwargs):
        if str(name).strip().casefold() in ("install", "uninstall"):
            _blocked_environment_mutation()
        return _open_science_pip_create_command(name, *args, **kwargs)
    _open_science_pip_commands.create_command = _guarded_pip_create_command
    if hasattr(_open_science_pip_cli, "create_command"):
        _open_science_pip_cli.create_command = _guarded_pip_create_command

    for _module_name, _class_name in (
        ("pip._internal.commands.install", "InstallCommand"),
        ("pip._internal.commands.uninstall", "UninstallCommand"),
    ):
        try:
            _module = __import__(_module_name, fromlist=[_class_name])
            _command_class = getattr(_module, _class_name)
            for _method_name in ("main", "_main", "run"):
                if hasattr(_command_class, _method_name):
                    setattr(_command_class, _method_name, _blocked_environment_mutation)
        except (ImportError, AttributeError):
            pass
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
