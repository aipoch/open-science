import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'

import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor
} from './runtime-service'

// Small stdin/stdout bridge that keeps Python globals alive across executions in one process.
const PYTHON_BRIDGE = String.raw`
import json
import os
import sys
import tempfile
import traceback

# Reuse a single global namespace so variables survive across notebook runs.
globals_ns = {"__name__": "__main__"}
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

  constructor(private readonly command = 'python3') {}

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

    if (this.child && !this.child.killed) {
      this.child.kill()
    }

    this.child = undefined
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

    const child = spawn(this.command, ['-u', '-c', PYTHON_BRIDGE], {
      cwd: this.currentCwd ?? request.cwd,
      env: {
        ...process.env,
        OPEN_SCIENCE_NOTEBOOK_DIR: request.notebookSessionRoot,
        OPEN_SCIENCE_NOTEBOOK_DATA_DIR: request.dataRoot,
        OPEN_SCIENCE_RUNTIME_DIR: request.runtimeRoot
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
