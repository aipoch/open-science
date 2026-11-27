import {
  createNotebookCellPreview,
  type NotebookCellPreview
} from '../../shared/notebook-process-monitor'
import { createLogger } from '@aipoch/diagnostics/node'
import { NotebookExecutionAdmissionError } from './execution-admission'
import { createNotebookMemorySampler } from './resource-memory'
import type { NotebookOwnedResource, NotebookResourceCleanupResult } from './owned-resources'
import type { analyzeNotebookSourceFileAccess } from '@aipoch/notebook-analysis'
import { observeResourceProcess, recordResourceEvent } from '../resource-diagnostics/recorder'
import { resourceActivity } from '../resource-diagnostics/activity'
import { resolveExternalRLibrary } from '@aipoch/environment'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { Transform, type TransformCallback } from 'node:stream'
import {
  NotebookExecutionStopError,
  NotebookKernelExitError,
  markNotebookKernelExitCleanedUp,
  notebookErrorRecovery
} from '../../shared/notebook-execution-error'
import { nodeRuntimeEnvironment } from '../node-process-host'
import { reapWindowsOwnedJob, spawnWindowsOwnedProcess } from '../process-tree-windows'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { condaRLibraryReadRoot, kernelExecutableReadRoot } from './kernel-executable-read-root'
import { diagnoseKernelExit } from './kernel-exit-diagnostics'
import { prepareReplCellBindings, type ReplCellBindings } from './repl-cell-bindings'
import { prepareShellNpmEnvironment } from './shell-npm-environment'
import {
  resolveWindowsNotebookRuntime,
  windowsNotebookRuntimeEnvironment,
  type WindowsNotebookRuntime
} from './windows-notebook-runtime'

import { boundedRuntimeDiagnostic } from '@aipoch/diagnostics/node'
import {
  DEFAULT_R_ENV,
  buildManagedRuntimeProcessEnvironment,
  buildNotebookKernelEnvironment,
  condaActivatedPath,
  envPrefix,
  environmentPathRoots,
  normalizeRProcessLocale,
  notebookWorkloadCacheEnv,
  notebookWorkloadCacheRoot,
  prepareNotebookWorkloadCache,
  pythonBin,
  rBin,
  rScriptBin,
  readProcessStartToken,
  resolveEnvName
} from '@aipoch/environment'
import {
  assertProcessTreeSupport,
  createPosixProcessTreeOwnership,
  registerProcessTreeOwnership,
  terminateProcessTree,
  trackOwnedPosixProcessTree,
  capturePosixProcessTreeIdentity,
  type ProcessTreeKillResult
} from '../process-tree'
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
import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor
} from './execution-contract'
import {
  notebookHelperInitializationCode,
  type NotebookHelperModuleInjection
} from './helper-module-host'
import type {
  KernelProcessLifecycleOwner,
  KernelProcessReceipt,
  KernelProcessSpawnIntent
} from './kernel-process-lifecycle.windows-posix'
import {
  KERNEL_FIGURES_DIR_ENV,
  framePythonNamespaceRequest,
  framePythonRequest,
  frameRNamespaceRequest,
  frameRRequest,
  parseLoopResponse,
  type KernelLoopFigure,
  type KernelLoopResponse
} from './kernel-protocol'
import { mapLoopOutputs, type MappedFigure } from './loop-output-mapper'
import { protectManagedRuntimeWrites } from './managed-runtime-guard'
import {
  NotebookRuntimeAccessCancelledError,
  withNotebookSandboxProcessState,
  type NotebookProcessSandbox,
  type NotebookRuntimeAccessAdmission,
  type NotebookSandboxCleanupReason,
  type NotebookSandboxCleanupResult,
  type NotebookSandboxProcessOutcome
} from './process-sandbox'
import type {
  NotebookSessionNamespaceRequest,
  NotebookSessionNamespaceResult
} from './session-aggregate'
import { notebookInterpreterIdentity } from './session-aggregate'
import { TimeoutController } from './timeout-controller'
import { startWorkingFileObservation, type WorkingFileObservation } from './working-file-observer'

// Driver-internal process kind. 'python'/'r' are the data kernels selected by the agent-facing
// NotebookLanguage; 'repl' is the control-plane Node kernel reached only via the control path. The
// kind is the language/role discriminator (spawn logic, framing, readiness gate switch on it); the
// routing map is keyed by a finer ProcessKey so named envs of the same kind coexist as distinct procs.
type KernelProcessKind = 'python' | 'r' | 'repl'

export type NotebookKernelTerminationDiagnostic =
  | {
      reason: 'exit'
      exitCode: number | null
      signal: NodeJS.Signals | null
      stderr?: string
    }
  | {
      reason: 'error'
      name: string
      message: string
      code?: string
    }

// Composite routing key for `procs`: `${kind}:${env}` for the python/r data kernels (so
// python:default-python and python:my-analysis are separate processes/namespaces), and the bare
// 'repl' for the single env-agnostic control kernel.
type ProcessKey = string

// Opaque idle-timer handle; the default scheduler returns NodeJS.Timeout, tests inject a fake clock
// that returns a plain number (see TimeoutController, the same pattern for the per-run timeout).
type IdleTimerHandle = unknown
type ScheduleIdleTimer = (fn: () => void, ms: number) => IdleTimerHandle
type CancelIdleTimer = (handle: IdleTimerHandle) => void

// The executor-level request timer is off by default. Application composition explicitly disables
// it and uses NotebookIdleReclamation, which also protects model turns and background activity.
// Direct executor consumers can still opt into this legacy timer via OPEN_SCIENCE_KERNEL_IDLE_MS.
const DEFAULT_IDLE_MS = 0
const DEFAULT_CANCELLATION_GRACE_MS = 2_000
const DEFAULT_NAMESPACE_INSPECTION_TIMEOUT_MS = 5_000
const executorLog = createLogger('notebook:kernel-executor')
// Queued behind an interrupted R request before its queue is released. The sleep gives a SIGINT that
// raced with the original response an interruptible, side-effect-free request to land in.
const R_INTERRUPT_PROBE_CODE = 'base::Sys.sleep(0.05)'

const presentPaths = (values: readonly string[]): string[] =>
  values.filter((value) => value.length > 0)

// Node resolves the CommonJS package type before loading a loop script. Grant the package
// manifest beside the script explicitly; granting only the script path makes the sandbox reject
// the startup read even though the loop itself is already an approved resource.
const loopPackageConfigPath = (loopPath: string): string => join(dirname(loopPath), 'package.json')

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

// Resolves the request-level idle window: explicit option, then OPEN_SCIENCE_KERNEL_IDLE_MS,
// then DEFAULT_IDLE_MS. Non-positive values disable this timer; application session-aware
// reclamation remains independent of it.
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
  // Crash-safe host that publishes the OS process receipt before starting the real loop.
  processHostPath?: string
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
  // the right per-(kind, env) kernel status ('' for the env-agnostic repl). The optional epoch
  // identifies the original spawn even when later requests have reused the process.
  onIdleShutdown?: (kind: KernelProcessKind, env: string, kernelEpochId?: string) => void
  // Invoked once a proc is lost unexpectedly (a crash exit or a hard-timeout drop), or cancellation
  // must drop it because Windows cannot recoverably interrupt it or a POSIX grace period expires.
  // NOT invoked on an intentional shutdown()/restart(). Parallels onIdleShutdown so the caller can
  // persist a 'terminated' kernel status for an involuntary loss too (see NotebookRuntimeService).
  onTerminated?: (
    kind: KernelProcessKind,
    env: string,
    diagnostic?: NotebookKernelTerminationDiagnostic,
    kernelEpochId?: string
  ) => void
  // Injectable only to exercise the Windows conda activation contract on non-Windows test hosts.
  platform?: NodeJS.Platform
  // Shared application-owned network sandbox. Omitted only by isolated executor tests.
  processSandbox?: NotebookProcessSandbox
  // Application-owned durable process ledger. Production supplies one owner plus this executor's
  // immutable lane key; isolated executor tests may omit both.
  processLifecycle?: KernelProcessLifecycleOwner
  laneKey?: string
  // Process-ownership boundary injections keep post-exit identity/reaping tests deterministic.
  registerOwnedProcessGroup?: typeof trackOwnedPosixProcessTree
  terminateTree?: typeof terminateProcessTree
  // Lets the application move large source file-access analysis off the main event loop.
  analyzeSourceFileAccess?: typeof analyzeNotebookSourceFileAccess
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
  lastCell?: NotebookCellPreview
  startedAt: number
  cleanupResult?: NotebookResourceCleanupResult
  cleanupPending?: boolean
  kind: KernelProcessKind
  // Resolved env name backing this proc (DEFAULT_PY_ENV / DEFAULT_R_ENV or a named env); '' for the
  // env-agnostic repl. Reported to the idle/terminated callbacks so the caller keys per-env status.
  env: string
  // Routing key in `procs`; kept on the proc so map ops that only receive a ProcState (dropProc,
  // rearmIdleTimerIfLive, handleIdleTimeout) can re-key without recomputing from the request.
  key: ProcessKey
  // Identity belongs to the spawn, never to a later request reusing this process.
  kernelEpochId?: string
  child: ChildProcessWithoutNullStreams
  sampleMemory: ReturnType<typeof createNotebookMemorySampler>
  readline: Interface
  pending?: PendingRequest
  beginSandboxExecution: NonNullable<
    import('./process-sandbox').NotebookSandboxedSpawn['beginExecution']
  >
  waitForNetworkApprovals?: () => Promise<void>
  stderrTail: string
  annotateStderr: (stderr: string) => string
  teardownProcess: () => Promise<ProcessTreeKillResult>
  cleanupSandbox: (
    reason: NotebookSandboxCleanupReason,
    processOutcome: NotebookSandboxProcessOutcome
  ) => Promise<NotebookSandboxCleanupResult>
  sandboxCleanupPromise?: Promise<NotebookSandboxCleanupResult>
  // Captures why an involuntarily dropped proc became unusable before a request was registered, so
  // execute() can fail that pre-dispatch run instead of writing to a stale child and waiting forever.
  terminationError?: Error
  // True until the exit handler observes the process leaving. child.killed is unreliable here: Node
  // sets it once *any* signal is sent, including the soft-timeout SIGINT a loop catches and survives,
  // so it cannot distinguish a still-running loop from a dead one.
  alive: boolean
  cwd: string
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

