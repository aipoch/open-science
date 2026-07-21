import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'

import { terminateProcessTree, type ProcessTreeKillResult } from '../process-tree'
import {
  KERNEL_FIGURES_DIR_ENV,
  frameRRequest,
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopFigure,
  type KernelLoopResponse
} from './kernel-protocol'
import { mapLoopOutputs, type MappedFigure } from './loop-output-mapper'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  rScriptBin,
  resolveEnvName
} from './runtime-paths'
import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor
} from './runtime-service'
import { DEFAULT_TIMEOUT_MS, TimeoutController } from './timeout-controller'

// Driver-internal process kind. 'python'/'r' are the data kernels selected by the agent-facing
// NotebookLanguage; 'repl' is the control-plane Node kernel reached only via the control path. The
// kind is the language/role discriminator (spawn logic, framing, readiness gate switch on it); the
// routing map is keyed by a finer ProcessKey so named envs of the same kind coexist as distinct procs.
type KernelProcessKind = 'python' | 'r' | 'repl'

// Composite routing key for `procs`: `${kind}:${env}` for the python/r data kernels (so
// python:default-python and python:my-analysis are separate processes/namespaces), and the bare
// 'repl' for the single env-agnostic control kernel.
type ProcessKey = string

// Opaque idle-timer handle; the default scheduler returns NodeJS.Timeout, tests inject a fake clock
// that returns a plain number (see TimeoutController, the same pattern for the per-run timeout).
type IdleTimerHandle = unknown
type ScheduleIdleTimer = (fn: () => void, ms: number) => IdleTimerHandle
type CancelIdleTimer = (handle: IdleTimerHandle) => void

// Idle-shutdown is OFF by default: a notebook kernel is a PERSISTENT namespace (the agent is told to
// reuse variables across cells), so silently dropping it after a pause — then respawning a fresh,
// empty namespace on the next cell — makes a long analysis fail unpredictably. Reclaiming an idle
// kernel is opt-in via OPEN_SCIENCE_KERNEL_IDLE_MS (a positive ms value); 0 / unset keeps kernels
// alive until an explicit shutdown/restart or session teardown.
const DEFAULT_IDLE_MS = 0

// Real scheduler: unref'd so a pending idle timer alone never keeps the process alive.
const defaultScheduleIdleTimer: ScheduleIdleTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

const defaultCancelIdleTimer: CancelIdleTimer = (handle) => clearTimeout(handle as NodeJS.Timeout)

