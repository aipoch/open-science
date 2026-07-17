import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  NotebookCell,
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  FinishNotebookCodeCellRequest,
  NotebookEnvironmentStatus,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookOutput,
  NotebookRunRecord,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookRunSummary,
  NotebookSessionRequest,
  NotebookSessionReference,
  NotebookSessionState,
  RunNotebookCellRequest,
  NotebookWorkingFile,
  NotebookWriteLock
} from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult,
  ProvisionProgress
} from '../../shared/notebook-env'
import type { PackageMirror } from '../../shared/mirror'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import type { KernelProcessKind } from './kernel-executor'
import { effectiveMirrorAsync, type ProbeDeps } from './mirror-probe'
import {
  installPackages as installPackagesDefault,
  type InstallDeps,
  type InstallRequest,
  type InstallResult
} from './package-manager'
import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import {
  assertSafeEnvName,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  resolveEnvName
} from './runtime-paths'
import { getAppClaudeConfigDir } from '../settings/provider-env'

// Locale fallback when no explicit locale is injected (see shared/mirror.ts: non-CN locales resolve
// to public hosts, so this default never silently forces a CN mirror).
const DEFAULT_LOCALE = 'en-US'

// Default bash_execute timeout, matching the data/repl kernels' own default.
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
// Grace period between SIGTERM and SIGKILL when a timed-out shell command ignores the polite signal.
const SHELL_KILL_GRACE_MS = 2_000

// Composite routing key for a data run, matching the executor's resolveProcessKey: `${kind}:${env}`
// where kind is the language and env is the resolved env name. python:default-python and
// python:my-analysis are independent processes/queues; runs on the same key serialize.
const dataProcessKey = (language: NotebookLanguage, environment?: string): string =>
  `${language === 'r' ? 'r' : 'python'}:${resolveEnvName(language, environment)}`

// The process key the executor reports through onIdleShutdown/onTerminated(kind, env): `${kind}:${env}`
// for python/r, bare 'repl' for the env-agnostic control kernel. A missing kind/env (direct callers /
// tests that omit them) resolves to the DEFAULT env for the kind so run.json stays consistent.
const kernelProcessKey = (kind: KernelProcessKind | undefined, env: string | undefined): string => {
  const resolvedKind = kind ?? 'python'
  if (resolvedKind === 'repl') return 'repl'
  const resolvedEnv =
    env && env.length > 0 ? env : resolvedKind === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  return `${resolvedKind}:${resolvedEnv}`
}

// True when a process key's status is the one persisted into run.json's single kernel.lastKnownStatus:
// the two DEFAULT data envs and the control repl (backward compat — run.json shape is unchanged).
// Named-env statuses live only in memory / state() until a later task persists the environments map.
const persistsToRunJson = (processKey: string): boolean =>
  processKey === 'repl' ||
  processKey === `python:${DEFAULT_PY_ENV}` ||
  processKey === `r:${DEFAULT_R_ENV}`

type NotebookExecutionRequest = {
  code: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  // App-owned directories the kernel must not read (e.g. the CLAUDE_CONFIG_DIR with skill files).
  protectedDirs?: string[]
  timeoutMs?: number
  // Kernel language for this run; defaults to 'python' when omitted.
  language?: NotebookLanguage
  // Named conda environment to bind this run to; omitted -> the default env for the language.
  environment?: string
  // Selects the control-plane REPL kernel instead of the language-derived data kernel. Only the
  // control path sets this; data cells leave it unset and route by `language`.
  kind?: 'repl'
  // Connector RPC connection injected into the kernel spawn env for host.mcp().
  mcpRpcEndpoint?: string
  mcpRpcToken?: string
}

type NotebookExecutionResult = {
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout'>
  stdout: string
  stderr: string
  traceback: string
  cwdAfter: string
  outputs: NotebookOutput[]
  workingFiles?: NotebookWorkingFile[]
}

// Result of a control-plane REPL run. The mapped outputs (mapLoopOutputs) carry the returned value
// (text/plain display) and any error, and stdout/stderr/traceback are returned inline for the agent
// to inspect. Recording a run-history entry for this call is a side effect (see executeControlExclusive)
// that does not change this returned shape — the repl_execute contract to the agent stays the same.
type NotebookControlResult = {
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout'>
  stdout: string
  stderr: string
  traceback: string
  outputs: NotebookOutput[]
  workingFiles?: NotebookWorkingFile[]
}

// Result of one stateless bash_execute run. No status/traceback classification: the shell is
// expected to fail non-zero sometimes, so the caller inspects exitCode directly instead of a
// completed/failed status flag.
type NotebookShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

type NotebookExecutor = {
  execute: (request: NotebookExecutionRequest) => Promise<NotebookExecutionResult>
  shutdown: () => Promise<void>
  // Optional in-place restart; when present, restart() prefers it over shutdown()+recreate so the
  // caller's executor instance (and any wiring around it) doesn't have to change.
  restart?: () => Promise<void>
}

type NotebookRuntimeServiceCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookSessionReference) => void
}

// Provisioner-backed environment manager injected into the service (mirrors installPackagesImpl /
// getPackageMirror injection). DefaultRuntimeProvisioner satisfies this structurally; tests inject a
// fake so manageEnvironments never spawns real micromamba.
type NotebookEnvironmentManager = {
  createNamedEnvironment: (
    name: string,
    language: NotebookLanguage,
    packages?: string[]
  ) => Promise<EnvironmentInfo>
  listEnvironments: () => EnvironmentInfo[]
  removeEnvironment: (name: string) => EnvironmentInfo[]
}

// On-demand provisioner for the two DEFAULT envs (default-python / default-r), used when an agent run
// targets a default env that isn't materialized yet. Injected as the SAME serialized provisioner the
// startup gate / UI R-tab use, so concurrent provisions serialize (and materialize is idempotent), and
// R stays lazy but auto-builds from the offline bundle on first agent use instead of erroring — which
// otherwise nudges the agent into creating a redundant named env.
type DefaultEnvProvisioner = {
  provisionPython: (onProgress: (p: ProvisionProgress) => void) => Promise<void>
  provisionR: (onProgress: (p: ProvisionProgress) => void) => Promise<void>
}

// The connector RPC endpoint/token injected into a kernel's spawn env for host.mcp(). The token is
// stable for the lifetime of the local RPC server that issues it, so resolving it again on every run
// is cheap and always yields the same value the already-spawned kernel captured at its own spawn time.
type McpRpcConnection = { endpoint: string; token: string }