type KernelStartOperation = {
  key: ProcessKey
  kind: KernelProcessKind
  env: string
  startedAt: number
  kernelEpochId?: string
  controller: AbortController
  completion: Promise<ProcState>
  proc?: ProcState
  cleanup?: () => Promise<NotebookResourceCleanupResult>
  cleanupResult?: NotebookResourceCleanupResult
}

// Marks timeouts distinctly so persisted run status can reflect timeout instead of failure.
class NotebookExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotebookExecutionTimeoutError'
  }
}

class NotebookKernelStartupError extends Error {
  constructor() {
    super('Notebook kernel could not start.')
    this.name = 'NotebookKernelStartupError'
  }
}

const kernelExitReason = (code: number | null, signal: NodeJS.Signals | null): string => {
  if (code !== null) return ` with exit code ${code}`
  if (signal) return ` after signal ${signal}`
  return ''
}

const kernelExitError = (
  proc: ProcState,
  code: number | null,
  signal: NodeJS.Signals | null,
  message = `Notebook kernel process exited${kernelExitReason(code, signal)}.`
): Error => {
  const pending = proc.pending
  if (pending?.timeout?.timedOut && pending.timeoutMs !== undefined) {
    return new NotebookExecutionTimeoutError(
      `Notebook execution timed out after ${pending.timeoutMs}ms.`
    )
  }
  const stderr = proc.annotateStderr(proc.stderrTail).trim()
  return new NotebookKernelExitError(
    `${message}${stderr ? `\n${stderr}` : ''}\nThe interpreter's in-memory state was lost.`,
    {
      execution: 'may-have-run',
      retryAfter: 'runtime-ready',
      kernel: {
        kind: proc.kind,
        ...(proc.kind !== 'repl' ? { environment: proc.env } : {}),
        exitCode: code,
        signal,
        cause: 'unknown'
      }
    }
  )
}

class NotebookExecutionCancelledError extends Error {
  constructor() {
    super('Notebook execution was cancelled.')
    this.name = 'NotebookExecutionCancelledError'
  }
}

// Plain-Node hosts (runtime certification, SDK consumers) configure no host entry; the
// repo-relative candidates below resolve the loops directly instead of throwing.
const hostResourcesPath = (): string | undefined => runtimeMetadataIfConfigured()?.resourcesPath

// Resolves the packaged/dev location of python_loop.py; an env override wins (tests, dev), then the
// packaged resources dir, then the repo-relative dev path.
const defaultPythonLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_PYTHON_LOOP) return process.env.OPEN_SCIENCE_PYTHON_LOOP
  const resourcesPath = hostResourcesPath()
  if (resourcesPath) return join(resourcesPath, 'notebook', 'python_loop.py')
  return join(__dirname, '../../../resources/notebook/python_loop.py')
}

// Resolves the packaged/dev location of r_loop.R, mirroring defaultPythonLoopPath.
const defaultRLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_R_LOOP) return process.env.OPEN_SCIENCE_R_LOOP
  const resourcesPath = hostResourcesPath()
  if (resourcesPath) return join(resourcesPath, 'notebook', 'r_loop.R')
  return join(__dirname, '../../../resources/notebook/r_loop.R')
}

// Resolves the packaged/dev location of repl_loop.js, mirroring defaultPythonLoopPath.
const defaultReplLoopPath = (): string => {
  if (process.env.OPEN_SCIENCE_REPL_LOOP) return process.env.OPEN_SCIENCE_REPL_LOOP
  const resourcesPath = hostResourcesPath()
  if (resourcesPath) return join(resourcesPath, 'notebook', 'repl_loop.js')
  return join(__dirname, '../../../resources/notebook/repl_loop.js')
}

