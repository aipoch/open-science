import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  NotebookCell,
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  FinishNotebookCodeCellRequest,
  NotebookEnvironmentStatus,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookRunSource,
  NotebookRunSummary,
  NotebookSessionRequest,
  NotebookSessionReference,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type {
  EnvironmentInfo,
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult,
  ProvisionProgress
} from '../../shared/notebook-env'
import type { PackageMirror } from '../../shared/mirror'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import { NotebookExportReader } from './export-reader'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import { saveIpynbAll } from './save-ipynb-all'
import type { KernelProcessKind } from './kernel-executor'
import { effectiveMirrorAsync, type ProbeDeps } from './mirror-probe'
import {
  installPackages as installPackagesDefault,
  type InstallDeps,
  type InstallRequest,
  type InstallResult
} from './package-manager'
import { NotebookPackageAdmissionOwner } from './package-admission'
import { NotebookPackageMutationOwner } from './package-mutation'
import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import {
  assertSafeEnvName,
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  pythonReady,
  rBin,
  rScriptBin,
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
import type { NotebookRuntimeSettings } from '../settings/capabilities'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { NotebookRuntimeRepairOwner } from './runtime-repair'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import { NotebookEnvironmentOperations, type DefaultEnvProvisioner } from './environment-operations'
import {
  NotebookSessionAggregate,
  type NotebookSessionExecutorGeneration,
  type NotebookSessionOwnedExecutor,
  type NotebookSessionExecutionRequest,
  type NotebookSessionExecutionResult,
  type NotebookSessionExecutor,
  type NotebookSessionMcpRpcConnection,
  type NotebookSessionResolvedInterpreter,
  type NotebookSessionRuntimeBinding
} from './session-aggregate'
import { NotebookSessionRegistry } from './session-registry'
import { createLogger, getLogFilePath } from '../logger'
import {
  EnvironmentStateTracker,
  type EnvironmentCaptureTarget,
  type PackageInspectionResult
} from './environment-state-tracker'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import type { RuntimeDiagnosticLogger } from './runtime-diagnostics'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import type { NotebookShellProcess, NotebookShellResult } from './shell-process'
import {
  NotebookExecutionOwner,
  type NotebookControlCompletionInterceptor,
  type NotebookControlResult
} from './execution-owner'

// Locale fallback when no explicit locale is injected (see shared/mirror.ts: non-CN locales resolve
// to public hosts, so this default never silently forces a CN mirror).
const DEFAULT_LOCALE = 'en-US'

const EMPTY_NOTEBOOK_RUNTIME_SETTINGS: Pick<NotebookRuntimeSettings, 'getSnapshot'> = {
  getSnapshot: async (language) => ({
    language,
    runtimeEnablement: { enabled: {}, installAuthorized: {} },
    manualInterpreters: [],
    packageMirror: {}
  })
}

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

type ResolvedInterpreter = NotebookSessionResolvedInterpreter
type NotebookExecutionRequest = NotebookSessionExecutionRequest
type NotebookExecutionResult = NotebookSessionExecutionResult

type InspectPackagesRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  packages: string[]
}

type InspectPackagesResult = PackageInspectionResult & {
  language: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  runtimeId?: string
  runtimeLabel?: string
}

type NotebookExecutor = NotebookSessionExecutor

type NotebookExecutorLifecycleCallbacks = {
  onIdleShutdown: (kind?: KernelProcessKind, env?: string) => Promise<void>
  onTerminated: (kind: KernelProcessKind, env?: string) => Promise<void>
}

type NotebookRuntimeServiceCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookSessionReference) => void
}