type NotebookRuntimeServiceOptions = {
  // Config root: source of the app-owned claude config dir (protected from the kernel). Never relocated.
  configRoot: string
  // Data root: where notebook workspaces, data, and the runtime install live (user-relocatable).
  dataRoot: string
  projectName: string
  repository?: NotebookRunRepository
  executorFactory?: (sessionId: string) => NotebookExecutor
  callbacks?: NotebookRuntimeServiceCallbacks
  // Resolves the connector RPC connection to inject into the kernel spawn env. Usually set after
  // construction via setMcpRpcConnectionResolver, since the RPC server is constructed with this
  // service as a dependency (constructing them in the other order would cycle).
  getMcpRpcConnection?: () => Promise<McpRpcConnection>
  // Resolves the user-configured package mirror (settings). Usually set after construction via
  // setPackageMirrorResolver, mirroring getMcpRpcConnection above — kept optional/async so a
  // synchronous test double works just as well as the real (disk-backed) settings service.
  getPackageMirror?: () => PackageMirror | undefined | Promise<PackageMirror | undefined>
  // Locale used to pick the default region mirror when nothing is configured (see shared/mirror.ts).
  // Defaults to a non-CN locale so an omitted value never silently forces a CN mirror.
  locale?: string
  // Latency-probe deps for the fastest-mirror auto-selection, injectable so tests stay hermetic (the
  // real probe does live HEAD requests). Undefined in production → effectiveMirrorAsync's real probe.
  mirrorProbe?: ProbeDeps
  // Package installer, injectable so tests never spawn real micromamba/pip/R. Defaults to
  // package-manager's installPackages.
  installPackagesImpl?: (
    request: InstallRequest,
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  // Provisioner-backed named-environment manager for manageEnvironments. Injectable so tests use a
  // fake; the production instance (the DefaultRuntimeProvisioner) is wired after construction in
  // main/ipc.ts via setEnvironmentManager, mirroring the mcp/mirror resolvers.
  environmentManager?: NotebookEnvironmentManager
}

type RuntimeSession = {
  id: string
  sessionId: string
  projectName: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
  cells: NotebookCell[]
  activeWrite?: NotebookWriteLock
  activeRunId?: string
  executionCount: number
  executor: NotebookExecutor
  // Tail of the serialized execution chain PER process key (`${kind}:${env}`). Each named env is its
  // own process/state boundary, so python:default-python, python:my-analysis and r:default-r all run
  // concurrently, while same-(kind, env) runs stay serialized behind one chain (that env's single
  // interpreter runs one cell at a time; the executor's proc.pending guard backs this up).
  executionQueues: Map<string, Promise<unknown>>
  // Separate serialization chain for control-plane REPL runs. The repl kernel is its own process, so
  // control runs proceed independently of data cells but are still serialized among themselves (the
  // single control process handles one request at a time).
  controlQueue: Promise<unknown>
  // Process keys whose kernel was lost (crash/hard-timeout) during their current run. A run clears its
  // key before executing and re-adds it via onTerminated on loss, so the post-run 'idle' write is
  // skipped and the 'terminated' status survives (the next clean run of that key clears it back).
  terminatedKernels: Set<string>
  // Live per-process-key kernel status (design D6). Updated on every status write for every env; the
  // source for state().environments and for the refuse-if-live check. run.json still carries only the
  // DEFAULT env's status (persistsToRunJson), so its shape is unchanged.
  kernelStatuses: Map<string, NotebookKernelMetadata['lastKnownStatus']>
}

// Builds the compact plain text output list shown in the preview panel.
const outputPlainText = (stdout: string, stderr: string): string[] =>
  [stdout, stderr].filter((text) => text.trim().length > 0)

// Turns unexpected executor exceptions into ordinary run results for the agent to inspect.
const errorToExecutionResult = (error: unknown, cwd: string): NotebookExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: 'failed',
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: cwd,
    outputs: [
      {
        type: 'error',
        message,
        traceback: message
      }
    ]
  }
}

// Benign environment variables the bash kernel is allowed to inherit. Everything else from the host
// process.env is dropped (default-deny) — see buildShellEnv.
const SHELL_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP'
]

// Builds a minimal, secret-free environment for the stateless bash kernel. bash runs arbitrary shell
// and — unlike the python kernel's protected-dir audit hook — cannot enforce read restrictions in
// process, so it previously inherited the FULL host process.env, including the connector RPC token and
// any proxy/API credentials the app process holds; a bash command could read or exfiltrate those.
// Pass only an allowlist of benign vars plus the shared workspace channel, so bash cannot reach the
// connector RPC or read host secrets from its environment. (Full filesystem/network egress isolation
// for bash is a tracked follow-up; this closes the environment-based leak.)
const buildShellEnv = (handoffDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SHELL_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.OPEN_SCIENCE_HANDOFF_DIR = handoffDir
  return env
}

// Runs one shell command in a brand-new `sh -c` process — no persistent proc, no kernel executor
// involvement. cwd/env mirror where the data kernels start (session cwd + the handoff dir), so bash
// can read/write files the same shared workspace channel the other kernels see. The env is scrubbed to
// an allowlist (buildShellEnv) so host secrets never reach the shell. Never rejects: a spawn failure, a
// non-zero exit, and a timeout are all resolved as ordinary results for the agent to inspect, matching
// the other kernels' "don't throw on failure" contract.
const runShellCommand = (options: {
  command: string
  cwd: string
  handoffDir: string
  timeoutMs?: number
}): Promise<NotebookShellResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
    const child = spawn('sh', ['-c', options.command], {
      cwd: options.cwd,
      env: buildShellEnv(options.handoffDir)
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    // True once the process has actually exited. child.killed is unreliable here: Node sets it as
    // soon as a signal is *delivered*, not when the process dies, so it cannot distinguish a still-
    // running (e.g. SIGTERM-ignoring) process from a killed one — gate the SIGKILL escalation below
    // on this instead.
    let exited = false

    const finish = (result: NotebookShellResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      resolve(result)
    }

    const timeoutTimer = setTimeout(() => {
      // Escalate SIGTERM -> SIGKILL if the process ignores the polite signal; the promise itself
      // settles immediately so a wedged process can never hang the caller past the timeout.
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
      }, SHELL_KILL_GRACE_MS)
      child.once('exit', () => clearTimeout(killTimer))

      finish({
        stdout,
        stderr:
          stderr +
          `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command timed out after ${timeoutMs}ms and was killed.`,
        exitCode: null
      })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      finish({ stdout, stderr: stderr || error.message, exitCode: null })
    })
    child.once('exit', (code) => {
      exited = true
      finish({ stdout, stderr, exitCode: code })
    })
  })

