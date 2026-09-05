import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  NotebookCell,
  AbortNotebookCodeCellRequest,
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
  NotebookLanguage,
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
  NotebookRestartRequest,
  NotebookRunSummary,
  RequestNotebookNetworkAccessRequest,
  RequestNotebookNetworkAccessResult,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionReference,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import { publishUserFile } from '../user-file-publisher'
import {
  isNotebookRunCursor,
  NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES,
  NOTEBOOK_STATE_HISTORY_PAGE_LIMIT,
  NOTEBOOK_STATE_TARGET_RUN_LIMIT,
  parseNotebookLanguage
} from '../../shared/notebook'
import type {
  ManageEnvironmentsRequest,
  ManageEnvironmentsResult,
  ProvisionProgress
} from '../../shared/notebook-env'
import type { PackageMirror } from '../../shared/mirror'
import { NotebookDataExecutionAdmissionOwner } from './data-execution-admission'
import {
  NotebookEnvironmentManagementOwner,
  type NotebookEnvironmentManager
} from './environment-management'
import { NotebookExportReader } from './export-reader'
import type { NotebookKernelExecutorOptions } from './kernel-executor'
import { saveIpynbAll } from './save-ipynb-all'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import type { ProbeDeps } from './mirror-probe'
import {
  installPackages as installPackagesDefault,
  type InstallDeps,
  type InstallRequest,
  type InstallResult
} from './package-manager'
import {
  NotebookPackageOperations,
  type InspectPackagesRequest,
  type InspectPackagesResult
} from './package-operations'
import {
  NotebookRunRepository,
  getNotebookFileEvidenceLocation,
  getRuntimeRoot
} from './repository'
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
  DiscoveredInterpreter,
  NotebookRuntimeBindings,
  NotebookRuntimeListing,
  RuntimeBindingOperationResult,
  RuntimeEnablement,
  RuntimeUsage
} from '../../shared/notebook-runtime'
import type { NotebookRuntimeSettings } from '../settings/capabilities'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { managedNotebookWorkingCache } from './windows-micromamba-working-cache'
import { NotebookRuntimeRepairOwner, type ExplicitRuntimeRepairTarget } from './runtime-repair'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import { NotebookEnvironmentOperations, type DefaultEnvProvisioner } from './environment-operations'
import type { MicromambaRunner } from './windows-micromamba-runner'
import {
  type NotebookSessionAggregate,
  type NotebookSessionExecutionRequest,
  type NotebookSessionExecutionResult,
  type NotebookSessionExecutor,
  type NotebookSessionMcpRpcConnection,
  type NotebookSessionResolvedInterpreter,
  type NotebookSessionRuntimeBinding
} from './session-aggregate'
import { NotebookSessionRegistry } from './session-registry'
import { createLogger, errorLogFields } from '../logger'
import { EnvironmentStateTracker, type EnvironmentCaptureTarget } from './environment-state-tracker'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import type { RuntimeDiagnosticLogger } from './runtime-diagnostics'
import { resolveProjectId, type ProjectIdScope } from '../../shared/project-scope'
import { NotebookRunTerminalizationOwner } from './run-terminalization'
import type { NotebookShellProcess, NotebookShellResult } from './shell-process'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookProcessSandbox } from './process-sandbox'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import {
  NotebookExecutionOwner,
  type NotebookControlCompletionInterceptor,
  type NotebookControlResult
} from './execution-owner'
import { NotebookSessionReadModel, type NotebookHandoffContext } from './session-read-model'
import { notebookLaneKey } from './lane-identity'
import {
  completeWorkingFileEvidence,
  deleteWorkingFileEvidenceProject
} from './working-file-observer'
import {
  NotebookSessionLifecycleOwner,
  type NotebookExecutorLifecycleCallbacks,
  type NotebookSessionLifecycleCallbacks
} from './session-lifecycle'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import {
  assertNotebookCodeAppendWithinLimit,
  assertNotebookCodeWithinLimit
} from './content-limits'
import { NotebookHelperModuleHost, type NotebookHelperModuleCatalog } from './helper-module-host'
import { deleteNotebookProjectInputs, deleteNotebookSessionInputs } from './input-staging'
import {
  deleteNotebookProjectPromptInputs,
  deleteNotebookSessionPromptInputs
} from './prompt-input-materialization'

// The default stays outside CN mirror routing when no explicit locale is injected.
const DEFAULT_LOCALE = 'en-US'