type NotebookHandoffContext = {
  activeRunId?: string
  activeWriteCellId?: string
  executionCount: number
  cells: Array<{
    id: string
    language: NotebookLanguage
    status: NotebookCell['status']
    executionCount?: number
    latestRunId?: string
  }>
  kernels: Array<{
    kind: NotebookLanguage | 'repl'
    status: NotebookKernelMetadata['lastKnownStatus']
  }>
  runtimes: Array<{
    language: NotebookLanguage
    label: string
    version?: string
    status?: NotebookRuntimeBinding['status']
    reason?: NotebookRuntimeBinding['reason']
  }>
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

// The session-scoped connector RPC capability injected into the persistent control-plane REPL. The
// service caches it for the RuntimeSession lifetime because the child captures it only when spawned;
// release revokes that capability when the runtime session is shut down.
type McpRpcConnection = NotebookSessionMcpRpcConnection
type McpRpcConnectionBinding = { sessionId: string; projectId: string }

type NotebookRuntimeServiceOptions = {
  // Config root: source of the app-owned claude config dir (protected from the kernel). Never relocated.
  configRoot: string
  // Data root: where notebook workspaces, data, and the runtime install live (user-relocatable).
  dataRoot: string
  projectName: string
  repository?: NotebookRunRepository
  executorFactory?: (
    sessionId: string,
    lifecycle: NotebookExecutorLifecycleCallbacks
  ) => NotebookExecutor
  callbacks?: NotebookRuntimeServiceCallbacks
  // Resolves the connector RPC connection to inject into the kernel spawn env. Usually set after
  // construction via setMcpRpcConnectionResolver, since the RPC server is constructed with this
  // service as a dependency (constructing them in the other order would cycle).
  getMcpRpcConnection?: (binding: McpRpcConnectionBinding) => Promise<McpRpcConnection>
  // Resolves the user-configured package mirror (settings). Optional/async so a synchronous test
  // double works just as well as the real disk-backed settings service.
  getPackageMirror?: () => PackageMirror | undefined | Promise<PackageMirror | undefined>
  // Stable, detached Settings capability used by runtime discovery and binding policy. Production
  // injects this named capability; isolated tests may omit it and receive a fail-safe empty policy.
  notebookRuntimeSettings?: Pick<NotebookRuntimeSettings, 'getSnapshot'>
  // Discovers the interpreters available for a language (app-managed + user-own). Injectable so tests
  // don't spawn real interpreters; production defaults to environment-discovery over the runtime root.
  discoverRuntimes?: (language: NotebookLanguage) => Promise<DiscoveredInterpreter[]>
  // Locale used to pick the default region mirror when nothing is configured (see shared/mirror.ts).
  // Defaults to a non-CN locale so an omitted value never silently forces a CN mirror.
  locale?: string
  // Platform seam for path-layout decisions. Production uses process.platform; tests can verify that
  // a Windows-shaped string alone never activates Windows conda behavior on another platform.
  platform?: NodeJS.Platform
  // Stateless shell child-process port. The production adapter owns platform invocation, encoding,
  // environment projection, and timeout teardown; tests inject a fake without crossing IPC/shared.
  shellProcess?: NotebookShellProcess
  // Latency-probe deps for the fastest-mirror auto-selection, injectable so tests stay hermetic (the
  // real probe does live HEAD requests). Undefined in production → effectiveMirrorAsync's real probe.
  mirrorProbe?: ProbeDeps
  // Package installer, injectable so tests never spawn real micromamba/pip/R. Defaults to
  // package-manager's installPackages.
  installPackagesImpl?: (
    request: InstallRequest,
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  // Structured main-process diagnostics for package operations and interpreter probes. Injectable so
  // tests assert logging without initializing the rotating file sink.
  logger?: RuntimeDiagnosticLogger
  // Provisioner-backed named-environment manager for manageEnvironments. Injectable so tests use a
  // fake; the production instance (the DefaultRuntimeProvisioner) is wired after construction in
  // main/ipc.ts via setEnvironmentManager, mirroring the mcp/mirror resolvers.
  environmentManager?: NotebookEnvironmentManager
  // Included in exported notebook provenance. Tests may omit it.
  appVersion?: string
  // Save-dialog seam for notebook export tests. Production falls back to Electron's native dialog.
  saveIpynb?: (suggestedName: string, data: string) => Promise<ExportNotebookResult>
  // Save-directory seam for the "Download all" path. Production falls back to a directory picker
  // dialog and writes one file per data kernel under the user's chosen directory.
  saveIpynbAll?: (
    files: Array<{ kernel: 'python' | 'r'; name: string; data: string }>
  ) => Promise<ExportNotebookAllResult>
  // Resolves app-managed artifact paths with the artifact repository's canonical/symlink checks,
  // bound to the artifact's declaring project/session subtree.
  resolveArtifactPath?: (request: {
    path: string
    projectName: string
    sessionId: string
  }) => Promise<string>
  environmentStateTracker?: Pick<
    EnvironmentStateTracker,
    | 'prepareRun'
    | 'captureCompletedRun'
    | 'inspectPackages'
    | 'markPackageMutationDirty'
    | 'refreshAfterPackageMutation'
  >
}

// The wire binding plus the interpreter override the executor needs. `resolvedInterpreter` is set only
// for an EXTERNAL binding (run the user's own interpreter directly); an app-managed binding leaves it
// undefined so the executor keeps its managed-prefix lookup and ensureDefaultEnvReady provisions the env.
type InternalRuntimeBinding = NotebookSessionRuntimeBinding
type RuntimeSession = NotebookSessionAggregate

const saveIpynbWithDialog = async (
  suggestedName: string,
  data: string
): Promise<ExportNotebookResult> => {
  const { app, dialog } = await import('electron')
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: join(app.getPath('downloads'), suggestedName),
    title: 'Export notebook',
    filters: [{ name: 'Jupyter Notebook', extensions: ['ipynb'] }]
  })

  if (canceled || !filePath) return { saved: false }
  await writeFile(filePath, data, 'utf8')
  return { saved: true, filePath }
}

// Writes one .ipynb per data kernel under a user-picked directory. Used by the "Download all" path;
// the per-tab path (a single .ipynb) goes through `saveIpynbWithDialog` instead. The actual
// orchestration (directory picker, conflict check, partial-write cleanup) lives in save-ipynb-all
// so tests can exercise the real path with a mocked electron instead of bypassing via the seam.

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

