import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
  addRepairRequired,
  assertSafeEnvName,
  clearRepairRequired,
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  isRepairRequired,
  pythonBin,
  pythonReady,
  rBin,
  rReady,
  resolveEnvName
} from './runtime-paths'
import type {
  DiscoveredInterpreter,
  EnvProvenance,
  NotebookRuntimeBinding,
  NotebookRuntimeBindings,
  NotebookRuntimeListing,
  RuntimeEnablement,
  RuntimeUsage
} from '../../shared/notebook-runtime'
import { isEnvEnabled } from '../../shared/notebook-runtime'
import {
  discoverInterpreters,
  defaultDiscoveryDeps,
  rscriptFor,
  windowsCondaPrefixForR
} from './environment-discovery'
import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'
import { reconcileInterruptedOperations, defaultOperationChildLiveness } from './operation-recovery'
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

// Provenance of a named env under runtime/envs, mirroring environment-discovery.classify's rule: the
// two DEFAULT envs and their versioned siblings (e.g. default-python-3.13) are app-managed; any other
// name is an agent-created env. The remove-guard uses this so remove only ever deletes agent-created
// envs — never an app-managed default (user-own envs never live under runtime/envs, so they can't be
// named here at all).
const namedEnvProvenance = (name: string): EnvProvenance =>
  name === DEFAULT_PY_ENV ||
  name === DEFAULT_R_ENV ||
  name.startsWith(`${DEFAULT_PY_ENV}-`) ||
  name.startsWith(`${DEFAULT_R_ENV}-`)
    ? 'app-managed'
    : 'agent-created'

type ResolvedInterpreter = {
  command: string
  args?: string[]
  // Set only for an external Windows conda R. The prefix belongs to that interpreter and lets the
  // executor activate its DLL search path without ever substituting the app-managed R prefix.
  condaPrefix?: string
}

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
  // Interpreter resolved by the Runtime Registry for this run: a managed env bin, or an external /
  // overlay interpreter (BYO). When present it OVERRIDES the executor's default managed-prefix lookup
  // — this is the seam that removes the executor's hard-binding to the app conda prefix (foundation:
  // "avoid deep binding"). Absent -> the executor falls back to the env's own managed interpreter
  // (behavior unchanged). `args` are prepended before the loop script (e.g. a launcher's flags).
  resolvedInterpreter?: ResolvedInterpreter
  // Selects the control-plane REPL kernel instead of the language-derived data kernel. Only the
  // control path sets this; data cells leave it unset and route by `language`.
  kind?: 'repl'
  // Connector RPC connection injected into the kernel spawn env for host.mcp().
  mcpRpcEndpoint?: string
  mcpRpcToken?: string
}