const defaultProcessHostPath = (): string => {
  const resourcesPath = hostResourcesPath()
  if (resourcesPath) return join(resourcesPath, 'notebook', 'kernel_process_host.js')
  return join(__dirname, '../../../resources/notebook/kernel_process_host.js')
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
const interruptedExecutionRecovery = {
  execution: 'may-have-run',
  retryAfter: 'runtime-ready'
} as const

const errorToExecutionResult = (
  error: unknown,
  request: NotebookExecutionRequest,
  kernelDispatched = false,
  helperModulesInitialized: readonly string[] = []
): NotebookExecutionResult => {
  if (!kernelDispatched && request.signal?.aborted && error === request.signal.reason)
    error = new NotebookExecutionCancelledError()
  if (error instanceof NotebookRuntimeAccessCancelledError) {
    return {
      status: 'cancelled',
      kernelDispatched,
      stdout: '',
      stderr: error.message,
      traceback: '',
      cwdAfter: request.cwd,
      outputs: [],
      workingFiles: []
    }
  }
  if (error instanceof NotebookExecutionCancelledError) {
    return {
      status: 'cancelled',
      kernelDispatched,
      ...(kernelDispatched ? { recovery: interruptedExecutionRecovery } : {}),
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
  const recovery = notebookErrorRecovery(error)

  return {
    status: error instanceof NotebookExecutionTimeoutError ? 'timeout' : 'failed',
    ...(!kernelDispatched && error instanceof NotebookExecutionAdmissionError
      ? { executionStarted: false, recovery: error.recovery }
      : {}),
    ...(error instanceof NotebookKernelStartupError
      ? {
          executionStarted: false,
          recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
        }
      : {}),
    ...(recovery
      ? { recovery: { ...recovery, execution: kernelDispatched ? 'may-have-run' : 'not-started' } }
      : {}),
    ...(kernelDispatched && error instanceof NotebookExecutionTimeoutError
      ? { recovery: interruptedExecutionRecovery }
      : {}),
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
  resources(): NotebookOwnedResource[] {
    const owners = new Set([...this.procs.values(), ...this.pendingTeardowns.keys()])
    const processes: NotebookOwnedResource[] = Array.from(owners, (proc) => ({
      identity: proc,
      group: 'kernel',
      kind: proc.kind,
      phase: this.pendingTeardowns.has(proc)
        ? 'cleanup-pending'
        : proc.pending
          ? 'running'
          : 'idle',
      startedAt: proc.startedAt,
      laneKey: this.laneKey,
      executionDomain: 'host',
      processKey: proc.key,
      environment: proc.env,
      kernelEpochId: proc.kernelEpochId,
      sampleMemory: proc.sampleMemory,
      release: () => this.releaseProc(proc)
    }))
    return [
      ...processes,
      ...Array.from(this.starting, (operation): NotebookOwnedResource => ({
        identity: operation,
        group: 'kernel',
        kind: operation.kind,
        phase: operation.cleanupResult?.reaped === false ? 'cleanup-pending' : 'starting',
        startedAt: operation.startedAt,
        laneKey: this.laneKey,
        executionDomain: 'host',
        processKey: operation.key,
        environment: operation.env,
        kernelEpochId: operation.kernelEpochId,
        release: () => this.releaseStart(operation)
      }))
    ]
  }

  private async releaseStart(
    operation: KernelStartOperation
  ): Promise<NotebookResourceCleanupResult> {
    operation.controller.abort()
    await operation.completion.catch(() => undefined)
    const result = operation.proc
      ? await this.releaseProc(operation.proc)
      : ((await operation.cleanup?.()) ?? { reaped: true })
    operation.cleanupResult = result
    if (result.reaped) this.starting.delete(operation)
    return result
  }

  private async releaseProc(proc: ProcState): Promise<NotebookResourceCleanupResult> {
    if (proc.cleanupResult?.reaped) return proc.cleanupResult
    this.dropProc(proc)
    this.rejectPending(proc, new NotebookExecutionCancelledError())
    proc.readline.close()
    const pending = this.pendingTeardowns.get(proc)
    if (pending) {
      const result = await pending.completion
      return result.reaped ? result : pending.retry()
    }
    return this.killChildTracked(proc)
  }

  monitoredProcesses(): import('./process-monitor').MonitoredKernelProcess[] {
    const live = [...this.procs.values()]
    const pending = [...this.pendingTeardowns.keys()]
    return [...new Set([...live, ...pending])].map((proc) => ({
      identity: proc,
      processKey: proc.key,
      kernelEpochId: proc.kernelEpochId,
      pid: proc.child.pid,
      startedAt: proc.startedAt,
      lastCell: proc.lastCell,
      status:
        this.procs.get(proc.key) === proc
          ? proc.pending
            ? 'running'
            : 'idle'
          : proc.cleanupPending
            ? 'cleaning'
            : 'cleanup-failed',
      terminate: async () => {
        if (this.procs.get(proc.key) === proc) {
          const result = await this.releaseProc(proc)
          if (!result.reaped) {
            this.notifyTerminated(proc)
            throw new Error('Notebook process-tree cleanup remains incomplete.')
          }
        } else if (this.pendingTeardowns.has(proc)) {
          const result = await this.reconcilePendingTeardown(proc)
          if (!result?.reaped) throw new Error('Notebook process-tree cleanup remains incomplete.')
        } else throw new Error('Notebook process changed. Refresh the list.')
      }
    }))
  }

  idleProcesses(): ReturnType<NonNullable<NotebookExecutor['idleProcesses']>> {
    return Array.from(this.procs.values(), (proc) => ({
      identity: proc,
      processKey: proc.key,
      executionDomain: 'host',
      release: async () => {
        if (this.procs.get(proc.key) !== proc || !proc.alive || proc.pending) return false
        return (await this.releaseProc(proc)).reaped
      },
      retire: () => {
        if (this.procs.get(proc.key) !== proc || !proc.alive || proc.pending) return false
        this.dropProc(proc)
        void this.killChildTracked(proc)
        return true
      }
    }))
  }

  private readonly procs = new Map<ProcessKey, ProcState>()
  private readonly starting = new Set<KernelStartOperation>()
  private lifecycleGeneration = 0
  // In-flight process-tree teardowns retain every old proc independently across degraded restarts.
  // New epochs may start before old cleanup settles; shutdown() still includes every entry in its
  // reaped guarantee, and explicit resource release can retry the exact same proc.
  private readonly pendingTeardowns = new Map<
    ProcState,
    {
      completion: Promise<NotebookResourceCleanupResult>
      retry: () => Promise<NotebookResourceCleanupResult>
    }
  >()
  // One temp dir the loops write captured figures into; created lazily, reused, removed on shutdown.
  private figuresDir: string | undefined
  private readonly pythonLoopPath: string
  private readonly rLoopPath: string
  private readonly replLoopPath: string
  private readonly processHostPath: string
  private readonly idleTimeoutMs: number
  private readonly scheduleIdleTimer: ScheduleIdleTimer
  private readonly cancelIdleTimer: CancelIdleTimer
  private readonly onIdleShutdown?: NotebookKernelExecutorOptions['onIdleShutdown']
  private readonly onTerminated?: NotebookKernelExecutorOptions['onTerminated']
  private readonly cancellationGraceMs: number
  private readonly namespaceInspectionTimeoutMs: number
  private readonly platform: NodeJS.Platform
  private readonly processSandbox?: NotebookProcessSandbox
  private readonly processLifecycle?: KernelProcessLifecycleOwner
  private readonly laneKey?: string
  private readonly registerOwnedProcessGroup: typeof trackOwnedPosixProcessTree
  private readonly canTrackPosixProcesses: boolean
  private readonly terminateTree: typeof terminateProcessTree
  private readonly analyzeSourceFileAccess?: typeof analyzeNotebookSourceFileAccess

  constructor(options: NotebookKernelExecutorOptions = {}) {
    this.pythonLoopPath = options.pythonLoopPath ?? defaultPythonLoopPath()
    this.rLoopPath = options.rLoopPath ?? defaultRLoopPath()
    this.replLoopPath = options.replLoopPath ?? defaultReplLoopPath()
    this.processHostPath = options.processHostPath ?? defaultProcessHostPath()
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
    this.processLifecycle = options.processLifecycle
    this.laneKey = options.laneKey
    this.analyzeSourceFileAccess = options.analyzeSourceFileAccess
    this.registerOwnedProcessGroup = options.registerOwnedProcessGroup ?? trackOwnedPosixProcessTree
    this.canTrackPosixProcesses =
      process.platform !== 'win32' || options.registerOwnedProcessGroup !== undefined
    this.terminateTree = options.terminateTree ?? terminateProcessTree
  }

  // Sends one cell to the kind's loop and resolves with the mapped execution result.
  async execute(request: NotebookExecutionRequest): Promise<NotebookExecutionResult> {
    const endObservation = resourceActivity.begin()
    let workingFileObservation: WorkingFileObservation | undefined
    let kernelDispatched = false
    let cwdBefore: string | undefined
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
      endSandboxExecution = proc.beginSandboxExecution({
        commandText: request.code,
        executionReference: request.runId ?? randomUUID(),
        signal: request.signal,
        onNetworkWaitChange: (waiting) => {
          const pending = proc.pending
          if (!pending?.timeout || pending.timeout.timedOut) return
          pending.timeout.disarm()
          if (!waiting && pending.timeoutMs !== undefined) pending.timeout.arm(pending.timeoutMs)
        }
      })
      if (kind !== 'repl') {
        cwdBefore = proc.cwd
        request = { ...request, cwd: cwdBefore }
      }

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
            helperModules: undefined,
            pythonRandomState: undefined
          },
          () => undefined
        )
        request = { ...request, cwd: proc.cwd }
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
      const replBindings = kind === 'repl' ? await prepareReplCellBindings(request.code) : undefined
      workingFileObservation = await startWorkingFileObservation(
        {
          ...request,
          ...(kind === 'repl'
            ? {
                sourceFileAccessContext: {
                  staticStrings: [],
                  staticCollections: [],
                  localFileWrappers: [],
                  ...request.sourceFileAccessContext,
                  replPersistentBindings: true
                }
              }
            : {})
        },
        { analyzeSourceFileAccess: this.analyzeSourceFileAccess }
      )
      // sendRequest installs proc.pending synchronously. Revalidate immediately before that handoff:
      // an involuntary drop while ensureProc was finishing must settle this execute() locally rather
      // than dispatching to a stale child whose guarded exit handler can no longer reject the run.
      if (!proc.alive || this.procs.get(key) !== proc) {
        throw proc.terminationError ?? new Error('Notebook kernel process exited before execution.')
      }

      const reqId = randomUUID()
      const { response, timedOut, cancelled } = await this.sendRequest(
        proc,
        reqId,
        request,
        () => {
          kernelDispatched = true
        },
        replBindings
      )
      await proc.waitForNetworkApprovals?.()
      const status = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timeout'
          : response.error !== null
            ? 'failed'
            : 'completed'
      const fileObservation = await workingFileObservation.finish(
        // A reported cell error still leaves observable outputs. Preserve their bytes while
        // retaining incomplete evidence; only interruption cancels the capture itself.
        timedOut || cancelled ? AbortSignal.abort() : request.signal,
        status === 'completed' ? 'completed' : 'incomplete'
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
      return {
        status,
        kernelDispatched,
        ...(kernelDispatched && (timedOut || cancelled)
          ? { recovery: interruptedExecutionRecovery }
          : {}),
        ...(!timedOut && !cancelled && response.executionStarted !== undefined
          ? { executionStarted: response.executionStarted }
          : {}),
        stdout: mapped.stdout,
        stderr: mapped.stderr,
        traceback: cancelled ? '' : mapped.traceback,
        ...(cwdBefore !== undefined ? { cwdBefore } : {}),
        cwdAfter: response.cwd || request.cwd,
        outputs: cancelled
          ? mapped.outputs.filter((output) => output.type !== 'error')
          : mapped.outputs,
        truncated: response.outputTruncated || figureResult.truncated,
        workingFiles: fileObservation.workingFiles,
        fileEvidence: fileObservation.fileEvidence,
        ...(fileObservation.confirmedReadPaths
          ? { confirmedReadPaths: fileObservation.confirmedReadPaths }
          : {}),
        ...(helperModulesInitialized.length ? { helperModulesInitialized } : {}),
        environmentOverlay: response.environmentOverlay
      }
    } catch (error) {
      const fileObservation = await workingFileObservation?.finish(
        AbortSignal.abort(),
        'incomplete'
      )
      if (error instanceof NotebookExecutionStopError) throw error
      return {
        ...errorToExecutionResult(error, request, kernelDispatched, helperModulesInitialized),
        ...(cwdBefore !== undefined ? { cwdBefore } : {}),
        ...(fileObservation
          ? {
              workingFiles: fileObservation.workingFiles,
              fileEvidence: fileObservation.fileEvidence,
              ...(fileObservation.confirmedReadPaths
                ? { confirmedReadPaths: fileObservation.confirmedReadPaths }
                : {})
            }
          : {})
      }
    } finally {
      try {
        endSandboxExecution?.()
      } finally {
        endObservation()
      }
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
    this.lifecycleGeneration++
    const figuresDir = this.figuresDir
    this.figuresDir = undefined
    const starts = Array.from(this.starting, (operation) => this.releaseStart(operation))
    const procs = Array.from(this.procs.values())
    this.procs.clear()

    for (const proc of procs) {
      this.disarmIdleTimer(proc)
      this.rejectPending(proc, new Error('Notebook kernel was shut down.'))
      proc.readline.close()
    }
    // Snapshot every old proc, including multiple degraded epochs for the same process key. New work
    // admitted by restart() is absent from this snapshot and owns a different figures directory.
    const pending = Array.from(this.pendingTeardowns.keys(), (proc) =>
      this.reconcilePendingTeardown(proc)
    )
    const [results, pendingResults, startResults] = await Promise.all([
      Promise.all(procs.map((proc) => this.killChildTracked(proc))),
      Promise.all(pending),
      Promise.allSettled(starts)
    ])

    if (figuresDir) await rm(figuresDir, { recursive: true, force: true }).catch(() => {})
    // Reaped only when every captured proc AND every outstanding teardown reaped its whole tree.
    return {
      reaped:
        results.every((result) => result.reaped) &&
        pendingResults.every((result) => result?.reaped === true) &&
        startResults.every((result) => result.status === 'fulfilled' && result.value.reaped)
    }
  }

  // Tears down all loops so the next execute() lazily respawns a clean process per language.
  async restart(): Promise<void> {
    const cleanup = this.shutdown()
    void cleanup.then(
      (result) => {
        if (!result.reaped)
          executorLog.warn('Notebook kernel restart cleanup remains pending', { ...result })
      },
      (error: unknown) => {
        executorLog.warn('Notebook kernel restart cleanup failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  }

  // Runtime switches, Reset and permission revocation need a physical stop for this key.
  // Include every retained generation and any start already in flight.
  async terminate(kind: KernelProcessKind, env: string): Promise<void> {
    const key: ProcessKey = kind === 'repl' ? 'repl' : `${kind}:${env}`
    const pending = Array.from(this.pendingTeardowns.keys()).filter((proc) => proc.key === key)
    const starts = Array.from(this.starting).filter((operation) => operation.key === key)
    const current = this.detachProcessForTermination(key)
    const results = await Promise.allSettled([
      ...pending.map((proc) => this.reconcilePendingTeardown(proc)),
      ...starts.map((operation) => this.releaseStart(operation)),
      ...(current ? [this.killChildTracked(current)] : [])
    ])
    if (results.some((result) => result.status === 'rejected' || !result.value?.reaped)) {
      if (current) this.notifyTerminated(current)
      throw new Error(
        `Notebook kernel runtime switch refused because the ${key} persistent process tree was not reaped.`
      )
    }
  }

  // A Notebook restart may admit a successor while the old process is still being cleaned up.
  async restartProcess(kind: KernelProcessKind, env: string): Promise<void> {
    const key: ProcessKey = kind === 'repl' ? 'repl' : `${kind}:${env}`
    const current = this.detachProcessForTermination(key)
    if (!current) return
    void this.killChildTracked(current).then(
      (result) => {
        if (!result.reaped)
          executorLog.warn('Notebook kernel cleanup remains pending', { processKey: key })
      },
      (error: unknown) => {
        executorLog.warn('Notebook kernel cleanup failed', {
          processKey: key,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    )
  }

  private detachProcessForTermination(key: ProcessKey): ProcState | undefined {
    const proc = this.procs.get(key)
    if (!proc) return undefined
    this.dropProc(proc)
    this.rejectPending(proc, new Error('Notebook kernel was torn down for a runtime switch.'))
    proc.readline.close()
    return proc
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

    const interpreter =
      kind === 'python' ? pythonBin(prefix, this.platform) : rBin(prefix, this.platform)
    if (!existsSync(interpreter)) {
      const language = kind === 'python' ? 'Python' : 'R'
      throw new Error(
        `The ${language} interpreter for environment "${env}" was not found at "${interpreter}". ` +
          'The cell was not dispatched. Environment preparation or repair may be required; ' +
          'this check does not establish whether preparation is running. Check the environment status in the application before retrying.'
      )
    }
  }

  // Reuses a live loop for the (kind, env) or spawns a fresh one, wiring its readline, stderr drain,
  // and exit handling.
  private ensureProc(
    key: ProcessKey,
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest
  ): Promise<ProcState> {
    const existing = this.procs.get(key)
    if (
      existing?.alive &&
      existing.interpreterIdentity === notebookInterpreterIdentity(request.resolvedInterpreter)
    ) {
      return this.prepareProc(key, kind, env, request, this.lifecycleGeneration)
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    const operation: KernelStartOperation = {
      key,
      kind,
      env,
      controller,
      startedAt: Date.now(),
      kernelEpochId: request.kernelEpochId,
      completion: Promise.resolve(undefined as never)
    }
    this.starting.add(operation)
    operation.completion = this.prepareProc(
      key,
      kind,
      env,
      { ...request, signal: controller.signal },
      this.lifecycleGeneration,
      operation
    )
      .then((proc) => {
        operation.proc = proc
        if (controller.signal.aborted) {
          this.dropProc(proc)
          void this.killChildTracked(proc)
          this.notifyTerminated(proc)
          throw new NotebookExecutionCancelledError()
        }
        return proc
      })
      .finally(() => {
        request.signal?.removeEventListener('abort', abort)
        if (operation.cleanupResult?.reaped !== false) this.starting.delete(operation)
      })
    return operation.completion
  }

  private async prepareProc(
    key: ProcessKey,
    kind: KernelProcessKind,
    env: string,
    request: NotebookExecutionRequest,
    generation: number,
    operation?: KernelStartOperation
  ): Promise<ProcState> {
    const identity = notebookInterpreterIdentity(request.resolvedInterpreter)
    const existing = this.procs.get(key)
    if (request.executionAdmission) {
      await request.executionAdmission.prepare(existing?.alive ? 'dispatch' : 'create')
      request.executionAdmission.assertCurrent(existing?.alive ? 'dispatch' : 'create')
    }
    if (generation !== this.lifecycleGeneration) throw new NotebookExecutionCancelledError()
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

    const spawned = await this.spawnLoop(kind, env, request, generation, operation)
    const child = spawned.child
    const boundedOutput = createBoundedKernelOutput((error) => {
      if (this.procs.get(key) !== proc) return
      proc.terminationError = error
      this.dropProc(proc)
      this.killChildTracked(proc)
      this.notifyTerminated(proc)
      this.rejectPending(proc, error)
    })
    const readline = createInterface({ input: boundedOutput })
    const proc: ProcState = {
      startedAt: spawned.startedAt,
      kind,
      env,
      key,
      kernelEpochId: spawned.kernelEpochId,
      child,
      sampleMemory: spawned.sampleMemory,
      readline,
      beginSandboxExecution: spawned.beginSandboxExecution,
      waitForNetworkApprovals: spawned.waitForNetworkApprovals,
      stderrTail: '',
      annotateStderr: spawned.annotateStderr,
      teardownProcess: spawned.teardownProcess,
      cleanupSandbox: spawned.cleanupSandbox,
      alive: true,
      cwd: spawned.cwd,
      interpreterIdentity: identity,
      protectedDirs: new Set(request.protectedDirs ?? [])
    }

    readline.on('line', (line) => this.handleLine(proc, line))
    // Keep a bounded tail for sandbox diagnostics while continuing to drain a chatty child pipe.
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      proc.stderrTail = `${proc.stderrTail}${chunk}`.slice(-64 * 1024)
    })
    const handleProcessError = (
      error: Error,
      message: string,
      reason: NotebookSandboxCleanupReason
    ): void => {
      if (this.procs.get(key) !== proc) return
      const terminationError = kernelExitError(proc, null, null, message)
      proc.terminationError = terminationError
      this.dropProc(proc)
      void this.killChildTracked(proc, reason)
      this.notifyTerminated(proc, {
        reason: 'error',
        name: error.name,
        message: error.message,
        ...(typeof (error as NodeJS.ErrnoException).code === 'string'
          ? { code: (error as NodeJS.ErrnoException).code }
          : {})
      })
      this.rejectPending(proc, terminationError)
    }
    // EPIPE may arrive before exit. Retire the broken loop immediately so no later request can
    // reuse its pipe or its epoch, and let the exit handler ignore this detached process.
    child.stdin.on('error', (error) => {
      handleProcessError(error, 'Notebook kernel stdin pipe failed.', 'exit')
    })
    child.on('error', (error) =>
      handleProcessError(error, 'Notebook kernel process failed.', 'spawn-failed')
    )
    // An inherited stdio pipe can stay open after the direct child exits.
    child.on('exit', (code, signal) => {
      if (this.procs.get(key) !== proc) return
      const terminationError = kernelExitError(proc, code, signal)
      proc.terminationError = terminationError
      this.dropProc(proc)
      void this.reconcileExitedProc(proc)
      this.notifyTerminated(proc, {
        reason: 'exit',
        exitCode: code,
        signal,
        ...(proc.stderrTail
          ? { stderr: boundedRuntimeDiagnostic(proc.annotateStderr(proc.stderrTail)).text }
          : {})
      })
      // Diagnostics have their own bounded budget and do not depend on process or sandbox cleanup.
      const diagnosed =
        terminationError instanceof NotebookKernelExitError
          ? diagnoseKernelExit({
              pid: child.pid,
              signal,
              platform: this.platform,
              stderr: proc.stderrTail
            }).then((cause) => {
              terminationError.recovery = {
                ...terminationError.recovery,
                kernel: { ...terminationError.recovery.kernel!, cause }
              }
              if (cause === 'os-memory-pressure')
                terminationError.message +=
                  '\nThe operating system killed this process under memory pressure.'
              else if (cause === 'nul-initialization-unavailable')
                terminationError.message +=
                  '\nElectron could not initialize the Windows NUL device in the restricted process.'
              return terminationError
            })
          : terminationError
      this.rejectPending(proc, diagnosed)
    })

    if (operation) operation.proc = proc
    if (generation !== this.lifecycleGeneration) {
      this.dropProc(proc)
      void this.killChildTracked(proc)
      throw new NotebookExecutionCancelledError()
    }
    // Register before piping buffered stdout: pipe() can synchronously flush data that already arrived
    // after spawn, and the overflow callback must be able to identify and drop this proc. No await may
    // separate this generation check from the map write.
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
    request: NotebookExecutionRequest,
    generation: number,
    operation?: KernelStartOperation
  ): Promise<{
    startedAt: number
    kernelEpochId: string
    child: ChildProcessWithoutNullStreams
    sampleMemory: ReturnType<typeof createNotebookMemorySampler>
    cwd: string
    beginSandboxExecution: NonNullable<
      import('./process-sandbox').NotebookSandboxedSpawn['beginExecution']
    >
    waitForNetworkApprovals?: () => Promise<void>
    annotateStderr: (stderr: string) => string
    teardownProcess: () => Promise<ProcessTreeKillResult>
    cleanupSandbox: (
      reason: NotebookSandboxCleanupReason,
      processOutcome: NotebookSandboxProcessOutcome
    ) => Promise<NotebookSandboxCleanupResult>
  }> {
    assertProcessTreeSupport(this.platform)
    if (generation !== this.lifecycleGeneration) throw new NotebookExecutionCancelledError()
    const figuresDir = this.ensureFiguresDir()
    // Control-plane REPL may omit a runtime root; package cache belongs to a managed runtime directory.
    const workloadCacheEnv = request.runtimeRoot
      ? prepareNotebookWorkloadCache(request.runtimeRoot)
      : {}
    // A missing session dir would surface as an opaque ENOENT; fall back to the OS default cwd so
    // spawn fails only for a genuinely missing interpreter.
    const spawnCwd = existsSync(request.cwd) ? realpathSync(request.cwd) : undefined
    const windowsRuntime =
      kind === 'repl' && this.platform === 'win32'
        ? await this.processSandbox?.resolveWindowsRuntime?.({
            runtime: 'repl',
            signal: request.signal
          })
        : undefined
    const ownerToken = this.processLifecycle?.createOwnerToken()
    const spawnEnv = this.buildEnv(
      kind,
      request,
      figuresDir,
      workloadCacheEnv,
      ownerToken ? this.processLifecycle?.environment(ownerToken) : undefined,
      windowsRuntime
    )
    const prefix = envPrefix(request.runtimeRoot, env, this.platform)

    let command: string
    let args: string[]
    let loopPath: string
    if (kind === 'repl') {
      // Windows protection uses the prepared Node runtime; standard-mode fallback and other
      // platforms use the app binary with ELECTRON_RUN_AS_NODE.
      command =
        this.platform === 'win32' && windowsRuntime !== null
          ? (windowsRuntime ?? resolveWindowsNotebookRuntime()).node
          : process.execPath
      loopPath = this.replLoopPath
      // Node otherwise realpaths the main module before loading it. A Windows AppContainer can read
      // the explicitly granted script but cannot enumerate its drive root or unrelated ancestors.
      // The sandbox opts into env proxies; keep that runtime advisory out of cell output.
      args = [
        '--disable-warning=UNDICI-EHPA',
        ...(this.platform === 'win32' ? ['--preserve-symlinks-main'] : []),
        loopPath
      ]
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
      args = [
        ...(request.resolvedInterpreter?.args ?? []),
        ...(kind === 'r' && !request.resolvedInterpreter ? ['--vanilla'] : []),
        loopPath
      ]
    }

    // The semantic guard rejects known installers before dispatch. On enforced platforms, the
    // native layer also protects app-owned runtimes across the persistent-kernel process tree,
    // including dynamically constructed calls. Windows standard mode has no such filesystem
    // boundary: source/language guards cannot restrict arbitrary native children. Enforced data
    // kernels can write only the disposable workload cache; Windows REPL also shares Shell's npm
    // prefix, while manage_packages owns managed Python/R package writes.
    const nativeInvocation = { executable: command, args }
    const invocation = this.processSandbox
      ? nativeInvocation
      : protectManagedRuntimeWrites(
          nativeInvocation,
          request.runtimeRoot,
          this.platform,
          kind === 'repl' && this.platform === 'win32' && spawnEnv.NPM_CONFIG_PREFIX
            ? [spawnEnv.NPM_CONFIG_PREFIX]
            : []
        )
    const sessionId = request.sessionId
    const projectId = request.projectId
    if (this.processSandbox && (!sessionId || !projectId)) {
      throw new Error('Notebook network sandbox requires Session and Project context.')
    }
    // Admission routes external R and the managed default through DEFAULT_R_ENV. Named,
    // agent-created environments have no per-runtime durable ACL removal workflow.
    let admission: NotebookRuntimeAccessAdmission | void = undefined
    if (kind === 'r' && env === DEFAULT_R_ENV) {
      admission = await this.processSandbox?.ensureRuntimeAccess?.({
        executable: invocation.executable,
        runtime: kind,
        sessionId: sessionId!,
        signal: request.signal
      })
    }
    if (request.signal?.aborted) throw new NotebookExecutionCancelledError()
    const rLibrary = kind === 'r' ? request.resolvedInterpreter?.rLibrary : undefined
    if (rLibrary && (await resolveExternalRLibrary(rLibrary)) !== rLibrary) {
      throw new Error('The authorized R package library changed. Select and authorize it again.')
    }
    const kernelEpochId = request.kernelEpochId ?? randomUUID()
    if (operation) operation.kernelEpochId = kernelEpochId
    const sandboxed = this.processSandbox
      ? await this.processSandbox.wrap({
          executable: invocation.executable,
          args: invocation.args,
          ...(kind === 'repl' && (this.platform !== 'win32' || windowsRuntime === null)
            ? { electronAsNode: true }
            : {}),
          env: spawnEnv,
          cwd: spawnCwd ?? process.cwd(),
          commandText: [invocation.executable, ...invocation.args].join(' '),
          sessionId: sessionId!,
          projectId: projectId!,
          runtime: kind,
          kernelEpochId,
          ...admission,
          ...(windowsRuntime !== undefined
            ? { windowsProtectionRequired: windowsRuntime !== null }
            : {}),
          ...(this.platform === 'win32' ? { superviseProcessTree: true } : {}),
          ...(kind === 'repl' && request.mcpRpcSocketPath
            ? { localRpcSocketPath: request.mcpRpcSocketPath }
            : {}),
          ...(kind === 'repl' && this.platform === 'linux' && request.mcpRpcToken
            ? { inheritedFileDescriptorCount: 1 }
            : {}),
          filesystem: {
            readOnlyRoots: presentPaths([
              request.runtimeRoot,
              request.resolvedInterpreter?.condaPrefix ?? '',
              ...(kind === 'r' ? [request.resolvedInterpreter?.rLibrary ?? ''] : []),
              request.inputRoot ?? '',
              kernelExecutableReadRoot(invocation.executable, kind, this.platform),
              ...(kind === 'r' && request.resolvedInterpreter
                ? [condaRLibraryReadRoot(invocation.executable, this.platform)]
                : []),
              loopPath,
              ...(kind === 'repl' ? [loopPackageConfigPath(loopPath)] : []),
              ...(this.platform === 'win32' ? [] : environmentPathRoots(spawnEnv, this.platform))
            ]),
            ...(this.platform === 'win32'
              ? { optionalReadOnlyRoots: environmentPathRoots(spawnEnv, this.platform) }
              : {}),
            readWriteRoots: presentPaths([
              // cwd is interpreter-controlled state, never a source of filesystem authority.
              request.notebookSessionRoot,
              figuresDir,
              ...(kind === 'repl' && this.platform === 'win32' && spawnEnv.NPM_CONFIG_PREFIX
                ? [spawnEnv.NPM_CONFIG_PREFIX]
                : []),
              ...(request.runtimeRoot ? [notebookWorkloadCacheRoot(request.runtimeRoot)] : [])
            ]),
            deniedReadRoots: request.protectedDirs ?? [],
            deniedWriteRoots: presentPaths([
              request.inputRoot ?? '',
              ...(request.protectedDirs ?? [])
            ])
          }
        })
      : undefined
    let ownershipReceipt: KernelProcessReceipt | undefined
    const nativeTerminationProof = sandboxed?.confirmProcessTreeTermination
    let processProof: Promise<ProcessTreeKillResult> | undefined
    let windowsOsProof: Promise<ProcessTreeKillResult> | undefined
    let terminationAttempt = 0
    const log = createLogger('notebook:kernel-termination')
    // One owner supplies both executor and sandbox admission with evidence for this exact spawn.
    // Keep successful proof before settling the receipt; failed observations remain retryable.
    const teardownProcess = async (): Promise<ProcessTreeKillResult> => {
      recordResourceEvent('kernel-teardown-started', {
        kernelEpochId,
        sessionId: request.sessionId,
        projectId: request.projectId,
        kind,
        pid: child?.pid,
        attempt: terminationAttempt + 1
      })
      if (!processProof) {
        const attempt = ++terminationAttempt
        const proof = (async () => {
          // POSIX retries verify recorded birth identities. Windows taskkill only addresses a PID,
          // so never repeat it after the first attempt; only its native owner may supply late proof.
          const windowsJobName = ownershipIntent?.record.windowsJobName
          const killOwnedChild = (): Promise<ProcessTreeKillResult> =>
            this.killChild(child).catch(() => {
              log.warn('kernel process termination attempt failed', {
                sessionId: request.sessionId,
                projectId: request.projectId,
                kernelEpochId,
                runtime: kind,
                phase: 'process-termination',
                attempt,
                failureCategory: 'termination-error'
              })
              return { reaped: false }
            })
          // On Windows the native supervisor owns the Job proof. Ask it to terminate first;
          // taskkill is only a conservative fallback because it can kill the proof publisher.
          const osResult =
            this.platform === 'win32' &&
            sandboxed?.confirmProcessState &&
            sandboxed.requestProcessTreeTermination
              ? (await sandboxed.requestProcessTreeTermination().catch(() => false))
                ? { reaped: true }
                : await (windowsOsProof ??= killOwnedChild())
              : this.platform === 'win32'
                ? await (windowsOsProof ??= killOwnedChild())
                : await killOwnedChild()
          let result = osResult
          if (
            this.platform === 'win32' &&
            nativeTerminationProof &&
            sandboxed?.requestProcessTreeTermination
          ) {
            const nativeReaped = await nativeTerminationProof().catch(() => false)
            if (!windowsJobName) result = { reaped: nativeReaped }
          } else if (!result.reaped && (await nativeTerminationProof?.().catch(() => false))) {
            result = { reaped: true }
          }
          if (
            result.reaped &&
            this.platform === 'win32' &&
            nativeTerminationProof &&
            child.pid !== undefined &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            // The native Job proof covers the workload, but precedes ACL restoration and the
            // supervisor's exit. Keep this exact ChildProcess and its ownership receipt until the
            // host exits; killing it here could interrupt ACL restoration. The caller's existing
            // shutdown budget still applies and must not turn an unfinished drain into success.
            await new Promise<void>((resolve) => child.once('exit', () => resolve()))
          }
          // The inner proof covers the workload only. Settle the outer host and any remaining
          // descendants as well, without depending on a supervisor that may already have crashed.
          if (windowsJobName) {
            result = { reaped: await reapWindowsOwnedJob(windowsJobName).catch(() => false) }
          }
          log.info('kernel process termination proof', {
            sessionId: request.sessionId,
            projectId: request.projectId,
            kernelEpochId,
            runtime: kind,
            phase: 'process-termination',
            attempt,
            osReaped: osResult.reaped,
            ...(this.platform === 'win32' && !result.reaped
              ? {
                  failureCategory: nativeTerminationProof
                    ? 'native-proof-pending'
                    : 'native-proof-unavailable'
                }
              : {}),
            ...result
          })
          recordResourceEvent('kernel-teardown-proof', {
            kernelEpochId,
            sessionId: request.sessionId,
            projectId: request.projectId,
            kind,
            pid: child.pid,
            attempt,
            osReaped: osResult.reaped,
            reaped: result.reaped
          })
          return result
        })()
        processProof = proof
        void proof.then(
          (result) => {
            if (!result.reaped && processProof === proof) processProof = undefined
          },
          () => {
            if (processProof === proof) processProof = undefined
          }
        )
      }
      const result = await processProof
      if (ownershipReceipt) {
        try {
          this.processLifecycle?.complete(ownershipReceipt, result.reaped)
        } catch (error) {
          log.warn('kernel receipt settlement incomplete', {
            sessionId: request.sessionId,
            projectId: request.projectId,
            kernelEpochId,
            runtime: kind,
            phase: 'receipt-settlement',
            attempt: terminationAttempt,
            processesTerminated: result.reaped
          })
          throw error
        }
      }
      return result
    }
    // This callback never enters sandbox cleanup, which may be holding its own retry lock.
    const confirmTermination = async (): Promise<boolean> => (await teardownProcess()).reaped
    const cleanupSandbox = (
      reason: NotebookSandboxCleanupReason,
      processOutcome: NotebookSandboxProcessOutcome
    ): Promise<NotebookSandboxCleanupResult> =>
      (async () => {
        const nativeState =
          processOutcome.processState === 'never-started'
            ? processOutcome.processState
            : ownershipIntent?.record.windowsJobName && processOutcome.processesTerminated
              ? 'started-and-reaped'
              : await sandboxed?.confirmProcessState?.().catch(() => undefined)
        const state =
          nativeState ??
          processOutcome.processState ??
          (processOutcome.processesTerminated ? 'started-and-reaped' : 'termination-unknown')
        const outcome = withNotebookSandboxProcessState(
          {
            processesTerminated: state !== 'termination-unknown',
            confirmTermination
          },
          state
        )
        return (
          sandboxed?.cleanup(reason, outcome) ??
          Promise.resolve({
            processesTerminated: state !== 'termination-unknown',
            networkClosed: true,
            temporaryResourcesRemoved: true,
            processState: state
          })
        )
      })()
    const rpcTokenFileDescriptor =
      kind === 'repl' && this.platform === 'linux' && request.mcpRpcToken ? 3 : undefined
    let ownershipIntent: KernelProcessSpawnIntent | undefined
    if (this.processLifecycle && this.laneKey && ownerToken) {
      ownershipIntent = this.processLifecycle.beginSpawn(
        {
          laneKey: this.laneKey,
          processKey: kind === 'repl' ? 'repl' : `${kind}:${env}`,
          kernelEpochId
        },
        ownerToken,
        sandboxed?.processTreeProof,
        this.platform === 'win32'
      )
    }
    const kernelExecutable = sandboxed?.executable ?? invocation.executable
    const kernelArgs = sandboxed?.args ?? invocation.args
    const spawnExecutable = ownershipIntent ? process.execPath : kernelExecutable
    // This Node host inherits the proxy opt-in even for Python/R, and shares the cell's stderr.
    const spawnArgs = ownershipIntent
      ? [
          '--disable-warning=UNDICI-EHPA',
          this.processHostPath,
          ownershipIntent.path,
          ownershipIntent.record.receiptId,
          kernelExecutable,
          ...kernelArgs
        ]
      : kernelArgs
    // Admission has already been checked before any kernel resources are prepared.
    const processTreeOwnership = createPosixProcessTreeOwnership(
      sandboxed?.env ?? spawnEnv,
      this.platform
    )
    const effectiveSpawnEnv = {
      ...processTreeOwnership.env,
      ...(ownershipIntent
        ? {
            ...nodeRuntimeEnvironment(),
            OPEN_SCIENCE_KERNEL_INHERITED_FDS: rpcTokenFileDescriptor ? '1' : '0'
          }
        : {})
    }
    let child: ChildProcessWithoutNullStreams
    let spawnAdmission: Readonly<{ started: () => void; notStarted: () => void }> | undefined
    const cleanupUnstarted = async (): Promise<NotebookResourceCleanupResult> => {
      let result: NotebookResourceCleanupResult
      try {
        const cleanup = await cleanupSandbox(
          'spawn-failed',
          withNotebookSandboxProcessState({ processesTerminated: true }, 'never-started')
        )
        result = {
          ...cleanup,
          reaped:
            cleanup.processesTerminated &&
            cleanup.networkClosed &&
            cleanup.temporaryResourcesRemoved
        }
      } catch (error) {
        result = { reaped: false, error }
      }
      if (operation) operation.cleanupResult = result
      return result
    }
    if (operation) operation.cleanup = cleanupUnstarted
    try {
      if (request.executionAdmission) await request.executionAdmission.prepare('create')
      if (request.signal?.aborted) throw new NotebookExecutionCancelledError()
      request.executionAdmission?.assertCurrent('create')
      // No await may separate this check from spawn: settings mutations must not interleave
      // between validating the prepared launch and creating its process.
      spawnAdmission = sandboxed?.beginSpawn?.()
      const spawnOptions = {
        cwd: spawnCwd,
        env: effectiveSpawnEnv,
        // The desktop's Node backend has no console to inherit; hide the outer host too.
        windowsHide: true,
        // Persistent kernels own a private POSIX process group. This gives teardown a stable OS-level
        // container that remains addressable even when the loop leader exits before its descendants.
        // Windows production hosts are atomically contained in a durable named Job below.
        detached: this.platform !== 'win32'
      }
      child = ownershipIntent?.record.windowsJobName
        ? spawnWindowsOwnedProcess(
            ownershipIntent.record.windowsJobName,
            spawnExecutable,
            spawnArgs,
            {
              ...spawnOptions,
              stdio: 'pipe'
            }
          )
        : spawn(spawnExecutable, spawnArgs, {
            ...spawnOptions,
            ...(rpcTokenFileDescriptor ? { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] } : {})
          })
      const windowsJobName = ownershipIntent?.record.windowsJobName
      if (windowsJobName) {
        registerProcessTreeOwnership(child, {
          terminate: async () => ({ reaped: await reapWindowsOwnedJob(windowsJobName) }),
          // The executor settles its receipt only after sandbox/host termination proof agrees.
          settled: () => {}
        })
      }
    } catch (error) {
      spawnAdmission?.notStarted()
      if (ownershipIntent) this.processLifecycle?.abandonSpawn(ownershipIntent)
      await cleanupUnstarted()
      throw error
    }
    child.once('spawn', () => spawnAdmission?.started())
    const startedAt = Date.now()
    try {
      // laneKey is the existing owner's serialized identity, not a path or an inferred session.
      const lane = JSON.parse(this.laneKey ?? '[]') as unknown[]
      observeResourceProcess(
        child,
        {
          kernelEpochId,
          sessionId: request.sessionId ?? lane[1],
          projectId: request.projectId ?? lane[0],
          kind,
          role: 'notebook',
          lane: lane[2],
          frameId: lane[3],
          attempt: lane[4],
          receiptId: ownershipIntent?.record.receiptId
        },
        () => terminationAttempt > 0
      )
    } catch {
      /* Missing diagnostic lane metadata cannot affect process admission. */
    }
    child.once('error', () => spawnAdmission?.notStarted())
    if (this.platform !== 'win32' && this.canTrackPosixProcesses)
      this.registerOwnedProcessGroup(child, processTreeOwnership.token)
    const sampleMemory = createNotebookMemorySampler(child, this.platform)
    let failedSpawnCleanup: Promise<NotebookResourceCleanupResult> | undefined
    const cleanupFailedSpawn = (): Promise<NotebookResourceCleanupResult> => {
      failedSpawnCleanup ??= (async () => {
        const result = await teardownProcess()
        if (ownershipIntent && result.reaped) this.processLifecycle?.abandonSpawn(ownershipIntent)
        const cleanup = await cleanupSandbox(
          'spawn-failed',
          withNotebookSandboxProcessState(
            { processesTerminated: result.reaped },
            child.pid === undefined
              ? 'never-started'
              : result.reaped
                ? 'started-and-reaped'
                : 'termination-unknown'
          )
        )
        return {
          ...result,
          ...cleanup,
          reaped:
            cleanup.processesTerminated &&
            cleanup.networkClosed &&
            cleanup.temporaryResourcesRemoved
        }
      })()
        .catch((error: unknown) => ({ reaped: false, error }))
        .then((result) => {
          if (operation) {
            operation.cleanupResult = result
            if (result.reaped) this.starting.delete(operation)
          }
          if (!result.reaped) {
            failedSpawnCleanup = undefined
            executorLog.warn('Notebook kernel startup cleanup remains pending', { kernelEpochId })
          }
          return result
        })
      return failedSpawnCleanup
    }
    if (operation) operation.cleanup = cleanupFailedSpawn
    const recordOwnership = (): void => {
      if (!ownershipIntent || child.pid === undefined || ownershipReceipt) return
      const birthToken = capturePosixProcessTreeIdentity(child)?.birthToken
      ownershipReceipt = this.processLifecycle?.recordSpawned(ownershipIntent, {
        pid: child.pid,
        processStartToken: readProcessStartToken(child.pid),
        ...(birthToken ? { posixBirthToken: birthToken } : {}),
        commandIdentityMarker: ownershipIntent.record.receiptId
      })
    }
    const rejectStartedKernel = (error: unknown): never => {
      // recordSpawned can fail after promoting the receipt. Keep the exact path for settlement
      // after verified reaping, and retire the epoch even while ownership remains unconfirmed.
      if (ownershipIntent && child.pid !== undefined && !ownershipReceipt) {
        ownershipReceipt = {
          path: ownershipIntent.activePath(child.pid),
          receiptId: ownershipIntent.record.receiptId,
          laneKey: ownershipIntent.record.laneKey
        }
      }
      if (operation) operation.cleanupResult = { reaped: false }
      void cleanupFailedSpawn()
      this.onTerminated?.(
        kind,
        env,
        {
          reason: 'error',
          name: 'KernelStartupError',
          message: error instanceof Error ? error.message : String(error)
        },
        kernelEpochId
      )
      throw new NotebookKernelStartupError()
    }
    try {
      // The parent records the child before yielding. If main dies first, the process host
      // activates this receipt before it starts the loop.
      recordOwnership()
    } catch (error) {
      rejectStartedKernel(error)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch (error) {
      if (child.pid !== undefined) rejectStartedKernel(error)
      await cleanupFailedSpawn()
      throw error
    }
    try {
      recordOwnership()
      if (ownershipIntent && !ownershipReceipt) {
        throw new Error('Kernel process did not expose a valid pid.')
      }
    } catch (error) {
      rejectStartedKernel(error)
    }
    if (rpcTokenFileDescriptor) {
      const tokenPipe = child.stdio[rpcTokenFileDescriptor]
      if (!tokenPipe || !('end' in tokenPipe)) {
        return rejectStartedKernel(new Error('Notebook RPC credential pipe was not created.'))
      }
      tokenPipe.on('error', () => undefined)
      tokenPipe.end(request.mcpRpcToken)
    }
    return {
      startedAt,
      kernelEpochId,
      child,
      sampleMemory,
      cwd: spawnCwd ?? process.cwd(),
      beginSandboxExecution: sandboxed?.beginExecution ?? (() => () => undefined),
      waitForNetworkApprovals: sandboxed?.waitForNetworkApprovals,
      annotateStderr: sandboxed?.annotateStderr ?? ((stderr) => stderr),
      teardownProcess,
      cleanupSandbox
    }
  }

  // Builds the spawn env shared by the loops, adding the figures dir, (for R) a PATH prefix, and (for
  // the repl kernel) the ELECTRON_RUN_AS_NODE flag so the app binary runs as plain Node. The R env
  // prefix is derived per request from request.runtimeRoot + the resolved env name.
  private buildEnv(
    kind: KernelProcessKind,
    request: NotebookExecutionRequest,
    figuresDir: string,
    workloadCacheEnv: NodeJS.ProcessEnv = notebookWorkloadCacheEnv(request.runtimeRoot),
    processOwnershipEnv?: NodeJS.ProcessEnv,
    windowsRuntime?: WindowsNotebookRuntime | null
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
      ...processOwnershipEnv,
      ...(kind === 'r' && request.resolvedInterpreter?.rLibrary
        ? { R_LIBS_USER: request.resolvedInterpreter.rLibrary }
        : {}),
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
      ...(kind === 'repl' && request.workspaceCwd
        ? { OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD: request.workspaceCwd }
        : {}),
      ...(kind === 'repl' ? { ...nodeRuntimeEnvironment() } : {}),
      ...(rEnvPrefix ? { OPEN_SCIENCE_R_ENV_PREFIX: rEnvPrefix } : {})
    }

    // The R interpreter and loop depend on the env's native libraries. Windows conda activation
    // requires Library\bin (BLAS/LAPACK and compiler runtimes), not just <prefix>\bin.
    if (rEnvPrefix) {
      env.PATH = condaActivatedPath(rEnvPrefix, process.env.PATH, this.platform)
    }
    if (kind !== 'repl' && !request.resolvedInterpreter) {
      Object.assign(
        env,
        buildManagedRuntimeProcessEnvironment(request.runtimeRoot, {
          language: kind,
          prefix: rEnvPrefix,
          platform: this.platform,
          sourceEnv: env
        })
      )
    }
    if (kind === 'repl' && this.platform === 'win32') {
      const runtimeEnv =
        windowsRuntime === null
          ? env
          : windowsNotebookRuntimeEnvironment(
              env,
              windowsRuntime ?? resolveWindowsNotebookRuntime()
            )
      // Control-plane REPL requests can run without managed storage. They still need the bundled
      // interpreter, but cannot create or grant a shared npm prefix without its runtime owner.
      return request.runtimeRoot
        ? prepareShellNpmEnvironment(request.runtimeRoot, 'win32', runtimeEnv)
        : runtimeEnv
    }
    return kind === 'r' ? normalizeRProcessLocale(env, this.platform) : env
  }

  // Frames one request onto the loop's stdin and returns a promise settled by the matching response
  // line, the timeout manager, or an unexpected process exit.
  private async sendRequest(
    proc: ProcState,
    reqId: string,
    request: NotebookExecutionRequest,
    onDispatch: () => void,
    replBindings?: ReplCellBindings
  ): Promise<{ response: KernelLoopResponse; timedOut: boolean; cancelled: boolean }> {
    if (request.executionAdmission) await request.executionAdmission.prepare('dispatch')
    return new Promise((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new NotebookExecutionCancelledError())
        return
      }
      if (!proc.alive || this.procs.get(proc.key) !== proc) {
        reject(
          proc.terminationError ?? new Error('Notebook kernel process exited before execution.')
        )
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
      const stopTimeout = (): void => {
        if (proc.pending !== pending) return
        this.stopPendingExecution(
          proc,
          new NotebookExecutionTimeoutError(`Notebook execution timed out after ${timeoutMs}ms.`),
          'timeout'
        )
      }
      const timeout =
        timeoutMs === undefined
          ? undefined
          : new TimeoutController({
              kill: (signal) => {
                if (proc.pending !== pending) return
                // Windows SIGINT terminates the leader outside its owned-tree teardown.
                if (this.platform === 'win32' || signal === 'SIGKILL') stopTimeout()
                else {
                  proc.child.kill(signal)
                  if (proc.kind === 'r') this.queueRInterruptProbe(proc, pending)
                }
              },
              onHardTimeout: stopTimeout
            })
      pending.timeout = timeout
      proc.pending = pending

      if (request.signal) {
        pending.abortListener = () => {
          if (proc.pending !== pending || pending.cancelled) return
          pending.cancelled = true
          pending.timeout?.disarm()

          const stopCancelled = (): void => {
            if (proc.pending !== pending) return
            this.stopPendingExecution(proc, new NotebookExecutionCancelledError(), 'cancel')
          }
          if (this.platform === 'win32') {
            stopCancelled()
            return
          }

          proc.child.kill('SIGINT')
          if (proc.kind === 'r') this.queueRInterruptProbe(proc, pending)
          pending.cancellationTimer = this.scheduleIdleTimer(
            stopCancelled,
            this.cancellationGraceMs
          )
        }
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }

      try {
        const assertDispatch = (): void => {
          if (request.signal?.aborted) throw new NotebookExecutionCancelledError()
          request.executionAdmission?.assertCurrent('dispatch')
          if (!proc.alive || this.procs.get(proc.key) !== proc)
            throw (
              proc.terminationError ?? new Error('Notebook kernel process exited before execution.')
            )
        }
        if (proc.kind === 'r') {
          const frame = frameRRequest(reqId, request.code)
          assertDispatch()
          proc.child.stdin.write(frame)
        } else {
          // Python and the repl (JS) loop share the same JSON-lines request framing.
          const protectedDirAdditions = (request.protectedDirs ?? []).filter(
            (directory) => !proc.protectedDirs.has(directory)
          )
          const frame = framePythonRequest(
            reqId,
            replBindings?.source ?? request.code,
            request.controlInvocationId,
            protectedDirAdditions,
            request.language === 'python' ? request.pythonRandomState : undefined,
            replBindings?.publisher,
            request.controlInvocationNonce
          )
          assertDispatch()
          proc.child.stdin.write(frame)
          for (const directory of protectedDirAdditions) proc.protectedDirs.add(directory)
        }
        proc.lastCell = createNotebookCellPreview(request.code)
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
        this.notifyTerminated(proc)
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
      if (response.cwd) proc.cwd = response.cwd
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

  private stopPendingExecution(
    proc: ProcState,
    error: Error,
    reason: NotebookSandboxCleanupReason
  ): void {
    proc.terminationError = error
    this.dropProc(proc)
    void this.killChildTracked(proc, reason)
    this.notifyTerminated(proc)
    this.rejectPending(proc, error)
  }

  // Fails the loop's current run once, clearing timers before any bounded exit diagnosis.
  private rejectPending(proc: ProcState, error: Error | Promise<Error>): void {
    const pending = proc.pending
    if (!pending) return

    this.clearPendingResources(pending)
    proc.pending = undefined
    if (pending.cancelled) pending.reject(new NotebookExecutionCancelledError())
    else if (error instanceof Error) pending.reject(error)
    else void error.then(pending.reject, pending.reject)
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

  private notifyTerminated(
    proc: ProcState,
    diagnostic?: NotebookKernelTerminationDiagnostic
  ): void {
    if (proc.kernelEpochId !== undefined) {
      this.onTerminated?.(proc.kind, proc.env, diagnostic, proc.kernelEpochId)
    } else if (diagnostic !== undefined) {
      this.onTerminated?.(proc.kind, proc.env, diagnostic)
    } else {
      this.onTerminated?.(proc.kind, proc.env)
    }
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
    if (proc.kernelEpochId !== undefined) {
      this.onIdleShutdown?.(proc.kind, proc.env, proc.kernelEpochId)
    } else {
      this.onIdleShutdown?.(proc.kind, proc.env)
    }
  }

  private async reconcileExitedProc(proc: ProcState): Promise<void> {
    let result = await this.killChildTracked(proc, 'exit')
    // Late native proof can arrive after exit. Delayed attempts join any cleanup another caller
    // already started, and only the tracked attempt may remove this process from the resource list.
    for (const delay of [100, 300]) {
      if (result.reaped) return
      await new Promise<void>((resolve) => setTimeout(resolve, delay).unref())
      result = await this.killChildTracked(proc, 'exit')
    }
  }

  // Fire-and-forget tree teardown for a DROPPED proc. Entry identity prevents an older retry from
  // clearing a newer attempt, while ProcState identity prevents one epoch from overwriting another.
  private killChildTracked(
    proc: ProcState,
    reason: NotebookSandboxCleanupReason = 'cancel'
  ): Promise<NotebookResourceCleanupResult> {
    if (proc.cleanupResult?.reaped) return Promise.resolve(proc.cleanupResult)
    const pending = this.pendingTeardowns.get(proc)
    if (proc.cleanupPending && pending) return pending.completion
    proc.cleanupPending = true
    const done = this.teardownProc(proc, reason).finally(() => {
      if (this.pendingTeardowns.get(proc)?.completion === done) proc.cleanupPending = false
    })
    const entry = {
      completion: done,
      retry: () => this.killChildTracked(proc, reason)
    }
    this.pendingTeardowns.set(proc, entry)
    void done.then((result) => {
      if (result.reaped && this.pendingTeardowns.get(proc) === entry) {
        this.pendingTeardowns.delete(proc)
      } else if (!result.reaped) {
        executorLog.warn('Notebook kernel cleanup remains pending', {
          processKey: proc.key,
          kernelEpochId: proc.kernelEpochId,
          reason
        })
      }
    })
    return done
  }

  private teardownProc(
    proc: ProcState,
    reason: NotebookSandboxCleanupReason
  ): Promise<NotebookResourceCleanupResult> {
    return (
      Promise.resolve()
        .then(() => proc.teardownProcess())
        .then(async (result) => {
          const cleanup = await this.cleanupProc(
            proc,
            reason,
            withNotebookSandboxProcessState(
              { processesTerminated: result.reaped },
              result.reaped ? 'started-and-reaped' : 'termination-unknown'
            )
          )
          return {
            ...result,
            processesTerminated: cleanup.processesTerminated,
            networkClosed: cleanup.networkClosed,
            temporaryResourcesRemoved: cleanup.temporaryResourcesRemoved,
            reaped:
              cleanup.processesTerminated &&
              cleanup.networkClosed &&
              cleanup.temporaryResourcesRemoved
          }
        })
        // A rejected cleanup is still an unconfirmed teardown, not a permanently rejected barrier.
        .catch((error: unknown) => ({ reaped: false, error }))
        .then((result) => {
          if (result.reaped) {
            proc.cleanupResult = result
            markNotebookKernelExitCleanedUp(proc.terminationError)
          }
          return result
        })
    )
  }

  private async reconcilePendingTeardown(
    proc: ProcState
  ): Promise<ProcessTreeKillResult | undefined> {
    const pending = this.pendingTeardowns.get(proc)
    if (!pending) return undefined
    const result = await pending.completion
    // Explicit cleanup and shutdown still retry the exact owned process until every stage succeeds.
    return result.reaped ? result : pending.retry()
  }

  private cleanupProc(
    proc: ProcState,
    reason: NotebookSandboxCleanupReason,
    processOutcome: NotebookSandboxProcessOutcome
  ): Promise<NotebookSandboxCleanupResult> {
    if (proc.sandboxCleanupPromise) return proc.sandboxCleanupPromise
    const cleanup = proc.cleanupSandbox(reason, processOutcome).then(
      (result) => {
        if (
          !result.processesTerminated ||
          !result.networkClosed ||
          !result.temporaryResourcesRemoved
        )
          proc.sandboxCleanupPromise = undefined
        return result
      },
      (error) => {
        proc.sandboxCleanupPromise = undefined
        throw error
      }
    )
    proc.sandboxCleanupPromise = cleanup
    return cleanup
  }

  // Kills a child and every descendant it spawned (a conda/micromamba launcher, an R subprocess),
  // waiting for the direct child to actually exit and escalating to SIGKILL anything left alive.
  // Returns { reaped } so shutdown()/shutdownAll() can tell a clean teardown (all trees gone, file
  // handles released) from a degraded one — the update-install gate refuses the NSIS uninstall unless
  // every kernel tree was cleanly reaped. terminateProcessTree never rejects.
  private async killChild(child: ChildProcessWithoutNullStreams): Promise<ProcessTreeKillResult> {
    const result = await this.terminateTree(child)
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