// Resolves the idle window: an explicit option wins, then OPEN_SCIENCE_KERNEL_IDLE_MS (a positive ms
// value opts INTO idle reclaim), else DEFAULT_IDLE_MS (0 = disabled). A value <= 0 disables idle
// shutdown, so kernels persist until an explicit teardown — see DEFAULT_IDLE_MS for why that is the
// default.
const resolveIdleTimeoutMs = (configured?: number): number => {
  if (configured !== undefined) return configured
  const raw = Number(process.env.OPEN_SCIENCE_KERNEL_IDLE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS
}

export type NotebookKernelExecutorOptions = {
  // Legacy option, still accepted for backward compat but no longer used for interpreter resolution.
  // The interpreter is always the env's own <prefix>/bin/python, derived per request.
  pythonBin?: string
  // <default-r> prefix; its bin dir is prepended to the R loop's PATH and exported to the loop.
  rEnvPrefix?: string
  // Path to resources/notebook/python_loop.py (env override OPEN_SCIENCE_PYTHON_LOOP).
  pythonLoopPath?: string
  // Path to resources/notebook/r_loop.R (env override OPEN_SCIENCE_R_LOOP).
  rLoopPath?: string
  // Path to resources/notebook/repl_loop.js (env override OPEN_SCIENCE_REPL_LOOP). Spawned under
  // process.execPath with ELECTRON_RUN_AS_NODE=1.
  replLoopPath?: string
  // Idle window before a proc with no pending request is dropped so the next execute() lazily
  // respawns a fresh one (namespace cleared). Defaults to OPEN_SCIENCE_KERNEL_IDLE_MS if that is a
  // positive ms value, else DEFAULT_IDLE_MS (0 = disabled). A non-positive value keeps kernels alive.
  idleTimeoutMs?: number
  // Injectable idle-timer scheduler/canceller so tests drive idle-shutdown with a fake clock instead
  // of waiting out the real idle window.
  scheduleIdleTimer?: ScheduleIdleTimer
  cancelIdleTimer?: CancelIdleTimer
  // Invoked once a proc is dropped for being idle; the caller can use this to surface a 'terminated'
  // kernel status upward (see NotebookRuntimeService). Carries the resolved env so the caller marks
  // the right per-(kind, env) kernel status ('' for the env-agnostic repl).
  onIdleShutdown?: (kind: KernelProcessKind, env: string) => void
  // Invoked once a proc is lost unexpectedly (a crash exit or a hard-timeout drop), NOT on an
  // intentional shutdown()/restart(). Parallels onIdleShutdown so the caller can persist a
  // 'terminated' kernel status for an involuntary loss too (see NotebookRuntimeService).
  onTerminated?: (kind: KernelProcessKind, env: string) => void
}

// One in-flight request awaiting a matching loop response line.
type PendingRequest = {
  reqId: string
  resolve: (response: KernelLoopResponse) => void
  reject: (error: unknown) => void
  timeout: TimeoutController
}

// One persistent loop process for a (kind, env), reused across cells until it exits or is killed.
type ProcState = {
  kind: KernelProcessKind
  // Resolved env name backing this proc (DEFAULT_PY_ENV / DEFAULT_R_ENV or a named env); '' for the
  // env-agnostic repl. Reported to the idle/terminated callbacks so the caller keys per-env status.
  env: string
  // Routing key in `procs`; kept on the proc so map ops that only receive a ProcState (dropProc,
  // rearmIdleTimerIfLive, handleIdleTimeout) can re-key without recomputing from the request.
  key: ProcessKey
  child: ChildProcessWithoutNullStreams
  readline: Interface
  pending?: PendingRequest
  // True until the exit handler observes the process leaving. child.killed is unreliable here: Node
  // sets it once *any* signal is sent, including the soft-timeout SIGINT a loop catches and survives,
  // so it cannot distinguish a still-running loop from a dead one.
  alive: boolean
  // Armed while the proc is idle (no pending request); disarmed at the start of the next request.
  idleTimer?: IdleTimerHandle
  // Interpreter backing this proc (see interpreterIdentity): '' for the managed default, or the resolved
  // external command+args. ensureProc drops+respawns when the next run's identity differs, so a runtime
  // switch never reuses a kernel bound to the previous interpreter.
  interpreterIdentity: string
}

// Marks timeouts distinctly so persisted run status can reflect timeout instead of failure.
class NotebookExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotebookExecutionTimeoutError'
  }
}

// Resolves the packaged/dev location of python_loop.py; an env override wins (tests, dev), then the
// packaged resources dir, then the repo-relative dev path.
const defaultPythonLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_PYTHON_LOOP) return process.env.OPEN_SCIENCE_PYTHON_LOOP
  if (process.resourcesPath) return join(process.resourcesPath, 'notebook', 'python_loop.py')
  return join(__dirname, '../../../resources/notebook/python_loop.py')
}

// Resolves the packaged/dev location of r_loop.R, mirroring defaultPythonLoopPath.
const defaultRLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_R_LOOP) return process.env.OPEN_SCIENCE_R_LOOP
  if (process.resourcesPath) return join(process.resourcesPath, 'notebook', 'r_loop.R')
  return join(__dirname, '../../../resources/notebook/r_loop.R')
}

// Resolves the packaged/dev location of repl_loop.js, mirroring defaultPythonLoopPath.
const defaultReplLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_REPL_LOOP) return process.env.OPEN_SCIENCE_REPL_LOOP
  if (process.resourcesPath) return join(process.resourcesPath, 'notebook', 'repl_loop.js')
  return join(__dirname, '../../../resources/notebook/repl_loop.js')
}