const EMPTY_NOTEBOOK_RUNTIME_SETTINGS: Pick<NotebookRuntimeSettings, 'getSnapshot'> &
  Partial<Pick<NotebookRuntimeSettings, 'setEnvironmentEnabled'>> = {
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

type ResolvedInterpreter = NotebookSessionResolvedInterpreter
type NotebookExecutionRequest = NotebookSessionExecutionRequest
type NotebookExecutionResult = NotebookSessionExecutionResult

type NotebookExecutor = NotebookSessionExecutor

type NotebookRuntimeServiceCallbacks = NotebookSessionLifecycleCallbacks

// The session-scoped connector RPC capability injected into the persistent control-plane REPL. The
// service caches it for the RuntimeSession lifetime because the child captures it only when spawned;
// release revokes that capability when the runtime session is shut down.
type McpRpcConnection = NotebookSessionMcpRpcConnection
type McpRpcConnectionBinding = {
  sessionId: string
  projectId: string
  agentFrameId: string
  attemptId?: string
  executionCwd: string
}

type NotebookRuntimeServiceOptions = ProjectIdScope & {
  // Config root: source of the app-owned claude config dir (protected from the kernel). Never relocated.
  configRoot: string
  // Data root: where notebook workspaces, data, and the runtime install live (user-relocatable).
  dataRoot: string
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
  notebookRuntimeSettings?: Pick<NotebookRuntimeSettings, 'getSnapshot'> &
    Partial<Pick<NotebookRuntimeSettings, 'setEnvironmentEnabled'>>
  // Read fresh at every Agent-triggered creation boundary. Historical settings resolve to true;
  // a failed production read rejects creation rather than silently bypassing the user's policy.
  getAgentEnvironmentCreationEnabled?: () => Promise<boolean>
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
  processSandbox?: NotebookProcessSandbox
  // Latency-probe deps for the fastest-mirror auto-selection, injectable so tests stay hermetic (the
  // real probe does live HEAD requests). Undefined in production → effectiveMirrorAsync's real probe.
  mirrorProbe?: ProbeDeps
  // Package installer, injectable so tests never spawn real micromamba/pip/R. Defaults to
  // package-manager's installPackages.
  installPackagesImpl?: (
    request: InstallRequest,
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
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
  translate?: NativeTranslator
  environmentStateTracker?: Pick<
    EnvironmentStateTracker,
    | 'prepareRun'
    | 'captureCompletedRun'
    | 'inspectPackages'
    | 'markPackageMutationDirty'
    | 'refreshAfterPackageMutation'
  >
  dependencyAnalyzer?: Pick<NotebookDependencyAnalyzer, 'project'>
  helperModuleCatalog?: NotebookHelperModuleCatalog
}

// The wire binding plus the interpreter override the executor needs. `resolvedInterpreter` is set only
// for an EXTERNAL binding (run the user's own interpreter directly); an app-managed binding leaves it
// undefined so the executor keeps its managed-prefix lookup and ensureDefaultEnvReady provisions the env.
type InternalRuntimeBinding = NotebookSessionRuntimeBinding
type RuntimeSession = NotebookSessionAggregate

const saveIpynbWithDialog = async (
  suggestedName: string,
  data: string,
  translate: NativeTranslator = englishNativeTranslator
): Promise<ExportNotebookResult> => {
  const { app, dialog } = await import('electron')
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: join(app.getPath('downloads'), suggestedName),
    title: translate('Export notebook'),
    filters: [{ name: translate('Jupyter Notebook'), extensions: ['ipynb'] }]
  })

  if (canceled || !filePath) return { saved: false }
  await publishUserFile(filePath, (temporaryPath) => writeFile(temporaryPath, data, 'utf8'))
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
    createLogger('notebook:runtime').error('could not resolve loop script', {
      fileName,
      candidateCount: candidates.length
    })
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
  private readonly helperModules: NotebookHelperModuleHost
  private readonly dependencyAnalyzer: Pick<NotebookDependencyAnalyzer, 'project'>
  private readonly dataExecutionAdmission: NotebookDataExecutionAdmissionOwner
  private readonly packageOperations: NotebookPackageOperations
  private readonly repairPolicy: NotebookRuntimeRepairPolicy
  private readonly runtimeRepair: NotebookRuntimeRepairOwner
  private readonly sessions: NotebookSessionRegistry<RuntimeSession>
  private readonly sessionReadModel: NotebookSessionReadModel<RuntimeSession>
  private readonly sessionLifecycle: NotebookSessionLifecycleOwner
  // Owns process-global operation admission, provisioning progress, restart recommendations,
  // revocation drains, repair blocks, and installer diagnostics. The service remains the compatibility
  // facade and chooses which execution/package path enters each environment operation.
  private readonly environmentOperations: NotebookEnvironmentOperations
  private readonly environmentManagement: NotebookEnvironmentManagementOwner
  private mcpRpcConnectionResolver:
    ((binding: McpRpcConnectionBinding) => Promise<McpRpcConnection>) | undefined
  private readonly runtimeEnablementResolver:
    ((language: NotebookLanguage) => Promise<RuntimeEnablement | undefined>) | undefined
  private readonly agentEnvironmentCreationEnabled: () => Promise<boolean>
  private readonly runtimeBindingOwner: NotebookRuntimeBindingOwner
  private readonly recoveryCoordinator: NotebookRecoveryCoordinator
  private readonly runtimeLogger: RuntimeDiagnosticLogger
  private readonly environmentStateTracker: Pick<
    EnvironmentStateTracker,
    | 'prepareRun'
    | 'captureCompletedRun'
    | 'inspectPackages'
    | 'markPackageMutationDirty'
    | 'refreshAfterPackageMutation'
  >
  private disposalPromise: Promise<{ reaped: boolean }> | undefined
  private environmentStartupBarrier: Promise<void> = Promise.resolve()

  constructor(private readonly options: NotebookRuntimeServiceOptions) {
    const defaultProjectId = resolveProjectId(options)
    this.repository = options.repository ?? new NotebookRunRepository(options.dataRoot)
    this.exportReader = new NotebookExportReader({
      repository: this.repository,
      defaultProjectId,
      appVersion: options.appVersion
    })
    this.sessions = new NotebookSessionRegistry({
      beforeTeardown: async () => {
        await this.environmentOperations.waitForRevocationDrains().catch(() => undefined)
        await this.runtimeBindingOwner.waitForWrites()
      }
    })
    const runtimeRoot = getRuntimeRoot(options.dataRoot)
    const workingCache = managedNotebookWorkingCache(options.platform, !options.installPackagesImpl)
    this.repairPolicy = new NotebookRuntimeRepairPolicy(runtimeRoot)
    this.recoveryCoordinator = new NotebookRecoveryCoordinator(
      runtimeRoot,
      this.repairPolicy,
      workingCache
    )
    this.mcpRpcConnectionResolver = options.getMcpRpcConnection
    const runtimeSettings = options.notebookRuntimeSettings ?? EMPTY_NOTEBOOK_RUNTIME_SETTINGS
    this.runtimeEnablementResolver = async (language) =>
      (await runtimeSettings.getSnapshot(language)).runtimeEnablement
    this.agentEnvironmentCreationEnabled =
      options.getAgentEnvironmentCreationEnabled ?? (() => Promise.resolve(true))
    this.runtimeBindingOwner = new NotebookRuntimeBindingOwner({
      dataRoot: options.dataRoot,
      repository: this.repository,
      runtimeSettings,
      repairPolicy: this.repairPolicy,
      discoverRuntimes: options.discoverRuntimes,
      waitForEnvironmentStartup: () => this.environmentStartupBarrier,
      platform: options.platform
    })
    this.dependencyAnalyzer =
      options.dependencyAnalyzer ??
      new NotebookDependencyAnalyzer({
        storageRoot: options.dataRoot,
        repository: this.repository,
        resolveInterpreter: (run) =>
          run.runtimeId && (run.kernelKind === 'python' || run.kernelKind === 'r')
            ? this.runtimeBindingOwner.dependencyInterpreter(run.kernelKind, run.runtimeId)
            : Promise.resolve(undefined)
      })
    this.runtimeLogger = options.logger ?? createLogger('notebook:runtime')
    this.environmentOperations = new NotebookEnvironmentOperations({
      recovery: this.recoveryCoordinator,
      bindings: this.runtimeBindingOwner,
      sessions: () => this.sessions.values(),
      clearKernelTermination: (session, processKey) =>
        this.sessionLifecycle.clearPersistedKernelTermination(
          session as RuntimeSession,
          processKey
        ),
      notifyChanged: (session) => this.sessionLifecycle.notifyChanged(session as RuntimeSession),
      logger: this.runtimeLogger
    })
    this.sessionReadModel = new NotebookSessionReadModel({
      storageRoot: options.dataRoot,
      defaultProjectId,
      repository: this.repository,
      dependencyAnalyzer: this.dependencyAnalyzer,
      findSession: (sessionId) => this.sessions.get(this.sessionLifecycle.rootLane(sessionId)),
      runtimeBindings: (session) => this.runtimeBindingOwner.snapshot(session),
      runtimeEnvironment: (session, language) => this.resolveRunEnv(session, language),
      isRestartRecommended: (processKey) =>
        this.environmentOperations.isRestartRecommended(processKey)
    })
    this.sessionLifecycle = new NotebookSessionLifecycleOwner({
      storageRoot: options.dataRoot,
      defaultProjectId,
      repository: this.repository,
      sessions: this.sessions,
      runtimeBindings: this.runtimeBindingOwner,
      waitForRevocationDrains: () => this.environmentOperations.waitForRevocationDrains(),
      executorFactory: options.executorFactory,
      defaultExecutorOptions: () => ({
        ...resolveDefaultExecutorOptions(),
        ...(options.processSandbox ? { processSandbox: options.processSandbox } : {})
      }),
      platform: options.platform,
      callbacks: options.callbacks,
      toSessionReference: (session) => this.sessionReadModel.toSessionReference(session),
      onKernelStatusPersistenceFailure: ({ operation, lane, kind, env, error }) => {
        const message = 'notebook kernel lifecycle persistence failed'
        const fields = {
          ...errorLogFields(error),
          operation,
          lane: notebookLaneKey(lane),
          kind,
          environment: env
        }
        this.runtimeLogger.error(message, fields)
      }
    })
    this.runtimeRepair = new NotebookRuntimeRepairOwner({
      runtimeRoot,
      policy: this.repairPolicy,
      bindings: this.runtimeBindingOwner,
      environmentOperations: this.environmentOperations,
      sessions: () => this.sessions.values(),
      isCurrentSession: (session) => this.sessions.get(session.lane) === session,
      clearKernelTermination: (session, processKey) =>
        this.sessionLifecycle.clearPersistedKernelTermination(session, processKey),
      notifyChanged: (session) => this.sessionLifecycle.notifyChanged(session)
    })
    this.environmentManagement = new NotebookEnvironmentManagementOwner({
      runtimeRoot,
      manager: options.environmentManager,
      sessions: () => this.sessions.values(),
      ensureRecovered: () => this.ensureRecovered(),
      assertPrefixRecoverable: (prefix) => this.assertPrefixRecoverable(prefix),
      environmentOperations: this.environmentOperations,
      runtimeRepair: this.runtimeRepair,
      isAgentEnvironmentCreationEnabled: this.agentEnvironmentCreationEnabled
    })
    this.environmentStateTracker =
      options.environmentStateTracker ??
      new EnvironmentStateTracker({
        dataRoot: options.dataRoot,
        platform: options.platform,
        logger: this.runtimeLogger
      })
    this.packageOperations = new NotebookPackageOperations({
      storageRoot: options.dataRoot,
      runtimeRoot,
      locale: options.locale ?? DEFAULT_LOCALE,
      mirrorProbe: options.mirrorProbe,
      resolvePackageMirror: options.getPackageMirror,
      ensureRecovered: () => this.ensureRecovered(),
      loadSession: (request) => this.sessionLifecycle.ensure(request),
      findSession: (sessionId) => this.sessions.get(this.sessionLifecycle.rootLane(sessionId)),
      sessions: () => this.sessions.values(),
      notifyChanged: (session) => this.sessionLifecycle.notifyChanged(session),
      resolveRuntimeEnablement: (language) => this.resolveRuntimeEnablement(language),
      isDefaultEnvironmentDisabled: (language, candidateRuntimeRoot) =>
        this.isDefaultEnvDisabled(language, candidateRuntimeRoot),
      isAgentEnvironmentCreationEnabled: this.agentEnvironmentCreationEnabled,
      repairPolicy: this.repairPolicy,
      runtimeRepair: this.runtimeRepair,
      environmentOperations: this.environmentOperations,
      recovery: this.recoveryCoordinator,
      environmentStateTracker: this.environmentStateTracker,
      installPackages: options.installPackagesImpl ?? installPackagesDefault,
      ...(options.processSandbox
        ? {
            packageSpawn: (target) =>
              sandboxedPackageSpawn({
                processSandbox: options.processSandbox!,
                request: target.request,
                runtimeRoot,
                storageRoot: options.dataRoot,
                interpreter: target.interpreter
              })
          }
        : {}),
      micromambaRunner: options.micromambaRunner,
      ...workingCache,
      createEnvironmentCaptureTarget: (...args) => this.environmentCaptureTarget(...args)
    })
    this.dataExecutionAdmission = new NotebookDataExecutionAdmissionOwner({
      runtimeRoot: getRuntimeRoot(options.dataRoot),
      environmentOperations: this.environmentOperations,
      recovery: this.recoveryCoordinator,
      ensureRecovered: () => this.ensureRecovered(),
      resolveRuntimeEnablement: (language) => this.resolveRuntimeEnablement(language),
      isAgentEnvironmentCreationEnabled: this.agentEnvironmentCreationEnabled,
      repairPolicy: this.repairPolicy,
      platform: options.platform
    })
    this.runTerminalization = new NotebookRunTerminalizationOwner({
      repository: this.repository,
      notifyChanged: (session) => this.sessionLifecycle.notifyChanged(session as RuntimeSession),
      afterCommit: async (session, run) => {
        const location = getNotebookFileEvidenceLocation(
          options.dataRoot,
          session.projectId,
          session.sessionId,
          session.lane
        )
        await completeWorkingFileEvidence(
          {
            storageRoot: options.dataRoot,
            root: location.root,
            storageKeyPrefix: location.storageKeyPrefix
          },
          run
        ).catch((error) => {
          this.runtimeLogger.error('Notebook file-evidence receipt settlement failed', {
            ...errorLogFields(error),
            runId: run.runId,
            lane: notebookLaneKey(session.lane)
          })
        })
      }
    })
    this.helperModules = new NotebookHelperModuleHost(options.helperModuleCatalog)
    this.executionOwner = new NotebookExecutionOwner({
      configRoot: options.configRoot,
      storageRoot: options.dataRoot,
      runTerminalization: this.runTerminalization,
      dataExecutionAdmission: this.dataExecutionAdmission,
      environmentStateTracker: this.environmentStateTracker,
      createEnvironmentCaptureTarget: (...args) => this.environmentCaptureTarget(...args),
      setKernelStatus: (session, status, processKey) => session.setKernelStatus(processKey, status),
      persistRecoveredKernelIdle: (session, processKey) =>
        this.sessionLifecycle.persistRecoveredKernelIdle(session as RuntimeSession, processKey),
      getMcpRpcConnectionResolver: () => this.mcpRpcConnectionResolver,
      notifyAvailable: (session, source) =>
        this.sessionLifecycle.notifyAvailable(session as RuntimeSession, source),
      projectDependencies: (session, run, interpreter) =>
        this.dependencyAnalyzer.project({
          projectId: session.projectId,
          sessionId: session.sessionId,
          completedRun: run,
          ...(interpreter ? { interpreter } : {})
        }),
      helperModules: this.helperModules,
      logger: this.runtimeLogger,
      platform: options.platform,
      shellProcess:
        options.shellProcess ??
        new NotebookShellProcessAdapter(options.platform, options.processSandbox)
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
    this.environmentManagement.setManager(manager)
  }

  setEnvironmentStartupBarrier(barrier: Promise<void>): void {
    this.environmentStartupBarrier = barrier
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
    const prefix = envPrefix(
      runtimeRootDir,
      language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV,
      this.options.platform
    )
    const interp =
      language === 'r'
        ? rBin(prefix, this.options.platform)
        : pythonBin(prefix, this.options.platform)
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

  private defaultEnvNameFor(language: NotebookLanguage): string {
    return language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  }

  // The Session binding picks the run's conda env. External or missing bindings use the language's
  // default env key, even when an external binding overrides the interpreter.
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
    const prefix = envPrefix(runtimeRootDir, environmentName, this.options.platform)
    return {
      language,
      environmentName,
      runtimeSource: binding?.source === 'external' ? 'external' : 'managed',
      command:
        resolvedInterpreter?.command ??
        (language === 'r'
          ? rScriptBin(prefix, this.options.platform)
          : pythonBin(prefix, this.options.platform)),
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
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const session = await this.sessionLifecycle.ensure(request)
      return this.runtimeBindingOwner.list(session)
    })
  }

  // notebook_bind_runtime: the FIRST binding of a language for the session. Refuses a disabled/unknown
  // runtime; refuses re-binding a different runtime (use notebook_switch_runtime to change).
  async bindRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<RuntimeBindingOperationResult> {
    return this.sessionLifecycle.runProjectOperation(request, () =>
      this.runtimeBindingOwner.runWrite(
        notebookLaneKey(this.sessionLifecycle.laneForRequest(request)),
        async () => {
          const session = await this.sessionLifecycle.ensure(request)
          return this.runtimeBindingOwner.bind(
            session,
            request.language,
            request.runtimeId,
            async (binding) => {
              if (binding.source !== 'external') return
              const oldEnv = this.resolveRunEnv(session, request.language)
              const processKey = dataProcessKey(request.language, oldEnv)
              if (session.kernelStatus(processKey) === undefined) return
              const kind = request.language === 'r' ? 'r' : 'python'
              await session.terminateExecutor(kind, oldEnv)
              await this.tearDownLanguageBinding(session, request.language, oldEnv)
            }
          )
        }
      )
    )
  }

  // notebook_switch_runtime: an EXPLICIT switch — tear down the old kernel + clear that language's
  // state, then rebind. Refuses a disabled/unknown runtime (same MAIN-process gate as bind).
  async switchRuntime(
    request: NotebookSessionRequest & { language: NotebookLanguage; runtimeId: string }
  ): Promise<RuntimeBindingOperationResult> {
    return this.sessionLifecycle.runProjectOperation(request, () =>
      this.runtimeBindingOwner.runWrite(
        notebookLaneKey(this.sessionLifecycle.laneForRequest(request)),
        async () => {
          const session = await this.sessionLifecycle.ensure(request)
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
              await this.tearDownLanguageBinding(session, request.language, oldEnv)
            }
          )
          if ('bound' in result) this.sessionLifecycle.notifyChanged(session)
          return result
        }
      )
    )
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
  private async tearDownLanguageBinding(
    session: RuntimeSession,
    language: NotebookLanguage,
    env: string
  ): Promise<void> {
    const processKey = dataProcessKey(language, env)
    await this.sessionLifecycle.clearPersistedKernelTermination(session, processKey)
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
  async beginCodeCell(
    request: BeginNotebookCodeCellRequest,
    signal?: AbortSignal
  ): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    status: NotebookCell['status']
  }> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const session = await this.sessionLifecycle.ensure(request)
      const cellId = request.cellId ?? `cell-${randomUUID()}`
      const writeId = `write-${randomUUID()}`
      const source = request.source ?? 'agent'
      const cell = session.beginCellWrite(
        {
          cellId,
          language: request.language ?? 'python',
          writeId,
          source,
          startedAt: Date.now()
        },
        signal ? { signal, onAbort: () => this.sessionLifecycle.notifyChanged(session) } : undefined
      )

      this.sessionLifecycle.notifyAvailable(session, source)
      this.sessionLifecycle.notifyChanged(session)

      return { sessionId: session.sessionId, cellId, writeId, status: cell.status }
    })
  }

  // Appends raw code text to the locked cell and streams the change to the preview.
  async appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    receivedBytes: number
  }> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const session = await this.sessionLifecycle.ensure(request)
      const current = session.cellView(request.cellId)
      try {
        assertNotebookCodeAppendWithinLimit(current.code, request.delta)
      } catch (error) {
        session.abortCellWrite(request.cellId, request.writeId)
        this.sessionLifecycle.notifyChanged(session)
        throw error
      }
      const cell = session.appendCellCode(request.cellId, request.writeId, request.delta)
      this.sessionLifecycle.notifyChanged(session)

      return {
        sessionId: session.sessionId,
        cellId: cell.id,
        writeId: request.writeId,
        receivedBytes: Buffer.byteLength(cell.code, 'utf8')
      }
    })
  }

  // Releases a write lock so the completed cell can be run by the same shared interpreter.
  async finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    code: string
    status: NotebookCell['status']
  }> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const session = await this.sessionLifecycle.ensure(request)
      const cell = session.finishCellWrite(request.cellId, request.writeId)
      this.sessionLifecycle.notifyChanged(session)

      return { sessionId: session.sessionId, cellId: cell.id, code: cell.code, status: cell.status }
    })
  }

  // Explicit recovery uses the same lane lookup and exact write identity as append/finish.
  async abortCodeCell(request: AbortNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    code: string
    status: NotebookCell['status']
  }> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const session = await this.sessionLifecycle.ensure(request)
      const cell = session.abortCellWrite(request.cellId, request.writeId)
      this.sessionLifecycle.notifyChanged(session)
      return { sessionId: session.sessionId, cellId: cell.id, code: cell.code, status: cell.status }
    })
  }

  // Compatibility facade: Session lookup and public summary projection stay here; lifecycle is owned.
  async runCell(
    request: RunNotebookCellRequest,
    signal?: AbortSignal,
    helperModules?: readonly string[]
  ): Promise<NotebookRunSummary> {
    return this.sessionLifecycle.runProjectOperation(request, async (deletionSignal) => {
      const session = await this.sessionLifecycle.ensure(request)
      const { run, dependencyProjection } = await this.executionOwner.executeDataCell(
        session,
        request,
        signal ? AbortSignal.any([signal, deletionSignal]) : deletionSignal,
        helperModules
      )
      return this.sessionReadModel.toRunSummary(session, run, dependencyProjection)
    })
  }

  // Convenience path used by the terminal and MCP to write a temporary cell and run it.
  async execute(
    request: ExecuteNotebookCodeRequest,
    signal?: AbortSignal
  ): Promise<NotebookRunSummary> {
    assertNotebookCodeWithinLimit(request.code)
    const begin = await this.beginCodeCell(request, signal)

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

    return this.runCell(
      {
        ...request,
        cellId: begin.cellId
      },
      signal,
      request.helperModules
    )
  }

  // Compatibility facade for the control-plane REPL. Admission, capability lifetime, dispatch,
  // terminalization, and completion interception belong to NotebookExecutionOwner.
  async executeControl(request: ExecuteNotebookControlRequest): Promise<NotebookControlResult> {
    return this.sessionLifecycle.runProjectOperation(request, async (deletionSignal) => {
      assertNotebookCodeWithinLimit(request.code)
      const session = await this.sessionLifecycle.ensure(request)
      return this.executionOwner.executeControl(session, request, deletionSignal)
    })
  }

  // Compatibility facade for stateless shell execution. The execution owner bounds process admission
  // across the runtime generation and serializes calls that share one Session workspace.
  async executeShell(
    request: ExecuteShellRequest,
    signal?: AbortSignal
  ): Promise<NotebookShellResult> {
    return this.sessionLifecycle.runProjectOperation(request, (deletionSignal) => {
      assertNotebookCodeWithinLimit(request.command)
      return this.executionOwner.executeShell(
        this.sessionLifecycle.laneForRequest(request),
        request,
        () => this.sessionLifecycle.ensure(request),
        signal ? AbortSignal.any([signal, deletionSignal]) : deletionSignal
      )
    })
  }

  async requestNetworkAccess(
    request: RequestNotebookNetworkAccessRequest,
    signal?: AbortSignal
  ): Promise<RequestNotebookNetworkAccessResult> {
    if (!this.options.processSandbox?.requestNetworkAccess) {
      return { hostname: request.hostname, status: 'unavailable' }
    }
    return this.options.processSandbox.requestNetworkAccess({
      sessionId: request.sessionId,
      projectId: resolveProjectId(request),
      hostname: request.hostname,
      reason: request.reason,
      ...(request.runtime ? { runtime: request.runtime } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(signal ? { signal } : {})
    })
  }

  // Read-only handoff projection for a fresh Agent context. A missing aggregate means Notebook was
  // never used (or was intentionally shut down for a Branch change), so this must not call
  // ensureSession(), load run.json, discover runtimes, or create an executor.
  peekHandoffContext(sessionId: string): NotebookHandoffContext | undefined {
    return this.sessionReadModel.peekHandoffContext(sessionId)
  }

  // Returns current live state plus the bounded recent run window used by renderer consumers.
  async state(
    request: NotebookSessionStateRequest
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const requestedRunIds = request.runIds ?? []
      if (requestedRunIds.length > NOTEBOOK_STATE_TARGET_RUN_LIMIT) {
        throw new Error(
          `Notebook state accepts at most ${NOTEBOOK_STATE_TARGET_RUN_LIMIT} targeted run IDs per request.`
        )
      }
      if (
        request.historySummaryFrameId !== undefined &&
        Buffer.byteLength(request.historySummaryFrameId, 'utf8') >
          NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES
      ) {
        throw new Error(
          `Notebook state history summary Frame ID must not exceed ${NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES} UTF-8 bytes.`
        )
      }
      const runIds = [...new Set(requestedRunIds)]
      const historyLimit = request.historyLimit ?? NOTEBOOK_STATE_HISTORY_PAGE_LIMIT
      if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100)
        throw new Error('Notebook history limit must be 1-100.')
      if (request.historyBefore && !isNotebookRunCursor(request.historyBefore))
        throw new Error('Notebook state history cursor is invalid.')
      const session = await this.sessionLifecycle.ensure(request)
      await this.runTerminalization.reconcilePending(session)
      return this.sessionReadModel.state(
        session,
        runIds,
        request.historySummaryFrameId,
        request.historyBefore,
        historyLimit
      )
    })
  }

  async inspectNamespace(request: NotebookNamespaceRequest): Promise<NotebookNamespaceSnapshot> {
    return this.sessionLifecycle.inspectNamespace(request)
  }

  // Resolves the durable reference for a session, preferring the live runtime session but falling
  // back to persisted run.json so notebook entries survive an app relaunch without re-running code.
  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    return this.sessionReadModel.getSessionReference(request)
  }

  // Exports the .ipynb for the kernel the caller is currently viewing (tab = choose language).
  // Replaces the legacy "always use the dominant kernel" rule: a user on the R tab expects the
  // file to come back as `kernelspec.name='ir'`, and a user on the repl tab gets the .ipynb
  // scoped to whichever data kernel was most recently active when repl ran.
  async exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult> {
    const file = await this.exportReader.readKernel(request)
    if (this.options.saveIpynb) return this.options.saveIpynb(file.name, file.data)
    return saveIpynbWithDialog(file.name, file.data, this.options.translate)
  }

  // The "Download all" path: writes one .ipynb per data kernel that has runs to a directory the
  // user picks. Triggered by the secondary footer button when the session actually spans multiple
  // data kernels — a single-kernel session's "Download all" would be a confusing duplicate of the
  // main button, so the renderer gates the secondary button on `kindsWithRuns.has('python') && has('r')`.
  async exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult> {
    const files = await this.exportReader.readAll(request)
    if (this.options.saveIpynbAll) return this.options.saveIpynbAll(files)
    return saveIpynbAll(files, undefined, this.options.translate)
  }

  // Replaces one exact language/environment interpreter when a target is present. Omitting the target
  // preserves the historical session-wide restart for callers that intentionally restart every loop.
  // Both paths preserve cells and durable run history, report 'restarting' for affected kernels, and
  // clear only the termination evidence covered by the restart.
  async restart(request: NotebookRestartRequest): Promise<NotebookSessionState> {
    return this.sessionLifecycle.runProjectOperation(request, async () => {
      const hasLanguage = request.language !== undefined
      const hasEnvironment = request.environment !== undefined
      if (hasLanguage !== hasEnvironment) {
        throw new Error('Notebook restart language and environment must be provided together.')
      }

      let target: { language: NotebookLanguage; environment: string } | undefined
      if (request.language !== undefined && request.environment !== undefined) {
        const language = parseNotebookLanguage(request.language)
        if (!request.environment.trim()) {
          throw new Error('Notebook restart environment must not be empty.')
        }
        target = {
          language,
          environment: resolveEnvName(language, request.environment)
        }
      }

      const session = await this.sessionLifecycle.ensure(request)

      if (!target) {
        const write = session.snapshot().activeWrite
        if (write) {
          session.abortCellWrite(write.cellId, write.writeId)
          this.sessionLifecycle.notifyChanged(session)
        }
      }

      if (target) {
        const { language, environment } = target
        const processKey = dataProcessKey(language, environment)
        const isDefaultPython = processKey === dataProcessKey('python', DEFAULT_PY_ENV)
        const restoredKernelStatus = session.restoredKernelStatus()
        const statusBeforeRestart =
          session.kernelStatus(processKey) ??
          (isDefaultPython && restoredKernelStatus !== 'idle' ? restoredKernelStatus : undefined)
        const wasDurablyTerminated = session.hasDurableKernelTermination(processKey)
        const hasTargetState = statusBeforeRestart !== undefined || wasDurablyTerminated

        if (hasTargetState) {
          session.setKernelStatus(processKey, 'restarting')
          this.sessionLifecycle.notifyChanged(session)
        }

        const restartTransition = (async (): Promise<void> => {
          try {
            await session.drainExecution(processKey)
            await session.terminateExecutor(language, environment)
            if (hasTargetState) {
              await this.sessionLifecycle.persistKernelStatus(session, 'idle', processKey)
            }
            session.clearKernelTerminated(processKey)
            this.environmentOperations.clearRestartRecommendations([processKey])
          } catch (error) {
            if (hasTargetState) {
              const failureStatus =
                statusBeforeRestart === 'terminated' || wasDurablyTerminated
                  ? 'terminated'
                  : 'error'
              try {
                if (failureStatus === 'terminated' || isDefaultPython) {
                  await this.sessionLifecycle.persistKernelStatus(
                    session,
                    failureStatus,
                    processKey
                  )
                } else {
                  session.setKernelStatus(processKey, failureStatus)
                }
              } catch {
                // Keep the original restart failure while retaining the best available live state.
                session.setKernelStatus(processKey, failureStatus)
              }
            }
            this.sessionLifecycle.notifyChanged(session)
            throw error
          }
        })()
        session.blockKernelExecutionUntil(processKey, restartTransition)
        await restartTransition

        this.sessionLifecycle.notifyChanged(session)
        await this.runTerminalization.reconcilePending(session)
        return this.sessionReadModel.state(session)
      }

      // A restart respawns fresh loops, so any pending R-restart recommendation for this session's envs
      // is cleared. Snapshot the keys before teardown drops them from kernelStatuses.
      const envKeys = session.kernelProcessKeys()
      const statusesBeforeRestart = new Map(
        envKeys.map((processKey) => [processKey, session.kernelStatus(processKey)] as const)
      )

      envKeys.forEach((processKey) => session.setKernelStatus(processKey, 'restarting'))
      const restartingDocument = await this.repository.updateKernelStatus({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lane: session.lane,
        status: 'restarting'
      })
      const hadDurableTerminations =
        session.hasUnknownDurableKernelTermination() ||
        (restartingDocument.kernel.terminatedKernelInstances?.length ?? 0) > 0
      this.sessionLifecycle.notifyChanged(session)

      try {
        await session.restartExecutor(() => this.sessionLifecycle.createExecutor(session.lane))
        this.environmentOperations.clearRestartRecommendations(envKeys)
        await this.repository.clearKernelTerminations({
          projectId: session.projectId,
          sessionId: session.sessionId,
          lane: session.lane,
          status: 'idle'
        })
        session.clearAllDurableKernelTerminations()
        envKeys.forEach((processKey) => session.setKernelStatus(processKey, 'idle'))
      } catch (error) {
        await this.repository.updateKernelStatus({
          projectId: session.projectId,
          sessionId: session.sessionId,
          lane: session.lane,
          status: hadDurableTerminations ? 'terminated' : 'error'
        })
        envKeys.forEach((processKey) =>
          session.setKernelStatus(
            processKey,
            statusesBeforeRestart.get(processKey) === 'terminated' ? 'terminated' : 'error'
          )
        )
        this.sessionLifecycle.notifyChanged(session)
        throw error
      }
      this.sessionLifecycle.notifyChanged(session)

      await this.runTerminalization.reconcilePending(session)
      return this.sessionReadModel.state(session)
    })
  }

  // Reads installed package metadata from the app-managed runtime bound to this session. The shared
  // env slot prevents the inventory scan from overlapping a package mutation, while still allowing
  // ordinary notebook runs to proceed. External runtimes are rejected because inventory capture must
  // execute their interpreter; notebookExecute provides the explicit execution approval for that case.
  async inspectPackages(request: InspectPackagesRequest): Promise<InspectPackagesResult> {
    return this.sessionLifecycle.runProjectOperation(request, () =>
      this.packageOperations.inspect(request)
    )
  }

  // Installs packages into the shared global environments (never inside a session/kernel). Resolves
  // the effective package mirror (configured override, else the region default) and forwards it as
  // installPackages' deps, so the conda/pip/CRAN install actually hits the configured mirror. Runs as
  // the exclusive writer of the target ENV's lock, so it drains and blocks every in-flight run on that
  // env — a pip/conda/CRAN install can never overlap a cell mid-import (§5, G2/D5). Installs into
  // DIFFERENT envs proceed concurrently (the lock is keyed by resolved env name, not language).
  async managePackages(request: InstallRequest): Promise<InstallResult> {
    const manage = (): Promise<InstallResult> => this.packageOperations.manage(request)
    if (request.projectId === undefined && request.sessionId === undefined) return manage()

    // Project admission is keyed only by project identity. InstallRequest intentionally keeps the
    // session fields optional because settings and repair flows can manage a global environment.
    return this.sessionLifecycle.runProjectOperation(request as NotebookSessionRequest, manage)
  }

  // Named-environment management (design D2), delegating to the injected provisioner-backed manager.
  // Only list returns the full current env set; remove REFUSES if any session currently has a live
  // executor process bound to that env name (locked decision — the on-disk env can't be rm-rf'd out
  // from under a running kernel). Mutations return bounded operation receipts, and create returns on
  // completion (progress streaming is out of scope).
  async manageEnvironments(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult> {
    return this.environmentManagement.manage(request)
  }

  // Shuts down one session executor and removes its in-memory routing state.
  async shutdown(
    request: NotebookSessionRequest
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    return this.executionOwner.withShellLaneTeardown(
      this.sessionLifecycle.laneForRequest(request),
      () => this.sessionLifecycle.shutdown(request)
    )
  }

  async shutdownSession(sessionId: string): Promise<{ sessionId: string; status: 'shutdown' }> {
    return this.executionOwner.withShellSessionTeardown(
      this.sessionLifecycle.rootLane(sessionId),
      () => this.sessionLifecycle.shutdownSession(sessionId)
    )
  }

  async shutdownProject(projectId: string): Promise<void> {
    return this.sessionLifecycle.shutdownProject(projectId)
  }

  async deleteProjectFileEvidence(projectId: string): Promise<void> {
    await deleteWorkingFileEvidenceProject(this.options.dataRoot, projectId)
  }

  async deleteSessionInputs(projectId: string, sessionId: string): Promise<void> {
    await Promise.all([
      deleteNotebookSessionInputs(this.options.dataRoot, projectId, sessionId),
      deleteNotebookSessionPromptInputs(this.options.dataRoot, projectId, sessionId)
    ])
  }

  async deleteProjectInputs(projectId: string): Promise<void> {
    await Promise.all([
      deleteNotebookProjectInputs(this.options.dataRoot, projectId),
      deleteNotebookProjectPromptInputs(this.options.dataRoot, projectId)
    ])
  }

  beginProjectDeletion(projectId: string): void {
    this.sessionLifecycle.beginProjectDeletion(projectId)
  }

  releaseProjectDeletion(projectId: string): void {
    this.sessionLifecycle.releaseProjectDeletion(projectId)
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
      language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV,
      this.options.platform
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

  async prepareRuntimeRepair(
    language: NotebookLanguage,
    target: ExplicitRuntimeRepairTarget
  ): Promise<void> {
    const environment = this.defaultEnvNameFor(language)
    let binding: InternalRuntimeBinding | undefined
    if (target.kind === 'default-environment') {
      if (target.environmentName !== environment) {
        throw new Error(
          `The selected runtime is no longer the app-managed ${language} default. Recheck runtimes and try again.`
        )
      }
      if (
        !this.isDefaultEnvRecoveryBlocked(language) &&
        !this.repairPolicy.requirement(language, environment).required
      ) {
        throw new Error(
          `The selected runtime is no longer the app-managed ${language} default. Recheck runtimes and try again.`
        )
      }
    } else {
      binding = await this.runtimeBindingOwner.requireManagedDefault(language, target.runtimeId)
    }
    await this.runtimeRepair.prepareExplicitRepair(language, binding)
  }

  // Called only after the explicit UI Runtime Reset has rebuilt and verified the managed default env.
  // This is deliberately separate from managePackages(): an ordinary install may clear an
  // interrupted-install marker, but it must never release a protected-identity quarantine.
  async completeRuntimeRepair(language: NotebookLanguage): Promise<void> {
    const replacement = await this.runtimeBindingOwner.requireManagedDefault(language)
    await this.runtimeRepair.completeExplicitRepair(language, replacement)
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
    return this.executionOwner.withShellTeardown(() => this.sessionLifecycle.shutdownAll())
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
    const shutdown = this.executionOwner.withShellTeardown(() => this.sessionLifecycle.dispose())
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
  getActiveNotebookSessions(): { projectId: string; sessionId: string }[] {
    return this.sessionLifecycle.activeSessions()
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
