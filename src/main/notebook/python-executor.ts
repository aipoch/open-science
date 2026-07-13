import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { createInterface, type Interface } from 'node:readline'

import { resolvePythonCommand } from './python-command'
import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor
} from './runtime-service'

// Longest shutdown() waits for the killed interpreter to actually exit before giving up, so a
// wedged child can never hang app teardown.
const SHUTDOWN_EXIT_GRACE_MS = 5_000

// Resolves after ms; the timer is unref'd so the fallback alone never keeps the process alive.
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

// Small stdin/stdout bridge that keeps Python globals alive across executions in one process.
const PYTHON_BRIDGE = String.raw`
import json
import os
import sys
import tempfile
import traceback
import urllib.error
import urllib.request

class _Host:
    # Control-plane bridge to the main process connector service. Tool arguments accept either a
    # positional dict (host.mcp("s", "m", {...})) or keyword arguments (host.mcp("s", "m", term=...));
    # server/method/args are positional-only so a tool whose own argument is named one of these still
    # routes through **kwargs.
    def mcp(self, server, method, args=None, /, **kwargs):
        if args is not None:
            if not isinstance(args, dict):
                raise TypeError("host.mcp arguments must be a dict or keyword arguments")
            if kwargs:
                raise TypeError("host.mcp: pass arguments as a dict or as keywords, not both")
            call_args = args
        else:
            call_args = kwargs
        endpoint = os.environ.get("OPEN_SCIENCE_MCP_RPC_ENDPOINT")
        token = os.environ.get("OPEN_SCIENCE_MCP_RPC_TOKEN")
        if not endpoint:
            raise RuntimeError("host.mcp is unavailable: connector RPC endpoint not set")
        payload = json.dumps({"method": "mcpCall", "params": {"server": server, "method": method, "args": call_args}}).encode("utf-8")
        req = urllib.request.Request(endpoint, data=payload, method="POST",
            headers={"content-type": "application/json", "authorization": "Bearer " + (token or "")})
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # urlopen raises on non-2xx before the body is read as a normal response, so the error
            # detail from the RPC server's JSON body must be pulled out of the exception instead.
            try:
                parsed = json.loads(e.read().decode("utf-8"))
            except Exception:
                parsed = {}
            raise RuntimeError(parsed.get("error") or ("host.mcp HTTP " + str(e.code)))
        if body.get("error"):
            raise RuntimeError("host.mcp error: " + str(body["error"]))
        return body["result"]

# Block reads of app-owned protected directories (e.g. the CLAUDE_CONFIG_DIR holding materialized
# skill files) so their contents can't be surfaced through notebook code. CPython audit hooks cannot
# be removed once installed, so in-process reads (open/io.open/os.open/pathlib) are reliably blocked;
# a separately spawned subprocess is the residual gap (see the read-guard spec).
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

# Reuse a single global namespace so variables survive across notebook runs.
globals_ns = {"__name__": "__main__"}
globals_ns["host"] = _Host()
# Keep protocol responses on the original stdout even if executed code changes file descriptor 1.
protocol_stdout = os.fdopen(os.dup(1), "w", buffering=1)


# Captures Python prints plus direct subprocess fd writes while code executes.
def execute_captured(code):
    stdout_file = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
    stderr_file = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)
    status = "completed"
    traceback_text = ""

    try:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(stdout_file.fileno(), 1)
        os.dup2(stderr_file.fileno(), 2)

        try:
            exec(code, globals_ns, globals_ns)
        except Exception:
            status = "failed"
            traceback_text = traceback.format_exc()
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)

        stdout_file.seek(0)
        stderr_file.seek(0)
        return status, traceback_text, stdout_file.read(), stderr_file.read()
    finally:
        os.close(saved_stdout)
        os.close(saved_stderr)
        stdout_file.close()
        stderr_file.close()


# Each stdin line is one JSON execution request from the Electron main process.
for line in sys.stdin:
    request = {}
    stdout_text = ""
    stderr_text = ""
    cwd_before = os.getcwd()
    status = "completed"
    traceback_text = ""

    try:
        request = json.loads(line)
        # Mirror notebook roots into environment variables for user code and helper scripts.
        os.environ["OPEN_SCIENCE_NOTEBOOK_DIR"] = request.get("notebookSessionRoot", "")
        os.environ["OPEN_SCIENCE_NOTEBOOK_DATA_DIR"] = request.get("dataRoot", "")
        os.environ["OPEN_SCIENCE_RUNTIME_DIR"] = request.get("runtimeRoot", "")
        cwd_before = os.getcwd()
        # Capture file descriptors so subprocesses and package managers cannot pollute the bridge protocol.
        status, traceback_text, stdout_text, stderr_text = execute_captured(request.get("code", ""))
    except Exception:
        status = "failed"
        traceback_text = traceback.format_exc()

    response = {
        "id": request.get("id"),
        "status": status,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "traceback": traceback_text,
        "cwdBefore": cwd_before,
        "cwdAfter": os.getcwd(),
        "outputs": [],
        "workingFiles": []
    }
    # Emit exactly one JSON line per request so Node can resolve the matching pending run.
    print(json.dumps(response), file=protocol_stdout, flush=True)
`