// Resolves the process kind a request targets: the control path sets kind 'repl'; data cells leave it
// unset and route by language (omitted language defaults to 'python', matching the rest of the stack).
const resolveProcessKind = (request: NotebookExecutionRequest): KernelProcessKind => {
  if (request.kind === 'repl') return 'repl'
  return request.language === 'r' ? 'r' : 'python'
}

// Resolves the env name for a data-kernel request. The kind is authoritative for the language default
// (kind 'r' <-> language 'r'), so an omitted request.language still picks the right default env.
const resolveRequestEnv = (kind: KernelProcessKind, request: NotebookExecutionRequest): string =>
  resolveEnvName(kind === 'r' ? 'r' : 'python', request.environment)

// Routing key for the persistent-process map: `${kind}:${env}` for python/r so each named env is its
// own process, and the bare 'repl' for the single env-agnostic control kernel.
const resolveProcessKey = (request: NotebookExecutionRequest): ProcessKey => {
  const kind = resolveProcessKind(request)
  if (kind === 'repl') return 'repl'
  return `${kind}:${resolveRequestEnv(kind, request)}`
}

// Identity of the interpreter backing a run: the resolved external command+args, or '' for the managed
// default (no resolvedInterpreter). ensureProc compares this against the live proc so a DEFAULT env
// whose runtime changed (managed <-> external, or a different external interpreter) tears the old kernel
// down instead of reusing its process + stale in-memory state. Kept OUT of the process key so there is
// still exactly ONE proc per (kind, env), matching the (kind, env)-keyed status/lock tracking upstream.
const interpreterIdentity = (request: NotebookExecutionRequest): string => {
  const ri = request.resolvedInterpreter
  return ri ? [ri.command, ...(ri.args ?? [])].join('\n') : ''
}

// Converts process, spawn, timeout, and loop errors into normal notebook execution results.
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
    outputs: [{ type: 'error', message, traceback: message }],
    workingFiles: []
  }
}

// Drives one persistent exec-loop process per kind for a notebook session, framing requests over
// stdin, matching responses by id, enforcing the interrupt/kill timeout, and mapping each reply to a
// NotebookExecutionResult (mapLoopOutputs). The python/r data loops and the repl control loop coexist
// as independent processes; the requested kind never triggers a restart of another.
class NotebookKernelExecutor implements NotebookExecutor {
  private readonly procs = new Map<ProcessKey, ProcState>()
  // In-flight process-tree teardowns, keyed by the process key of the proc being reaped. A dropped
  // proc's tree is killed asynchronously; ensureProc awaits any pending teardown for a key before
  // spawning its replacement, so two live process trees for the SAME (kind, env) never briefly coexist.
  // Each promise resolves to the teardown's ProcessTreeKillResult (killChildTracked stores killChild's
  // result), so shutdown() can fold its reaped outcome into the overall reaped guarantee.
  private readonly pendingTeardowns = new Map<ProcessKey, Promise<ProcessTreeKillResult>>()
  // One temp dir the loops write captured figures into; created lazily, reused, removed on shutdown.
  private figuresDir: string | undefined
  private readonly pythonLoopPath: string
  private readonly rLoopPath: string
  private readonly replLoopPath: string
  private readonly idleTimeoutMs: number
  private readonly scheduleIdleTimer: ScheduleIdleTimer
  private readonly cancelIdleTimer: CancelIdleTimer
  private readonly onIdleShutdown?: (kind: KernelProcessKind, env: string) => void
  private readonly onTerminated?: (kind: KernelProcessKind, env: string) => void

  constructor(options: NotebookKernelExecutorOptions = {}) {
    this.pythonLoopPath = options.pythonLoopPath ?? defaultPythonLoopPath()
    this.rLoopPath = options.rLoopPath ?? defaultRLoopPath()
    this.replLoopPath = options.replLoopPath ?? defaultReplLoopPath()
    this.idleTimeoutMs = resolveIdleTimeoutMs(options.idleTimeoutMs)
    this.scheduleIdleTimer = options.scheduleIdleTimer ?? defaultScheduleIdleTimer
    this.cancelIdleTimer = options.cancelIdleTimer ?? defaultCancelIdleTimer
    this.onIdleShutdown = options.onIdleShutdown
    this.onTerminated = options.onTerminated
  }