// Coordinates notebook cells, shared interpreters, persisted run history, and UI notifications.
class NotebookRuntimeService {
  private readonly repository: NotebookRunRepository
  private readonly exportReader: NotebookExportReader
  private readonly runTerminalization: NotebookRunTerminalizationOwner
  private readonly executionOwner: NotebookExecutionOwner
  private readonly dataExecutionAdmission: NotebookDataExecutionAdmissionOwner
  private readonly packageAdmission: NotebookPackageAdmissionOwner
  private readonly packageMutation: NotebookPackageMutationOwner
  private readonly repairPolicy: NotebookRuntimeRepairPolicy
  private readonly runtimeRepair: NotebookRuntimeRepairOwner
  private readonly sessions: NotebookSessionRegistry<RuntimeSession>
  private readonly announcedAgentSessionIds = new Set<string>()
  // Owns process-global operation admission, provisioning progress, restart recommendations,
  // revocation drains, repair blocks, and installer diagnostics. The service remains the compatibility
  // facade and chooses which execution/package path enters each environment operation.
  private readonly environmentOperations: NotebookEnvironmentOperations
  private mcpRpcConnectionResolver:
    ((binding: McpRpcConnectionBinding) => Promise<McpRpcConnection>) | undefined
  private readonly packageMirrorResolver:
    (() => PackageMirror | undefined | Promise<PackageMirror | undefined>) | undefined
  private readonly runtimeEnablementResolver:
    ((language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>) | undefined
  private readonly runtimeBindingOwner: NotebookRuntimeBindingOwner
  // Owns startup-recovery promises, journal reconciliation, fail-closed block decisions, Reset
  // allowlisting, and same-process live-unconfirmed tracking. The service retains its public recovery
  // facade so Electron, Web, CLI, and IPC adapters keep the same contract.
  private readonly recoveryCoordinator: NotebookRecoveryCoordinator
  private readonly runtimeLogger?: RuntimeDiagnosticLogger
  private readonly environmentStateTracker: Pick<
    EnvironmentStateTracker,
    | 'prepareRun'
    | 'captureCompletedRun'
    | 'inspectPackages'
    | 'markPackageMutationDirty'
    | 'refreshAfterPackageMutation'
  >
  private environmentManager: NotebookEnvironmentManager | undefined
  private disposalPromise: Promise<{ reaped: boolean }> | undefined

  constructor(private readonly options: NotebookRuntimeServiceOptions) {
    this.repository = options.repository ?? new NotebookRunRepository(options.dataRoot)
    this.exportReader = new NotebookExportReader({
      repository: this.repository,
      defaultProjectName: options.projectName,
      appVersion: options.appVersion,
      resolveArtifactPath: options.resolveArtifactPath
    })
    this.sessions = new NotebookSessionRegistry({
      beforeTeardown: async () => {
        await this.environmentOperations.waitForRevocationDrains().catch(() => undefined)
        await this.runtimeBindingOwner.waitForWrites()
      }
    })
    const runtimeRoot = getRuntimeRoot(options.dataRoot)
    this.repairPolicy = new NotebookRuntimeRepairPolicy(runtimeRoot)
    this.recoveryCoordinator = new NotebookRecoveryCoordinator(runtimeRoot, this.repairPolicy)
    this.mcpRpcConnectionResolver = options.getMcpRpcConnection
    this.packageMirrorResolver = options.getPackageMirror
    const runtimeSettings = options.notebookRuntimeSettings ?? EMPTY_NOTEBOOK_RUNTIME_SETTINGS
    this.runtimeEnablementResolver = async (language) =>
      (await runtimeSettings.getSnapshot(language)).runtimeEnablement
    this.runtimeBindingOwner = new NotebookRuntimeBindingOwner({
      dataRoot: options.dataRoot,
      repository: this.repository,
      runtimeSettings,
      repairPolicy: this.repairPolicy,
      discoverRuntimes: options.discoverRuntimes,
      platform: options.platform
    })
    this.runtimeLogger =
      options.logger ?? (getLogFilePath() ? createLogger('notebook:runtime') : undefined)
    this.environmentOperations = new NotebookEnvironmentOperations({
      recovery: this.recoveryCoordinator,
      bindings: this.runtimeBindingOwner,
      sessions: () => this.sessions.values(),
      notifyChanged: (session) => this.notifyNotebookChanged(session as RuntimeSession),
      logger: this.runtimeLogger
    })
    this.runtimeRepair = new NotebookRuntimeRepairOwner({
      runtimeRoot,
      policy: this.repairPolicy,
      bindings: this.runtimeBindingOwner,
      environmentOperations: this.environmentOperations,
      sessions: () => this.sessions.values(),
      findSession: (sessionId) => this.sessions.get(sessionId),
      notifyChanged: (session) => this.notifyNotebookChanged(session)
    })
    this.environmentStateTracker =
      options.environmentStateTracker ??
      new EnvironmentStateTracker({
        dataRoot: options.dataRoot,
        platform: options.platform,
        logger: this.runtimeLogger
      })
    this.packageAdmission = new NotebookPackageAdmissionOwner({
      runtimeRoot: getRuntimeRoot(options.dataRoot),
      loadSession: (request) => this.ensureSession(request),
      findSession: (sessionId) => this.sessions.get(sessionId),
      resolveRuntimeEnablement: (language) => this.resolveRuntimeEnablement(language),
      isDefaultEnvironmentDisabled: (language, runtimeRoot) =>
        this.isDefaultEnvDisabled(language, runtimeRoot),
      repairPolicy: this.repairPolicy,
      environmentOperations: this.environmentOperations,
      recovery: this.recoveryCoordinator,
      createEnvironmentCaptureTarget: (...args) => this.environmentCaptureTarget(...args)
    })
    this.packageMutation = new NotebookPackageMutationOwner({
      storageRoot: options.dataRoot,
      runtimeRoot: getRuntimeRoot(options.dataRoot),
      environmentOperations: this.environmentOperations,
      environmentStateTracker: this.environmentStateTracker,
      installPackages: options.installPackagesImpl ?? installPackagesDefault,
      recheckRepair: (target) => this.packageAdmission.recheckRepair(target),
      runtimeRepair: this.runtimeRepair,
      blockUnconfirmedChild: ({ repairRuntimeId, journalTarget }) => {
        this.recoveryCoordinator.markRuntimeLiveUnconfirmed(repairRuntimeId)
        if (journalTarget) this.blockPrefixRecovery(journalTarget)
      }
    })
    this.dataExecutionAdmission = new NotebookDataExecutionAdmissionOwner({
      runtimeRoot: getRuntimeRoot(options.dataRoot),
      environmentOperations: this.environmentOperations,
      recovery: this.recoveryCoordinator,
      ensureRecovered: () => this.ensureRecovered(),
      resolveRuntimeEnablement: (language) => this.resolveRuntimeEnablement(language),
      repairPolicy: this.repairPolicy
    })
    this.environmentManager = options.environmentManager
    this.runTerminalization = new NotebookRunTerminalizationOwner({
      repository: this.repository,
      notifyChanged: (session) => this.notifyNotebookChanged(session as RuntimeSession)
    })
    this.executionOwner = new NotebookExecutionOwner({
      configRoot: options.configRoot,
      repository: this.repository,
      runTerminalization: this.runTerminalization,
      dataExecutionAdmission: this.dataExecutionAdmission,
      environmentStateTracker: this.environmentStateTracker,
      createEnvironmentCaptureTarget: (...args) => this.environmentCaptureTarget(...args),
      persistKernelStatus: (session, status, processKey) =>
        this.persistKernelStatus(session, status, processKey),
      getMcpRpcConnectionResolver: () => this.mcpRpcConnectionResolver,
      notifyAvailable: (session, source) => this.notifyNotebookAvailable(session, source),
      platform: options.platform,
      shellProcess: options.shellProcess
    })
  }

  private async resolveRuntimeEnablement(
    language: NotebookLanguage
  ): Promise<RuntimeEnablement | undefined> {
    const resolver = this.runtimeEnablementResolver
    if (!resolver) return undefined
    try {
      return await resolver(language)
    } catch {
      return undefined
    }
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
    this.environmentOperations.setDefaultEnvProvisioner(provisioner, onProgress)
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

  // The DEFAULT env name / process key for a language, matching resolveEnvName / dataProcessKey.
  private defaultEnvNameFor(language: NotebookLanguage): string {
    return language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  }

  // The conda env NAME a run uses for a language, derived from the SESSION BINDING (v4: the binding,
  // not a per-call argument, picks the env). A managed binding runs in its conda env (default-python or
  // an agent-created named env); an external binding or no binding runs under the language's DEFAULT
  // env name (an external binding overrides the interpreter but is tracked on the default env key).
  private resolveRunEnv(session: RuntimeSession, language: NotebookLanguage): string {
    const binding = session.runtimeBinding(language)
    if (binding?.source === 'managed' && binding.envName) return binding.envName
    return this.defaultEnvNameFor(language)
  }

  private environmentCaptureTarget(
    language: NotebookLanguage,
    environmentName: string,
    binding: InternalRuntimeBinding | undefined,
    resolvedInterpreter: ResolvedInterpreter | undefined,
    runtimeRootDir: string
  ): EnvironmentCaptureTarget {
    const prefix = envPrefix(runtimeRootDir, environmentName)
    return {
      language,
      environmentName,
      runtimeSource: binding?.source === 'external' ? 'external' : 'managed',
      command:
        resolvedInterpreter?.command ?? (language === 'r' ? rScriptBin(prefix) : pythonBin(prefix)),
      args: resolvedInterpreter?.args,
      ...(language === 'r' && (resolvedInterpreter?.condaPrefix || binding?.source !== 'external')
        ? { condaPrefix: resolvedInterpreter?.condaPrefix ?? prefix }
        : {})
    }
  }

  // list_notebook_runtimes: the enabled runtimes for both languages, each flagged with whether it is
  // this session's current binding. Never returns a disabled runtime.
  async listRuntimes(request: NotebookSessionRequest): Promise<{
    runtimes: NotebookRuntimeListing[]
    bindings: NotebookRuntimeBindings
  }> {
    const session = await this.ensureSession(request)
    return this.runtimeBindingOwner.list(session)
  }

  // notebook_bind_runtime: the FIRST binding of a language for the session. Refuses a disabled/unknown
  // runtime; refuses re-binding a different runtime (use notebook_switch_runtime to change).
  async bindRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    return this.runtimeBindingOwner.runWrite(request.sessionId, async () => {
      const session = await this.ensureSession(request)
      return this.runtimeBindingOwner.bind(session, request.language, request.runtimeId)
    })
  }

  // notebook_switch_runtime: an EXPLICIT switch — tear down the old kernel + clear that language's
  // state, then rebind. Refuses a disabled/unknown runtime (same MAIN-process gate as bind).
  async switchRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<{ bound: NotebookRuntimeBinding; bindings: NotebookRuntimeBindings }> {
    return this.runtimeBindingOwner.runWrite(request.sessionId, async () => {
      const session = await this.ensureSession(request)
      const result = await this.runtimeBindingOwner.switch(
        session,
        request.language,
        request.runtimeId,
        async () => {
          // PHYSICALLY tear down the CURRENT runtime's kernel for this language BEFORE rebinding, so the
          // new runtime starts fresh and two same-language interpreters never coexist.
          const oldEnv = this.resolveRunEnv(session, request.language)
          const kind = request.language === 'r' ? 'r' : 'python'
          await session.terminateExecutor(kind, oldEnv)
          this.tearDownLanguageBinding(session, request.language, oldEnv)
        }
      )
      this.notifyNotebookChanged(session)
      return result
    })
  }

  // WS11: how many live sessions are bound to a runtime, split by kernel state, so Settings can warn
  // before disabling it. Counts only sessions whose binding for this language IS this runtime; a
  // running cell → running, a live-but-idle kernel → idle, a bound session with no live kernel →
  // dormant (nothing to drain). Purely in-memory (no disk read).
  describeRuntimeUsage(language: NotebookLanguage, runtimeId: string): RuntimeUsage {
    return this.environmentOperations.describeRuntimeUsage(language, runtimeId)
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
    await this.environmentOperations.revokeRuntime(language, runtimeId, options)
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
    session.clearProcessState(processKey)
  }

  // Wires the connector RPC connection lookup after construction (the local RPC server that provides
  // it is itself constructed with this service as a dependency, so it cannot be passed in up front).
  setMcpRpcConnectionResolver(
    resolver: (binding: McpRpcConnectionBinding) => Promise<McpRpcConnection>
  ): void {
    this.mcpRpcConnectionResolver = resolver
  }

  // Composes the app-owned completion gate into the actual repl_execute return path. The adapter is
  // injected because concrete provider cancellation/reconfiguration/continuation belongs to later
  // framework-specific work, while this service owns the provider-neutral timing boundary now.
  setControlCompletionInterceptor(
    interceptor: NotebookControlCompletionInterceptor | undefined
  ): void {
    this.executionOwner.setControlCompletionInterceptor(interceptor)
  }

  // Starts an exclusive agent/user write stream into a cell and locks notebook editing.
  async beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    status: NotebookCell['status']
  }> {
    const session = await this.ensureSession(request)
    const cellId = request.cellId ?? `cell-${randomUUID()}`
    const writeId = `write-${randomUUID()}`
    const source = request.source ?? 'agent'
    const cell = session.beginCellWrite({
      cellId,
      language: request.language ?? 'python',
      writeId,
      source,
      startedAt: Date.now()
    })

    this.notifyNotebookAvailable(session, source)
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
    const cell = session.appendCellCode(request.cellId, request.writeId, request.delta)
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
    const cell = session.finishCellWrite(request.cellId, request.writeId)
    this.notifyNotebookChanged(session)

    return { sessionId: session.sessionId, cellId: cell.id, code: cell.code, status: cell.status }
  }