type PythonBridgeResponse = NotebookExecutionResult & {
  id: string
  cwdBefore?: string
}

type PendingExecution = {
  id: string
  resolve: (result: PythonBridgeResponse) => void
  reject: (error: unknown) => void
  timeout: NodeJS.Timeout
}

// Marks timeouts distinctly so persisted run status can reflect timeout instead of failure.
class NotebookExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotebookExecutionTimeoutError'
  }
}

// Converts process, spawn, timeout, and bridge errors into normal notebook execution results.
const errorToExecutionResult = (
  error: unknown,
  request: NotebookExecutionRequest
): NotebookExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: error instanceof NotebookExecutionTimeoutError ? 'timeout' : 'failed',
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: request.cwd,
    outputs: [
      {
        type: 'error',
        message,
        traceback: message
      }
    ],
    workingFiles: []
  }
}

// Manages one long-lived Python interpreter for a notebook session.
class NotebookPythonExecutor implements NotebookExecutor {
  private child: ChildProcessWithoutNullStreams | undefined
  private readline: Interface | undefined
  private pending: PendingExecution | undefined
  private currentCwd: string | undefined
  private passthroughStdout: string[] = []
  private passthroughStderr: string[] = []

  // Leading args (e.g. the Windows `py` launcher's `-3`) prepended before the bridge invocation.
  private baseArgs: string[] = []

  // An explicit command (tests, or a known interpreter) is used as-is; when omitted, the interpreter
  // is resolved per platform on first launch (py -> python -> python3 on Windows, python3 -> python
  // elsewhere).
  constructor(private command?: string) {}

  // Sends code to the bridge and resolves with the matching JSON response.
  async execute(request: NotebookExecutionRequest): Promise<NotebookExecutionResult> {
    try {
      if (this.pending) {
        throw new Error('Notebook execution is already running.')
      }

      const child = await this.ensureStarted(request)
      const id = randomUUID()
      const result = await new Promise<PythonBridgeResponse>((resolve, reject) => {
        // Timeout kills the bridge because Python execution cannot be interrupted safely here.
        const timeout = setTimeout(() => {
          if (this.pending?.id === id) {
            this.pending = undefined
          }
          if (!child.killed) child.kill()
          reject(
            new NotebookExecutionTimeoutError(
              `Notebook execution timed out after ${request.timeoutMs ?? 120_000}ms.`
            )
          )
        }, request.timeoutMs ?? 120_000)

        this.passthroughStdout = []
        this.passthroughStderr = []
        this.pending = { id, resolve, reject, timeout }
        // The bridge expects one newline-delimited JSON request per execution.
        child.stdin.write(
          `${JSON.stringify({
            id,
            code: request.code,
            notebookSessionRoot: request.notebookSessionRoot,
            dataRoot: request.dataRoot,
            runtimeRoot: request.runtimeRoot
          })}\n`
        )
      })

      this.currentCwd = result.cwdAfter

      return result
    } catch (error) {
      return errorToExecutionResult(error, request)
    }
  }

