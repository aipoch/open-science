import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, posix, win32 } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { Transform, type TransformCallback } from 'node:stream'

import { terminateProcessTree, type ProcessTreeKillResult } from '../process-tree'
import {
  KERNEL_FIGURES_DIR_ENV,
  frameRNamespaceRequest,
  frameRRequest,
  framePythonNamespaceRequest,
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopFigure,
  type KernelLoopResponse
} from './kernel-protocol'
import { mapLoopOutputs, type MappedFigure } from './loop-output-mapper'
import { protectManagedRuntimeWrites } from './managed-runtime-guard'
import { buildNotebookKernelEnvironment, environmentPathRoots } from './process-environment'
import type { NotebookProcessSandbox } from './process-sandbox'
import {
  notebookWorkloadCacheEnv,
  notebookWorkloadCacheRoot,
  prepareNotebookWorkloadCache
} from './notebook-workload-cache-paths'
import {
  condaActivatedPath,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  rScriptBin,
  resolveEnvName
} from './runtime-paths'
import type {
  NotebookSessionNamespaceRequest,
  NotebookSessionNamespaceResult
} from './session-aggregate'
import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor
} from './runtime-service'
import { TimeoutController } from './timeout-controller'
import { startWorkingFileObservation, type WorkingFileObservation } from './working-file-observer'
import {
  NOTEBOOK_FIGURE_COUNT_LIMIT,
  NOTEBOOK_FIGURE_COUNT_LIMIT_ENV,
  NOTEBOOK_FIGURE_LIMIT_BYTES,
  NOTEBOOK_FIGURE_LIMIT_ENV,
  NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES,
  NOTEBOOK_FIGURE_TOTAL_LIMIT_ENV,
  NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_BYTES,
  NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_ENV,
  NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_BYTES,
  NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_ENV,
  NOTEBOOK_NAMESPACE_VARIABLE_LIMIT,
  NOTEBOOK_NAMESPACE_VARIABLE_LIMIT_ENV,
  NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES,
  NOTEBOOK_TEXT_LIMIT_BYTES,
  NOTEBOOK_TEXT_LIMIT_ENV
} from './content-limits'
import {
  notebookHelperInitializationCode,
  type NotebookHelperModuleInjection
} from './helper-module-host'
import { notebookInterpreterIdentity } from './session-aggregate'

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
const DEFAULT_CANCELLATION_GRACE_MS = 2_000
const DEFAULT_NAMESPACE_INSPECTION_TIMEOUT_MS = 5_000
// Queued behind an interrupted R request before its queue is released. The sleep gives a SIGINT that
// raced with the original response an interruptible, side-effect-free request to land in.
const R_INTERRUPT_PROBE_CODE = 'base::Sys.sleep(0.05)'

const presentPaths = (values: readonly string[]): string[] =>
  values.filter((value) => value.length > 0)

const kernelExecutableReadRoot = (
  executable: string,
  kind: KernelProcessKind,
  platform: NodeJS.Platform
): string => {
  const platformPath = platform === 'win32' ? win32 : posix
  if (kind === 'repl' && platform === 'darwin' && executable.includes('/Contents/MacOS/')) {
    return platformPath.resolve(platformPath.dirname(executable), '../..')
  }
  return platformPath.dirname(executable)
}

// Real scheduler: unref'd so a pending idle timer alone never keeps the process alive.
const defaultScheduleIdleTimer: ScheduleIdleTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

const defaultCancelIdleTimer: CancelIdleTimer = (handle) => clearTimeout(handle as NodeJS.Timeout)

// Stops an unframed native/subprocess write from making readline retain an unbounded protocol line.
const createBoundedKernelOutput = (onLimit: (error: Error) => void): Transform => {
  let lineBytes = 0
  let limited = false
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      if (limited) {
        callback()
        return
      }
      let start = 0
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, start)
        const end = newline === -1 ? chunk.byteLength : newline
        lineBytes += end - start
        if (lineBytes > NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES) {
          limited = true
          onLimit(
            new Error(
              `Notebook kernel response exceeded the ${NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES}-byte transport limit.`
            )
          )
          callback()
          return
        }
        if (newline === -1) break
        lineBytes = 0
        start = newline + 1
      }
      callback(null, chunk)
    }
  })
}

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
  // Time allowed for a POSIX kernel to acknowledge SIGINT before its process tree is dropped. The
  // short grace preserves responsive namespaces without letting cancellation hang indefinitely.
  cancellationGraceMs?: number
  // Hard limit for the read-only namespace request. Expiry drops the kernel because a stuck
  // interpreter cannot safely accept another framed request.
  namespaceInspectionTimeoutMs?: number
  // Injectable idle-timer scheduler/canceller so tests drive idle-shutdown with a fake clock instead
  // of waiting out the real idle window.
  scheduleIdleTimer?: ScheduleIdleTimer
  cancelIdleTimer?: CancelIdleTimer
  // Invoked once a proc is dropped for being idle; the caller can use this to surface a 'terminated'
  // kernel status upward (see NotebookRuntimeService). Carries the resolved env so the caller marks
  // the right per-(kind, env) kernel status ('' for the env-agnostic repl).
  onIdleShutdown?: (kind: KernelProcessKind, env: string) => void
  // Invoked once a proc is lost unexpectedly (a crash exit or a hard-timeout drop), or cancellation
  // must drop it because Windows cannot recoverably interrupt it or a POSIX grace period expires.
  // NOT invoked on an intentional shutdown()/restart(). Parallels onIdleShutdown so the caller can
  // persist a 'terminated' kernel status for an involuntary loss too (see NotebookRuntimeService).
  onTerminated?: (kind: KernelProcessKind, env: string) => void
  // Injectable only to exercise the Windows conda activation contract on non-Windows test hosts.
  platform?: NodeJS.Platform
  // Shared application-owned network sandbox. Omitted only by isolated executor tests.
  processSandbox?: NotebookProcessSandbox
}