type NotebookExecutionResult = {
  // 'cancelled' is produced only by a force-stop disable killing the run (WS10); the executor itself
  // only ever returns completed/failed/timeout.
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout' | 'cancelled'>
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
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout' | 'cancelled'>
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
  // Returns { reaped }: true only when every kernel tree was cleanly reaped, so shutdownAll can gate
  // the update-install uninstall on all interpreter file handles being released.
  shutdown: () => Promise<{ reaped: boolean }>
  // Optional in-place restart; when present, restart() prefers it over shutdown()+recreate so the
  // caller's executor instance (and any wiring around it) doesn't have to change.
  restart?: () => Promise<void>
  // Optional physical teardown of ONE (kind, env) kernel process (kill + drop from routing) so the
  // next run for that key respawns clean. Used by switchRuntime to actually stop the old interpreter
  // rather than relying only on the interpreter-identity respawn seam. Optional so test doubles that
  // only implement execute/shutdown keep working.
  terminate?: (kind: 'python' | 'r' | 'repl', env: string) => Promise<void>
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
  // Resolves the v4 per-language enablement (enabled/install-authorized maps) used to gate which
  // discovered runtimes the agent may bind. Usually wired after construction via
  // setRuntimeEnablementResolver (settings service). Undefined / returning undefined -> the provenance
  // defaults (app-managed enabled; user-own disabled), so an unwired resolver can never enable a BYO
  // env — the enable gate holds by default (defense-in-depth).
  getRuntimeEnablement?: (language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>
  // Discovers the interpreters available for a language (app-managed + user-own). Injectable so tests
  // don't spawn real interpreters; production defaults to environment-discovery over the runtime root.
  discoverRuntimes?: (language: NotebookLanguage) => Promise<DiscoveredInterpreter[]>
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

// The wire binding plus the interpreter override the executor needs. `resolvedInterpreter` is set only
// for an EXTERNAL binding (run the user's own interpreter directly); an app-managed binding leaves it
// undefined so the executor keeps its managed-prefix lookup and ensureDefaultEnvReady provisions the env.
type InternalRuntimeBinding = NotebookRuntimeBinding & {
  resolvedInterpreter?: ResolvedInterpreter
  // The conda env NAME a MANAGED binding runs in (default-python / an agent-created named env like
  // "my-analysis"), so a run resolves its env + process key + Windows conda activation from the binding
  // rather than a per-call environment argument. Undefined for an EXTERNAL binding (runs a raw
  // interpreter, tracked under the language's default env key).
  envName?: string
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
  // v4 per-language DEFAULT-runtime binding (bound via notebook_bind/switch_runtime). One runtime per
  // language per session; absent -> the language still resolves to the app-managed default (today's
  // behavior). Named conda envs are orthogonal and never recorded here.
  runtimeBindings: Map<NotebookLanguage, InternalRuntimeBinding>
  // Process keys whose in-flight run is being FORCE-STOPPED by a disable (kernel killed mid-run): the
  // run's kill is recorded 'cancelled' (not 'failed'), then the key is cleared. WS10 force-stop.
  forceStoppedKeys: Set<string>
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

// Result for a run whose kernel was deliberately FORCE-STOPPED (a "stop running work and disable"):
// recorded 'cancelled', not 'failed', so history reflects a user action rather than an error.
const CANCELLED_MESSAGE =
  'Run cancelled: the runtime was disabled (stop running work) while this cell was executing.'
const cancelledExecutionResult = (cwd: string): NotebookExecutionResult => ({
  status: 'cancelled',
  stdout: '',
  stderr: CANCELLED_MESSAGE,
  traceback: CANCELLED_MESSAGE,
  cwdAfter: cwd,
  outputs: [{ type: 'error', message: CANCELLED_MESSAGE, traceback: CANCELLED_MESSAGE }]
})

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
  // In-flight background drains kicked off by revokeRuntime (disable): each drains the affected env's
  // in-flight run then physically closes its kernel. Tracked so shutdown paths await them (and tests
  // can settle them) rather than leaking a dangling teardown.
  private readonly revocationDrains = new Set<Promise<void>>()
  private runSequence = 0
  private mcpRpcConnectionResolver: (() => Promise<McpRpcConnection>) | undefined
  private packageMirrorResolver:
    (() => PackageMirror | undefined | Promise<PackageMirror | undefined>) | undefined
  private runtimeEnablementResolver:
    ((language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>) | undefined
  // Manually-added interpreter paths (Settings catalog) folded into discovery so a picked interpreter
  // that is NOT on PATH / in a conda root is still discovered here — and therefore bindable and not
  // reported 'missing' after a restart. Wired post-construction like the enablement resolver.
  private manualInterpretersResolver:
    ((language: NotebookLanguage) => Promise<string[]>) | undefined
  // Resolves when startup crash-recovery has finished; awaited by materialize/install so their prefix
  // work never races recovery's cleanup. Undefined until recoverInterruptedOperations is kicked off.
  private recoveryComplete: Promise<void> | undefined
  // Env prefixes an interrupted op left possibly-live: recovery couldn't confirm the child process died
  // (liveness 'unknown' — no ps / Windows / unparsable), so a survivor might STILL be writing this
  // prefix. Any op that would write it (default materialize, package install, named-env create, UI
  // provision/repair) must refuse for the rest of THIS process's life — the recovery barrier resolving
  // is not enough, since the op wasn't actually reconciled. A later restart re-runs recovery against the
  // retained journal entry: if the pid is gone/verifiable then, it reconciles and the prefix clears.
  private readonly blockedPrefixes = new Set<string>()
  private readonly runtimeDiscoveryImpl: (
    language: NotebookLanguage
  ) => Promise<DiscoveredInterpreter[]>
  private readonly installPackagesImpl: (
    request: InstallRequest,
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  private environmentManager: NotebookEnvironmentManager | undefined
  private defaultEnvProvisioner: DefaultEnvProvisioner | undefined
  private defaultEnvProgress: (progress: ProvisionProgress) => void = () => undefined

  constructor(private readonly options: NotebookRuntimeServiceOptions) {
    this.repository = options.repository ?? new NotebookRunRepository(options.dataRoot)
    this.mcpRpcConnectionResolver = options.getMcpRpcConnection
    this.packageMirrorResolver = options.getPackageMirror
    this.runtimeEnablementResolver = options.getRuntimeEnablement
    this.runtimeDiscoveryImpl =
      options.discoverRuntimes ??
      (async (language) => {
        // Resolve the manual catalog for this language (async), then hand discovery a sync getter for
        // it — mirroring runtime-ipc, so the service and the Settings survey discover the same set.
        const manual = this.manualInterpretersResolver
          ? await this.manualInterpretersResolver(language).catch(() => [])
          : []
        return discoverInterpreters(
          language,
          defaultDiscoveryDeps(getRuntimeRoot(this.options.dataRoot), () => manual)
        )
      })
    this.installPackagesImpl = options.installPackagesImpl ?? installPackagesDefault
    this.environmentManager = options.environmentManager
  }

  // Wires the provisioner-backed environment manager after construction (the provisioner is built in
  // main/ipc.ts alongside the env gate, after this service exists), mirroring the resolver setters.
  setEnvironmentManager(manager: NotebookEnvironmentManager): void {
    this.environmentManager = manager
  }

  // Wires the (serialized) default-env provisioner used to build default-python/default-r on demand.
  setDefaultEnvProvisioner(
    provisioner: DefaultEnvProvisioner,
    onProgress: (progress: ProvisionProgress) => void = () => undefined
  ): void {
    this.defaultEnvProvisioner = provisioner
    this.defaultEnvProgress = onProgress
  }

  // Before running a data cell against a DEFAULT env, build it from the offline bundle if it isn't
  // materialized yet — so an agent's first R (or Python) run auto-provisions instead of erroring and
  // nudging the agent to create a redundant named env. Named envs are NOT auto-created here: the agent
  // must create those explicitly (a missing named env still surfaces the executor's error). Never
  // True when the app-managed default env for a language has been EXPLICITLY disabled in Settings. The
  // default is enabled by its provenance unless an explicit `false` override exists (keyed by the
  // interpreter's real path — the same key the Settings toggle persists). Used to refuse a no-binding
  // run against a disabled default instead of silently provisioning + running it.
  private async isDefaultEnvDisabled(
    language: NotebookLanguage,
    runtimeRootDir: string
  ): Promise<boolean> {
    const enablement = await this.resolveRuntimeEnablement(language)
    if (!enablement) return false
    const prefix = envPrefix(runtimeRootDir, language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV)
    const interp = language === 'r' ? rBin(prefix) : pythonBin(prefix)
    // Match by real path if the interpreter is on disk (how the Settings card keys it); else the path
    // as-is (an unprovisioned default can't have been toggled, so this only matters once it exists).
    let envId = interp
    try {
      envId = realpathSync(interp)
    } catch {
      // Not on disk yet — keep the raw path.
    }
    return enablement.enabled[envId] === false || enablement.enabled[interp] === false
  }

  // A provision failure is broadcast and rethrown so the run path records the actionable root cause
  // as a failed run rather than spawning the executor against a missing prefix.
  private async ensureDefaultEnvReady(
    language: NotebookLanguage,
    env: string,
    runtimeRootDir: string,
    sessionId: string
  ): Promise<void> {
    const provisioner = this.defaultEnvProvisioner
    if (!provisioner) return
    if (env !== DEFAULT_PY_ENV && env !== DEFAULT_R_ENV) return
    // Let startup recovery finish first so its prefix cleanup/verify can't race this materialize.
    await this.ensureRecovered()
    // Refuse if recovery left this prefix blocked (an unknown-liveness orphan may still be writing it) —
    // materializing over it now could corrupt a live env.
    this.assertPrefixRecoverable(envPrefix(runtimeRootDir, env))
    const ready =
      language === 'r'
        ? rReady(runtimeRootDir, DEFAULT_ENV_VERSION)
        : pythonReady(runtimeRootDir, DEFAULT_ENV_VERSION)
    if (ready) return
    const reportProgress = (progress: ProvisionProgress): void =>
      this.defaultEnvProgress({ ...progress, scope: language, sessionId })
    try {
      if (language === 'r') await provisioner.provisionR(reportProgress)
      else await provisioner.provisionPython(reportProgress)
    } catch (error) {
      const message = `Could not prepare ${env}: ${error instanceof Error ? error.message : String(error)}`
      reportProgress({ phase: 'error', message, progress: 0 })
      throw new Error(message, { cause: error })
    }
  }

  // The DEFAULT env name / process key for a language, matching resolveEnvName / dataProcessKey.
  private defaultEnvNameFor(language: NotebookLanguage): string {
    return language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  }

  // The conda env NAME a run uses for a language, derived from the SESSION BINDING (v4: the binding,
  // not a per-call argument, picks the env). A managed binding runs in its conda env (default-python or
  // an agent-created named env); an external binding or no binding runs under the language's DEFAULT
  // env name (an external binding overrides the interpreter but is tracked on the default env key).
  private resolveRunEnv(session: RuntimeSession, language: NotebookLanguage): string {
    const binding = session.runtimeBindings.get(language)
    if (binding?.source === 'managed' && binding.envName) return binding.envName
    return this.defaultEnvNameFor(language)
  }

  // Discovers a language's interpreters (best-effort; a discovery failure yields an empty list so the
  // tools degrade to "only the app-managed default is available" rather than throwing at the agent).
  private async runtimeDiscovery(language: NotebookLanguage): Promise<DiscoveredInterpreter[]> {
    try {
      return await this.runtimeDiscoveryImpl(language)
    } catch {
      return []
    }
  }

  // The persisted enablement for a language; undefined (unwired or a read failure) -> isEnvEnabled
  // falls back to the provenance defaults, keeping the enable gate closed for BYO envs.
  private async resolveRuntimeEnablement(
    language: NotebookLanguage
  ): Promise<RuntimeEnablement | undefined> {
    if (!this.runtimeEnablementResolver) return undefined
    try {
      return await this.runtimeEnablementResolver(language)
    } catch {
      return undefined
    }
  }

  // Projects a discovered interpreter into the wire binding. An app-managed env is 'managed' (the
  // executor keeps its managed-prefix lookup); everything else is 'external' (run its interpreter).
  private toInternalBinding(env: DiscoveredInterpreter): InternalRuntimeBinding {
    // A conda env WE own (app-managed default OR an agent-created named env) is 'managed': the executor
    // resolves it by env NAME (managed-prefix lookup + conda activation). Only the USER'S OWN
    // interpreter is 'external' — run its binary directly.
    const source = env.provenance === 'user-own' ? 'external' : 'managed'
    const externalRCondaPrefix =
      source === 'external' && env.language === 'r'
        ? windowsCondaPrefixForR(env.interpreterPath, 'win32')
        : undefined
    return {
      language: env.language,
      runtimeId: env.envId,
      source,
      provenance: env.provenance,
      interpreterPath: env.interpreterPath,
      label: env.label,
      version: env.version,
      status: 'active',
      // Managed runs in its conda env by NAME (default-python, or the agent-created env's condaEnv);
      // external runs the user's own interpreter directly. External R must launch via Rscript (the R
      // kernel loop needs Rscript, not the R binary), matching the managed path's rScriptBin.
      resolvedInterpreter:
        source === 'external'
          ? {
              command: env.language === 'r' ? rscriptFor(env.interpreterPath) : env.interpreterPath,
              ...(externalRCondaPrefix ? { condaPrefix: externalRCondaPrefix } : {})
            }
          : undefined,
      envName:
        source === 'managed' ? (env.condaEnv ?? this.defaultEnvNameFor(env.language)) : undefined
    }
  }

  // The ENABLED interpreters for a language: app-managed + user-enabled external, never disabled.
  private async listEnabledInterpreters(
    language: NotebookLanguage
  ): Promise<DiscoveredInterpreter[]> {
    const [discovered, enablement] = await Promise.all([
      this.runtimeDiscovery(language),
      this.resolveRuntimeEnablement(language)
    ])
    return discovered.filter((env) => isEnvEnabled(env, enablement))
  }

  // Resolves a runtimeId to an ENABLED runtime for a language, refusing in the MAIN process when it is
  // disabled or unknown — a guessed interpreter path can never bypass the Settings enable gate.
  private async resolveEnabledRuntime(
    language: NotebookLanguage,
    runtimeId: string
  ): Promise<InternalRuntimeBinding> {
    const enabled = await this.listEnabledInterpreters(language)
    const match = enabled.find((env) => env.envId === runtimeId)
    if (!match) {
      throw new Error(
        `"${runtimeId}" is not an enabled ${language} runtime. Use list_notebook_runtimes to see the ` +
          'available runtimes, or enable it in Settings → Runtimes first (disabled and unknown ' +
          'runtimes are refused).'
      )
    }
    const binding = this.toInternalBinding(match)
    // An interrupted install left this runtime possibly half-applied (crash recovery flagged it): mark
    // the binding repair-required so execution refuses rather than silently trusting it. A completed
    // re-install of this runtime clears the flag (see managePackages).
    if (isRepairRequired(getRuntimeRoot(this.options.dataRoot), runtimeId)) {
      return { ...binding, status: 'unavailable', reason: 'repair-required' }
    }
    return binding
  }

  // list_notebook_runtimes: the enabled runtimes for both languages, each flagged with whether it is
  // this session's current binding. Never returns a disabled runtime.
  async listRuntimes(request: NotebookSessionRequest): Promise<{
    runtimes: NotebookRuntimeListing[]
    bindings: NotebookRuntimeBindings
  }> {
    const session = await this.ensureSession(request)
    const runtimes: NotebookRuntimeListing[] = []
    for (const language of ['python', 'r'] as const) {
      const bound = session.runtimeBindings.get(language)
      for (const env of await this.listEnabledInterpreters(language)) {
        const binding = this.toInternalBinding(env)
        runtimes.push({
          language: binding.language,
          runtimeId: binding.runtimeId,
          source: binding.source,
          provenance: binding.provenance,
          interpreterPath: binding.interpreterPath,
          label: binding.label,
          version: binding.version,
          runnable: env.runnable,
          detail: env.detail,
          bound: bound?.runtimeId === binding.runtimeId
        })
      }
    }
    return { runtimes, bindings: this.buildRuntimeBindings(session) }
  }

  // notebook_bind_runtime: the FIRST binding of a language for the session. Refuses a disabled/unknown
  // runtime; refuses re-binding a different runtime (use notebook_switch_runtime to change).
  async bindRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    const session = await this.ensureSession(request)
    const binding = await this.resolveEnabledRuntime(request.language, request.runtimeId)
    const existing = session.runtimeBindings.get(request.language)
    if (existing && existing.runtimeId !== binding.runtimeId) {
      throw new Error(
        `A ${request.language} runtime is already bound for this session. Use ` +
          'notebook_switch_runtime to change it (it tears down the current kernel first).'
      )
    }
    session.runtimeBindings.set(request.language, binding)
    await this.persistRuntimeBindings(session)
    return { bound: this.toWireBinding(binding), bindings: this.buildRuntimeBindings(session) }
  }

  // notebook_switch_runtime: an EXPLICIT switch — tear down the old kernel + clear that language's
  // state, then rebind. Refuses a disabled/unknown runtime (same MAIN-process gate as bind).
  async switchRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    const session = await this.ensureSession(request)
    const binding = await this.resolveEnabledRuntime(request.language, request.runtimeId)
    // PHYSICALLY tear down the CURRENT runtime's kernel for this language BEFORE rebinding, so the new
    // runtime starts fresh and two same-language interpreters never coexist. Resolve the OLD env first
    // (from the outgoing binding), kill its kernel process via the executor, then clear its state.
    const oldEnv = this.resolveRunEnv(session, request.language)
    const kind = request.language === 'r' ? 'r' : 'python'
    await session.executor.terminate?.(kind, oldEnv)
    this.tearDownLanguageBinding(session, request.language, oldEnv)
    session.runtimeBindings.set(request.language, binding)
    await this.persistRuntimeBindings(session)
    this.notifyNotebookChanged(session)
    return { bound: this.toWireBinding(binding), bindings: this.buildRuntimeBindings(session) }
  }

  // WS11: how many live sessions are bound to a runtime, split by kernel state, so Settings can warn
  // before disabling it. Counts only sessions whose binding for this language IS this runtime; a
  // running cell → running, a live-but-idle kernel → idle, a bound session with no live kernel →
  // dormant (nothing to drain). Purely in-memory (no disk read).
  describeRuntimeUsage(language: NotebookLanguage, runtimeId: string): RuntimeUsage {
    const usage: RuntimeUsage = { running: 0, idle: 0, dormant: 0 }
    for (const session of this.sessions.values()) {
      const binding = session.runtimeBindings.get(language)
      if (!binding || binding.runtimeId !== runtimeId) continue
      const processKey = dataProcessKey(language, this.resolveRunEnv(session, language))
      const status = session.kernelStatuses.get(processKey)
      if (status === 'running') usage.running += 1
      else if (status !== undefined) usage.idle += 1
      else usage.dormant += 1
    }
    return usage
  }

  // WS10: a runtime was DISABLED in Settings. Revoke it from every session bound to it — mark the
  // binding unavailable/disabled so subsequent execute/install REJECT with RUNTIME_BINDING_UNAVAILABLE
  // (no silent fallback); an in-flight run is left to finish (its kernel drains, then idle-times out —
  // explicit post-drain kernel teardown is WS5). The agent recovers via list_notebook_runtimes ->
  // notebook_switch_runtime. See [[notebook-runtime-disable-binding-lifecycle]].
  async revokeRuntime(
    language: NotebookLanguage,
    runtimeId: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      const binding = session.runtimeBindings.get(language)
      if (binding && binding.runtimeId === runtimeId && binding.status !== 'unavailable') {
        // 1. Block new leases NOW: an unavailable binding makes further execute/install reject.
        const env = this.resolveRunEnv(session, language)
        const processKey = dataProcessKey(language, env)
        binding.status = 'unavailable'
        binding.reason = 'disabled'
        await this.persistRuntimeBindings(session)
        this.notifyNotebookChanged(session)

        if (options.force) {
          // FORCE-STOP ("stop running work and disable"): abort a running cell now — flag its process
          // key so the killed run records 'cancelled' (not 'failed'), then physically terminate the
          // kernel and clear its state. Only flag when a cell is actually running, so the one-shot flag
          // can't leak onto a later run of an idle/dormant kernel.
          const kind = language === 'r' ? 'r' : 'python'
          if (session.kernelStatuses.get(processKey) === 'running') {
            session.forceStoppedKeys.add(processKey)
          }
          await session.executor.terminate?.(kind, env)
          this.tearDownLanguageBinding(session, language, env)
          this.notifyNotebookChanged(session)
          continue
        }

        // 2. Default (drain): close in the BACKGROUND so the disable toggle doesn't block on a
        //    long-running cell — let the in-flight run finish, then tear the kernel down. Tracked so
        //    shutdown awaits it.
        const drain = this.drainAndCloseRuntime(session, language, env)
        this.revocationDrains.add(drain)
        void drain.finally(() => this.revocationDrains.delete(drain))
      }
    }
  }

  // Drain-and-close for a revoked (disabled) runtime: wait out the in-flight run on this env (never a
  // mid-kill), then physically terminate its kernel and clear its state so no stale interpreter lingers
  // (the binding stays unavailable — the agent must switch). Best-effort: teardown errors are logged.
  private async drainAndCloseRuntime(
    session: RuntimeSession,
    language: NotebookLanguage,
    env: string
  ): Promise<void> {
    const kind = language === 'r' ? 'r' : 'python'
    const processKey = dataProcessKey(language, env)
    try {
      // The queue tail settles when the current run (and any new run that already enqueued and will
      // now reject on the unavailable binding) finishes.
      await (session.executionQueues.get(processKey) ?? Promise.resolve()).catch(() => undefined)
      await session.executor.terminate?.(kind, env)
      this.tearDownLanguageBinding(session, language, env)
      this.notifyNotebookChanged(session)
    } catch (error) {
      console.error('[notebook] Failed to drain/close a revoked runtime', error)
    }
  }

  // Drops the wire-only fields of an internal binding (never leaks the interpreter override shape).
  private toWireBinding(binding: InternalRuntimeBinding): NotebookRuntimeBinding {
    return {
      language: binding.language,
      runtimeId: binding.runtimeId,
      source: binding.source,
      provenance: binding.provenance,
      interpreterPath: binding.interpreterPath,
      label: binding.label,
      version: binding.version,
      status: binding.status ?? 'active',
      reason: binding.reason
    }
  }

  // The session's current per-language bindings in wire shape (for notebook_state / the tools).
  private buildRuntimeBindings(session: RuntimeSession): NotebookRuntimeBindings {
    const python = session.runtimeBindings.get('python')
    const r = session.runtimeBindings.get('r')
    return {
      python: python ? this.toWireBinding(python) : undefined,
      r: r ? this.toWireBinding(r) : undefined
    }
  }

  // Persists the session's bindings so they survive a restart (best-effort; a persistence failure must
  // not fail the bind/switch/revoke operation itself). Reloaded + revalidated by reloadPersistedBindings.
  private async persistRuntimeBindings(session: RuntimeSession): Promise<void> {
    try {
      await this.repository.setRuntimeBindings(
        session.projectName,
        session.sessionId,
        this.buildRuntimeBindings(session)
      )
    } catch (error) {
      console.error('[notebook] Failed to persist runtime bindings', error)
    }
  }

  // On session (re)load, rehydrate persisted bindings and REVALIDATE each against current discovery +
  // enablement: a binding that still resolves to an enabled+runnable runtime is restored active (its
  // kernel is terminated after a restart — memory is gone, but the binding stands); one that no longer
  // resolves is kept as unavailable (NO silent fallback) so the next execute rejects and the agent
  // switches — 'disabled' when the runtime is still detected but turned off, 'missing' when it is gone.
  private async reloadPersistedBindings(
    session: RuntimeSession,
    persisted: NotebookRuntimeBindings | undefined
  ): Promise<void> {
    if (!persisted) return
    for (const language of ['python', 'r'] as const) {
      const wire = persisted[language]
      if (!wire) continue
      try {
        session.runtimeBindings.set(
          language,
          await this.resolveEnabledRuntime(language, wire.runtimeId)
        )
      } catch {
        const discovered = await this.runtimeDiscovery(language)
        const stillDetected = discovered.some((env) => env.envId === wire.runtimeId)
        session.runtimeBindings.set(language, {
          language,
          runtimeId: wire.runtimeId,
          source: wire.source,
          provenance: wire.provenance,
          interpreterPath: wire.interpreterPath,
          label: wire.label,
          version: wire.version,
          status: 'unavailable',
          reason: stillDetected ? 'disabled' : 'missing'
        })
      }
    }
  }

  // Clears the state of ONE (language, env) runtime after its kernel was torn down on switch: drops its
  // live status, terminated flag, and execution-queue tail so the rebound runtime starts clean. Only
  // the given env's process key is affected; the other language and other envs are untouched.
  private tearDownLanguageBinding(
    session: RuntimeSession,
    language: NotebookLanguage,
    env: string
  ): void {
    const processKey = dataProcessKey(language, env)
    session.kernelStatuses.delete(processKey)
    session.terminatedKernels.delete(processKey)
    session.executionQueues.delete(processKey)
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

  // Wires the per-language enablement lookup after construction (settings service), mirroring the
  // resolvers above. Absent -> the provenance defaults, so a BYO env is never enabled until this is
  // wired AND the user turns it on — the enable gate holds by default.
  setRuntimeEnablementResolver(
    resolver: (language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>
  ): void {
    this.runtimeEnablementResolver = resolver
  }

  // Wires the manual-interpreter catalog lookup after construction, so the service's discovery folds in
  // Settings-added interpreters (same set the Settings survey sees). Absent -> only PATH/conda/app envs.
  setManualInterpretersResolver(resolver: (language: NotebookLanguage) => Promise<string[]>): void {
    this.manualInterpretersResolver = resolver
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
    const processKey = dataProcessKey(cell.language, this.resolveRunEnv(session, cell.language))
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
    // Resolve the env at the run boundary from the SESSION BINDING (not a per-call argument): the run
    // uses this env's process/queue/lock and it is recorded on the run so history/replay and the UI
    // know which env produced it (D1/D6).
    const env = this.resolveRunEnv(session, cell.language)
    const processKey = dataProcessKey(cell.language, env)

    // Resolve which interpreter backs this run. v4 unified model: the session BINDING decides. A
    // MANAGED binding (app-managed default OR an agent-created named env) runs via the executor's
    // managed-prefix lookup for `env` (resolved above from the binding). An EXTERNAL binding runs the
    // user's own interpreter directly. No binding -> the app-managed default. There is no implicit
    // external default and no per-call env override anymore.
    let resolvedInterpreter: ResolvedInterpreter | undefined
    // Deferred so a first-use overlay-build failure (bad base interpreter, ensurepip failure, an
    // interpreter moved after selection) is normalized into a FAILED run record with a traceback below,
    // exactly like an executor spawn/crash — rather than throwing raw out of the run path and leaving no
    // run history for the agent to inspect.
    let interpreterResolveError: unknown
    const binding = session.runtimeBindings.get(cell.language)
    if (binding && (binding.status ?? 'active') !== 'active') {
      // No silent fallback: a disabled/unavailable bound runtime FAILS the run with an actionable
      // message rather than quietly running a different interpreter (the user would wrongly assume
      // their vars/packages/interpreter are unchanged). The agent recovers via list → switch. See
      // [[notebook-runtime-disable-binding-lifecycle]] / [[notebook-runtime-crash-recovery]].
      interpreterResolveError = new Error(
        `RUNTIME_BINDING_UNAVAILABLE: the bound ${cell.language} runtime is ${binding.status}` +
          (binding.reason ? ` (${binding.reason})` : '') +
          '. Call list_notebook_runtimes then notebook_switch_runtime to choose another runtime ' +
          '(an unspecified choice falls back to the app-managed default). Any prior kernel memory ' +
          '(variables, imports) for this language was lost.'
      )
    } else if (binding?.resolvedInterpreter) {
      // An ENABLED external binding runs the user's own interpreter directly.
      resolvedInterpreter = binding.resolvedInterpreter
    } else {
      // No binding, or an app-managed MANAGED binding (default or an agent-created named env): build the
      // default env from the offline bundle on first use (R is lazy) before dispatching, so the agent
      // doesn't hit "still being prepared" and go create its own env. No-op for named envs and for an
      // already-materialized default.
      try {
        // No silent fallback (same guarantee as the binding path above): if the app-managed default is
        // explicitly DISABLED, refuse rather than provision + run it. Otherwise disabling the last
        // runtime in Settings would leave "no available runtime" showing there while notebook_execute
        // still ran the disabled default.
        //
        // But ONLY gate on the default's enablement when this run actually targets the default env. A
        // managed binding to an agent-created NAMED env (my-analysis) also lands here (no
        // resolvedInterpreter), and its `env` is that named env — disabling `default-python` must not
        // block it. The named env has its own enablement, checked where it is disabled/revoked (the
        // status branch above), so here we guard the default only.
        const isDefaultEnvRun = env === this.defaultEnvNameFor(cell.language)
        if (
          isDefaultEnvRun &&
          (await this.isDefaultEnvDisabled(cell.language, session.runtimeRoot))
        ) {
          throw new Error(
            `No enabled ${cell.language} runtime: the app-managed default is disabled and no runtime ` +
              'is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
              'list_notebook_runtimes then notebook_bind_runtime, before running cells.'
          )
        }
        await this.ensureDefaultEnvReady(cell.language, env, session.runtimeRoot, session.sessionId)
      } catch (error) {
        interpreterResolveError = error
      }
    }

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
        this.envLock.withRun(env, () => {
          // A failed interpreter resolve (external overlay build) never reached a live kernel; surface
          // it through the same normalization the executor uses so it becomes a failed run, not a throw.
          if (interpreterResolveError !== undefined) {
            executedOnLiveKernel = false
            return Promise.resolve(errorToExecutionResult(interpreterResolveError, cwdBefore))
          }
          return session.executor
            .execute({
              code: cell.code,
              cwd: cwdBefore,
              language: cell.language,
              // v4: the env comes from the session binding (resolveRunEnv), not a per-call argument.
              environment: env,
              notebookSessionRoot: session.notebookSessionRoot,
              dataRoot: session.dataRoot,
              runtimeRoot: session.runtimeRoot,
              protectedDirs: [getAppClaudeConfigDir(this.options.configRoot)],
              timeoutMs: request.timeoutMs,
              resolvedInterpreter
            })
            .catch((error: unknown) => {
              executedOnLiveKernel = false
              // A force-stop (disable "stop running work") kills the kernel mid-run: record the run as
              // 'cancelled' (a user action), not 'failed' (an error). Consume the one-shot flag.
              if (session.forceStoppedKeys.delete(processKey)) {
                return cancelledExecutionResult(cwdBefore)
              }
              return errorToExecutionResult(error, cwdBefore)
            })
        }),
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
  async state(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
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
      environments: this.buildEnvironmentStatuses(session),
      // v4 session runtime bindings (notebook_state surfaces the current python/r bindings).
      runtimeBindings: this.buildRuntimeBindings(session)
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
    // Let startup recovery finish before installing, so recovery's repair-flagging / prefix cleanup
    // can't race this install writing into the same env.
    await this.ensureRecovered()
    const configured = await this.resolvePackageMirror()
    const mirror = await effectiveMirrorAsync(
      configured,
      this.options.locale ?? DEFAULT_LOCALE,
      this.options.mirrorProbe
    )

    // Install target env comes from the SESSION BINDING (v4: no per-call environment argument). A
    // managed binding installs into its conda env by name; an external binding pips into the user's own
    // interpreter; no session context -> the language default env.
    //
    // ensureSession() (not a bare sessions.get) so the FIRST manage_packages after an app restart loads
    // the session and REHYDRATES its persisted runtime bindings before we read them — otherwise the
    // session isn't in memory yet, the binding reads as undefined, and the install silently targets the
    // default env (bypassing a bound named/external/unavailable runtime and its install-authorization,
    // while pinnedRequest below would then guarantee the wrong target). Mirrors execute(), which already
    // ensureSession()s. The MCP bridge and local RPC always carry workspaceCwd, so this is the real path.
    let bindingSession: RuntimeSession | undefined
    if (request.sessionId) {
      if (request.workspaceCwd) {
        bindingSession = await this.ensureSession({
          sessionId: request.sessionId,
          workspaceCwd: request.workspaceCwd,
          projectName: request.projectName
        })
      } else {
        // A sessionId was given but there's no workspaceCwd to LOAD the session, and it isn't already in
        // memory. A persisted binding may exist that we can't see, so installing would silently bypass
        // it and target the default env. Refuse rather than fall back — no silent default. (Real callers
        // always send workspaceCwd; this only guards a malformed/legacy request that names a session.)
        bindingSession = this.sessions.get(request.sessionId)
        if (!bindingSession) {
          return {
            ok: false,
            needsRestart: false,
            log: '',
            error:
              'RUNTIME_SESSION_UNAVAILABLE: cannot resolve this session to honor its runtime binding ' +
              '(no workspaceCwd to load it). Retry with the notebook session context so any bound ' +
              'runtime is applied instead of silently installing into the default environment.'
          }
        }
      }
    }
    // No sessionId at all -> a caller with no session context -> the language default env (unchanged).
    const binding = bindingSession
      ? bindingSession.runtimeBindings.get(request.language)
      : undefined
    const envName = bindingSession
      ? this.resolveRunEnv(bindingSession, request.language)
      : resolveEnvName(request.language, undefined)
    const runtimeRoot = getRuntimeRoot(this.options.dataRoot)

    // Gate the install on that binding. An EXTERNAL binding is read-only unless the user turned on
    // "Allow package install" for THAT runtime in Settings (per-env installAuthorized) — then pip
    // installs into the user's OWN interpreter (installs land in the user's env, not app storage), and
    // external uninstall stays disabled. A managed binding / no session -> micromamba into the app
    // prefix. This replaces the removed pre-v4 RuntimeSelection gate.
    let interpreter: { command: string; args?: string[] } | undefined
    if (binding?.source === 'external') {
      // repair-required is installable: re-running the install to completion is exactly how the user
      // clears it. Only a genuinely disabled/missing binding refuses the install.
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            `RUNTIME_BINDING_UNAVAILABLE: the bound ${request.language} runtime is ${binding.status}` +
            (binding.reason ? ` (${binding.reason})` : '') +
            '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
            'installing packages.'
        }
      }
      if (request.operation === 'uninstall') {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            'Uninstalling packages from your own environment is disabled. Manage it yourself, or ' +
            'switch to the managed environment.'
        }
      }
      const enablement = await this.resolveRuntimeEnablement(request.language)
      const authorized = enablement?.installAuthorized[binding.runtimeId] ?? false
      if (!authorized) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            `Installing packages into your own ${request.language} environment is not authorized. ` +
            'Turn on "Allow package install" for this runtime in Settings → Runtimes first (installs ' +
            'go into your own environment, not the app-managed storage).'
        }
      }
      if (request.language !== 'python') {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            'Package management for an external R runtime is not supported yet. Use the managed R ' +
            'environment, or install the package yourself.'
        }
      }
      // Install directly into the user's own interpreter (pip). No app-owned overlay: the user
      // explicitly authorized installing into their own environment.
      interpreter = binding.resolvedInterpreter
    } else if (binding) {
      // A MANAGED binding (app-managed default or an agent-created named env). Same no-silent-fallback
      // guarantee as execute() and the external path: a disabled/unavailable managed binding refuses the
      // install rather than quietly installing into a different env. repair-required stays installable —
      // completing the install is how the user clears it. Without this, disabling a managed runtime
      // blocked execution but still let manage_packages install into it (the gate was external-only).
      const blocked =
        (binding.status ?? 'active') !== 'active' && binding.reason !== 'repair-required'
      if (blocked) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            `RUNTIME_BINDING_UNAVAILABLE: the bound ${request.language} runtime is ${binding.status}` +
            (binding.reason ? ` (${binding.reason})` : '') +
            '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
            'installing packages.'
        }
      }
    } else if (envName === this.defaultEnvNameFor(request.language)) {
      // No binding and the target is the app-managed default: refuse if that default is disabled, so
      // manage_packages can't provision + install into a runtime the user turned off in Settings
      // (mirrors execute()'s disabled-default gate). A managed named env is never reached here (it always
      // has a binding), so this only guards the default.
      if (await this.isDefaultEnvDisabled(request.language, runtimeRoot)) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            `No enabled ${request.language} runtime: the app-managed default is disabled and no ` +
            'runtime is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
            'list_notebook_runtimes then notebook_bind_runtime, before installing packages.'
        }
      }
    }

    // Refuse if recovery left the install target prefix blocked (an unknown-liveness orphan may still be
    // writing it) — installing into a possibly-live env could corrupt it. Checked for every binding
    // kind, since even an external install journals this prefix as its target. Returned as a structured
    // error (not thrown) to match managePackages' other refusals — a tool call shouldn't surface a raw
    // exception.
    if (this.blockedPrefixes.has(envPrefix(runtimeRoot, envName))) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `RUNTIME_RECOVERY_BLOCKED: the ${request.language} environment is recovering from an ` +
          'interrupted operation whose process could not be confirmed stopped. Restart the app to ' +
          're-check and recover it before installing packages.'
      }
    }

    // Journal the install so a process death mid-install (killed conda/pip, half-applied packages) is
    // reconciled at next startup by flagging this runtime repair-required — an interrupted install is
    // never silently assumed to have succeeded. runtimeId is the bound runtime's identity (its envId)
    // so recovery flags exactly this env. Best-effort journal I/O; cleared in the finally on completion.
    const repairRuntimeId = binding?.runtimeId ?? envName
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const operationId = randomUUID()
    await journal
      .begin({
        operationId,
        kind: 'install',
        runtimeId: repairRuntimeId,
        phase: `install-${request.language}`,
        startedAt: Date.now(),
        targetPath: envPrefix(runtimeRoot, envName)
      })
      .catch(() => undefined)
    // The install target is the binding-resolved envName — NOT request.environment. v4 dropped the
    // per-call environment argument, but the package manager still reads req.environment (and the local
    // RPC forwards the raw request), so an old/direct caller could otherwise install into a DIFFERENT
    // env than the one whose lock, journal target, and repair flag we resolved above. Pin it here so all
    // four agree.
    const pinnedRequest = { ...request, environment: envName }
    let result: InstallResult
    try {
      result = await this.envLock.withInstall(envName, () =>
        this.installPackagesImpl(pinnedRequest, {
          storageRoot: this.options.dataRoot,
          condaChannel: mirror.condaChannel,
          pypiIndex: mirror.pypiIndex,
          cranMirror: mirror.cranMirror,
          caBundle: mirror.caBundle,
          interpreter,
          // Record each installer child's PID so startup recovery can kill a surviving conda/pip/R
          // install before flagging the env repair-required.
          onChild: (childPid) =>
            void journal
              .update(operationId, { childPid, childStartedAt: Date.now() })
              .catch(() => undefined)
        })
      )
    } finally {
      await journal.complete(operationId).catch(() => undefined)
    }
    // A completed install of this runtime clears any prior repair-required flag: re-running the install
    // to completion IS the repair, so the runtime returns to a known-good state. Clearing the disk flag
    // alone isn't enough — bindings that were resolved while repair-required (in THIS and OTHER sessions)
    // are still held in memory as unavailable/repair-required and would keep refusing execution until a
    // rebind/reload. Restore every matching binding to active and refresh its UI so the repaired runtime
    // is usable immediately, everywhere.
    if (result.ok) {
      clearRepairRequired(runtimeRoot, repairRuntimeId)
      this.restoreRepairedBindings(repairRuntimeId)
    }

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
        // Let startup recovery finish before creating a prefix: its cleanup/verify must not race a
        // fresh create writing into <root>/envs (same barrier materialize/install use).
        await this.ensureRecovered()
        // Refuse if recovery left this env's prefix blocked (an unknown-liveness orphan may still hold
        // it) — creating over a possibly-live prefix could corrupt it.
        this.assertPrefixRecoverable(envPrefix(getRuntimeRoot(this.options.dataRoot), name))
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
        // Remove-guard: only agent-created envs are removable. assertSafeEnvName already rejects the
        // bare defaults, but a versioned app-managed env (default-python-3.13) would slip past it, so
        // classify by provenance here and refuse anything that is not agent-created.
        if (namedEnvProvenance(name) !== 'agent-created') {
          throw new Error(
            `Environment "${name}" is app-managed and cannot be removed. Only environments you ` +
              'created with manage_environments(action:"create") can be removed.'
          )
        }
        if (this.isEnvironmentLive(name)) {
          throw new Error(
            `Environment "${name}" is in use by a running kernel — restart the notebook or ` +
              'wait for the run to finish before removing it.'
          )
        }
        // Let startup recovery finish before rm -rf'ing a prefix, same barrier create uses: recovery's
        // verify/rebuild of an interrupted op could otherwise race this delete on the same prefix.
        await this.ensureRecovered()
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

  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight. Run
  // ONCE at app startup, before new fetches/installs. For each journalled op: kill a surviving orphan
  // child, then clean its staging / verify its prefix / flag it repair-required, then clear the entry.
  // Best-effort — a failure is logged and the entry retried next startup. The download (staging
  // cleanup), materialize (verify/rebuild the env prefix), and install (flag repair-required) paths all
  // populate the journal, so each reconcile action below is wired to a real effect.
  async recoverInterruptedOperations(): Promise<void> {
    // Publish the in-flight recovery so new prefix-touching operations (materialize/install) can await
    // it — otherwise an old op's cleanup/delete could race a fresh fetch/install on the same prefix.
    const run = this.runRecovery()
    this.recoveryComplete = run.then(
      () => undefined,
      () => undefined
    )
    await run
  }

  // Awaited by materialize/install before they touch a prefix, so startup recovery has finished
  // reconciling (cleaning staging, verifying prefixes, flagging repair) before new work begins. A no-op
  // once recovery has settled, and when recovery was never kicked off (e.g. tests). Public so the
  // startup env gate and UI provision/repair handlers can share the SAME barrier (they touch prefixes
  // too, not just materialize/install).
  async ensureRecovered(): Promise<void> {
    if (this.recoveryComplete) await this.recoveryComplete
  }

  // Throws if `prefix` is one recovery couldn't confirm free of a live orphan (see blockedPrefixes).
  // Called by every path that would WRITE an env prefix, so an unknown-liveness orphan actually blocks
  // the write this session instead of only leaving a journal entry for next boot.
  private assertPrefixRecoverable(prefix: string): void {
    if (this.blockedPrefixes.has(prefix)) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: a previous operation on "${prefix}" was interrupted and its worker ` +
          'process could not be confirmed stopped, so writing this environment now could corrupt it. ' +
          'Restart the app to re-check and recover it, then try again.'
      )
    }
  }

  // Whether the app-managed default env for a language is currently recovery-blocked (see above). Public
  // so the env-IPC UI provision/repair handlers — which build the default env via the provisioner, not
  // through this service — can refuse before touching that prefix.
  isDefaultEnvRecoveryBlocked(language: NotebookLanguage): boolean {
    const prefix = envPrefix(
      getRuntimeRoot(this.options.dataRoot),
      language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
    )
    return this.blockedPrefixes.has(prefix)
  }

  private async runRecovery(): Promise<void> {
    const journal = RuntimeOperationJournal.forPath(
      operationJournalPath(getRuntimeRoot(this.options.dataRoot))
    )
    await reconcileInterruptedOperations(journal, {
      operationChildLiveness: defaultOperationChildLiveness,
      terminateOperationChild: async (record) => {
        if (record.childPid === undefined) return
        try {
          process.kill(record.childPid, 'SIGKILL')
        } catch {
          // Already gone — nothing to kill.
        }
      },
      cleanStaging: async (record) => {
        if (record.targetPath) await rm(record.targetPath, { recursive: true, force: true })
      },
      // materialize/upgrade: an interrupted create can leave the env prefix without conda-meta (a
      // half-built dir micromamba would later refuse). Remove such an incomplete prefix so the next
      // lazy materialize rebuilds it cleanly; a complete conda env (has conda-meta) is left intact.
      verifyOrRebuildEnv: async (record) => {
        if (!record.targetPath) return
        if (!existsSync(record.targetPath)) return
        if (existsSync(join(record.targetPath, 'conda-meta'))) return
        await rm(record.targetPath, { recursive: true, force: true })
      },
      // install: an interrupted package install may be half-applied — flag the runtime repair-required
      // so a bound session refuses it (no silent success). The flag is cleared when a fresh install of
      // that runtime completes (managePackages), which is how the user repairs it.
      markRepairRequired: async (record) => {
        if (record.runtimeId)
          addRepairRequired(getRuntimeRoot(this.options.dataRoot), record.runtimeId)
      },
      // liveness 'unknown' (couldn't confirm the child died — e.g. Windows with a recorded start time):
      // a possibly-live orphan may still be writing this operation's env prefix. Block that PREFIX for
      // the rest of this process's life so any write to it (default materialize, package install,
      // named-env create, UI provision/repair) refuses — rather than racing the survivor once the
      // recovery barrier opens. Keyed by targetPath (the prefix the op writes), which materialize/
      // upgrade/install all carry and which is exactly what the write paths check via
      // assertPrefixRecoverable — unlike a repair-required flag, whose env/interpreter-id key does not
      // match the materialize op's env-NAME runtimeId (so that flag never fired for the default env, and
      // install is deliberately allowed while repair-required anyway). The journal entry is retained, so
      // a later restart re-runs recovery and, once the pid is gone/verifiable, reconciles + unblocks.
      //
      // A 'download' op needs no block: each fetch stages into its own unique mkdtemp('.incoming-') dir
      // and commits by atomic rename, so an orphaned download can't corrupt a fresh fetch (a later
      // startup reaps the leftover). Its targetPath is that staging dir, which nothing else writes.
      blockUnknownChildTarget: async (record) => {
        if (record.targetPath) this.blockedPrefixes.add(record.targetPath)
      }
    })
  }

  // Shuts down every live interpreter, used by app-level cleanup paths. Returns { reaped }: true only
  // when every kernel tree was cleanly reaped, so the update-install gate can refuse to trigger the
  // NSIS uninstall while a kernel may still hold file handles under the install dir.
  async shutdownAll(): Promise<{ reaped: boolean }> {
    // Let any in-flight disable drain-and-close settle first, so a revocation teardown never races the
    // shutdown (and tests don't leak a dangling background drain).
    await Promise.all(Array.from(this.revocationDrains)).catch(() => undefined)
    const results = await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.executor.shutdown())
    )
    this.sessions.clear()
    return { reaped: results.every((result) => result.reaped) }
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

    let document = await this.repository.loadOrCreate({
      projectName,
      sessionId: request.sessionId,
      workspaceCwd: request.workspaceCwd
    })
    // Crash recovery (WS12): the FIRST time this process loads a session, any run still marked
    // 'running'/'queued' was in flight when a previous process died — its kernel is gone. Reconcile it
    // to 'interrupted' so history is truthful and the UI/agent see it ended. Only reconcile when such a
    // stale run exists (avoids rewriting a clean doc), and only here at session creation (never in
    // state()/loadOrCreate), so a run that is genuinely live in THIS process is never mislabeled.
    if (document.runs.some((run) => run.status === 'running' || run.status === 'queued')) {
      document = await this.repository.reconcileInterruptedRuns(projectName, request.sessionId)
    }
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
      kernelStatuses: new Map(),
      runtimeBindings: new Map(),
      forceStoppedKeys: new Set()
    }

    this.sessions.set(request.sessionId, session)

    // Rehydrate + revalidate any persisted runtime bindings (WS1-rest/WS12): a still-usable binding is
    // restored active; one whose runtime is now disabled/missing is kept as unavailable (no silent
    // fallback). Only touches discovery when bindings were actually persisted.
    await this.reloadPersistedBindings(session, document.runtimeBindings)

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

  // After a repair install clears the repair-required flag, bring every in-memory binding for that
  // runtime (across ALL sessions) back to active — they were held unavailable/repair-required from when
  // they were resolved, and clearing only the disk flag would leave them refusing execution until a
  // rebind. Persisted state needs no rewrite: it stores the binding without the transient repair status
  // (that status is recomputed from the disk flag on reload, which is now cleared). Notifies each
  // touched session's UI so the runtime shows usable again immediately.
  private restoreRepairedBindings(runtimeId: string): void {
    for (const session of this.sessions.values()) {
      let changed = false
      for (const [language, binding] of session.runtimeBindings) {
        if (binding.runtimeId === runtimeId && binding.reason === 'repair-required') {
          session.runtimeBindings.set(language, {
            ...binding,
            status: 'active',
            reason: undefined
          })
          changed = true
        }
      }
      if (changed) this.notifyNotebookChanged(session)
    }
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