  // Sends one cell to the kind's loop and resolves with the mapped execution result.
  async execute(request: NotebookExecutionRequest): Promise<NotebookExecutionResult> {
    try {
      const kind = resolveProcessKind(request)
      const env = kind === 'repl' ? '' : resolveRequestEnv(kind, request)
      const key = resolveProcessKey(request)
      this.checkEnvironmentReady(kind, env, request)

      const proc = await this.ensureProc(key, kind, env, request)
      if (proc.pending) {
        throw new Error('Notebook execution is already running.')
      }

      const reqId = randomUUID()
      const { response, timedOut } = await this.sendRequest(proc, reqId, request)

      const figures = await this.readFigures(response.figures)
      const mapped = mapLoopOutputs({
        stdout: response.stdout,
        stderr: response.stderr,
        error: response.error,
        errorLine: response.errorLine,
        result: response.result,
        figures
      })

      // A soft-timeout interrupt was sent for this run; whatever answered is reported as a timeout,
      // not trusted as a genuine completion (an interrupt ack does not prove the loop stopped).
      const status = timedOut ? 'timeout' : response.error !== null ? 'failed' : 'completed'

      return {
        status,
        stdout: mapped.stdout,
        stderr: mapped.stderr,
        traceback: mapped.traceback,
        cwdAfter: response.cwd || request.cwd,
        outputs: mapped.outputs,
        workingFiles: []
      }
    } catch (error) {
      return errorToExecutionResult(error, request)
    }
  }

  // Kills every loop, rejects any pending run, and removes the temp figures dir. Returns { reaped }:
  // true only when every kernel tree was cleanly reaped, so shutdownAll can gate the update-install
  // uninstall on all interpreter file handles being released.
  async shutdown(): Promise<ProcessTreeKillResult> {
    const procs = Array.from(this.procs.values())
    this.procs.clear()

    for (const proc of procs) {
      this.disarmIdleTimer(proc)
      this.rejectPending(proc, new Error('Notebook kernel was shut down.'))
      proc.readline.close()
    }
    // A hard-timeout/idle/identity-change drop moves its tree kill into pendingTeardowns and removes
    // the proc from `procs`, so a teardown started just before shutdown is invisible to the loop above.
    // Snapshot and await those too: a still-dying old tree must not let the reaped result greenlight the
    // update-install uninstall while it still holds an interpreter file handle.
    const pending = Array.from(this.pendingTeardowns.values())
    const [results, pendingResults] = await Promise.all([
      Promise.all(procs.map((proc) => this.killChild(proc.child))),
      Promise.all(pending)
    ])

    if (this.figuresDir) {
      await rm(this.figuresDir, { recursive: true, force: true }).catch(() => {})
      this.figuresDir = undefined
    }
    // Reaped only when every current proc AND every outstanding teardown reaped its whole tree.
    return {
      reaped:
        results.every((result) => result.reaped) && pendingResults.every((result) => result.reaped)
    }
  }

  // Tears down all loops so the next execute() lazily respawns a clean process per language.
  async restart(): Promise<void> {
    await this.shutdown()
  }

  // Physically tears down ONE (kind, env) kernel: drop it from the routing map FIRST (so its exit
  // handler is a no-op — no spurious 'terminated' status), fail any pending run, then kill + await the
  // child. A no-op when no such proc is live. The next execute() for this key respawns a clean process.
  async terminate(kind: KernelProcessKind, env: string): Promise<void> {
    const key: ProcessKey = kind === 'repl' ? 'repl' : `${kind}:${env}`
    const proc = this.procs.get(key)
    if (!proc) return
    this.procs.delete(key)
    this.disarmIdleTimer(proc)
    this.rejectPending(proc, new Error('Notebook kernel was torn down for a runtime switch.'))
    proc.readline.close()
    await this.killChild(proc.child)
  }

