import { spawn } from 'node:child_process'

import { resolvePythonCommand } from './python-command'

const CALLABLE_VALIDATOR = String.raw`
import builtins, collections, datetime, decimal, fractions, functools, itertools, json, math, re, statistics, sys

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

sys.addaudithook(deny)
request = json.loads(sys.stdin.read())
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
if missing:
    raise TypeError("missing or non-callable exports: " + ", ".join(missing))
`

const validateNotebookHelperExports = async (
  helperId: string,
  source: string,
  exports: readonly string[]
): Promise<void> => {
  const python = await resolvePythonCommand()
  await new Promise<void>((resolveValidation, rejectValidation) => {
    const child = spawn(
      python.command,
      [...python.baseArgs, '-I', '-S', '-c', CALLABLE_VALIDATOR],
      {
        env:
          process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
            : {},
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
    child.stdin.end(JSON.stringify({ source, exports }))
  })
}

export { validateNotebookHelperExports }