// Resolves the on-disk locations of the Python/R exec-loop scripts without depending on Electron
// (mirrors micromamba.ts's electron-free resolution). resources/** ships via electron-builder's
// asarUnpack, so a packaged build's loop scripts land beside app.asar under app.asar.unpacked rather
// than directly under process.resourcesPath. Existence-checked so a resolution mistake fails fast at
// startup instead of surfacing as an opaque spawn ENOENT.
const resolveLoopScript = (envOverride: string | undefined, fileName: string): string => {
  if (envOverride) return envOverride

  const candidates = [
    // Packaged (asar): resources/** is unpacked next to app.asar under process.resourcesPath.
    process.resourcesPath &&
      join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'notebook', fileName),
    // Packaged without an asar (e.g. an unpacked --dir build).
    process.resourcesPath && join(process.resourcesPath, 'resources', 'notebook', fileName),
    // Dev: electron-vite bundles main into out/main, two levels below the repo root.
    join(__dirname, `../../resources/notebook/${fileName}`),
    // Dev/test: unbundled ts source keeps this file at src/main/notebook, three levels below root.
    join(__dirname, `../../../resources/notebook/${fileName}`)
  ].filter((candidate): candidate is string => Boolean(candidate))

  const resolved = candidates.find((candidate) => existsSync(candidate))

  if (!resolved) {
    // Surface the miss instead of silently handing the executor a path that only fails once the loop
    // actually tries to spawn.
    console.error(`[notebook] Could not resolve ${fileName}; tried:`, candidates)
    return candidates[candidates.length - 1]
  }

  return resolved
}

// Resolves the exec-loop scripts the default executor spawns. Env overrides (OPEN_SCIENCE_PYTHON_LOOP
// / OPEN_SCIENCE_R_LOOP / OPEN_SCIENCE_REPL_LOOP) win for tests and dev, then the packaged/dev
// candidates above.
const resolveLoopScriptPaths = (): {
  pythonLoopPath: string
  rLoopPath: string
  replLoopPath: string
} => ({
  pythonLoopPath: resolveLoopScript(process.env.OPEN_SCIENCE_PYTHON_LOOP, 'python_loop.py'),
  rLoopPath: resolveLoopScript(process.env.OPEN_SCIENCE_R_LOOP, 'r_loop.R'),
  replLoopPath: resolveLoopScript(process.env.OPEN_SCIENCE_REPL_LOOP, 'repl_loop.js')
})

// Builds the default (non-test) executor's options from the storage root (D-B4). The executor now
// derives each interpreter prefix per request (from request.runtimeRoot + the resolved env name), so
// this no longer pins a single pythonBin/rEnvPrefix — it returns only the loop-script paths. Kept as a
// pure function separate from `new NotebookKernelExecutor(...)` so tests can assert the resolved paths
// without spawning a real loop process.
const resolveDefaultExecutorOptions = (): NotebookKernelExecutorOptions => {
  const { pythonLoopPath, rLoopPath, replLoopPath } = resolveLoopScriptPaths()

  return {
    pythonLoopPath,
    rLoopPath,
    replLoopPath
  }
}