  // Checked before ever spawning a loop for a (kind, env), so a not-yet-provisioned environment fails
  // with a clear, actionable message instead of an opaque spawn/ENOENT error. The repl kernel runs
  // under process.execPath (always present), so it needs no readiness gate.
  private checkEnvironmentReady(
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest
  ): void {
    if (kind === 'repl') return

    // An externally-resolved interpreter (BYO/overlay) bypasses the managed-prefix readiness gate:
    // its readiness is validated by the Runtime Registry before it reaches the executor, and the
    // managed default-env bin will not exist on disk for it. A genuinely bad path still surfaces as a
    // clear spawn ENOENT below.
    if (request.resolvedInterpreter) return

    const prefix = envPrefix(request.runtimeRoot, env)

    if (kind === 'python') {
      // Every env (default and named) is gated on its own on-disk interpreter: there is no system-PATH
      // fallback, so a missing interpreter is always a hard error here rather than a silent leak to a
      // system python. The default env keeps its "still being prepared" wording; a named env is named.
      if (!existsSync(pythonBin(prefix))) {
        throw new Error(
          env === DEFAULT_PY_ENV
            ? 'The Python environment is still being prepared — retry shortly. Do NOT create a new environment; the default one provisions automatically.'
            : `The Python environment "${env}" does not exist. Create it first with manage_environments(action:"create", language:"python", name:"${env}").`
        )
      }
      return
    }

    if (!existsSync(rBin(prefix))) {
      throw new Error(
        env === DEFAULT_R_ENV
          ? 'The R environment is still being prepared — retry shortly. Do NOT create a new environment; the default one provisions automatically.'
          : `The R environment "${env}" does not exist. Create it first with manage_environments(action:"create", language:"r", name:"${env}").`
      )
    }
  }

  // Reuses a live loop for the (kind, env) or spawns a fresh one, wiring its readline, stderr drain,
  // and exit handling.
  private async ensureProc(
    key: ProcessKey,
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest
  ): Promise<ProcState> {
    const identity = interpreterIdentity(request)
    const existing = this.procs.get(key)
    if (existing && existing.alive) {
      if (existing.interpreterIdentity === identity) {
        // Start of a new request on this proc: disarm the idle timer armed after its last completion.
        this.disarmIdleTimer(existing)
        return existing
      }
      // The resolved runtime for this (kind, env) changed (managed <-> external, or a different external
      // interpreter). Tear the old process down so a cell never runs in a kernel backed by the previous
      // interpreter with stale in-memory state; a fresh one spawns below. dropProc removes it from the
      // map first, so its exit handler is a no-op (no spurious 'terminated' status for this key).
      this.dropProc(existing)
      this.killChildTracked(existing)
    }

    // Wait out any in-flight teardown for this key (a prior hard-timeout/idle/identity-change drop) so
    // we never run two live process trees for the same (kind, env) at once.
    const pending = this.pendingTeardowns.get(key)
    if (pending) await pending

    const child = await this.spawnLoop(kind, env, request)
    const readline = createInterface({ input: child.stdout })
    const proc: ProcState = {
      kind,
      env,
      key,
      child,
      readline,
      alive: true,
      interpreterIdentity: identity
    }

    readline.on('line', (line) => this.handleLine(proc, line))
    // Drain stderr unconditionally so a chatty/crashing loop can never block on a full OS pipe.
    child.stderr.on('data', () => {})
    // A late async pipe error (e.g. EPIPE if the loop died mid-write) must not surface as an
    // uncaught error on the main process; fail any pending run instead, or swallow it if none is
    // in flight. Same stale-proc guard as the exit handler below.
    child.stdin.on('error', () => {
      if (this.procs.get(key) !== proc) return
      this.rejectPending(proc, new Error('Notebook kernel stdin pipe failed.'))
    })
    child.on('exit', () => {
      // Stale exit: this proc was already replaced (dropped after a hard kill, or a respawn) before
      // the event fired, so it must not touch the live proc or its pending run.
      if (this.procs.get(key) !== proc) return
      proc.alive = false
      this.disarmIdleTimer(proc)
      this.procs.delete(key)
      proc.readline.close()
      this.rejectPending(proc, new Error('Notebook kernel process exited.'))
      // Unexpected exit of a still-live proc is a crash; surface it as a 'terminated' kernel status.
      // Intentional teardown (shutdown/restart) and hard-timeout/idle drops clear the map first, so
      // this only fires for a genuine crash (the stale-proc guard above returns early otherwise).
      this.onTerminated?.(kind, env)
    })

    this.procs.set(key, proc)
    return proc
  }