// One in-flight request awaiting a matching loop response line.
type PendingRequest = {
  reqId: string
  resolve: (response: KernelLoopResponse) => void
  reject: (error: unknown) => void
  cancelled: boolean
  signal?: AbortSignal
  abortListener?: () => void
  cancellationTimer?: IdleTimerHandle
  interruptProbeReqId?: string
  interruptAcknowledged?: boolean
  response?: KernelLoopResponse
  timeout?: TimeoutController
  timeoutMs?: number
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
  beginSandboxExecution: () => () => void
  stderrTail: string
  annotateStderr: (stderr: string) => string
  // Captures why an involuntarily dropped proc became unusable before a request was registered, so
  // execute() can fail that pre-dispatch run instead of writing to a stale child and waiting forever.
  terminationError?: Error
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
  // Canonical host descriptors already installed into the Python loop's immutable audit hooks.
  // New roots cross the protocol once; Python never exposes a mutable policy collection or updater.
  protectedDirs: Set<string>
}

// Marks timeouts distinctly so persisted run status can reflect timeout instead of failure.
class NotebookExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotebookExecutionTimeoutError'
  }
}

class NotebookExecutionCancelledError extends Error {
  constructor() {
    super('Notebook execution was cancelled.')
    this.name = 'NotebookExecutionCancelledError'
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
// Converts process, spawn, timeout, and loop errors into normal notebook execution results.
const errorToExecutionResult = (
  error: unknown,
  request: NotebookExecutionRequest,
  kernelDispatched = false,
  helperModulesInitialized: readonly string[] = []
): NotebookExecutionResult => {
  if (error instanceof NotebookExecutionCancelledError) {
    return {
      status: 'cancelled',
      kernelDispatched,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: [],
      workingFiles: [],
      ...(helperModulesInitialized.length ? { helperModulesInitialized } : {})
    }
  }

  const message = error instanceof Error ? error.message : String(error)

  return {
    status: error instanceof NotebookExecutionTimeoutError ? 'timeout' : 'failed',
    kernelDispatched,
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: request.cwd,
    outputs: [{ type: 'error', message, traceback: message }],
    workingFiles: [],
    ...(helperModulesInitialized.length ? { helperModulesInitialized } : {})
  }
}

const helperInitializationError = (
  helpers: readonly NotebookHelperModuleInjection[],
  responseError: string
): Error => {
  const stage = responseError.includes('OPEN_SCIENCE_HELPER_MISSING_EXPORT')
    ? 'HELPER_MISSING_EXPORT'
    : responseError.includes('OPEN_SCIENCE_HELPER_EXPORT_COLLISION')
      ? 'HELPER_EXPORT_COLLISION'
      : responseError.includes('OPEN_SCIENCE_HELPER_DEPENDENCY_EXPORT_MISSING')
        ? 'HELPER_DEPENDENCY_EXPORT_MISSING'
        : 'HELPER_INITIALIZATION_FAILED'
  const helper =
    helpers.find(({ id }) =>
      responseError.includes(`${stage.replace(/^HELPER_/, 'OPEN_SCIENCE_HELPER_')}:${id}`)
    ) ??
    helpers.find(({ id }) => responseError.includes(`:${id}`)) ??
    helpers[0]
  if (!helper) return new Error(`${stage}: helper plan failed before producer dispatch.`)
  const initializationDiagnostic = responseError.match(
    new RegExp(
      `OPEN_SCIENCE_HELPER_INITIALIZATION_FAILED:${helper.id}:` +
        `([A-Za-z_][A-Za-z0-9_]{0,127})` +
        `(?::MISSING_MODULE:([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))?`
    )
  )
  const pythonErrorType = initializationDiagnostic?.[1]
  const missingModule = initializationDiagnostic?.[2]
  const actionableDetail = missingModule
    ? ` Python ${pythonErrorType}: No module named "${missingModule}". ` +
      'Use inspect_packages to inspect the current environment and manage_packages to install dependencies.'
    : pythonErrorType
      ? ` Python ${pythonErrorType}.`
      : ''
  return new Error(
    `${stage}: helper "${helper.id}" failed before producer dispatch ` +
      `(digest ${helper.digest.slice(0, 12)}, epoch ${helper.epochId}).${actionableDetail}`
  )
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
  private readonly cancellationGraceMs: number
  private readonly namespaceInspectionTimeoutMs: number
  private readonly platform: NodeJS.Platform
  private readonly processSandbox?: NotebookProcessSandbox

  constructor(options: NotebookKernelExecutorOptions = {}) {
    this.pythonLoopPath = options.pythonLoopPath ?? defaultPythonLoopPath()
    this.rLoopPath = options.rLoopPath ?? defaultRLoopPath()
    this.replLoopPath = options.replLoopPath ?? defaultReplLoopPath()
    this.idleTimeoutMs = resolveIdleTimeoutMs(options.idleTimeoutMs)
    this.scheduleIdleTimer = options.scheduleIdleTimer ?? defaultScheduleIdleTimer
    this.cancelIdleTimer = options.cancelIdleTimer ?? defaultCancelIdleTimer
    this.onIdleShutdown = options.onIdleShutdown
    this.onTerminated = options.onTerminated
    this.cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS
    this.namespaceInspectionTimeoutMs =
      options.namespaceInspectionTimeoutMs ?? DEFAULT_NAMESPACE_INSPECTION_TIMEOUT_MS
    this.platform = options.platform ?? process.platform
    this.processSandbox = options.processSandbox
  }

  // Sends one cell to the kind's loop and resolves with the mapped execution result.
  async execute(request: NotebookExecutionRequest): Promise<NotebookExecutionResult> {
    let workingFileObservation: WorkingFileObservation | undefined
    let kernelDispatched = false
    let endSandboxExecution: (() => void) | undefined
    const helperModulesInitialized: string[] = []
    try {
      if (request.signal?.aborted) throw new NotebookExecutionCancelledError()
      const kind = resolveProcessKind(request)
      const env = kind === 'repl' ? '' : resolveRequestEnv(kind, request)
      const key = resolveProcessKey(request)
      this.checkEnvironmentReady(kind, env, request)

      const proc = await this.ensureProc(key, kind, env, request)
      if (proc.pending) throw new Error('Notebook execution is already running.')
      endSandboxExecution = proc.beginSandboxExecution()

      const helperModules = request.helperModules ?? []
      for (const helper of helperModules) {
        if (kind !== 'python' || helper.language !== 'python') {
          throw new Error(
            `UNSUPPORTED_HELPER_LANGUAGE: helper "${helper.id}" cannot run on this kernel.`
          )
        }
      }
      if (helperModules.length > 0) {
        const initialization = await this.sendRequest(
          proc,
          randomUUID(),
          {
            ...request,
            code: notebookHelperInitializationCode(helperModules),
            helperModules: undefined
          },
          () => undefined
        )
        // A matched success response proves the whole transaction published even when a soft
        // timeout/cancellation raced with it. Never report or commit a partial helper plan.
        if (initialization.response.error === null) {
          helperModulesInitialized.push(...helperModules.map(({ id }) => id))
        }
        if (initialization.cancelled) throw new NotebookExecutionCancelledError()
        if (initialization.timedOut) {
          const first = helperModules[0]
          throw new NotebookExecutionTimeoutError(
            `HELPER_INITIALIZATION_TIMEOUT: helper plan timed out before producer dispatch` +
              (first
                ? ` (first helper "${first.id}", digest ${first.digest.slice(0, 12)}, epoch ${first.epochId}).`
                : '.')
          )
        }
        if (initialization.response.error !== null) {
          throw helperInitializationError(helperModules, initialization.response.error)
        }
      }
      workingFileObservation = await startWorkingFileObservation(request)
      // sendRequest installs proc.pending synchronously. Revalidate immediately before that handoff:
      // an involuntary drop while ensureProc was finishing must settle this execute() locally rather
      // than dispatching to a stale child whose guarded exit handler can no longer reject the run.
      if (!proc.alive || this.procs.get(key) !== proc) {
        throw proc.terminationError ?? new Error('Notebook kernel process exited before execution.')
      }

      const reqId = randomUUID()
      const { response, timedOut, cancelled } = await this.sendRequest(proc, reqId, request, () => {
        kernelDispatched = true
      })
      const fileObservation = await workingFileObservation.finish(
        timedOut || cancelled ? AbortSignal.abort() : request.signal
      )
      workingFileObservation = undefined

      const figureResult = await this.readFigures(response.figures)
      const processStderr = proc.annotateStderr(proc.stderrTail)
      proc.stderrTail = ''
      const mapped = mapLoopOutputs({
        stdout: response.stdout,
        stderr: [response.stderr, processStderr].filter(Boolean).join('\n'),
        error: response.error,
        errorLine: response.errorLine,
        result: response.result,
        figures: figureResult.figures
      })

      // A soft-timeout interrupt was sent for this run; whatever answered is reported as a timeout,
      // not trusted as a genuine completion (an interrupt ack does not prove the loop stopped).
      const status = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timeout'
          : response.error !== null
            ? 'failed'
            : 'completed'

      return {
        status,
        kernelDispatched,
        stdout: mapped.stdout,
        stderr: mapped.stderr,
        traceback: cancelled ? '' : mapped.traceback,
        cwdAfter: response.cwd || request.cwd,
        outputs: cancelled
          ? mapped.outputs.filter((output) => output.type !== 'error')
          : mapped.outputs,
        truncated: response.outputTruncated || figureResult.truncated,
        workingFiles: fileObservation.workingFiles,
        fileEvidence: fileObservation.fileEvidence,
        ...(helperModulesInitialized.length ? { helperModulesInitialized } : {}),
        environmentOverlay: response.environmentOverlay
      }
    } catch (error) {
      const fileObservation = await workingFileObservation?.finish(AbortSignal.abort())
      return {
        ...errorToExecutionResult(error, request, kernelDispatched, helperModulesInitialized),
        ...(fileObservation
          ? {
              workingFiles: fileObservation.workingFiles,
              fileEvidence: fileObservation.fileEvidence
            }
          : {})
      }
    } finally {
      endSandboxExecution?.()
    }
  }

  // Reads a bounded snapshot from an already-live data kernel. Unlike execute(), this deliberately
  // never calls ensureProc(): opening Variables must not create a fresh, misleading namespace.
  async inspectNamespace(
    request: NotebookSessionNamespaceRequest
  ): Promise<NotebookSessionNamespaceResult> {
    const kind = request.language
    const env = resolveEnvName(request.language, request.environment)
    const key = `${kind}:${env}`
    const proc = this.procs.get(key)
    if (!proc?.alive) return { status: 'unavailable' }
    if (proc.pending) throw new Error('Notebook kernel is already running.')

    this.disarmIdleTimer(proc)
    const reqId = randomUUID()
    const response = await this.sendNamespaceRequest(proc, reqId, request.includePrivate === true)
    if (!response.namespace)
      throw new Error('Notebook kernel returned an invalid namespace snapshot.')
    return { status: 'available', ...response.namespace }
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

    const prefix = envPrefix(request.runtimeRoot, env, this.platform)

    if (kind === 'python') {
      // Every env (default and named) is gated on its own on-disk interpreter: there is no system-PATH
      // fallback, so a missing interpreter is always a hard error here rather than a silent leak to a
      // system python. The default env keeps its "still being prepared" wording; a named env is named.
      if (!existsSync(pythonBin(prefix, this.platform))) {
        throw new Error(
          env === DEFAULT_PY_ENV
            ? 'The Python environment is still being prepared — retry shortly. Do NOT create a new environment; the default one provisions automatically.'
            : `The Python environment "${env}" does not exist. Create it first with manage_environments(action:"create", language:"python", name:"${env}").`
        )
      }
      return
    }

    if (!existsSync(rBin(prefix, this.platform))) {
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
    const identity = notebookInterpreterIdentity(request.resolvedInterpreter)
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

    const spawned = await this.spawnLoop(kind, env, request)
    const child = spawned.child
    const boundedOutput = createBoundedKernelOutput((error) => {
      if (this.procs.get(key) !== proc) return
      proc.terminationError = error
      this.dropProc(proc)
      this.killChildTracked(proc)
      this.onTerminated?.(kind, env)
      this.rejectPending(proc, error)
    })
    const readline = createInterface({ input: boundedOutput })
    const proc: ProcState = {
      kind,
      env,
      key,
      child,
      readline,
      beginSandboxExecution: spawned.beginSandboxExecution,
      stderrTail: '',
      annotateStderr: spawned.annotateStderr,
      alive: true,
      interpreterIdentity: identity,
      protectedDirs: new Set(request.protectedDirs ?? [])
    }

    readline.on('line', (line) => this.handleLine(proc, line))
    // Keep a bounded tail for sandbox diagnostics while continuing to drain a chatty child pipe.
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      proc.stderrTail = `${proc.stderrTail}${chunk}`.slice(-64 * 1024)
    })
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
      const pending = proc.pending
      const terminationError =
        pending?.timeout?.timedOut && pending.timeoutMs !== undefined
          ? new NotebookExecutionTimeoutError(
              `Notebook execution timed out after ${pending.timeoutMs}ms.`
            )
          : new Error('Notebook kernel process exited.')
      proc.terminationError = terminationError
      this.rejectPending(proc, terminationError)
      // Unexpected exit of a still-live proc is a crash; surface it as a 'terminated' kernel status.
      // Intentional teardown (shutdown/restart) and hard-timeout/idle drops clear the map first, so
      // this only fires for a genuine crash (the stale-proc guard above returns early otherwise).
      this.onTerminated?.(kind, env)
    })