// Finds an editable in-memory cell or fails with a clear notebook-domain error.
const findCell = (session: RuntimeSession, cellId: string): NotebookCell => {
  const cell = session.cells.find((candidate) => candidate.id === cellId)

  if (!cell) {
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  return cell
}

// Per-ENV readers-writer lock serializing environment management against kernel runs (§5
// "serialize package management against the target environment"). A run is a shared reader (runs on
// the same env proceed concurrently, e.g. across
// sessions), an install is an exclusive writer (blocks every run on that env until it finishes), so a
// pip/conda/CRAN install can never overlap an in-flight cell on the same env. Keyed by the RESOLVED env
// name (not language), so installs into DIFFERENT envs run concurrently while install+run on the SAME
// env stay mutually exclusive. Held at the service instance level because installs are process-global.
class EnvConcurrencyLock {
  // Tail of the exclusive (install) chain per env; a live install keeps this promise unresolved.
  private readonly writer = new Map<string, Promise<void>>()
  // In-flight readers (runs) per env, awaited by a pending install so it never overlaps one.
  private readonly readers = new Map<string, Set<Promise<void>>>()

  private readersFor(env: string): Set<Promise<void>> {
    let set = this.readers.get(env)
    if (!set) {
      set = new Set()
      this.readers.set(env, set)
    }
    return set
  }

  // Shared slot for a kernel run: waits out any active install, then runs concurrently with peers.
  async withRun<T>(env: string, fn: () => Promise<T>): Promise<T> {
    // Re-check after each wait so a run that arrives mid-install joins only once the install clears.
    let active = this.writer.get(env)
    while (active) {
      await active
      active = this.writer.get(env)
    }
    // Register synchronously (no await between the writer check above and this add) so a concurrent
    // install can never slip in and start between our check and registration.
    const readers = this.readersFor(env)
    let done!: () => void
    const reader = new Promise<void>((resolve) => (done = resolve))
    readers.add(reader)
    try {
      return await fn()
    } finally {
      readers.delete(reader)
      done()
    }
  }

  // Exclusive slot for an install: waits for the previous install and every in-flight run on this env
  // to drain, then runs alone. New runs registered after this point block on `mine`.
  async withInstall<T>(env: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writer.get(env) ?? Promise.resolve()
    let done!: () => void
    const mine = new Promise<void>((resolve) => (done = resolve))
    this.writer.set(env, mine)
    try {
      await prev
      await Promise.all(Array.from(this.readersFor(env)))
      return await fn()
    } finally {
      if (this.writer.get(env) === mine) this.writer.delete(env)
      done()
    }
  }
}

// Coordinates notebook cells, shared interpreters, persisted run history, and UI notifications.
class NotebookRuntimeService {
  private readonly repository: NotebookRunRepository
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly announcedAgentSessionIds = new Set<string>()
  // Serializes environment management (installs) against kernel runs on the same language's env;
  // shared across this service's sessions because installs are process-global (§5, G2).
  private readonly envLock = new EnvConcurrencyLock()
  // Process-global set of env process keys ('r:<env>') with a pending R-kernel restart recommendation
  // after an install/uninstall. Shared across sessions like envLock, since installs are process-global;
  // set in managePackages, cleared when the owning session restarts. Only R populates it.
  private readonly restartRecommendedEnvs = new Set<string>()
  private runSequence = 0
  private mcpRpcConnectionResolver: (() => Promise<McpRpcConnection>) | undefined
  private packageMirrorResolver:
    (() => PackageMirror | undefined | Promise<PackageMirror | undefined>) | undefined
  private readonly installPackagesImpl: (
    request: InstallRequest,
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  private environmentManager: NotebookEnvironmentManager | undefined
  private defaultEnvProvisioner: DefaultEnvProvisioner | undefined

  constructor(private readonly options: NotebookRuntimeServiceOptions) {
    this.repository = options.repository ?? new NotebookRunRepository(options.dataRoot)
    this.mcpRpcConnectionResolver = options.getMcpRpcConnection
    this.packageMirrorResolver = options.getPackageMirror
    this.installPackagesImpl = options.installPackagesImpl ?? installPackagesDefault
    this.environmentManager = options.environmentManager
  }

  // Wires the provisioner-backed environment manager after construction (the provisioner is built in
  // main/ipc.ts alongside the env gate, after this service exists), mirroring the resolver setters.
  setEnvironmentManager(manager: NotebookEnvironmentManager): void {
    this.environmentManager = manager
  }

  // Wires the (serialized) default-env provisioner used to build default-python/default-r on demand.
  setDefaultEnvProvisioner(provisioner: DefaultEnvProvisioner): void {
    this.defaultEnvProvisioner = provisioner
  }

  // Before running a data cell against a DEFAULT env, build it from the offline bundle if it isn't
  // materialized yet — so an agent's first R (or Python) run auto-provisions instead of erroring and
  // nudging the agent to create a redundant named env. Named envs are NOT auto-created here: the agent
  // must create those explicitly (a missing named env still surfaces the executor's error). Never
  // throws: a provision failure leaves the env missing, and the executor's readiness check then
  // surfaces it as a normal failed-run result (unchanged behavior).
  private async ensureDefaultEnvReady(
    language: NotebookLanguage,
    env: string,
    runtimeRootDir: string
  ): Promise<void> {
    const provisioner = this.defaultEnvProvisioner
    if (!provisioner) return
    if (env !== DEFAULT_PY_ENV && env !== DEFAULT_R_ENV) return
    const prefix = envPrefix(runtimeRootDir, env)
    const bin = language === 'r' ? rBin(prefix) : pythonBin(prefix)
    if (existsSync(bin)) return
    try {
      if (language === 'r') await provisioner.provisionR(() => {})
      else await provisioner.provisionPython(() => {})
    } catch (error) {
      console.error(`[notebook] on-demand provision of ${env} failed`, error)
    }
  }

  // Wires the connector RPC connection lookup after construction (the local RPC server that provides
  // it is itself constructed with this service as a dependency, so it cannot be passed in up front).
  setMcpRpcConnectionResolver(resolver: () => Promise<McpRpcConnection>): void {
    this.mcpRpcConnectionResolver = resolver
  }

  // Wires the package-mirror lookup after construction (typically the settings service, constructed
  // alongside/after this one in main/ipc.ts), mirroring setMcpRpcConnectionResolver above.
  setPackageMirrorResolver(
    resolver: () => PackageMirror | undefined | Promise<PackageMirror | undefined>
  ): void {
    this.packageMirrorResolver = resolver
  }

  // Starts an exclusive agent/user write stream into a cell and locks notebook editing.
  async beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    status: NotebookCell['status']
  }> {
    const session = await this.ensureSession(request)

    if (session.activeWrite) {
      throw new Error(`Notebook cell is already receiving code: ${session.activeWrite.cellId}`)
    }

    const cellId = request.cellId ?? `cell-${randomUUID()}`
    let cell = session.cells.find((candidate) => candidate.id === cellId)

    // Existing cells are reused for explicit cell ids; new cells are appended for one-shot runs.
    if (!cell) {
      cell = {
        id: cellId,
        language: request.language ?? 'python',
        code: '',
        status: 'receiving-code'
      }
      session.cells.push(cell)
    } else {
      cell.status = 'receiving-code'
      cell.code = ''
    }

    const writeId = `write-${randomUUID()}`

    cell.writeId = writeId
    session.activeWrite = {
      writeId,
      cellId,
      source: request.source ?? 'agent',
      startedAt: Date.now()
    }

    this.notifyNotebookAvailable(session, session.activeWrite.source)
    this.notifyNotebookChanged(session)

    return { sessionId: session.sessionId, cellId, writeId, status: cell.status }
  }

  // Appends raw code text to the locked cell and streams the change to the preview.
  async appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    receivedBytes: number
  }> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    this.assertActiveWrite(session, request.writeId, request.cellId)
    cell.code += request.delta
    this.notifyNotebookChanged(session)

    return {
      sessionId: session.sessionId,
      cellId: cell.id,
      writeId: request.writeId,
      receivedBytes: Buffer.byteLength(cell.code, 'utf8')
    }
  }

  // Releases a write lock so the completed cell can be run by the same shared interpreter.
  async finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    code: string
    status: NotebookCell['status']
  }> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    this.assertActiveWrite(session, request.writeId, request.cellId)
    session.activeWrite = undefined
    cell.writeId = undefined
    cell.status = 'idle'
    this.notifyNotebookChanged(session)

    return { sessionId: session.sessionId, cellId: cell.id, code: cell.code, status: cell.status }
  }

  // Persists a running run, executes the cell, then updates the same history entry with results.
  async runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    if (session.activeWrite?.cellId === cell.id) {
      throw new Error(`Notebook cell is still receiving code: ${cell.id}`)
    }

    // Serialize execution PER process key (`${kind}:${env}`) on its own interpreter: chain this run
    // after any in-flight run on the SAME (kind, env) so that env's kernel processes one cell at a
    // time, while a different env or language (e.g. python:my-analysis vs python:default-python vs r)
    // proceeds on its own independent chain (§5/D4, generalizes G5's per-kind queue to per-env).
    const processKey = dataProcessKey(cell.language, request.environment)
    const prev = session.executionQueues.get(processKey) ?? Promise.resolve()
    const run = prev.then(() => this.runCellExclusive(session, cell, request))
    // Keep the queue tail settled so a failing run never wedges the runs waiting behind it.
    session.executionQueues.set(
      processKey,
      run.catch(() => undefined)
    )

    return run
  }

  // Runs one cell to completion while holding its (kind, env) execution slot. Only ever invoked through
  // the per-process-key executionQueues chain so activeRunId, execution counts, and each shared
  // interpreter stay consistent across overlapping run requests on that env.
  private async runCellExclusive(
    session: RuntimeSession,
    cell: NotebookCell,
    request: RunNotebookCellRequest
  ): Promise<NotebookRunSummary> {
    this.notifyNotebookAvailable(session, request.source ?? 'agent')
    this.runSequence += 1
    session.executionCount += 1
    const runId = `notebook-run-${Date.now()}-${this.runSequence}`
    const startedAt = Date.now()
    const cwdBefore = session.cwd
    // Resolve the env at the run boundary: the run binds to this named env's process/queue/lock and it
    // is recorded on the run so history/replay and the UI know which env produced it (D1/D6).
    const env = resolveEnvName(cell.language, request.environment)
    const processKey = dataProcessKey(cell.language, request.environment)

    // Build the default env from the offline bundle on first use (R is lazy) before dispatching, so
    // the agent doesn't hit "still being prepared" and go create its own env. No-op for named envs
    // and for an already-materialized default.
    await this.ensureDefaultEnvReady(cell.language, env, session.runtimeRoot)

    // Mark the cell as running before execution so the preview can show immediate progress.
    session.activeRunId = runId
    cell.status = 'running'
    cell.executionCount = session.executionCount
    cell.latestRunId = runId
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: cell.id,
      source: request.source ?? 'agent',
      inputKind: request.inputKind ?? 'cell',
      kernelKind: cell.language,
      script: cell.code,
      status: 'running',
      startedAt,
      cwdBefore,
      executionCount: session.executionCount,
      environment: env,
      text: {
        stdout: '',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }

    // Surfaces (rather than silently substituting) a missing cwd instead of letting the executor's
    // spawn fall back to the OS default cwd on ENOENT and run the kernel somewhere unexpected.
    if (!existsSync(cwdBefore)) {
      console.error(
        `[notebook] Session cwd is missing before execution, the kernel may run in an unexpected directory: ${cwdBefore}`
      )
    }

    // Kernel-level 'running' status for the live run (§4 [running]); clear any stale terminated flag
    // for this process key so a completing run of it can settle back to 'idle'. No notify: the run
    // record's own appendRun notify (in persistRun below) surfaces the fresh status to the renderer.
    session.terminatedKernels.delete(processKey)
    await this.persistKernelStatus(session, 'running', processKey)

    // Every execution result, including errors, is normalized into data for agent analysis. The
    // connector RPC connection is NOT threaded here: data kernels (python/r) have no host.mcp and no
    // outbound connector access. Connector fetches run on the control-plane REPL (executeControl) and
    // hand data to python/r through the ./handoff channel. The execute runs as a shared reader of the
    // per-ENV lock, so it can never overlap an install into that same env (§5, G2/D5).
    let executedOnLiveKernel = true
    const { run } = await this.persistRun(
      session,
      runningRun,
      () =>
        this.envLock.withRun(env, () =>
          session.executor
            .execute({
              code: cell.code,
              cwd: cwdBefore,
              language: cell.language,
              environment: request.environment,
              notebookSessionRoot: session.notebookSessionRoot,
              dataRoot: session.dataRoot,
              runtimeRoot: session.runtimeRoot,
              protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
              timeoutMs: request.timeoutMs
            })
            .catch((error: unknown) => {
              executedOnLiveKernel = false
              return errorToExecutionResult(error, cwdBefore)
            })
        ),
      (result) => {
        // The next run starts in whatever directory the shared interpreter ended in.
        session.cwd = result.cwdAfter ?? cwdBefore
        session.activeRunId = undefined
        cell.status = result.status === 'completed' ? 'completed' : 'failed'
      }
    )

    // A run that actually reached the executor (rather than failing to even start) proves the kernel
    // is alive — settle back to 'idle', clearing a stale 'terminated'/'restarting' left by an idle
    // shutdown or unrelated restart, the same way restart() itself settles back to 'idle'. Skip it
    // when this run's kernel was lost mid-flight (crash/hard-timeout): its 'terminated' status must
    // survive until the next clean run of that process key.
    if (executedOnLiveKernel && !session.terminatedKernels.has(processKey)) {
      await this.markKernelStatusIdle(session, processKey)
    }

    return this.toRunSummary(session, run)
  }

  // Convenience path used by the terminal and MCP to write a temporary cell and run it.
  async execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary> {
    const begin = await this.beginCodeCell(request)

    await this.appendCodeCell({
      ...request,
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: request.code
    })
    await this.finishCodeCell({
      ...request,
      writeId: begin.writeId,
      cellId: begin.cellId
    })

    return this.runCell({
      ...request,
      cellId: begin.cellId
    })
  }

  // Runs code on the control-plane REPL kernel (kind 'repl'). This is a distinct call from data cells:
  // it creates no cell, no run-history record, and uses no NotebookLanguage. The REPL is the only
  // kernel with host.mcp connector access; the connector RPC connection is threaded into its spawn env
  // exactly as data cells get it. Serialized per session behind controlQueue so overlapping
  // repl_execute calls run one at a time on the single control process.
  async executeControl(request: ExecuteNotebookControlRequest): Promise<NotebookControlResult> {
    const session = await this.ensureSession(request)

    const run = session.controlQueue.then(() => this.executeControlExclusive(session, request))
    // Keep the queue tail settled so a failing run never wedges the runs waiting behind it.
    session.controlQueue = run.catch(() => undefined)

    return run
  }

  // Runs one control-plane request to completion while holding the session's single control slot.
  // Records a run-history entry (kernelKind 'repl') as a side effect; the returned NotebookControlResult
  // shape is unchanged, so repl_execute's contract to the agent stays the same.
  private async executeControlExclusive(
    session: RuntimeSession,
    request: ExecuteNotebookControlRequest
  ): Promise<NotebookControlResult> {
    this.notifyNotebookAvailable(session, 'agent')
    this.runSequence += 1
    const runId = `notebook-run-${Date.now()}-${this.runSequence}`
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: `repl-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'repl',
      script: request.code,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      text: {
        stdout: '',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }

    // Backed by the RPC server's cached start promise, so it settles to the same stable {endpoint,
    // token} the repl kernel captured at its own spawn time.
    const mcpRpc = await this.resolveMcpRpcConnection()

    // Kernel-level 'running' status for the live control run (§4 [running]); same rationale as
    // runCellExclusive. The repl kernel takes no env lock — installs only ever target python/r envs.
    session.terminatedKernels.delete('repl')
    await this.persistKernelStatus(session, 'running', 'repl')

    let executedOnLiveKernel = true
    const { result } = await this.persistRun(session, runningRun, () =>
      session.executor
        .execute({
          code: request.code,
          kind: 'repl',
          cwd: session.cwd,
          notebookSessionRoot: session.notebookSessionRoot,
          dataRoot: session.dataRoot,
          runtimeRoot: session.runtimeRoot,
          protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
          timeoutMs: request.timeoutMs,
          mcpRpcEndpoint: mcpRpc?.endpoint,
          mcpRpcToken: mcpRpc?.token
        })
        .catch((error: unknown) => {
          executedOnLiveKernel = false
          return errorToExecutionResult(error, session.cwd)
        })
    )

    // Same live-kernel signal as runCellExclusive: a control run that reached the executor settles the
    // kernel back to 'idle', unless it was lost mid-flight (then 'terminated' survives to the next run).
    if (executedOnLiveKernel && !session.terminatedKernels.has('repl')) {
      await this.markKernelStatusIdle(session, 'repl')
    }

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      traceback: result.traceback,
      outputs: result.outputs,
      workingFiles: result.workingFiles
    }
  }

  // Runs one bash command in a brand-new stateless process — distinct from every persistent kernel:
  // no proc map entry, no serialization queue (each call is independent and spawns immediately).
  // cwd matches where the data kernels start (the session's data dir); env carries the handoff dir so
  // bash can read/write the same cross-kernel channel repl_execute uses. Each call still records its
  // own run-history entry (kernelKind 'bash'); a fresh runId per call plus the repository's own
  // write-serialization (see NotebookRunRepository.writeDocument) keep overlapping calls from
  // colliding, even though there is no serialization queue here.
  async executeShell(request: ExecuteShellRequest): Promise<NotebookShellResult> {
    const session = await this.ensureSession(request)

    this.runSequence += 1
    const runId = `notebook-run-${Date.now()}-${this.runSequence}`
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: `bash-${runId}`,
      source: 'agent',
      inputKind: 'cell',
      kernelKind: 'bash',
      script: request.command,
      status: 'running',
      startedAt: Date.now(),
      cwdBefore: session.cwd,
      text: {
        stdout: '',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }

    const { result } = await this.persistRun(session, runningRun, async () => {
      const shellResult = await runShellCommand({
        command: request.command,
        cwd: session.cwd,
        handoffDir: join(session.notebookSessionRoot, 'handoff'),
        timeoutMs: request.timeoutMs
      })
      // No status/traceback classification for the caller-facing NotebookShellResult (the shell is
      // expected to fail non-zero sometimes), but the run-history record still needs one: exitCode 0
      // is 'completed', a null exitCode means runShellCommand hit its own timeout, and anything else
      // (including a signal-kill) is 'failed'.
      const status: NotebookRunStatus =
        shellResult.exitCode === 0
          ? 'completed'
          : shellResult.exitCode === null
            ? 'timeout'
            : 'failed'
      const outputs: NotebookOutput[] = [
        ...(shellResult.stdout
          ? [{ type: 'stream' as const, name: 'stdout' as const, text: shellResult.stdout }]
          : []),
        ...(shellResult.stderr
          ? [{ type: 'stream' as const, name: 'stderr' as const, text: shellResult.stderr }]
          : [])
      ]

      return {
        status,
        stdout: shellResult.stdout,
        stderr: shellResult.stderr,
        traceback: '',
        cwdAfter: session.cwd,
        outputs,
        exitCode: shellResult.exitCode
      }
    })

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }

  // Returns the current in-memory cells plus the complete persisted run history.
  async state(request: NotebookSessionRequest): Promise<NotebookSessionState> {
    const session = await this.ensureSession(request)
    const document = await this.repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd
    })

    return {
      id: session.id,
      sessionId: session.sessionId,
      cwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      pythonPath: document.kernel.pythonPath,
      kernelStatus: document.kernel.lastKnownStatus,
      runJsonPath: session.runJsonPath,
      cells: [...session.cells],
      activeWrite: session.activeWrite,
      activeRunId: session.activeRunId,
      runs: document.runs,
      recentRuns: document.runs.slice(-20),
      environments: this.buildEnvironmentStatuses(session)
    }
  }

  // Projects the session's live per-process-key status map into the wire shape state()'s consumers
  // (the multi-env preview / T8) read: one entry per (kind, env) the session has spawned. The coarse
  // top-level kernelStatus stays the DEFAULT env's status for backward compat; this is the per-env view.
  private buildEnvironmentStatuses(session: RuntimeSession): NotebookEnvironmentStatus[] {
    return Array.from(session.kernelStatuses.entries()).map(([processKey, status]) => {
      if (processKey === 'repl') {
        return { processKey, kind: 'repl', status }
      }
      const separator = processKey.indexOf(':')
      const kind = processKey.slice(0, separator) === 'r' ? 'r' : 'python'
      return {
        processKey,
        kind,
        environment: processKey.slice(separator + 1),
        status,
        restartRecommended: this.restartRecommendedEnvs.has(processKey)
      }
    })
  }

  // Resolves the durable reference for a session, preferring the live runtime session but falling
  // back to persisted run.json so notebook entries survive an app relaunch without re-running code.
  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    const existing = this.sessions.get(request.sessionId)

    if (existing) {
      return this.toSessionReference(existing)
    }

    const projectName = request.projectName ?? this.options.projectName
    const document = await this.repository.findExisting(projectName, request.sessionId)

    if (!document) {
      return null
    }

    // Roots come from run.json normalization so a rehydrated entry matches the live one exactly.
    return {
      sessionId: request.sessionId,
      projectName,
      workspaceCwd: document.workspaceCwd,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.dataRoot, projectName, request.sessionId)
    }
  }

  // Replaces the interpreter process while preserving cells and durable run history. Prefers the
  // executor's own in-place restart (keeps the same instance, e.g. NotebookKernelExecutor tears down
  // and lazily respawns its loops) and only shuts down + recreates for executors that don't support it.
  // Reports 'restarting' for the duration and settles back to 'idle' once the fresh process is ready.
  async restart(request: NotebookSessionRequest): Promise<NotebookSessionState> {
    const session = await this.ensureSession(request)

    // A restart respawns fresh loops, so any pending R-restart recommendation for this session's envs
    // is cleared. Snapshot the keys before teardown drops them from kernelStatuses.
    const envKeys = Array.from(session.kernelStatuses.keys())

    await this.repository.updateKernelStatus({
      projectName: session.projectName,
      sessionId: session.sessionId,
      status: 'restarting'
    })
    this.notifyNotebookChanged(session)

    try {
      if (session.executor.restart) {
        await session.executor.restart()
      } else {
        await session.executor.shutdown()
        session.executor = this.createExecutor(session.sessionId, session.projectName)
      }
      for (const key of envKeys) this.restartRecommendedEnvs.delete(key)
    } finally {
      await this.repository.updateKernelStatus({
        projectName: session.projectName,
        sessionId: session.sessionId,
        status: 'idle'
      })
    }
    this.notifyNotebookChanged(session)

    return this.state(request)
  }

  // Installs packages into the shared global environments (never inside a session/kernel). Resolves
  // the effective package mirror (configured override, else the region default) and forwards it as
  // installPackages' deps, so the conda/pip/CRAN install actually hits the configured mirror. Runs as
  // the exclusive writer of the target ENV's lock, so it drains and blocks every in-flight run on that
  // env — a pip/conda/CRAN install can never overlap a cell mid-import (§5, G2/D5). Installs into
  // DIFFERENT envs proceed concurrently (the lock is keyed by resolved env name, not language).
  async managePackages(request: InstallRequest): Promise<InstallResult> {
    const configured = await this.resolvePackageMirror()
    const mirror = await effectiveMirrorAsync(
      configured,
      this.options.locale ?? DEFAULT_LOCALE,
      this.options.mirrorProbe
    )

    const envName = resolveEnvName(request.language, request.environment)
    const result = await this.envLock.withInstall(envName, () =>
      this.installPackagesImpl(request, {
        storageRoot: this.options.dataRoot,
        condaChannel: mirror.condaChannel,
        pypiIndex: mirror.pypiIndex,
        cranMirror: mirror.cranMirror,
        caBundle: mirror.caBundle
      })
    )

    // R installs/uninstalls don't take effect in a live R session (attached namespaces, held DLLs), so
    // flag the env for a restart prompt and refresh every session's env view. Python needs no restart.
    if (result.ok && result.needsRestart && request.language === 'r') {
      this.restartRecommendedEnvs.add(`r:${envName}`)
      for (const session of this.sessions.values()) {
        this.notifyNotebookChanged(session)
      }
    }

    return result
  }

  // Named-environment management (design D2), delegating to the injected provisioner-backed manager.
  // create/list return the full current env set; remove REFUSES if any session currently has a live
  // executor process bound to that env name (locked decision — the on-disk env can't be rm-rf'd out
  // from under a running kernel). Create returns on completion (progress streaming is out of scope).
  async manageEnvironments(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult> {
    const manager = this.environmentManager
    if (!manager) {
      throw new Error('Environment management is unavailable (no environment manager configured).')
    }

    switch (request.action) {
      case 'create': {
        // Validate BEFORE the name composes a filesystem path, and reject reserved/alias/default
        // names so a created env is always reachable by execute/install (design D8 / review #1,#2).
        const name = assertSafeEnvName(request.name)
        if (request.language !== 'python' && request.language !== 'r') {
          throw new Error('Creating an environment requires a language of "python" or "r".')
        }
        const language = request.language
        // Serialize create against installs / other env ops on the same env (design D4 / review A).
        return this.envLock.withInstall(name, async () => {
          await manager.createNamedEnvironment(name, language, request.packages)
          return { environments: manager.listEnvironments() }
        })
      }
      case 'list':
        return { environments: manager.listEnvironments() }
      case 'remove': {
        const name = assertSafeEnvName(request.name)
        if (this.isEnvironmentLive(name)) {
          throw new Error(
            `Environment "${name}" is in use by a running kernel — restart the notebook or ` +
              'wait for the run to finish before removing it.'
          )
        }
        // Serialize the rm -rf against a concurrent install into the same env (design D4 / review A).
        return this.envLock.withInstall(name, async () => ({
          environments: manager.removeEnvironment(name)
        }))
      }
    }
  }

  // True when any session has a live (spawned, not yet terminated) executor process bound to this env
  // name. Derived from the per-process-key status map: a key whose status is not 'terminated' has a
  // live proc (a run set it 'running'/'idle' and no idle-shutdown/crash has dropped it since). The
  // repl key is env-agnostic and never blocks a named-env removal.
  private isEnvironmentLive(name: string): boolean {
    for (const session of this.sessions.values()) {
      for (const [processKey, status] of session.kernelStatuses) {
        if (processKey === 'repl' || status === 'terminated') continue
        if (processKey.slice(processKey.indexOf(':') + 1) === name) return true
      }
    }
    return false
  }

  // Shuts down one session executor and removes its in-memory routing state.
  async shutdown(
    request: NotebookSessionRequest
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    const session = this.sessions.get(request.sessionId)

    if (session) {
      await session.executor.shutdown()
      this.sessions.delete(request.sessionId)
    }

    return { sessionId: request.sessionId, status: 'shutdown' }
  }

  // Shuts down every live interpreter, used by app-level cleanup paths.
  async shutdownAll(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.executor.shutdown())
    )
    this.sessions.clear()
  }

  // Lists sessions with a cell mid-execution, for the pre-migration active-session warning.
  getActiveNotebookSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.activeRunId !== undefined)
      .map((session) => ({ projectName: session.projectName, sessionId: session.sessionId }))
  }

  // Creates or returns the runtime session bound to an ACP/chat session id.
  private async ensureSession(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectName = request.projectName ?? this.options.projectName
    const existing = this.sessions.get(request.sessionId)

    if (existing) {
      return existing
    }

    const document = await this.repository.loadOrCreate({
      projectName,
      sessionId: request.sessionId,
      workspaceCwd: request.workspaceCwd
    })
    // Runtime session roots come from run.json normalization so UI, MCP, and Python agree.
    const session: RuntimeSession = {
      id: `notebook-session-${request.sessionId}`,
      sessionId: request.sessionId,
      projectName,
      // Start the interpreter in the session's writable data dir (like a Jupyter notebook's cwd), not
      // the outer workspace. Relative writes — e.g. plt.savefig("plot.png") — then land in a directory
      // that is inside the artifact import roots, so the agent never has to guess an absolute path.
      // dataRoot lives under notebookSessionRoot (an allowed import root) and is created before this.
      cwd: document.dataRoot,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.dataRoot, projectName, request.sessionId),
      cells: [],
      executionCount: document.runs.length,
      executor: this.createExecutor(request.sessionId, projectName),
      executionQueues: new Map(),
      controlQueue: Promise.resolve(),
      terminatedKernels: new Set(),
      kernelStatuses: new Map()
    }

    this.sessions.set(request.sessionId, session)

    return session
  }

  // Builds the interpreter backend, allowing tests to inject a fake executor. The default (D-B4)
  // builds a real NotebookKernelExecutor from the storage root's runtime paths, wired so an idle-
  // shutdown proc (kernel-executor.ts's own idle timer) surfaces as a 'terminated' kernel status; this
  // branch is not exercised by unit tests (see resolveDefaultExecutorOptions for the tested,
  // spawn-free portion).
  private createExecutor(sessionId: string, projectName: string): NotebookExecutor {
    if (this.options.executorFactory) return this.options.executorFactory(sessionId)

    return new NotebookKernelExecutor({
      ...resolveDefaultExecutorOptions(),
      onIdleShutdown: (kind, env) => {
        void this.handleKernelIdleShutdown(sessionId, projectName, kind, env)
      },
      onTerminated: (kind, env) => {
        void this.handleKernelTerminated(sessionId, projectName, kind, env)
      }
    })
  }

  // Persists 'terminated' for a proc the executor dropped after its idle window, then notifies the
  // renderer so a reload picks up the fresh status. Keyed by the (kind, env) the executor reports so a
  // named env's idle shutdown marks only that env, not the whole session. Never throws: this runs off
  // an executor-owned timer with nothing waiting on it, so a persistence failure here must not surface
  // anywhere louder than a swallowed no-op.
  private async handleKernelIdleShutdown(
    sessionId: string,
    projectName: string,
    kind?: KernelProcessKind,
    env?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    const processKey = kernelProcessKey(kind, env)
    if (session) {
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyNotebookChanged(session)
      return
    }
    // No live session (rehydrated after relaunch): still persist the default env's run.json status.
    if (!persistsToRunJson(processKey)) return
    try {
      await this.repository.updateKernelStatus({ projectName, sessionId, status: 'terminated' })
    } catch {
      return
    }
  }

  // Persists 'terminated' for a proc lost to a crash or hard-timeout (§4 "crash → [terminated]"),
  // then notifies. Flags the process key on the session so an in-flight run whose kernel died mid-
  // execution does not overwrite this back to 'idle' on completion; the next clean run of that key
  // clears it. Best-effort like handleKernelIdleShutdown: it runs off an executor callback.
  private async handleKernelTerminated(
    sessionId: string,
    projectName: string,
    kind: KernelProcessKind,
    env?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    const processKey = kernelProcessKey(kind, env)
    if (session) {
      session.terminatedKernels.add(processKey)
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyNotebookChanged(session)
      return
    }
    if (!persistsToRunJson(processKey)) return
    try {
      await this.repository.updateKernelStatus({ projectName, sessionId, status: 'terminated' })
    } catch {
      return
    }
  }

  // Persists 'idle' once a run actually completes on a live kernel, clearing a stale 'terminated'
  // (idle-shutdown) or 'restarting' status without a full status state machine — mirrors the
  // self-clearing 'restarting' -> 'idle' transition restart() already performs in its finally block.
  // Best-effort: a persistence failure here must not surface as a run failure.
  private async markKernelStatusIdle(session: RuntimeSession, processKey: string): Promise<void> {
    await this.persistKernelStatus(session, 'idle', processKey)
  }

  // Records a kernel-level lifecycle status for one process key. Always updates the in-memory per-env
  // map (source for state().environments and the refuse-if-live check); additionally persists into
  // run.json's single kernel.lastKnownStatus ONLY for the DEFAULT envs / repl (persistsToRunJson), so
  // run.json's shape stays unchanged — named-env status persistence is a separate later task. Does not
  // notify: callers persist a status alongside a run record whose own append/update notify already
  // surfaces the change. A persistence failure must never surface as a run failure.
  private async persistKernelStatus(
    session: RuntimeSession,
    status: NotebookKernelMetadata['lastKnownStatus'],
    processKey: string
  ): Promise<void> {
    session.kernelStatuses.set(processKey, status)
    if (!persistsToRunJson(processKey)) return
    try {
      await this.repository.updateKernelStatus({
        projectName: session.projectName,
        sessionId: session.sessionId,
        status
      })
    } catch {
      return
    }
  }

  // Shared append-running -> execute -> update-completed -> notify sequence used by cell, repl, and
  // bash runs so none of the three reimplements it. `execute` is expected to never reject (each caller
  // pre-catches its own executor/process failure into a normal result, matching every kernel's
  // "don't throw on failure" contract); `afterUpdate` lets the caller mutate session/cell state (e.g.
  // session.cwd, cell.status) from the result before the single trailing notify fires.
  private async persistRun<
    R extends {
      status: NotebookRunStatus
      stdout: string
      stderr: string
      traceback: string
      cwdAfter?: string
      outputs: NotebookOutput[]
      workingFiles?: NotebookWorkingFile[]
    }
  >(
    session: RuntimeSession,
    runningRun: NotebookRunRecord,
    execute: () => Promise<R>,
    afterUpdate?: (result: R, run: NotebookRunRecord) => void
  ): Promise<{ run: NotebookRunRecord; result: R }> {
    // The initial history entry lets users see in-progress runs before execution returns.
    await this.repository.appendRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: runningRun
    })
    this.notifyNotebookChanged(session)

    const result = await execute()

    // Replace the running record instead of appending so each run id has one durable entry.
    const completedRun: NotebookRunRecord = {
      ...runningRun,
      status: result.status,
      endedAt: Date.now(),
      cwdAfter: result.cwdAfter,
      text: {
        stdout: result.stdout,
        stderr: result.stderr,
        traceback: result.traceback,
        plain: outputPlainText(result.stdout, result.stderr)
      },
      // result.outputs already carries the mapped error output when there's a traceback (see
      // mapLoopOutputs / errorToExecutionResult); do NOT append a second one or the panel renders
      // the traceback twice.
      outputs: result.outputs,
      workingFiles: result.workingFiles ?? []
    }
    const document = await this.repository.updateRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: completedRun
    })
    const run = document.runs.find((candidate) => candidate.runId === runningRun.runId)

    if (!run) {
      throw new Error(`Notebook run not found after update: ${runningRun.runId}`)
    }

    afterUpdate?.(result, run)
    this.notifyNotebookChanged(session)

    return { run, result }
  }

  // Best-effort lookup of the connector RPC connection: host.mcp() is unavailable (rather than the
  // whole cell failing) when no resolver is wired or the RPC server fails to start.
  private async resolveMcpRpcConnection(): Promise<McpRpcConnection | undefined> {
    if (!this.mcpRpcConnectionResolver) return undefined

    try {
      return await this.mcpRpcConnectionResolver()
    } catch {
      return undefined
    }
  }

  // Best-effort lookup of the configured package mirror: an install falls back to the region default
  // (never a hard failure) when no resolver is wired or the settings read throws.
  private async resolvePackageMirror(): Promise<PackageMirror | undefined> {
    if (!this.packageMirrorResolver) return undefined

    try {
      return await this.packageMirrorResolver()
    } catch {
      return undefined
    }
  }

  // Verifies that streamed writes are still targeting the currently locked cell.
  private assertActiveWrite(session: RuntimeSession, writeId: string, cellId: string): void {
    if (session.activeWrite?.writeId !== writeId || session.activeWrite.cellId !== cellId) {
      throw new Error('Notebook write lock is not active for this cell.')
    }
  }

  // Creates the small event payload used by renderer listeners and preview tabs.
  private toSessionReference(session: RuntimeSession): NotebookSessionReference {
    return {
      sessionId: session.sessionId,
      projectName: session.projectName,
      workspaceCwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: session.runJsonPath
    }
  }

  // Announces notebook availability only once per agent-started session.
  private notifyNotebookAvailable(session: RuntimeSession, source: NotebookRunSource): void {
    if (source !== 'agent' || this.announcedAgentSessionIds.has(session.sessionId)) return

    this.announcedAgentSessionIds.add(session.sessionId)
    this.options.callbacks?.onNotebookAvailable?.(this.toSessionReference(session))
  }

  // Broadcasts state invalidation so the renderer can reload run.json and in-memory cell data.
  private notifyNotebookChanged(session: RuntimeSession): void {
    this.options.callbacks?.onNotebookChanged?.(this.toSessionReference(session))
  }

  // Adds notebook roots and kernel metadata to the run returned to MCP callers.
  private toRunSummary(session: RuntimeSession, run: NotebookRunRecord): NotebookRunSummary {
    return {
      ...run,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.dataRoot),
      kernelName: 'python3'
    }
  }
}

export { NotebookRuntimeService, resolveDefaultExecutorOptions, resolveLoopScriptPaths }
export type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookControlResult,
  NotebookShellResult,
  NotebookExecutor,
  NotebookEnvironmentManager,
  NotebookRuntimeServiceCallbacks,
  NotebookRuntimeServiceOptions
}