  // Spawns the loop process for a (kind, env) with the notebook runtime env. The interpreter is derived
  // per request from request.runtimeRoot + the resolved env name, so named envs bind to their own
  // on-disk interpreter. The repl kernel runs the JS loop under process.execPath.
  private async spawnLoop(
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest
  ): Promise<ChildProcessWithoutNullStreams> {
    const figuresDir = this.ensureFiguresDir()
    // A missing session dir would surface as an opaque ENOENT; fall back to the OS default cwd so
    // spawn fails only for a genuinely missing interpreter.
    const spawnCwd = existsSync(request.cwd) ? request.cwd : undefined
    const spawnEnv = this.buildEnv(kind, request, figuresDir)
    const prefix = envPrefix(request.runtimeRoot, env)

    let command: string
    let args: string[]
    if (kind === 'repl') {
      // Run the control-plane loop as plain Node via the app binary (ELECTRON_RUN_AS_NODE set in env).
      command = process.execPath
      args = [this.replLoopPath]
    } else {
      // Data kernel (python/r). The loop SCRIPT is chosen by kind; the INTERPRETER is either resolved
      // by the Runtime Registry (a managed env bin, or an external/overlay interpreter for BYO) or,
      // when unresolved, the env's own managed interpreter -- the backward-compatible default (no
      // system-PATH fallback; a missing managed interpreter still surfaces a clear ENOENT). This is
      // the seam that lets the user choose the kernel instead of hard-binding the app conda prefix.
      const loopPath = kind === 'r' ? this.rLoopPath : this.pythonLoopPath
      const managedBin = kind === 'r' ? rScriptBin(prefix) : pythonBin(prefix)
      command = request.resolvedInterpreter?.command ?? managedBin
      args = [...(request.resolvedInterpreter?.args ?? []), loopPath]
    }

    const child = spawn(command, args, { cwd: spawnCwd, env: spawnEnv })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return child
  }

  // Builds the spawn env shared by the loops, adding the figures dir, (for R) a PATH prefix, and (for
  // the repl kernel) the ELECTRON_RUN_AS_NODE flag so the app binary runs as plain Node. The R env
  // prefix is derived per request from request.runtimeRoot + the resolved env name.
  private buildEnv(
    kind: KernelProcessKind,
    request: NotebookExecutionRequest,
    figuresDir: string
  ): NodeJS.ProcessEnv {
    const rEnvPrefix =
      kind === 'r' ? envPrefix(request.runtimeRoot, resolveRequestEnv(kind, request)) : undefined
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Force a non-interactive matplotlib backend so plt.show() never opens a GUI window in this
      // headless runtime; respect an explicitly configured backend if present.
      MPLBACKEND: process.env.MPLBACKEND || 'Agg',
      OPEN_SCIENCE_NOTEBOOK_DIR: request.notebookSessionRoot,
      OPEN_SCIENCE_NOTEBOOK_DATA_DIR: request.dataRoot,
      OPEN_SCIENCE_RUNTIME_DIR: request.runtimeRoot,
      // Cross-kernel workspace channel (see repository.ts): same path every kernel kind sees.
      OPEN_SCIENCE_HANDOFF_DIR: join(request.notebookSessionRoot, 'handoff'),
      // App-owned directories the kernel must not read (e.g. materialized skill files).
      OPEN_SCIENCE_PROTECTED_DIRS: (request.protectedDirs ?? []).join(delimiter),
      [KERNEL_FIGURES_DIR_ENV]: figuresDir,
      // Connector RPC endpoint/token reach ONLY the control-plane repl kernel: the python/r data
      // kernels have no host.mcp and no outbound connector access. Gating on kind here is
      // defense-in-depth — even if a data request ever carried these, python/r would never see them.
      ...(kind === 'repl' && request.mcpRpcEndpoint
        ? { OPEN_SCIENCE_MCP_RPC_ENDPOINT: request.mcpRpcEndpoint }
        : {}),
      ...(kind === 'repl' && request.mcpRpcToken
        ? { OPEN_SCIENCE_MCP_RPC_TOKEN: request.mcpRpcToken }
        : {}),
      ...(kind === 'repl' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(rEnvPrefix ? { OPEN_SCIENCE_R_ENV_PREFIX: rEnvPrefix } : {})
    }

    // The R loop shells out to the env's own tools; putting its bin first keeps them consistent.
    if (rEnvPrefix) {
      env.PATH = `${join(rEnvPrefix, 'bin')}${delimiter}${process.env.PATH ?? ''}`
    }
    return env
  }