  // Stops the interpreter and rejects any caller waiting for an execution result.
  async shutdown(): Promise<void> {
    if (this.pending) {
      const pending = this.pending

      clearTimeout(pending.timeout)
      pending.reject(new Error('Notebook interpreter was shut down.'))
      this.pending = undefined
    }

    this.readline?.close()
    this.readline = undefined

    const child = this.child
    this.child = undefined

    if (child && !child.killed) {
      // Wait for the OS to actually reap the process before returning. On Windows the file handles
      // the interpreter holds under the cwd/runtime/data dirs are released only once it has fully
      // exited, so a caller (or test) that deletes those dirs right after shutdown would otherwise
      // hit EBUSY. The race guards against a wedged process never emitting 'exit'.
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('close', () => resolve())
      })

      child.kill()
      await Promise.race([exited, delay(SHUTDOWN_EXIT_GRACE_MS)])
    }

    this.currentCwd = undefined
    this.passthroughStdout = []
    this.passthroughStderr = []
  }

  // Starts the bridge lazily and reuses it until the child exits or is killed.
  private async ensureStarted(
    request: NotebookExecutionRequest
  ): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && !this.child.killed) {
      return this.child
    }

    // Resolve the interpreter once, lazily, so a GUI-launched app on Windows finds `py`/`python`
    // instead of a non-existent `python3`.
    if (!this.command) {
      const resolved = await resolvePythonCommand()
      this.command = resolved.command
      this.baseArgs = resolved.baseArgs
    }

    const child = spawn(this.command, [...this.baseArgs, '-u', '-c', PYTHON_BRIDGE], {
      cwd: this.currentCwd ?? request.cwd,
      env: {
        ...process.env,
        // Force a non-interactive matplotlib backend so plt.show() never opens a GUI window in
        // this headless notebook runtime; respect an explicitly configured backend if present.
        MPLBACKEND: process.env.MPLBACKEND || 'Agg',
        OPEN_SCIENCE_NOTEBOOK_DIR: request.notebookSessionRoot,
        OPEN_SCIENCE_NOTEBOOK_DATA_DIR: request.dataRoot,
        OPEN_SCIENCE_RUNTIME_DIR: request.runtimeRoot,
        ...(request.mcpRpcEndpoint
          ? { OPEN_SCIENCE_MCP_RPC_ENDPOINT: request.mcpRpcEndpoint }
          : {}),
        ...(request.mcpRpcToken ? { OPEN_SCIENCE_MCP_RPC_TOKEN: request.mcpRpcToken } : {}),
        // App-owned directories the notebook kernel must not read (e.g. materialized skill files).
        OPEN_SCIENCE_PROTECTED_DIRS: (request.protectedDirs ?? []).join(delimiter)
      }
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    this.child = child
    this.readline = createInterface({ input: child.stdout })
    this.readline.on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8')

      if (!text.trim()) return

      if (this.pending) {
        this.passthroughStderr.push(text)
        return
      }

      // Startup failures and bridge stderr should surface as the current execution result.
      this.rejectPending(new Error(text.trim()))
    })
    child.on('exit', () => {
      this.child = undefined

      // Unexpected exits are reported to the pending execution instead of being swallowed.
      this.rejectPending(new Error('Notebook interpreter exited.'))
    })

    return child
  }

  // Matches one bridge response to the in-flight request and clears its timeout.
  private handleLine(line: string): void {
    let response: PythonBridgeResponse

    try {
      response = JSON.parse(line) as PythonBridgeResponse
    } catch {
      if (this.pending) {
        this.passthroughStdout.push(`${line}\n`)
      }
      return
    }

    const pending = this.pending

    if (!pending || pending.id !== response.id) return

    if (this.passthroughStdout.length) {
      response.stdout = `${this.passthroughStdout.join('')}${response.stdout}`
    }

    if (this.passthroughStderr.length) {
      response.stderr = `${this.passthroughStderr.join('')}${response.stderr}`
    }

    this.passthroughStdout = []
    this.passthroughStderr = []
    clearTimeout(pending.timeout)
    this.pending = undefined
    pending.resolve(response)
  }

  // Fails the current execution once, preserving the first process-level error.
  private rejectPending(error: Error): void {
    if (!this.pending) return

    const pending = this.pending

    clearTimeout(pending.timeout)
    this.pending = undefined
    pending.reject(error)
  }
}

export { NotebookPythonExecutor }
