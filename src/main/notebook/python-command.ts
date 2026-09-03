import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const isPython3Version = (output: string): boolean => /\bPython\s+3(?:\.|\s|$)/i.test(output)

// A resolved Python interpreter invocation: the executable plus any leading args needed to select an
// interpreter (e.g. the Windows `py` launcher needs `-3`).
export type PythonCommand = {
  command: string
  baseArgs: string[]
}

export const isMacOSDeveloperToolsPythonStub = (
  interpreterPath: string,
  platform: NodeJS.Platform = process.platform
): boolean => platform === 'darwin' && interpreterPath === '/usr/bin/python3'

// Ordered interpreter candidates by platform. Windows prefers the `py -3` launcher (the reliable way
// to reach a real CPython, and it sidesteps the Microsoft Store `python3` execution-alias stub), then
// bare `python`, then `python3`. Unix prefers `python3`, then `python`.
const pythonCandidates = (platform: NodeJS.Platform): PythonCommand[] =>
  platform === 'win32'
    ? [
        { command: 'py', baseArgs: ['-3'] },
        { command: 'python', baseArgs: [] },
        { command: 'python3', baseArgs: [] }
      ]
    : [
        { command: 'python3', baseArgs: [] },
        { command: 'python', baseArgs: [] }
      ]

export type ResolvePythonDeps = {
  platform: NodeJS.Platform
  // Returns true when `<command> <baseArgs...> --version` runs successfully.
  probe: (candidate: PythonCommand) => Promise<boolean>
  resolveExecutables: (command: string) => Promise<string[]>
}

const defaultResolveExecutables = async (command: string): Promise<string[]> => {
  const matches: string[] = []
  const seen = new Set<string>()
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      const resolved = await realpath(candidate)
      if (!seen.has(resolved)) {
        seen.add(resolved)
        matches.push(resolved)
      }
    } catch {
      // Keep searching PATH when this entry is missing, inaccessible, or a broken symlink.
    }
  }
  return matches
}

// Real `<command> --version` probe. On Windows the check runs through a shell so a shimmed launcher
// still resolves; the `py`/`python` executables run fine without one.
const defaultProbe =
  (platform: NodeJS.Platform) =>
  async ({ command, baseArgs }: PythonCommand): Promise<boolean> => {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...baseArgs, '--version'], {
        timeout: 10_000,
        shell: platform === 'win32',
        windowsHide: true
      })

      return isPython3Version(`${stdout}\n${stderr}`)
    } catch {
      return false
    }
  }

// Finds the first Python interpreter that answers `--version`. Environment setup uses this optional
// result to report Notebook availability without making Python a core startup requirement.
export const findPythonCommand = async (
  deps: Partial<ResolvePythonDeps> = {}
): Promise<PythonCommand | undefined> => {
  const platform = deps.platform ?? process.platform
  const probe = deps.probe ?? defaultProbe(platform)
  const resolveExecutables = deps.resolveExecutables ?? defaultResolveExecutables
  const candidates = pythonCandidates(platform)

  for (const candidate of candidates) {
    if (platform === 'darwin' && candidate.command === 'python3') {
      const executables = await resolveExecutables(candidate.command).catch(() => [])
      for (const executable of executables) {
        if (isMacOSDeveloperToolsPythonStub(executable, platform)) continue
        const resolvedCandidate = { ...candidate, command: executable }
        if (await probe(resolvedCandidate)) return resolvedCandidate
      }
      continue
    }
    if (await probe(candidate)) return candidate
  }

  return undefined
}

// Probes a SPECIFIC interpreter invocation (`<command> <baseArgs...> --version`) and returns its
// Python-3 version string, or undefined if it is not a runnable Python 3. Used to VALIDATE a
// user-selected interpreter path before reporting it runnable — existence on disk is not enough
// (it could be python2, or not python at all).
export const probeInterpreterVersion = async (
  command: string,
  baseArgs: string[] = [],
  deps: { platform?: NodeJS.Platform } = {}
): Promise<string | undefined> => {
  const platform = deps.platform ?? process.platform
  try {
    const { stdout, stderr } = await execFileAsync(command, [...baseArgs, '--version'], {
      timeout: 10_000,
      shell: platform === 'win32',
      windowsHide: true
    })
    const output = `${stdout}\n${stderr}`
    return isPython3Version(output) ? output.trim().replace(/^Python\s+/i, '') : undefined
  } catch {
    return undefined
  }
}

export { isPython3Version }

// Resolves the first usable interpreter. Falls back to the platform's preferred command when none
// respond, so Notebook execution still produces a clear ENOENT error rather than silently doing
// nothing if the environment changed after the startup check.
export const resolvePythonCommand = async (
  deps: Partial<ResolvePythonDeps> = {}
): Promise<PythonCommand> => {
  const found = await findPythonCommand(deps)
  if (found) return found

  const platform = deps.platform ?? process.platform
  const candidates = pythonCandidates(platform)

  return candidates[0]
}