    // Register before piping buffered stdout: pipe() can synchronously flush data that already arrived
    // after spawn, and the overflow callback must be able to identify and drop this proc.
    this.procs.set(key, proc)
    child.stdout.pipe(boundedOutput)
    return proc
  }

  // Spawns the loop process for a (kind, env) with the notebook runtime env. The interpreter is derived
  // per request from request.runtimeRoot + the resolved env name, so named envs bind to their own
  // on-disk interpreter. The repl kernel runs the JS loop under process.execPath.
  private async spawnLoop(
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest
  ): Promise<{
    child: ChildProcessWithoutNullStreams
    beginSandboxExecution: () => () => void
    annotateStderr: (stderr: string) => string
  }> {
    const figuresDir = this.ensureFiguresDir()
    // Control-plane REPL may omit a runtime root; package cache belongs to a managed runtime directory.
    const workloadCacheEnv = request.runtimeRoot
      ? prepareNotebookWorkloadCache(request.runtimeRoot)
      : {}
    // A missing session dir would surface as an opaque ENOENT; fall back to the OS default cwd so
    // spawn fails only for a genuinely missing interpreter.
    const spawnCwd = existsSync(request.cwd) ? request.cwd : undefined
    const spawnEnv = this.buildEnv(kind, request, figuresDir, workloadCacheEnv)
    const prefix = envPrefix(request.runtimeRoot, env, this.platform)

    let command: string
    let args: string[]
    let loopPath: string
    if (kind === 'repl') {
      // Run the control-plane loop as plain Node via the app binary (ELECTRON_RUN_AS_NODE set in env).
      command = process.execPath
      loopPath = this.replLoopPath
      args = [loopPath]
    } else {
      // Data kernel (python/r). The loop SCRIPT is chosen by kind; the INTERPRETER is either resolved
      // by the Runtime Registry (a managed env bin, or an external/overlay interpreter for BYO) or,
      // when unresolved, the env's own managed interpreter -- the backward-compatible default (no
      // system-PATH fallback; a missing managed interpreter still surfaces a clear ENOENT). This is
      // the seam that lets the user choose the kernel instead of hard-binding the app conda prefix.
      loopPath = kind === 'r' ? this.rLoopPath : this.pythonLoopPath
      const managedBin =
        kind === 'r' ? rScriptBin(prefix, this.platform) : pythonBin(prefix, this.platform)
      command = request.resolvedInterpreter?.command ?? managedBin
      args = [...(request.resolvedInterpreter?.args ?? []), loopPath]
    }

    // The semantic guard rejects known installers before dispatch. This native layer makes the
    // app-owned runtime read-only to the complete persistent-kernel process tree as well, covering
    // dynamically constructed R/Python/REPL calls. Only the disposable workload-cache subtree remains
    // writable; manage_packages remains the only package writer and wraps each installer separately.
    const nativeInvocation = { executable: command, args }
    const invocation = this.processSandbox
      ? nativeInvocation
      : protectManagedRuntimeWrites(nativeInvocation, request.runtimeRoot, this.platform)
    const sessionId = request.sessionId
    const projectId = request.projectId
    if (this.processSandbox && (!sessionId || !projectId)) {
      throw new Error('Notebook network sandbox requires Session and Project context.')
    }
    const sandboxed = this.processSandbox
      ? await this.processSandbox.wrap({
          executable: invocation.executable,
          args: invocation.args,
          env: spawnEnv,
          cwd: spawnCwd ?? process.cwd(),
          commandText: [invocation.executable, ...invocation.args].join(' '),
          sessionId: sessionId!,
          projectId: projectId!,
          runtime: kind,
          ...(kind === 'repl' && request.mcpRpcSocketPath
            ? { localRpcSocketPath: request.mcpRpcSocketPath }
            : {}),
          ...(kind === 'repl' && this.platform === 'linux' && request.mcpRpcToken
            ? { inheritedFileDescriptorCount: 1 }
            : {}),
          filesystem: {
            readOnlyRoots: presentPaths([
              request.runtimeRoot,
              request.inputRoot ?? '',
              kernelExecutableReadRoot(invocation.executable, kind, this.platform),
              loopPath,
              ...environmentPathRoots(spawnEnv, this.platform)
            ]),
            readWriteRoots: presentPaths([
              request.notebookSessionRoot,
              request.cwd,
              figuresDir,
              ...(request.runtimeRoot ? [notebookWorkloadCacheRoot(request.runtimeRoot)] : [])
            ]),
            deniedReadRoots: request.protectedDirs ?? [],
            deniedWriteRoots: request.protectedDirs ?? []
          }
        })
      : undefined
    const rpcTokenFileDescriptor =
      kind === 'repl' && this.platform === 'linux' && request.mcpRpcToken ? 3 : undefined
    const child = spawn(
      sandboxed?.executable ?? invocation.executable,
      sandboxed?.args ?? invocation.args,
      {
        cwd: spawnCwd,
        env: sandboxed?.env ?? spawnEnv,
        ...(rpcTokenFileDescriptor ? { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] } : {})
      }
    )
    if (rpcTokenFileDescriptor) {
      const tokenPipe = child.stdio[rpcTokenFileDescriptor]
      if (!tokenPipe || !('end' in tokenPipe)) {
        child.kill()
        sandboxed?.cleanup()
        throw new Error('Notebook RPC credential pipe was not created.')
      }
      tokenPipe.on('error', () => undefined)
      tokenPipe.end(request.mcpRpcToken)
    }
    if (sandboxed) {
      child.once('exit', sandboxed.cleanup)
      child.once('error', sandboxed.cleanup)
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return {
      child,
      beginSandboxExecution: sandboxed?.beginExecution ?? (() => () => undefined),
      annotateStderr: sandboxed?.annotateStderr ?? ((stderr) => stderr)
    }
  }

  // Builds the spawn env shared by the loops, adding the figures dir, (for R) a PATH prefix, and (for
  // the repl kernel) the ELECTRON_RUN_AS_NODE flag so the app binary runs as plain Node. The R env
  // prefix is derived per request from request.runtimeRoot + the resolved env name.
  private buildEnv(
    kind: KernelProcessKind,
    request: NotebookExecutionRequest,
    figuresDir: string,
    workloadCacheEnv: NodeJS.ProcessEnv = notebookWorkloadCacheEnv(request.runtimeRoot)
  ): NodeJS.ProcessEnv {
    // A resolved interpreter is user-owned (BYO/overlay). Never put app-managed conda DLLs ahead of
    // it: on Windows that can load an incompatible BLAS/compiler runtime into the external R process.
    // An external Windows conda R instead carries its OWN verified prefix from runtime discovery.
    const rEnvPrefix =
      kind !== 'r'
        ? undefined
        : request.resolvedInterpreter
          ? this.platform === 'win32'
            ? request.resolvedInterpreter.condaPrefix
            : undefined
          : envPrefix(request.runtimeRoot, resolveRequestEnv(kind, request), this.platform)
    const env: NodeJS.ProcessEnv = {
      ...buildNotebookKernelEnvironment(this.platform),
      ...workloadCacheEnv,
      // Force a non-interactive backend. Inheriting MPLBACKEND can load an arbitrary module from the
      // host environment and would bypass the environment-isolation policy below.
      MPLBACKEND: 'Agg',
      OPEN_SCIENCE_NOTEBOOK_DIR: request.notebookSessionRoot,
      OPEN_SCIENCE_NOTEBOOK_DATA_DIR: request.dataRoot,
      OPEN_SCIENCE_RUNTIME_DIR: request.runtimeRoot,
      // Cross-kernel workspace channel (see repository.ts): same path every kernel kind sees.
      OPEN_SCIENCE_HANDOFF_DIR: join(request.notebookSessionRoot, 'handoff'),
      // App-owned directories the kernel must not read (e.g. materialized skill files).
      OPEN_SCIENCE_PROTECTED_DIRS: (request.protectedDirs ?? []).join(delimiter),
      [KERNEL_FIGURES_DIR_ENV]: figuresDir,
      [NOTEBOOK_TEXT_LIMIT_ENV]: String(NOTEBOOK_TEXT_LIMIT_BYTES),
      [NOTEBOOK_FIGURE_LIMIT_ENV]: String(NOTEBOOK_FIGURE_LIMIT_BYTES),
      [NOTEBOOK_FIGURE_COUNT_LIMIT_ENV]: String(NOTEBOOK_FIGURE_COUNT_LIMIT),
      [NOTEBOOK_FIGURE_TOTAL_LIMIT_ENV]: String(NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES),
      [NOTEBOOK_NAMESPACE_VARIABLE_LIMIT_ENV]: String(NOTEBOOK_NAMESPACE_VARIABLE_LIMIT),
      [NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_ENV]: String(NOTEBOOK_NAMESPACE_PREVIEW_LIMIT_BYTES),
      [NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_ENV]: String(NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_BYTES),
      // Connector RPC endpoint/token reach ONLY the control-plane repl kernel: the python/r data
      // kernels have no host.mcp and no outbound connector access. Gating on kind here is
      // defense-in-depth — even if a data request ever carried these, python/r would never see them.
      ...(kind === 'repl' && request.mcpRpcEndpoint
        ? { OPEN_SCIENCE_MCP_RPC_ENDPOINT: request.mcpRpcEndpoint }
        : {}),
      ...(kind === 'repl' && request.mcpRpcSocketPath
        ? { OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: request.mcpRpcSocketPath }
        : {}),
      ...(kind === 'repl' && request.mcpRpcToken
        ? this.platform === 'linux'
          ? { OPEN_SCIENCE_MCP_RPC_TOKEN_FD: '3' }
          : { OPEN_SCIENCE_MCP_RPC_TOKEN: request.mcpRpcToken }
        : {}),
      // Session/project identity reaches ONLY the repl kernel, alongside the RPC creds: host.compute
      // carries it on call_command payloads for grant-scope approval memory (This conversation / This
      // project). The data kernels have no host.compute, so they never need — and never receive — it.
      ...(kind === 'repl' && request.sessionId
        ? { OPEN_SCIENCE_NOTEBOOK_SESSION_ID: request.sessionId }
        : {}),
      ...(kind === 'repl' && request.projectId
        ? { OPEN_SCIENCE_NOTEBOOK_PROJECT_ID: request.projectId }
        : {}),
      ...(kind === 'repl' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(rEnvPrefix ? { OPEN_SCIENCE_R_ENV_PREFIX: rEnvPrefix } : {})
    }

    // The R interpreter and loop depend on the env's native libraries. Windows conda activation
    // requires Library\bin (BLAS/LAPACK and compiler runtimes), not just <prefix>\bin.
    if (rEnvPrefix) {
      env.PATH = condaActivatedPath(rEnvPrefix, process.env.PATH, this.platform)
    }
    return env
  }

  // Frames one request onto the loop's stdin and returns a promise settled by the matching response
  // line, the timeout manager, or an unexpected process exit.
  private sendRequest(
    proc: ProcState,
    reqId: string,
    request: NotebookExecutionRequest,
    onDispatch: () => void
  ): Promise<{ response: KernelLoopResponse; timedOut: boolean; cancelled: boolean }> {
    return new Promise((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new NotebookExecutionCancelledError())
        return
      }
      const timeoutMs = request.timeoutMs
      const pending: PendingRequest = {
        reqId,
        resolve: (response) =>
          resolve({
            response,
            timedOut: pending.timeout?.timedOut ?? false,
            cancelled: pending.cancelled
          }),
        reject,
        cancelled: false,
        signal: request.signal,
        timeoutMs
      }
      const timeout =
        timeoutMs === undefined
          ? undefined
          : new TimeoutController({
              // SIGINT (soft) goes to the direct loop so it can interrupt gracefully. The hard
              // SIGKILL is routed through terminateProcessTree, which reaps descendants too.
              kill: (signal) => {
                if (signal === 'SIGKILL') this.killChildTracked(proc)
                else {
                  proc.child.kill(signal)
                  if (proc.kind === 'r') this.queueRInterruptProbe(proc, pending)
                }
              },
              onHardTimeout: () => {
                // Drop the wedged loop so the next execute respawns it, then fail this run.
                if (proc.pending?.reqId !== reqId) return
                this.clearPendingResources(proc.pending)
                proc.pending = undefined
                this.dropProc(proc)
                this.onTerminated?.(proc.kind, proc.env)
                reject(
                  new NotebookExecutionTimeoutError(
                    `Notebook execution timed out after ${timeoutMs}ms.`
                  )
                )
              }
            })
      pending.timeout = timeout
      proc.pending = pending

      if (request.signal) {
        pending.abortListener = () => {
          if (proc.pending !== pending || pending.cancelled) return
          pending.cancelled = true
          pending.timeout?.disarm()

          // Node maps SIGINT to TerminateProcess on Windows, so it cannot preserve this headless
          // kernel's namespace. Make that platform limitation explicit: drop and reap the whole
          // process tree, mark the kernel terminated, and let the next execute lazily respawn it.
          if (this.platform === 'win32') {
            this.clearPendingResources(pending)
            proc.pending = undefined
            this.dropProc(proc)
            this.killChildTracked(proc)
            this.onTerminated?.(proc.kind, proc.env)
            pending.reject(new NotebookExecutionCancelledError())
            return
          }

          proc.child.kill('SIGINT')
          if (proc.kind === 'r') this.queueRInterruptProbe(proc, pending)
          pending.cancellationTimer = this.scheduleIdleTimer(() => {
            pending.cancellationTimer = undefined
            if (proc.pending !== pending) return
            this.clearPendingResources(pending)
            proc.pending = undefined
            this.dropProc(proc)
            this.killChildTracked(proc)
            this.onTerminated?.(proc.kind, proc.env)
            pending.reject(new NotebookExecutionCancelledError())
          }, this.cancellationGraceMs)
        }
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }

      try {
        if (proc.kind === 'r') {
          proc.child.stdin.write(frameRRequest(reqId, request.code))
        } else {
          // Python and the repl (JS) loop share the same JSON-lines request framing.
          const protectedDirAdditions = (request.protectedDirs ?? []).filter(
            (directory) => !proc.protectedDirs.has(directory)
          )
          proc.child.stdin.write(
            framePythonRequest(
              reqId,
              request.code,
              request.controlInvocationId,
              protectedDirAdditions
            )
          )
          for (const directory of protectedDirAdditions) proc.protectedDirs.add(directory)
        }
        onDispatch()
      } catch (error) {
        this.clearPendingResources(pending)
        if (proc.pending === pending) proc.pending = undefined
        reject(error)
        return
      }
      if (timeout && timeoutMs !== undefined && !pending.cancelled) timeout.arm(timeoutMs)
    })
  }

  private sendNamespaceRequest(
    proc: ProcState,
    reqId: string,
    includePrivate: boolean
  ): Promise<KernelLoopResponse> {
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { reqId, resolve, reject, cancelled: false }
      proc.pending = pending
      pending.cancellationTimer = this.scheduleIdleTimer(() => {
        pending.cancellationTimer = undefined
        if (proc.pending !== pending) return
        this.clearPendingResources(pending)
        proc.pending = undefined
        this.dropProc(proc)
        this.killChildTracked(proc)
        this.onTerminated?.(proc.kind, proc.env)
        reject(
          new Error(
            `Notebook namespace inspection timed out after ${this.namespaceInspectionTimeoutMs}ms.`
          )
        )
      }, this.namespaceInspectionTimeoutMs)
      try {
        proc.child.stdin.write(
          proc.kind === 'r'
            ? frameRNamespaceRequest(reqId, includePrivate)
            : framePythonNamespaceRequest(reqId, includePrivate)
        )
      } catch (error) {
        this.clearPendingResources(pending)
        if (proc.pending === pending) proc.pending = undefined
        this.rearmIdleTimerIfLive(proc)
        reject(error)
      }
    })
  }

  // Matches one loop response line to the in-flight request and clears its timeout.
  private handleLine(proc: ProcState, line: string): void {
    const response = parseLoopResponse(line)
    if (!response) return

    const pending = proc.pending
    if (!pending) return

    if (pending.reqId === response.reqId) {
      pending.response = response
      pending.interruptAcknowledged ||= response.interruptAck === true
      if (pending.interruptProbeReqId !== undefined) return
      this.settlePendingResponse(proc, pending, response)
      return
    }

    if (pending.interruptProbeReqId !== response.reqId) return
    pending.interruptProbeReqId = undefined
    // An interrupted probe explicitly acknowledges a late SIGINT. A successful probe also
    // acknowledges it: the unmaskable base sleep held an interrupt checkpoint open after the
    // original request, so returning normally proves the original request already consumed SIGINT
    // (including when user code caught the interrupt itself).
    pending.interruptAcknowledged ||= response.interruptAck === true || response.error === null
    if (!pending.interruptAcknowledged) {
      this.queueRInterruptProbe(proc, pending)
      return
    }
    if (pending.response) this.settlePendingResponse(proc, pending, pending.response)
  }

  private settlePendingResponse(
    proc: ProcState,
    pending: PendingRequest,
    response: KernelLoopResponse
  ): void {
    if (proc.pending !== pending) return

    this.clearPendingResources(pending)
    proc.pending = undefined
    pending.resolve(response)
    this.rearmIdleTimerIfLive(proc)
  }

  // R may emit the cancelled request's ordinary response before the OS-delivered SIGINT reaches an
  // interrupt checkpoint. Pre-queue a private probe while the original request is still pending, and
  // retain queue ownership until either request explicitly acknowledges the interrupt or the trusted
  // probe completes its interruptible delay. If neither happens, the existing cancellation/hard-
  // timeout grace drops the process tree.
  private queueRInterruptProbe(proc: ProcState, pending: PendingRequest): void {
    if (proc.pending !== pending || pending.interruptProbeReqId !== undefined) return
    const reqId = randomUUID()
    pending.interruptProbeReqId = reqId
    proc.child.stdin.write(frameRRequest(reqId, R_INTERRUPT_PROBE_CODE))
  }

  // Reads each captured figure file, base64-encodes it, and unlinks it. A missing/unreadable file is
  // skipped rather than failing the whole cell.
  private async readFigures(
    figures: KernelLoopFigure[]
  ): Promise<{ figures: MappedFigure[]; truncated: boolean }> {
    const mapped: MappedFigure[] = []
    let totalBytes = 0
    let truncated = false
    for (const figure of figures) {
      try {
        const info = await stat(figure.path)
        if (
          mapped.length >= NOTEBOOK_FIGURE_COUNT_LIMIT ||
          info.size > NOTEBOOK_FIGURE_LIMIT_BYTES ||
          totalBytes + info.size > NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES
        ) {
          truncated = true
          await unlink(figure.path).catch(() => {})
          continue
        }
        const data = await readFile(figure.path)
        mapped.push({ mime: figure.mime, base64: data.toString('base64') })
        totalBytes += data.byteLength
        await unlink(figure.path).catch(() => {})
      } catch {
        // Skip a figure that vanished or could not be read.
      }
    }
    return { figures: mapped, truncated }
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

    this.clearPendingResources(pending)
    proc.pending = undefined
    pending.reject(pending.cancelled ? new NotebookExecutionCancelledError() : error)
    this.rearmIdleTimerIfLive(proc)
  }

  private clearPendingResources(pending: PendingRequest): void {
    pending.timeout?.disarm()
    if (pending.cancellationTimer !== undefined) {
      this.cancelIdleTimer(pending.cancellationTimer)
      pending.cancellationTimer = undefined
    }
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
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

export { NotebookKernelExecutor, kernelExecutableReadRoot }
export type { KernelProcessKind }