  // Frames one request onto the loop's stdin and returns a promise settled by the matching response
  // line, the timeout manager, or an unexpected process exit.
  private sendRequest(
    proc: ProcState,
    reqId: string,
    request: NotebookExecutionRequest
  ): Promise<{ response: KernelLoopResponse; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timeout = new TimeoutController({
        // SIGINT (soft) goes to the direct loop so it can interrupt gracefully. The hard SIGKILL is
        // routed through terminateProcessTree, which enumerates descendants BEFORE killing — so a
        // grandchild the loop spawned is reaped too, not orphaned by a premature direct kill of the
        // root (killing the root first would reparent its children away from any ps-walk).
        kill: (signal) => {
          if (signal === 'SIGKILL') this.killChildTracked(proc)
          else proc.child.kill(signal)
        },
        onHardTimeout: () => {
          // The tree kill was already initiated by kill('SIGKILL') above; here we just drop the wedged
          // loop (next execute respawns), surface 'terminated', and fail this run.
          if (proc.pending?.reqId !== reqId) return
          proc.pending = undefined
          this.dropProc(proc)
          // The dropped proc is gone for good; surface it as 'terminated' (its exit handler no longer
          // fires onTerminated because dropProc already removed it from the map).
          this.onTerminated?.(proc.kind, proc.env)
          reject(
            new NotebookExecutionTimeoutError(`Notebook execution timed out after ${timeoutMs}ms.`)
          )
        }
      })

      proc.pending = {
        reqId,
        resolve: (response) => resolve({ response, timedOut: timeout.timedOut }),
        reject,
        timeout
      }

      if (proc.kind === 'r') {
        proc.child.stdin.write(frameRRequest(reqId, request.code))
      } else {
        // Python and the repl (JS) loop share the same JSON-lines request framing.
        proc.child.stdin.write(framePythonRequest(reqId, request.code))
      }
      timeout.arm(timeoutMs)
    })
  }

  // Matches one loop response line to the in-flight request and clears its timeout.
  private handleLine(proc: ProcState, line: string): void {
    const response = parseLoopResponse(line)
    if (!response) return

    const pending = proc.pending
    if (!pending || pending.reqId !== response.reqId) return

    pending.timeout.disarm()
    proc.pending = undefined
    pending.resolve(response)
    this.rearmIdleTimerIfLive(proc)
  }

  // Reads each captured figure file, base64-encodes it, and unlinks it. A missing/unreadable file is
  // skipped rather than failing the whole cell.
  private async readFigures(figures: KernelLoopFigure[]): Promise<MappedFigure[]> {
    const mapped: MappedFigure[] = []
    for (const figure of figures) {
      try {
        const data = await readFile(figure.path)
        mapped.push({ mime: figure.mime, base64: data.toString('base64') })
        await unlink(figure.path).catch(() => {})
      } catch {
        // Skip a figure that vanished or could not be read.
      }
    }
    return mapped
  }

  // Removes a wedged loop from the routing map after a hard kill so the next execute() respawns it.
  private dropProc(proc: ProcState): void {
    proc.alive = false
    this.disarmIdleTimer(proc)
    if (this.procs.get(proc.key) === proc) this.procs.delete(proc.key)
    proc.readline.close()
  }

  // Fails the loop's current run once (if any), clearing its timeout first.
  private rejectPending(proc: ProcState, error: Error): void {
    const pending = proc.pending
    if (!pending) return

    pending.timeout.disarm()
    proc.pending = undefined
    pending.reject(error)
    this.rearmIdleTimerIfLive(proc)
  }

  // Arms the idle-shutdown timer for a proc that just went idle (no pending request). A non-positive
  // window disables idle reclaim entirely (the default): the kernel persists until an explicit
  // shutdown/restart or session teardown, so its namespace is never silently dropped mid-analysis.
  private armIdleTimer(proc: ProcState): void {
    if (this.idleTimeoutMs <= 0) return
    proc.idleTimer = this.scheduleIdleTimer(() => this.handleIdleTimeout(proc), this.idleTimeoutMs)
  }

  // Cancels a proc's idle timer; called at the start of every new request on that proc.
  private disarmIdleTimer(proc: ProcState): void {
    if (proc.idleTimer === undefined) return
    this.cancelIdleTimer(proc.idleTimer)
    proc.idleTimer = undefined
  }

  // Re-arms the idle timer once a request settles, but only while this is still the live proc routed
  // for its key -- a shutdown() or hard-timeout drop removes it from the map first, and an idle timer
  // on an already-dropped proc would be a dangling no-op at best.
  private rearmIdleTimerIfLive(proc: ProcState): void {
    if (!proc.alive || this.procs.get(proc.key) !== proc) return
    this.armIdleTimer(proc)
  }

  // Fires after the idle window with no new request on this proc: drops it (kill + remove from the
  // map) so the next execute() lazily respawns a fresh process with a clean namespace. A request that
  // started between the timer arming and firing always wins the race -- execute()/ensureProc() disarm
  // the timer synchronously before any await, so it can never fire while a request is in flight.
  private handleIdleTimeout(proc: ProcState): void {
    proc.idleTimer = undefined
    if (proc.pending || this.procs.get(proc.key) !== proc) return

    this.dropProc(proc)
    this.killChildTracked(proc)
    this.onIdleShutdown?.(proc.kind, proc.env)
  }

  // Fire-and-forget tree teardown for a DROPPED proc, tracked by its key so ensureProc can await it
  // before respawning a replacement for the same (kind, env). Self-clears once the teardown settles.
  private killChildTracked(proc: ProcState): void {
    const done = this.killChild(proc.child).finally(() => {
      if (this.pendingTeardowns.get(proc.key) === done) this.pendingTeardowns.delete(proc.key)
    })
    this.pendingTeardowns.set(proc.key, done)
  }

  // Kills a child and every descendant it spawned (a conda/micromamba launcher, an R subprocess),
  // waiting for the direct child to actually exit and escalating to SIGKILL anything left alive.
  // Returns { reaped } so shutdown()/shutdownAll() can tell a clean teardown (all trees gone, file
  // handles released) from a degraded one — the update-install gate refuses the NSIS uninstall unless
  // every kernel tree was cleanly reaped. terminateProcessTree never rejects.
  private async killChild(child: ChildProcessWithoutNullStreams): Promise<ProcessTreeKillResult> {
    const result = await terminateProcessTree(child)
    child.removeAllListeners('exit')
    child.removeAllListeners('close')
    return result
  }

  // Creates the per-executor figures dir on first use and reuses it thereafter.
  private ensureFiguresDir(): string {
    if (!this.figuresDir) {
      this.figuresDir = mkdtempSync(join(tmpdir(), 'open-science-kernel-figs-'))
    }
    return this.figuresDir
  }
}

export { NotebookKernelExecutor }
export type { KernelProcessKind }