const CALLABLE_HELPER_VALIDATOR = String.raw`
import ast, base64, builtins, collections, datetime, decimal, fractions, functools, itertools, json, math, re, statistics, sys

allowed_modules = {
    module.__name__: module
    for module in (
        collections, datetime, decimal, fractions, functools, itertools, json, math, re, statistics
    )
}

def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in allowed_modules:
        raise ImportError('stdlib import is not allowed during helper validation: ' + name)
    return allowed_modules[name]

def deny(event, args):
    if event == "open" or event == "import" or event.startswith(("socket.", "subprocess.", "os.system", "os.exec", "os.spawn")):
        raise PermissionError("host access is unavailable during helper validation")

request = json.loads(base64.b64decode(sys.stdin.read()).decode("utf-8"))
if hasattr(sys, "addaudithook"):
    sys.addaudithook(deny)
    safe_names = (
        "__build_class__", "abs", "all", "any", "bool", "bytes", "callable", "dict", "enumerate",
        "Exception", "float", "int", "isinstance", "len", "list", "map", "max", "min", "object",
        "range", "repr", "reversed", "set", "slice", "sorted", "str", "sum", "tuple", "ValueError", "zip"
    )
    safe_builtins = {name: getattr(builtins, name) for name in safe_names}
    safe_builtins["__import__"] = restricted_import
    namespace = {"__builtins__": safe_builtins, "__name__": "__open_science_helper_validation__"}
    exec(compile(request["source"], "<registered-helper>", "exec"), namespace, namespace)
    missing = [name for name in request["exports"] if name not in namespace or not callable(namespace[name])]
else:
    # Python < 3.8 cannot audit validation-time host access, so never execute staged source there.
    tree = ast.parse(request["source"], filename="<registered-helper>")

    def is_literal(expression):
        try:
            ast.literal_eval(expression)
            return True
        except (SyntaxError, TypeError, ValueError):
            return False

    def is_static_function(node):
        arguments = (
            list(getattr(node.args, "posonlyargs", ()))
            + list(node.args.args)
            + list(node.args.kwonlyargs)
        )
        if node.args.vararg is not None:
            arguments.append(node.args.vararg)
        if node.args.kwarg is not None:
            arguments.append(node.args.kwarg)
        defaults = list(node.args.defaults) + [
            default for default in node.args.kw_defaults if default is not None
        ]
        annotations = [argument.annotation for argument in arguments] + [node.returns]

        def is_static_annotation(annotation):
            return is_literal(annotation) or (
                isinstance(annotation, ast.Name)
                and annotation.id in {
                    "bool", "bytes", "dict", "Exception", "float", "int", "list", "object",
                    "set", "str", "tuple", "ValueError"
                }
            )

        return (
            not node.decorator_list
            and all(is_literal(default) for default in defaults)
            and all(
                annotation is None or is_static_annotation(annotation)
                for annotation in annotations
            )
        )

    def bind_literal_target(target, value):
        if isinstance(target, ast.Name):
            return {target.id: value}
        if isinstance(target, (ast.List, ast.Tuple)):
            try:
                values = list(value)
            except TypeError:
                return None
            starred = [
                index for index, element in enumerate(target.elts)
                if isinstance(element, ast.Starred)
            ]
            if len(starred) > 1:
                return None
            if not starred and len(values) != len(target.elts):
                return None
            if starred and len(values) < len(target.elts) - 1:
                return None

            bindings = {}
            for index, element in enumerate(target.elts):
                if isinstance(element, ast.Starred):
                    trailing = len(target.elts) - index - 1
                    nested_value = values[index:len(values) - trailing if trailing else None]
                    element = element.value
                elif starred and index > starred[0]:
                    nested_value = values[len(values) - (len(target.elts) - index)]
                else:
                    nested_value = values[index]
                nested_bindings = bind_literal_target(element, nested_value)
                if nested_bindings is None:
                    return None
                bindings.update(nested_bindings)
            return bindings
        return None

    def literal_assignment_bindings(node):
        if not isinstance(node, ast.Assign):
            return None
        try:
            value = ast.literal_eval(node.value)
        except (SyntaxError, TypeError, ValueError):
            return None
        bindings = {}
        for target in node.targets:
            target_bindings = bind_literal_target(target, value)
            if target_bindings is None:
                return None
            bindings.update(target_bindings)
        return bindings

    def static_import_bindings(node):
        bindings = {}
        if isinstance(node, ast.Import):
            for alias in node.names:
                module = allowed_modules.get(alias.name)
                if module is None:
                    return None
                bindings[alias.asname or alias.name] = module
            return bindings
        if not isinstance(node, ast.ImportFrom) or node.level != 0:
            return None
        module = allowed_modules.get(node.module)
        if module is None:
            return None
        for alias in node.names:
            if alias.name == "*":
                names = getattr(module, "__all__", None)
                if names is None:
                    names = [name for name in dir(module) if not name.startswith("_")]
                for name in names:
                    try:
                        bindings[name] = getattr(module, name)
                    except AttributeError:
                        return None
                continue
            try:
                bindings[alias.asname or alias.name] = getattr(module, alias.name)
            except AttributeError:
                return None
        return bindings

    def is_docstring(node):
        if not isinstance(node, ast.Expr):
            return False
        try:
            return isinstance(ast.literal_eval(node.value), str)
        except (SyntaxError, TypeError, ValueError):
            return False

    static_base_types = {
        name: getattr(builtins, name)
        for name in (
            "bytes", "dict", "Exception", "float", "int", "list", "object", "set", "str",
            "tuple", "ValueError"
        )
    }

    def callable_placeholder(*args, **kwargs):
        return None

    static_classes_with_init_subclass = set()

    def build_static_class(node, visible_bindings=None):
        if node.decorator_list or node.keywords:
            return None
        if visible_bindings is None:
            visible_bindings = {}
        bases = []
        for base in node.bases:
            if not isinstance(base, ast.Name):
                return None
            if base.id in visible_bindings:
                base_type = visible_bindings[base.id]
                if not isinstance(base_type, type):
                    return None
            else:
                base_type = static_base_types.get(base.id)
                if base_type is None:
                    return None
            if base_type in static_classes_with_init_subclass:
                return None
            bases.append(base_type)
        if not bases:
            bases.append(object)

        namespace = {
            "__module__": "__open_science_helper_validation__",
            "__qualname__": node.name,
        }
        local_bindings = dict(visible_bindings)
        for index, member in enumerate(node.body):
            if index == 0 and is_docstring(member):
                namespace["__doc__"] = ast.literal_eval(member.value)
                continue
            if isinstance(member, ast.Pass):
                continue
            if isinstance(member, (ast.AsyncFunctionDef, ast.FunctionDef)) and is_static_function(member):
                namespace[member.name] = callable_placeholder
                local_bindings[member.name] = callable_placeholder
                continue
            if isinstance(member, ast.ClassDef):
                nested_class = build_static_class(member, local_bindings)
                if nested_class is None:
                    return None
                namespace[member.name] = nested_class
                local_bindings[member.name] = nested_class
                continue
            class_bindings = literal_assignment_bindings(member)
            if class_bindings is not None:
                namespace.update(class_bindings)
                local_bindings.update(class_bindings)
                continue
            imported_bindings = static_import_bindings(member)
            if imported_bindings is None:
                return None
            namespace.update(imported_bindings)
            local_bindings.update(imported_bindings)

        try:
            static_class = type(node.name, tuple(bases), namespace)
        except Exception:
            return None
        if "__init_subclass__" in namespace:
            static_classes_with_init_subclass.add(static_class)
        return static_class

    bindings = {}
    unsafe = []
    for index, node in enumerate(tree.body):
        if index == 0 and is_docstring(node):
            continue
        if isinstance(node, ast.Pass):
            continue
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and is_static_function(node):
            bindings[node.name] = callable_placeholder
            continue
        if isinstance(node, ast.ClassDef):
            static_class = build_static_class(node, bindings)
            if static_class is not None:
                bindings[node.name] = static_class
                continue
        assignment_bindings = literal_assignment_bindings(node)
        if assignment_bindings is not None:
            bindings.update(assignment_bindings)
            continue
        imported_bindings = static_import_bindings(node)
        if imported_bindings is not None:
            bindings.update(imported_bindings)
            continue
        unsafe.append(type(node).__name__)

    if unsafe:
        raise TypeError(
            "legacy helper validation requires side-effect-free definitions: "
            + ", ".join(unsafe)
        )
    missing = [name for name in request["exports"] if not callable(bindings.get(name))]
if missing:
    raise TypeError("missing or non-callable exports: " + ", ".join(missing))
`

export const validateNotebookHelperExports = async (
  helperId: string,
  source: string,
  exports: readonly string[],
  deps: { python?: PythonCommand; env?: NodeJS.ProcessEnv } = {}
): Promise<void> => {
  const python = deps.python ?? (await resolvePythonCommand())
  await new Promise<void>((resolveValidation, rejectValidation) => {
    const child = spawn(
      python.command,
      [...python.baseArgs, '-I', '-S', '-c', CALLABLE_HELPER_VALIDATOR],
      {
        env:
          deps.env ??
          (process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
            : {}),
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true
      }
    )
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), 5_000)
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length)
    })
    child.stdin.on('error', () => undefined)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectValidation(
        new Error(`helper "${helperId}" callable validation requires Python 3: ${error.message}`)
      )
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolveValidation()
        return
      }
      const detail = signal ? `terminated by ${signal}` : stderr.trim().split('\n').at(-1)
      rejectValidation(
        new Error(
          `INVALID_REGISTERED_HELPER: helper "${helperId}" failed isolated callable export validation${detail ? `: ${detail}` : ''}`
        )
      )
    })
    child.stdin.end(Buffer.from(JSON.stringify({ source, exports }), 'utf8').toString('base64'))
  })
}