  // Compatibility facade: Session lookup and public summary projection stay here; lifecycle is owned.
  async runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary> {
    const session = await this.ensureSession(request)
    const run = await this.executionOwner.executeDataCell(session, request)
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

  // Compatibility facade for the control-plane REPL. Admission, capability lifetime, dispatch,
  // terminalization, and completion interception belong to NotebookExecutionOwner.
  async executeControl(request: ExecuteNotebookControlRequest): Promise<NotebookControlResult> {
    const session = await this.ensureSession(request)
    return this.executionOwner.executeControl(session, request)
  }

  // Compatibility facade for stateless shell execution. The owner deliberately admits calls without
  // a per-Session queue while the repository continues to serialize durable run writes.
  async executeShell(request: ExecuteShellRequest): Promise<NotebookShellResult> {
    const session = await this.ensureSession(request)
    return this.executionOwner.executeShell(session, request)
  }

  // Read-only handoff projection for a fresh Agent context. A missing aggregate means Notebook was
  // never used (or was intentionally shut down for a Branch change), so this must not call
  // ensureSession(), load run.json, discover runtimes, or create an executor.
  peekHandoffContext(sessionId: string): NotebookHandoffContext | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined

    const snapshot = session.snapshot()
    const kernels: NotebookHandoffContext['kernels'] = snapshot.kernelStatuses
      .filter(([, status]) => status !== 'terminated')
      .slice(-6)
      .map(([processKey, status]) => ({
        kind: processKey === 'repl' ? 'repl' : processKey.startsWith('r:') ? 'r' : 'python',
        status
      }))
    const runtimes = session
      .runtimeBindingEntries()
      .slice(-4)
      .map(([language, binding]) => ({
        language,
        label: binding.label,
        ...(binding.version ? { version: binding.version } : {}),
        ...(binding.status ? { status: binding.status } : {}),
        ...(binding.reason ? { reason: binding.reason } : {})
      }))
    const cells = snapshot.cells.slice(-6).map((cell) => ({
      id: cell.id,
      language: cell.language,
      status: cell.status,
      ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
      ...(cell.latestRunId ? { latestRunId: cell.latestRunId } : {})
    }))

    if (
      snapshot.executionCount === 0 &&
      !snapshot.activeRunId &&
      !snapshot.activeWrite &&
      cells.length === 0 &&
      kernels.length === 0 &&
      runtimes.length === 0
    ) {
      return undefined
    }

    return {
      executionCount: snapshot.executionCount,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      ...(snapshot.activeWrite ? { activeWriteCellId: snapshot.activeWrite.cellId } : {}),
      cells,
      kernels,
      runtimes
    }
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
    const snapshot = session.snapshot()

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
      cells: snapshot.cells.map((cell) => ({ ...cell })),
      activeWrite: snapshot.activeWrite ? { ...snapshot.activeWrite } : undefined,
      activeRunId: snapshot.activeRunId,
      // run.json retains managed storage keys for later Artifact evidence, but no renderer/agent
      // state response may expose them.
      runs: document.runs.map((run) => this.toPublicRunRecord(run)),
      recentRuns: document.runs.slice(-20).map((run) => this.toPublicRunRecord(run)),
      environments: this.buildEnvironmentStatuses(session),
      // v4 session runtime bindings (notebook_state surfaces the current python/r bindings).
      runtimeBindings: this.runtimeBindingOwner.snapshot(session)
    }
  }

  // Projects the session's live per-process-key status map into the wire shape state()'s consumers
  // (the multi-env preview / T8) read: one entry per (kind, env) the session has spawned. The coarse
  // top-level kernelStatus stays the DEFAULT env's status for backward compat; this is the per-env view.
  private buildEnvironmentStatuses(session: RuntimeSession): NotebookEnvironmentStatus[] {
    return session.kernelStatusEntries().map(([processKey, status]) => {
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
        restartRecommended: this.environmentOperations.isRestartRecommended(processKey)
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

  // Exports the .ipynb for the kernel the caller is currently viewing (tab = choose language).
  // Replaces the legacy "always use the dominant kernel" rule: a user on the R tab expects the
  // file to come back as `kernelspec.name='ir'`, and a user on the repl tab gets the .ipynb
  // scoped to whichever data kernel was most recently active when repl ran.
  async exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult> {
    const file = await this.exportReader.readKernel(request)
    return (this.options.saveIpynb ?? saveIpynbWithDialog)(file.name, file.data)
  }

  // The "Download all" path: writes one .ipynb per data kernel that has runs to a directory the
  // user picks. Triggered by the secondary footer button when the session actually spans multiple
  // data kernels — a single-kernel session's "Download all" would be a confusing duplicate of the
  // main button, so the renderer gates the secondary button on `kindsWithRuns.has('python') && has('r')`.
  async exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult> {
    const files = await this.exportReader.readAll(request)
    return (this.options.saveIpynbAll ?? saveIpynbAll)(files)
  }

  // Replaces the interpreter process while preserving cells and durable run history. Prefers the
  // executor's own in-place restart (keeps the same instance, e.g. NotebookKernelExecutor tears down
  // and lazily respawns its loops) and only shuts down + recreates for executors that don't support it.
  // Reports 'restarting' for the duration and settles back to 'idle' once the fresh process is ready.
  async restart(request: NotebookSessionRequest): Promise<NotebookSessionState> {
    const session = await this.ensureSession(request)

    // A restart respawns fresh loops, so any pending R-restart recommendation for this session's envs
    // is cleared. Snapshot the keys before teardown drops them from kernelStatuses.
    const envKeys = session.kernelProcessKeys()

    await this.repository.updateKernelStatus({
      projectName: session.projectName,
      sessionId: session.sessionId,
      status: 'restarting'
    })
    this.notifyNotebookChanged(session)

    try {
      await session.restartExecutor(() =>
        this.createExecutor(session.sessionId, session.projectName)
      )
      this.environmentOperations.clearRestartRecommendations(envKeys)
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

  // Reads installed package metadata from the app-managed runtime bound to this session. The shared
  // env slot prevents the inventory scan from overlapping a package mutation, while still allowing
  // ordinary notebook runs to proceed. External runtimes are rejected because inventory capture must
  // execute their interpreter; notebookExecute provides the explicit execution approval for that case.
  async inspectPackages(request: InspectPackagesRequest): Promise<InspectPackagesResult> {
    await this.ensureRecovered()
    const session = await this.ensureSession(request)
    const binding = session.runtimeBinding(request.language)
    const envName = this.resolveRunEnv(session, request.language)
    const runtimeRoot = getRuntimeRoot(this.options.dataRoot)
    const isExternal = binding?.source === 'external'
    if (isExternal) {
      throw new Error(
        'EXTERNAL_RUNTIME_INSPECTION_REQUIRES_EXECUTION: inspect_packages cannot run a bound ' +
          'external interpreter under package-metadata permission. Use notebook_execute in this ' +
          'runtime to query package metadata so interpreter execution receives notebook approval.'
      )
    }
    const prefixBlocked =
      !isExternal && this.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, envName))

    if (
      (binding?.runtimeId && this.recoveryCoordinator.isRuntimeIdBlocked(binding.runtimeId)) ||
      prefixBlocked ||
      (isExternal && this.recoveryCoordinator.isGloballyBlocked())
    ) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: the ${request.language} environment is recovering from an ` +
          'interrupted operation whose process could not be confirmed stopped. Restart the app to ' +
          're-check and recover it before inspecting packages.'
      )
    }
    if (binding && (binding.status ?? 'active') !== 'active') {
      throw new Error(
        `RUNTIME_BINDING_UNAVAILABLE: the bound ${request.language} runtime is ${binding.status}` +
          (binding.reason ? ` (${binding.reason})` : '') +
          '. Switch to another runtime (list_notebook_runtimes → notebook_switch_runtime) before ' +
          'inspecting packages.'
      )
    }
    if (!binding && (await this.isDefaultEnvDisabled(request.language, runtimeRoot))) {
      throw new Error(
        `No enabled ${request.language} runtime: the app-managed default is disabled and no runtime ` +
          'is bound. Enable a runtime in Settings → Runtimes, or bind one with ' +
          'list_notebook_runtimes then notebook_bind_runtime, before inspecting packages.'
      )
    }

    // Inspection is approved as a read-only action, so it must not materialize a missing default env
    // (which can download packages and write the runtime prefix). Refuse with an actionable boundary
    // instead of silently returning `unknown` from a nonexistent interpreter. Notebook execution owns
    // the existing mutating/first-use approval path; once it prepares the runtime, inspection can retry.
    const isDefaultEnv = envName === this.defaultEnvNameFor(request.language)
    const isDefaultReady =
      request.language === 'r'
        ? rReady(runtimeRoot, DEFAULT_ENV_VERSION)
        : pythonReady(runtimeRoot, DEFAULT_ENV_VERSION)
    if (isDefaultEnv && !isDefaultReady) {
      throw new Error(
        `DEFAULT_RUNTIME_NOT_READY: the app-managed ${request.language} runtime is not prepared, and ` +
          'inspect_packages cannot create it under read-only package-metadata permission. Use ' +
          `notebook_execute with language "${request.language}" to prepare the runtime under notebook ` +
          'execution approval, then retry inspect_packages.'
      )
    }

    const target = this.environmentCaptureTarget(
      request.language,
      envName,
      binding,
      binding?.resolvedInterpreter,
      runtimeRoot
    )
    const inspection = await this.environmentOperations.runShared('inspection', envName, () =>
      this.environmentStateTracker.inspectPackages(target, request.packages)
    )
    return {
      language: request.language,
      environmentName: envName,
      runtimeSource: target.runtimeSource,
      ...(binding?.runtimeId ? { runtimeId: binding.runtimeId } : {}),
      ...(binding?.label ? { runtimeLabel: binding.label } : {}),
      ...inspection
    }
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

    const admission = await this.packageAdmission.admit(request)
    if (admission.status === 'refused') return admission.result
    const result = await this.packageMutation.mutate({ target: admission.target, mirror })

    // R installs/uninstalls don't take effect in a live R session (attached namespaces, held DLLs), so
    // flag the env for a restart prompt and refresh every session's env view. Python needs no restart.
    if (result.ok && result.needsRestart && request.language === 'r') {
      this.environmentOperations.recommendRestart('r', admission.target.environmentName)
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
        return this.environmentOperations.runMutation(name, async () => {
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
        // Refuse if recovery flagged this prefix possibly-live (an unknown-liveness orphan may still be
        // writing it). After a restart there is no in-memory kernel state, so isEnvironmentLive() above
        // can't see a surviving installer — without this, rm -rf could delete a named prefix a survivor
        // is still writing. Mirrors the 'create' guard; keyed by the same real prefix.
        this.assertPrefixRecoverable(envPrefix(getRuntimeRoot(this.options.dataRoot), name))
        // Serialize the rm -rf against a concurrent install into the same env (design D4 / review A).
        return this.environmentOperations.runMutation(name, async () => {
          const environments = manager.removeEnvironment(name)
          this.runtimeRepair.completeRemovedManagedEnvironment(name)
          return { environments }
        })
      }
    }
  }

  // True when any session has a live (spawned, not yet terminated) executor process bound to this env
  // name. Derived from the per-process-key status map: a key whose status is not 'terminated' has a
  // live proc (a run set it 'running'/'idle' and no idle-shutdown/crash has dropped it since). The
  // repl key is env-agnostic and never blocks a named-env removal.
  private isEnvironmentLive(name: string): boolean {
    for (const session of this.sessions.values()) {
      for (const [processKey, status] of session.kernelStatusEntries()) {
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
    return this.shutdownSession(request.sessionId)
  }

  async shutdownSession(sessionId: string): Promise<{ sessionId: string; status: 'shutdown' }> {
    await this.runtimeBindingOwner.withSessionTeardown(sessionId, async () => {
      await this.runtimeBindingOwner.waitForWrites(sessionId)
      await this.sessions.remove(sessionId)
    })
    return { sessionId, status: 'shutdown' }
  }

  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight. Run at
  // app startup and refresh guarded startup blocks before new writes. For each journalled op: if a child
  // MIGHT still be running, BLOCK its target and leave the entry (recovery never signals the orphan);
  // only once the child is provably gone does it clean staging / verify the prefix / flag repair-required,
  // then clear the entry. Best-effort — a failure is logged and the entry retried next startup. The
  // download (staging cleanup), materialize (verify/rebuild the env prefix), and install (flag
  // repair-required) paths all populate the journal, so each reconcile action below is wired to a real effect.
  async recoverInterruptedOperations(): Promise<void> {
    await this.recoveryCoordinator.recover()
  }

  // Awaited by materialize/install before they touch a prefix, so startup recovery has finished
  // reconciling (cleaning staging, verifying prefixes, flagging repair) before new work begins. A no-op
  // once recovery has settled, and when recovery was never kicked off (e.g. tests). Public so the
  // startup env gate and UI provision/repair handlers can share the SAME barrier (they touch prefixes
  // too, not just materialize/install).
  async ensureRecovered(): Promise<void> {
    await this.recoveryCoordinator.ensureReady()
  }

  // Throws if `prefix` is one recovery couldn't confirm free of a live orphan (see blockedPrefixes).
  // Called by every path that would WRITE an env prefix, so an unknown-liveness orphan actually blocks
  // the write this session instead of only leaving a journal entry for next boot.
  private assertPrefixRecoverable(prefix: string): void {
    if (this.isPrefixRecoveryBlocked(prefix)) {
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
    return this.isPrefixRecoveryBlocked(prefix)
  }

  // Whether an arbitrary env prefix is recovery-blocked. Injected into the provisioner (ipc.ts) so its
  // startup restore/upgrade/repair and named create self-refuse a possibly-live prefix — the guarantee
  // the barrier alone didn't give the startup gate. Keyed by real prefix, matching blockedPrefixes.
  // A corrupt journal blocks EVERY prefix, not just a specific one:
  // an unreadable journal means we can't rule out an orphan writing an arbitrary (including named) env.
  // A force Reset can exempt ONE prefix from that global block (corruptResetAllowlist) so it rebuilds
  // while the others stay blocked; the explicit per-prefix block (blockedPrefixes) still applies to it.
  isPrefixRecoveryBlocked(prefix: string): boolean {
    return this.recoveryCoordinator.isPrefixBlocked(prefix)
  }

  // Drops the in-memory recovery block for a prefix. Called by an EXPLICIT user recovery (repair with
  // force, wired via ipc.ts) so a quarantined runtime can be reset. The provisioner also clears the
  // retained journal record + sidecar for the prefix, so the quarantine won't re-arm next startup.
  clearRecoveryBlock(prefix: string): void {
    this.recoveryCoordinator.clearPrefixBlock(prefix)
  }

  // Drops the in-memory recovery block for a runtime ID. An interrupted INSTALL blocks the bound
  // runtimeId (not a prefix), so a prefix-only Reset would rebuild the env yet still leave bound
  // sessions rejected by blockedRuntimeIds until the next restart. The provisioner's Reset collects the
  // runtimeIds of the retained install records for the reset prefix and clears them here too.
  clearRuntimeRecoveryBlock(runtimeId: string): void {
    this.recoveryCoordinator.clearRuntimeBlock(runtimeId)
  }

  // Called only after the explicit UI Runtime Reset has rebuilt and verified the managed default env.
  // This is deliberately separate from managePackages(): an ordinary install may clear an
  // interrupted-install marker, but it must never release a protected-identity quarantine.
  async completeRuntimeRepair(language: NotebookLanguage): Promise<void> {
    await this.runtimeRepair.completeExplicitRepair(language)
  }

  // Releases ONE prefix from the global corrupt-journal write barrier. Called by a force Reset (via the
  // provisioner's clearQuarantine) after it has moved that env's corrupt journal aside. A corrupt journal
  // means we can't know which env had in-flight work, so resetting Python must NOT unblock R, named, and
  // external targets — they stay blocked (recoveryCorrupt still true) until their own Reset or a restart
  // (which re-reads the now-absent journal and clears the barrier entirely). The user accepted the risk
  // for the prefix they explicitly reset, and only that prefix. Idempotent.
  clearCorruptRecoveryBlock(prefix: string): void {
    this.recoveryCoordinator.allowCorruptReset(prefix)
  }

  // Records, in THIS process, that a prefix write failed with a child we could not confirm stopped — a
  // worker MAY still be writing it. Blocks it immediately so an in-session retry can't begin() a second
  // concurrent op onto the same prefix (the retained journal record only guards the next boot), AND marks
  // it live-unconfirmed so a force Reset this session refuses to delete it out from under that orphan.
  // Injected into the provisioner as blockPrefix (ipc.ts), and called directly by the install path.
  blockPrefixRecovery(prefix: string): void {
    this.recoveryCoordinator.markLiveUnconfirmed(prefix)
  }

  // True when a write in THIS process left `prefix` with a child that could not be confirmed stopped (see
  // blockPrefixRecovery). The provisioner consults this (injected) in clearQuarantine to REFUSE a force
  // Reset that would otherwise delete + rebuild the prefix while that orphan may still be writing it. It
  // is only the PER-PROCESS view: it goes false after a restart, but that does NOT by itself authorize a
  // Reset — an app restart does not prove a reparented orphan exited. On the next launch, recovery re-gates
  // from the DURABLE journal/sidecar and clears the block only once the child is provably gone (pid ESRCH /
  // reused) or, for a no-PID orphan, a Linux machine-reboot proof (boot_id changed).
  isPrefixLiveUnconfirmed(prefix: string): boolean {
    return this.recoveryCoordinator.isPrefixLiveUnconfirmed(prefix)
  }

  // Runs fn under the SAME exclusive per-env lease that package installs use, so a
  // default-env materialize/repair/upgrade in the provisioner serializes with an install into that env
  // instead of racing it on a separate lock. Injected into the provisioner as withPrefixLock (ipc.ts).
  // Keyed by env NAME, matching managePackages/named-env create/remove. The provisioner only calls this
  // from its top-level entries (never re-entrantly), so it cannot deadlock against itself.
  withEnvLock<T>(envName: string, fn: () => Promise<T>): Promise<T> {
    return this.environmentOperations.runMutation(envName, fn)
  }

  // Shuts down every live interpreter, used by app-level cleanup paths. Returns { reaped }: true only
  // when every kernel tree was cleanly reaped, so the update-install gate can refuse to trigger the
  // NSIS uninstall while a kernel may still hold file handles under the install dir.
  shutdownAll(): Promise<{ reaped: boolean }> {
    return this.runtimeBindingOwner.withGlobalTeardown(() => this.sessions.shutdownAll())
  }

  // Permanently closes process-owned recovery work before the final kernel teardown. Unlike
  // shutdownAll(), this is terminal: quit/relaunch and module disposal use it, while update and data-root
  // migration gates retain the reusable shutdown contract so a refused/cancelled flow can resume work.
  dispose(): Promise<{ reaped: boolean }> {
    if (this.disposalPromise) return this.disposalPromise

    // Close the terminal admission boundary before any asynchronous teardown starts. Existing holders
    // are released and queued acquisitions reject, so no package/environment operation can begin after
    // application disposal has crossed this point.
    this.environmentOperations.dispose()
    // Mark recovery disposed first, but do not let slow startup filesystem reconciliation consume the
    // quit budget before kernel teardown even starts. Await both so non-quit module disposal still leaves
    // no recovery work behind once this terminal operation resolves.
    const recoveryDisposal = this.recoveryCoordinator.dispose()
    const shutdown = this.runtimeBindingOwner.withGlobalTeardown(() => this.sessions.dispose())
    const disposal = Promise.allSettled([shutdown, recoveryDisposal]).then(
      ([shutdownResult, recoveryResult]) => {
        const failures = [shutdownResult, recoveryResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            'Multiple notebook runtime resources failed to dispose.'
          )
        }
        return (shutdownResult as PromiseFulfilledResult<{ reaped: boolean }>).value
      }
    )
    this.disposalPromise = disposal
    return disposal
  }

  // Lists sessions with a cell mid-execution, for the pre-migration active-session warning.
  getActiveNotebookSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.hasActiveRun())
      .map((session) => ({ projectName: session.projectName, sessionId: session.sessionId }))
  }

  // Creates or returns the runtime session bound to an ACP/chat session id.
  private async ensureSession(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectName = request.projectName ?? this.options.projectName
    return this.sessions.getOrCreate(request.sessionId, async () => {
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
      const ownedExecutor = this.createExecutor(request.sessionId, projectName)
      const session: RuntimeSession = new NotebookSessionAggregate({
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
        executionCount: document.runs.length,
        executor: ownedExecutor.executor,
        executorGeneration: ownedExecutor.generation
      })

      try {
        // Rehydrate + revalidate any persisted runtime bindings (WS1-rest/WS12): a still-usable binding
        // is restored active; one whose runtime is now disabled/missing is kept as unavailable (no
        // silent fallback). Publish only after this initialization completes so same-ID callers cannot
        // observe a partially hydrated aggregate.
        await this.runtimeBindingOwner.reload(session, document.runtimeBindings)
        return session
      } catch (error) {
        // Initialization failures stay retryable. Best-effort cleanup must not replace the repository /
        // binding error that callers already observe.
        await session.shutdownExecutor().catch(() => undefined)
        try {
          session.releaseMcpRpcConnection()
        } catch {
          // Preserve the initialization failure.
        }
        throw error
      }
    })
  }

  // Builds the interpreter backend, allowing tests to inject a fake executor. The default (D-B4)
  // builds a real NotebookKernelExecutor from the storage root's runtime paths, wired so an idle-
  // shutdown proc (kernel-executor.ts's own idle timer) surfaces as a 'terminated' kernel status; this
  // branch is not exercised by unit tests (see resolveDefaultExecutorOptions for the tested,
  // spawn-free portion).
  private createExecutor(sessionId: string, projectName: string): NotebookSessionOwnedExecutor {
    const generation = Symbol(`notebook-executor:${sessionId}`)
    const lifecycle: NotebookExecutorLifecycleCallbacks = {
      onIdleShutdown: (kind, env) =>
        this.handleKernelIdleShutdown(sessionId, projectName, kind, env, generation),
      onTerminated: (kind, env) =>
        this.handleKernelTerminated(sessionId, projectName, kind, env, generation)
    }

    if (this.options.executorFactory) {
      return { executor: this.options.executorFactory(sessionId, lifecycle), generation }
    }

    const executor = new NotebookKernelExecutor({
      ...resolveDefaultExecutorOptions(),
      platform: this.options.platform,
      onIdleShutdown: (kind, env) => {
        void lifecycle.onIdleShutdown(kind, env)
      },
      onTerminated: (kind, env) => {
        void lifecycle.onTerminated(kind, env)
      }
    })
    return { executor, generation }
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
    env?: string,
    generation?: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    const processKey = kernelProcessKey(kind, env)
    if (session) {
      if (generation) {
        await session.runExecutorLifecycleCallback(generation, async () => {
          await this.persistKernelStatus(session, 'terminated', processKey)
          this.notifyNotebookChanged(session)
        })
        return
      }
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyNotebookChanged(session)
      return
    }
    // Executor-owned callbacks are valid only while their Aggregate generation is published. Once
    // teardown removes that owner, do not fall through to the legacy rehydration path and rewrite the
    // durable state a same-ID successor will load.
    if (generation) return
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
    env?: string,
    generation?: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    const processKey = kernelProcessKey(kind, env)
    if (session) {
      if (generation) {
        await session.runExecutorLifecycleCallback(generation, async () => {
          session.markKernelTerminated(processKey)
          await this.persistKernelStatus(session, 'terminated', processKey)
          this.notifyNotebookChanged(session)
        })
        return
      }
      session.markKernelTerminated(processKey)
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyNotebookChanged(session)
      return
    }
    if (generation) return
    if (!persistsToRunJson(processKey)) return
    try {
      await this.repository.updateKernelStatus({ projectName, sessionId, status: 'terminated' })
    } catch {
      return
    }
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
    session.setKernelStatus(processKey, status)
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
    const publicRun = this.toPublicRunRecord(run)
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput as NotebookRunSummary['inputFiles'][number]
    })
    return {
      ...publicRun,
      inputFiles,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.dataRoot),
      kernelName: 'python3'
    }
  }

  private toPublicRunRecord(run: NotebookRunRecord): NotebookRunRecord {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput
    })
    // NotebookRunRecord is also the legacy renderer shape. The boundary deliberately omits the
    // internal-only required key while keeping every public input field; persisted records remain
    // strongly typed and complete inside the repository.
    return { ...run, inputFiles } as NotebookRunRecord
  }
}

export { NotebookRuntimeService, resolveDefaultExecutorOptions, resolveLoopScriptPaths }
export { NotebookControlCompletionCapturedError } from './execution-owner'
export type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookControlResult,
  NotebookShellResult,
  InspectPackagesRequest,
  InspectPackagesResult,
  NotebookExecutor,
  NotebookExecutorLifecycleCallbacks,
  NotebookEnvironmentManager,
  NotebookHandoffContext,
  NotebookRuntimeServiceCallbacks,
  NotebookRuntimeServiceOptions
}
