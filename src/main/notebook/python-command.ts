import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { redactSensitiveText } from '../diagnostic-redaction'
import { createLogger } from '../logger'

const execFileAsync = promisify(execFile)
const log = createLogger('notebook:python-command')
const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_BUFFER = 64 * 1024
const DIAGNOSTIC_OUTPUT_LIMIT = 2048

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
  // Returns true when the invocation reports Python 3.
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

// Match the direct spawn used to run Python. Shell execution splits unquoted Windows paths with
// spaces, and can accept batch shims that the actual kernel/helper process cannot launch.
const defaultProbe =
  (platform: NodeJS.Platform) =>
  async ({ command, baseArgs }: PythonCommand): Promise<boolean> => {
    return (await probeInterpreterVersion(command, baseArgs, { platform })) !== undefined
  }

// Finds the first Python interpreter that executes a version probe. Environment setup uses this optional
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

// Executes a version probe through a SPECIFIC interpreter invocation and returns its
// Python-3 version string, or undefined if it is not a runnable Python 3. Used to VALIDATE a
// user-selected interpreter path before reporting it runnable — existence on disk is not enough
// (it could be python2, or not python at all).
export type PythonProbeExec = (
  command: string,
  args: readonly string[],
  options: {
    timeout: number
    maxBuffer: number
    shell: false
    windowsHide: boolean
    env?: NodeJS.ProcessEnv
  }
) => Promise<{ stdout: string; stderr: string }>

const boundedOutput = (output: unknown): string => {
  // Redact complete credential patterns before truncation can make them unrecognizable.
  const text = redactSensitiveText(output === undefined ? '' : String(output))
  return text.length <= DIAGNOSTIC_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, DIAGNOSTIC_OUTPUT_LIMIT)} [truncated]`
}

export const probeInterpreterVersion = async (
  command: string,
  baseArgs: string[] = [],
  deps: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exec?: PythonProbeExec } = {}
): Promise<string | undefined> => {
  const exec: PythonProbeExec =
    deps.exec ??
    (async (file, args, options) => {
      const { stdout, stderr } = await execFileAsync(file, [...args], options)
      return { stdout: String(stdout), stderr: String(stderr) }
    })
  let attempts = 0
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    const maxAttempts = (deps.platform ?? process.platform) === 'win32' ? 5 : 1
    let timeout = PROBE_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    do {
      attempts++
      const result = await exec(command, [...baseArgs, '--version'], {
        timeout,
        maxBuffer: PROBE_MAX_BUFFER,
        shell: false,
        windowsHide: true,
        ...(deps.env ? { env: deps.env } : {})
      })
      stdout = result.stdout
      stderr = result.stderr
      // Real Windows interpreters occasionally exit successfully with both streams empty.
      // Retry only that observed anomaly, within the original probe deadline.
      if (stdout !== '' || stderr !== '') break
      timeout = deadline - Date.now()
    } while (attempts < maxAttempts && timeout > 0)
    const output = `${stdout}\n${stderr}`
    // Dots already belong to the suffix: repeating that group causes exponential backtracking
    // on malformed version lines, blocking the main thread after the subprocess has exited.
    const version = /^Python\s+(3(?:\.[\w.+-]+)?)(?:\s|$)/m.exec(output)?.[1]
    if (version) return version
    log.warn('Python interpreter probe failed', {
      command,
      baseArgs,
      phase: 'version',
      attempts,
      code: 'INVALID_PYTHON3_VERSION',
      timedOut: false,
      stdout: boundedOutput(stdout),
      stderr: boundedOutput(stderr)
    })
  } catch (error) {
    const failure = error as Error & {
      code?: string | number
      signal?: string
      killed?: boolean
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    log.warn('Python interpreter probe failed', {
      command,
      baseArgs,
      phase: 'version',
      attempts,
      code: failure.code,
      signal: failure.signal,
      timedOut: failure.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      timeoutMs: PROBE_TIMEOUT_MS,
      message: boundedOutput(failure.message),
      stdout: boundedOutput(failure.stdout),
      stderr: boundedOutput(failure.stderr)
    })
    return undefined
  }
  return undefined
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
import base64, builtins, collections, datetime, decimal, fractions, functools, itertools, json, math, re, statistics, sys

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
elif not request.get("trustedSource", False):
    raise PermissionError("external helper validation requires Python audit-hook support")
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

// Windows-hosted runners can spend several seconds starting the interpreter while the full
// Notebook shard is under disk and process pressure. Keep a bounded watchdog without treating
// normal startup contention as an invalid helper.
const NOTEBOOK_HELPER_VALIDATION_TIMEOUT_MS = 15_000

export const validateNotebookHelperExports = async (
  helperId: string,
  source: string,
  exports: readonly string[],
  deps: { python?: PythonCommand; env?: NodeJS.ProcessEnv; trustedSource?: boolean } = {}
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
    const timeout = setTimeout(() => child.kill(), NOTEBOOK_HELPER_VALIDATION_TIMEOUT_MS)
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
    child.stdin.end(
      Buffer.from(
        JSON.stringify({ source, exports, trustedSource: deps.trustedSource ?? false }),
        'utf8'
      ).toString('base64')
    )
  })
}
