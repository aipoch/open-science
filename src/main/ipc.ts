import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { app, BrowserWindow, net, Notification, protocol, webContents } from 'electron'

import { ipcMainHandle } from './ipc-handler-registry'
import {
  APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
  composeApplicationRuntimeWithAdapters,
  type ApplicationModuleBuilder
} from './application-runtime'

import { createAcpRuntime, createDefaultNotebookRuntimeService } from './acp/ipc'
import { createDefaultArtifactRepository, registerArtifactIpcHandlers } from './artifacts/ipc'
import { ArtifactProvenanceRepository } from './artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from './artifacts/provenance-message-snapshot'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { createComputeIpcModule } from './compute/ipc'
import { attachEnabledComputeHosts } from './compute/enabled-hosts-registry'
import { createComputeJobRuntime } from './compute/job-runtime'
import { waitForInitialConnectorRefresh, wireConnectorReload } from './connector-reload'
import { ApprovalBroker } from './connectors/approval-broker'
import { toCustomMcpConfig, selectEnabledCustomServers } from './connectors/custom-mcp-bootstrap'
import { McpClientManager } from './connectors/mcp-client-manager'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorService } from './connectors/service'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './connectors/provision'
import { registerFileSaveHandlers } from './file-save'
import { createSessionArtifactFileResolver } from './session-artifact-file-resolver'
import { registerCliInstallIpcHandlers } from './cli-install/ipc'
import { registerGithubIpcHandlers } from './github-ipc'
import {
  BackendShutdownCoordinator,
  QUIT_SHUTDOWN_BUDGET_MS,
  UPDATE_SHUTDOWN_BUDGET_MS
} from './lifecycle-shutdown'
import { registerLifecycleIpcHandlers } from './lifecycle-broadcast'
import { registerLogsIpcHandlers } from './logs-ipc'
import { registerWindowIpcHandlers } from './window-ipc'
import { registerWindowFindIpcHandlers } from './window-find-ipc'
import { TaskNotificationService } from './notifications/task-notifications'
import {
  buildSkillImportApprovalBroadcast,
  buildConnectorApprovalBroadcast,
  buildTaskNotificationShow
} from './notifications/electron-wiring'
import { createLogger, errorLogFields } from './logger'
import {
  broadcastNotebookEnvProgress,
  registerNotebookEnvIpcHandlers,
  serializeProvisioner
} from './notebook/env-ipc'
import { registerManagedPreviewIpcHandlers } from './managed-preview-ipc'
import { registerManagedPreviewProtocol } from './managed-preview-protocol'
import { ManagedPreviewResources } from './managed-preview-resources'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from './office-preview/office-preview-electron'
import { registerOfficePreviewIpcHandlers } from './office-preview/office-preview-ipc'
import {
  createOfficePreviewRuntimeUrl,
  registerOfficePreviewRuntimeProtocol
} from './office-preview/office-preview-runtime-protocol'
import { OfficePreviewSupervisor } from './office-preview/office-preview-supervisor'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { registerRuntimeIpcHandlers } from './notebook/runtime-ipc'
import { getRuntimeRoot } from './notebook/repository'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { NotebookInputRegistry } from './notebook/input-registry'
import { effectiveMirrorAsync } from './notebook/mirror-probe'
import { createProductionProvisioner, type RuntimeProvisioner } from './notebook/provisioner'
import { runtimeRoot } from './notebook/runtime-paths'
import type { NotebookEnvironmentManager } from './notebook/runtime-service'
import { parseArtifactVersionLocator } from '../shared/artifact-provenance'
import { DEFAULT_ARTIFACT_PROJECT_NAME } from '../shared/artifacts'
import type { NotebookLanguage } from '../shared/notebook'
import { OFFICE_PREVIEW_STATE_CHANNEL } from '../shared/office-preview'
import { prepareExternalPythonRuntime } from './notebook/venv-overlay'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  registerProjectIpcHandlers
} from './projects/ipc'
import { registerReviewerIpcHandlers } from './reviewer/ipc'
import {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers
} from './session-persistence/ipc'
import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from './session-persistence/conversation-export'
import { registerProjectFilesIpcHandlers } from './project-files/ipc'
import { createManagedFileIndexRepository } from './project-files/repository'
import { ProjectDeletionCoordinator } from './projects/deletion-coordinator'
import { getProjectDbClient } from './projects/prisma-client'
import { createPermissionGrantRegistry } from './permission-grants/registry'
import { isPermissionGrantScopeLive } from './permission-grants/scope-liveness'
import { registerPermissionGrantIpcHandlers } from './permission-grants/ipc'
import { reconcilePermissionGrantOwners } from './permission-grants/reconciliation'
import { SessionPersistenceCoordinator } from './session-persistence/coordinator'
import { type SessionPersistenceBackend } from './session-persistence/ipc'
import { tryDecryptKey } from './settings/crypto'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { getAppClaudeConfigDir } from './settings/provider-env'
import { createDefaultSettingsService, type SettingsService } from './settings/service'
import { createProfileService } from './specialist/service'
import { AgentsService } from './agents/agents-service'
import { PendingSessionSpecialistBindings } from './agents/pending-session-specialist-bindings'
import { passthroughApprovalGateway } from './agents/passthrough-approval-gateway'
import { registerSpecialistIpcHandlers } from './specialist/ipc'
import { SessionBindingService } from './specialist/session-binding'
import { SPECIALIST_IPC } from '../shared/specialist'
import type { StoredConnectors } from './settings/types'
import type { AppIconPreview, AppIconVariant, RespondApprovalRequest } from '../shared/settings'
import { registerStorageIpcHandlers } from './storage/ipc'
import { normalizeLegacyDataPaths } from './storage/normalize-legacy-paths'
import { detectActiveSessions } from './storage/detect-active'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveDataRoot,
  resolveStorageRoot,
  samePath
} from './storage-root'
import { registerUpdateIpcHandlers } from './update/ipc'
import { createUpdateStrategy } from './update/create-strategy'
import { startUpdateScheduler } from './update/scheduler'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'
import { broadcastToRenderers } from './renderer-broadcast'
import {
  installElectronRuntimeAdapters,
  type ElectronRuntimeAdapterInterfaces,
  type NamedElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { ConversationSkillImporter, SkillImportApprovalBroker } from './skills/conversation-import'
import type { ConversationSkillImportApprovalResponse } from '../shared/settings'

const permissionGrantsLog = createLogger('permission-grants')

type IpcRegistrationOptions = {
  mainEntryPath: string
  // Headless web-serve launches (--serve) have no local desktop user; task notifications are
  // disabled there by contract, not just incidentally via Notification.isSupported().
  headless?: boolean
  // Applies a newly-selected app-icon variant to the window + dock/taskbar. Supplied by the desktop
  // startup path; absent in web/headless mode (no local window to re-skin).
  onAppIconVariantChanged?: (variant: AppIconVariant) => void
  // Renders the built-in icon variants to preview data URLs for the Appearance picker.
  listAppIconPreviews?: () => AppIconPreview[]
}

export type ApplicationRuntimeInterfaces = {
  taskNotifications: Pick<
    TaskNotificationService,
    'setActivationHandler' | 'setAttentionHandlers' | 'setPendingOpenSession' | 'setUnreadHandler'
  >
  settingsService: Pick<
    SettingsService,
    'getAppIconVariant' | 'getClosePreference' | 'setClosePreference'
  >
  sessionDeletionCapability: Pick<SessionPersistenceCoordinator, 'setSessionDeletionHandlers'>
  detectActiveSessions: () => ReturnType<typeof detectActiveSessions>
}

type ApplicationModuleInterfaces = ApplicationRuntimeInterfaces & {
  readonly electronAdapters: ElectronRuntimeAdapterInterfaces
}

type IpcRegistration = ApplicationRuntimeInterfaces & {
  dispose: () => Promise<void>
}

// Builds a short, human-readable preview of a connector call's arguments for the approval card.
const previewArgs = (args: Record<string, unknown>): string => {
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    json = '{…}'
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

// Reads the connectors settings block and refreshes the mcp-<connector>/mcp-<server> skill docs to
// match — both the bundled catalog and any enabled custom MCP servers (stdio + remote). Called at
// startup;
// a future connectors-settings mutation (Plan 2/5 UI) should call this again so enable/disable
// (bundled or custom) takes effect without an app restart. Never throws — a bad read or a
// misconfigured/unreachable custom server (e.g. bad command) is logged and leaves the previous
// snapshot and on-disk docs in place rather than breaking bootstrap.
const refreshConnectorSkillDocs = async (
  settingsService: SettingsService,
  storageRoot: string,
  mcpClientManager: McpClientManager,
  onSnapshot: (connectors: StoredConnectors | undefined) => void
): Promise<void> => {
  try {
    const connectors = await settingsService.getConnectors()

    onSnapshot(connectors)
    const skillsDir = join(getAppClaudeConfigDir(storageRoot), 'skills')

    // Opt-out model: every bundled connector is enabled unless explicitly disabled.
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])
    const enabledIds = ALL_CONNECTOR_IDS.filter((id) => !disabled.has(id))

    await syncConnectorSkillDocs(skillsDir, enabledIds)
    await syncCustomServerSkillDocs(skillsDir, selectEnabledCustomServers(connectors), (server) =>
      mcpClientManager.listTools(toCustomMcpConfig(server))
    )
  } catch (error) {
    console.error('Failed to sync connector skill docs:', error)
  }
}

// Constructs application-owned modules and their narrow Electron adapter interfaces. The factory does
// not register a channel or protocol; transport installation happens only after construction succeeds.
const createApplicationModules = async (
  {
    mainEntryPath,
    headless = false,
    onAppIconVariantChanged,
    listAppIconPreviews
  }: IpcRegistrationOptions,
  modules: ApplicationModuleBuilder
): Promise<ApplicationModuleInterfaces> => {
  const beforeComputeAdapters: NamedElectronSurfaceAdapter[] = []
  const beforeAcpAdapters: NamedElectronSurfaceAdapter[] = []
  const afterAcpAdapters: NamedElectronSurfaceAdapter[] = []
  let surfaceAdapters = beforeComputeAdapters
  const declareElectronAdapter = (
    name: string,
    install: NamedElectronSurfaceAdapter['install']
  ): void => {
    surfaceAdapters.push({ name, install })
  }
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsService = await modules.add(undefined, () => ({
    capability: createDefaultSettingsService()
  }))
  const storedSettings = await settingsService.getStoredSettings()
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot)
  // Recovery breadcrumb: if settings.json is ever lost/corrupted, the resolved dataRoot from the
  // last successful launch is still findable in the logs, so a user with data at a non-default
  // location isn't left guessing where it went.
  createLogger('storage').info('data root resolved', {
    dataRoot: resolveDataRoot(),
    isDefault: samePath(resolveDataRoot(), computeDefaultDataRoot())
  })

  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const uploadRepository = createDefaultUploadRepository()
  try {
    await uploadRepository.recoverStagingUploads()
  } catch (error) {
    // Ready bytes remain fail-closed; keep startup available so Files can surface unaffected rows and
    // the next launch can retry any recoverable staging Version.
    createLogger('storage').error(
      'staging upload recovery incomplete; will retry next launch',
      error
    )
  }
  const sessionRepository = createDefaultSessionRepository()
  const projectRepository = createDefaultProjectRepository()
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    try {
      await normalizeLegacyDataPaths({
        sessionRepository,
        sessionUploads: uploadRepository,
        previewStateRepository,
        projectRepository,
        dataRoot: resolveDataRoot()
      })
      await settingsService.markPathsNormalized()
    } catch (error) {
      createLogger('storage').error(
        'legacy path normalization failed; will retry next launch',
        error
      )
    }
  }

  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const artifactProvenanceRepository = new ArtifactProvenanceRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot()),
    compatibilityRepository: artifactRepository,
    loadSession: (projectId, appSessionId) => sessionRepository.loadSession(projectId, appSessionId)
  })
  const provenanceMessageSnapshots = new ProvenanceMessageSnapshotRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  const artifactRunRegistry = new ArtifactRunRegistry()
  // The upload repository above is shared so staging recovery, Session upgrade, prompt finalization,
  // and previews all observe one durable Version authority.
  const notebookInputRegistry = new NotebookInputRegistry({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    source: 'artifact' | 'upload' | 'notebook-input',
    request: { path: string; projectId?: string; sessionId?: string }
  ): Promise<string> =>
    source === 'artifact'
      ? (() => {
          const versionIdentity = parseArtifactVersionLocator(request.path)
          return versionIdentity
            ? artifactProvenanceRepository
                .resolveVersionContent(versionIdentity)
                .then((resolved) => resolved.path)
            : artifactRepository.resolveManagedFilePath(request)
        })()
      : source === 'upload'
        ? uploadRepository.resolveManagedUploadPath(request, {
            projectId: request.projectId,
            sessionId: request.sessionId
          })
        : notebookInputRegistry
            .resolvePreviewKey(request.path)
            .then((target) => target.absolutePath)
  const resolveSessionArtifactFilePath = createSessionArtifactFileResolver({
    compatibilityProjectName: DEFAULT_ARTIFACT_PROJECT_NAME,
    resolveVersionContent: (identity) =>
      artifactProvenanceRepository.resolveVersionContent(identity),
    resolveLegacyArtifactPath: (projectName, sessionId, path) =>
      artifactRepository.resolveSessionArtifactFilePath(projectName, sessionId, path)
  })
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    resolvePath: resolveManagedFilePath
  })

  // Permission scope validation starts before the ACP coordinator is constructed. Keep the late-bound
  // reference here so a first-turn Session grant can recognize its live owner before the renderer's
  // asynchronous session persistence finishes.
  const runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined } = {
    current: undefined
  }

  // Construct one storage/index/deletion graph for every related IPC surface. Sharing these instances
  // is essential: separate coordinators would have independent queues and recovery gates.
  const configRoot = resolveStorageRoot()
  const permissionGrantRegistry = await createPermissionGrantRegistry({
    getClient: () => getProjectDbClient(configRoot),
    isScopeLive: (scope) =>
      isPermissionGrantScopeLive(scope, {
        projectExists: async (projectId) => (await projectRepository.get(projectId)) !== undefined,
        persistedSessionExists: async (projectId, sessionId) =>
          (await sessionRepository.loadSession(projectId, sessionId)) !== undefined,
        liveSessionExists: (projectId, sessionId) =>
          runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false
      })
  })
  const projectFilesRepository = createManagedFileIndexRepository(
    getProjectDbClient,
    configRoot,
    resolveDataRoot()
  )
  const sessionPersistenceCoordinator = new SessionPersistenceCoordinator(
    sessionRepository,
    projectFilesRepository,
    (event) => broadcastToRenderers('project-files:changed', event),
    provenanceMessageSnapshots,
    uploadRepository,
    artifactProvenanceRepository,
    {
      reconcileSessions: (sessions) =>
        reconcilePermissionGrantOwners(permissionGrantRegistry, { sessions })
    }
  )
  const reviewRepository = createDefaultReviewRepository()
  const projectDeletionCoordinator = new ProjectDeletionCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    previewStateRepository,
    reviewRepository,
    artifactProvenanceRepository,
    permissionGrantRegistry
  )
  // Stashed host.agents.switch bindings for sessions that are not yet durable (fresh unsent drafts),
  // flushed to disk on the session's first save so an approved switch survives an app restart before
  // the next message. Shared by persistSessionSpecialist (stash) and saveSession (flush).
  const pendingSpecialistBindings = new PendingSessionSpecialistBindings()
  const sessionPersistenceBackend: SessionPersistenceBackend = {
    loadAll: () =>
      loadSessionsAfterProjectRecovery(projectDeletionCoordinator, sessionPersistenceCoordinator),
    saveSession: async (session, options) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      const created =
        (await sessionRepository.loadSession(session.projectId, session.id)) === undefined
      const durableSession = await sessionPersistenceCoordinator.saveSession(session, options)
      // Flush any approved host.agents.switch binding stashed while this session was not yet durable,
      // so the approved target survives a restart before the next message (the in-memory binding
      // alone does not persist across restart).
      if (pendingSpecialistBindings.has(durableSession.id)) {
        const specialistId = pendingSpecialistBindings.take(durableSession.id)
        await sessionPersistenceCoordinator.saveSessionSpecialistBinding(
          durableSession,
          specialistId
        )
      }
      return { created, session: durableSession }
    },
    deleteSession: async (projectId, sessionId) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      const result = await sessionPersistenceCoordinator.deleteSession(projectId, sessionId)
      await permissionGrantRegistry.prune({ kind: 'session', projectId, sessionId })
      return result
    },
    saveManifest: async (request) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      return sessionPersistenceCoordinator.saveManifest(request)
    }
  }
  let backendTeardownOwnedByCoordinator = false
  const notebookService = await modules.add(
    {
      getPackageMirror: () => settingsService.getPackageMirror(),
      getRuntimeEnablement: (language: NotebookLanguage) =>
        settingsService.getRuntimeEnablement(language),
      getManualInterpreters: (language: NotebookLanguage) =>
        settingsService.getManualInterpreters(language)
    },
    (settings) => {
      const notebook = createDefaultNotebookRuntimeService(settings)
      return {
        name: 'notebook-runtime',
        capability: notebook,
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        rollback: () =>
          backendTeardownOwnedByCoordinator ? undefined : notebook.dispose().then(() => undefined)
      }
    }
  )

  // Read fresh on every call so a future connectors-settings mutation (Plan 2 UI) only needs to call
  // refreshConnectorSkillDocs again to take effect, without reconstructing the connector service.
  let connectorsSnapshot: StoredConnectors | undefined
  // Resolved lazily per connector call so dispatch always sees the latest persisted Specialist profile.
  const profileService = createProfileService(resolveStorageRoot())
  // Per-session specialist binding store. Shared between the SET_SESSION_SPECIALIST barrier
  // (validate + record) and the runtime switch so a hot-switch lands on the same source of truth.
  const sessionBindingService = new SessionBindingService(profileService)
  // Desktop notifications for finished/failed agent tasks and approval waits. Delivery is
  // Electron's Notification (Notification Center on macOS, toasts on Windows, libnotify on Linux);
  // the service itself stays Electron-free so its filtering rules are unit-testable. The click
  // handler is bound later, in index.ts, where showMainWindow exists. Constructed before the
  // connector approval broker, which nudges through it.
  //
  // The wiring is extracted into electron-wiring helpers so the headless gate and the broker→service
  // sessionId pass-through have a unit-level home — inline closures were untestable, and a
  // regression on either of those contracts would not be caught by TaskNotificationService tests.
  const notificationsLog = createLogger('notifications')
  const liveNotifications = new Set<Notification>()
  const taskNotifications = new TaskNotificationService({
    isEnabled: () => settingsService.getNotificationsEnabled(),
    isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    show: buildTaskNotificationShow({
      notificationCtor: Notification,
      liveNotifications,
      log: notificationsLog,
      headless
    }),
    onDeliveryError: (error) =>
      notificationsLog.warn('task notification delivery failed', errorLogFields(error)),
    onAttentionError: (error) =>
      notificationsLog.warn('desktop attention handler failed', errorLogFields(error)),
    onUnreadError: (error) =>
      notificationsLog.warn('unread task handler failed', errorLogFields(error))
  })
  // The renderer peeks once sessions are hydrated, then conditionally consumes the same target.
  // This lets partial recovery open an already-loaded conversation while retaining an omitted one
  // for retry, without an older IPC round trip clearing a newer click target.
  declareElectronAdapter('task-notifications', () => {
    ipcMainHandle('notifications:peek-pending-open-session', () =>
      taskNotifications.peekPendingOpenSession()
    )
    ipcMainHandle('notifications:take-pending-open-session', (_event, expectedToken: unknown) =>
      typeof expectedToken === 'number' && Number.isSafeInteger(expectedToken) && expectedToken > 0
        ? taskNotifications.takePendingOpenSession(expectedToken)
        : null
    )
  })
  // One MCP client manager backs both dispatch (ConnectorService.call → custom server) and skill-doc
  // generation (listTools) for user-added custom MCP servers (stdio + remote). It lazily connects per
  // server, so constructing it here does not spawn anything until a custom server is actually used.
  const mcpClientManager = await modules.add(undefined, () => {
    const manager = new McpClientManager()
    return {
      name: 'mcp-client-manager',
      capability: manager,
      dispose: () => manager.closeAll()
    }
  })
  // Bridges un-trusted connector calls to the renderer approval card. A tool call that isn't
  // pre-allowed or skip-approved is held here until the user decides (or it auto-denies on timeout).
  const approvalBroker = new ApprovalBroker({
    generateId: () => randomUUID(),
    broadcast: buildConnectorApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications,
      onNotificationError: (error) =>
        notificationsLog.warn('connector approval notification failed', errorLogFields(error))
    })
  })
  // The late-bound app runtime also serves connector tools that attach a generated file to the current
  // turn. It is created below because it depends on the connector service.
  const skillImportApprovalBroker = new SkillImportApprovalBroker({
    generateId: () => randomUUID(),
    broadcast: buildSkillImportApprovalBroadcast({
      broadcastToRenderers,
      taskNotifications,
      onNotificationError: (error) =>
        notificationsLog.warn('skill import approval notification failed', errorLogFields(error))
    }),
    onSettled: (id) => broadcastToRenderers('skills:conversation-import-settled', id)
  })
  const conversationSkillImporter = new ConversationSkillImporter({
    uploads: uploadRepository,
    createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
      skillImportApprovalBroker.createCancellationGuard(sessionId, turnToken, attachmentUri),
    previewBundle: (bundle) => settingsService.previewSkillArchive(bundle),
    importBundle: (bundle, items) => settingsService.importSkillArchiveBatch(bundle, items),
    requestApproval: (request, cancellation) =>
      skillImportApprovalBroker.request(request, cancellation),
    // If a prompt is active the coordinator defers the reconnect until its terminal event, making the
    // new Skill available on the next user turn without interrupting the importing tool call.
    onSkillsChanged: () => void runtimeRef.current?.requestSkillsReload()
  })
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (sessionId, input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(sessionId, input)
    }
  })
  const connectorService = new ConnectorService({
    getConnectors: () => connectorsSnapshot,
    getConnectorsFresh: () => settingsService.getConnectors(),
    resolveApiKey: (ref) => tryDecryptKey(ref),
    mcpClientManager,
    permissionGrantRegistry,
    requestApproval: ({ connector, method, args, sessionId, availableScopes }) =>
      approvalBroker.request({
        connector,
        method,
        argsPreview: previewArgs(args),
        ...(sessionId ? { sessionId } : {}),
        availableScopes
      }),
    resolveSpecialistProfile: async (specialistId) => {
      try {
        return await profileService.getById(specialistId)
      } catch {
        return undefined
      }
    },
    localToolHandlers: { 'molecule/preview_molecule': moleculePreviewHandler }
  })
  // Register compute IPC handlers early so computeService can be wired into the notebook RPC server.
  // The approval broker in compute/ipc.ts broadcasts via BrowserWindow.getAllWindows(), which requires
  // Electron to be ready — this is always the case here since we're inside registerIpcHandlers.
  // Adapt the artifact repository to the ArtifactResolver shape so job input staging can upload
  // absolute artifact-store paths (validated to stay inside the store by resolveManagedFilePath).
  const computeArtifactResolver = {
    resolveArtifactPath: (path: string) => artifactRepository.resolveManagedFilePath({ path })
  }
  const computeIpcModule = createComputeIpcModule(
    undefined,
    undefined,
    computeArtifactResolver,
    undefined,
    taskNotifications,
    permissionGrantRegistry
  )
  surfaceAdapters = beforeAcpAdapters
  const {
    computeService,
    jobRepository,
    hostRepository,
    enabledComputeHostsRegistry: hostsRegistry
  } = computeIpcModule
  const dataRoot = resolveDataRoot()
  // Start the JobPoller wired to the shared broadcaster so every state/tail change is pushed to all
  // renderer windows via 'compute:job-updated' (Phase 3d, design.md §9 + §15.3). The dispatcher
  // (inside ComputeService) uses the same hook, so submitted→running/error transitions broadcast too.
  // Phase 3b: harvestFn drives automatic harvest on terminal transitions; broadcast + storageRoot
  // wire the compute_done notification emitter for all three terminal outcomes (issue 06).
  await modules.add(
    { computeService, hostRepository, jobRepository, storageRoot: dataRoot },
    (dependencies) => {
      const jobPoller = createComputeJobRuntime(dependencies)
      return {
        name: 'compute-job-runtime',
        capability: undefined,
        start: () => jobPoller.start(),
        dispose: () => jobPoller.stop()
      }
    }
  )
  // Augment computeService with getEnabledComputeHosts so the RPC server can serve list_compute.
  // Must preserve ComputeService's prototype methods (list/getDetails/submitJob/...) — see the helper.
  const computeServiceWithRegistry = attachEnabledComputeHosts(computeService, hostsRegistry)
  // host.agents control-plane SDK (issue 02/05): read Specialist/catalog surface plus the durable
  // next-message switch lifecycle. The catalog adapter delegates to the authoritative
  // SettingsService + ProfileService; switch() reuses the SAME SessionBindingService and durable
  // session-file persistence seam the SET_SESSION_SPECIALIST IPC handler uses (no parallel switch
  // service). The runtime reconfigure callback is intentionally NOT wired here — it runs at the safe
  // next-message boundary, not inside the SDK call. Issue 08 composes the pass-through approval
  // gateway + SwitchNotifier + catalog invalidation here so delete/name-change/switch reach
  // ProfileService end-to-end; the standard ACP permission card is a separate later issue.
  const agentsService = new AgentsService({
    profileService,
    catalog: {
      listSkillCatalog: () => settingsService.listSpecialistSkillCatalog(),
      getConnectors: () => settingsService.getConnectors()
    },
    sessionBinding: sessionBindingService,
    // Pass-through approval gateway (issue 08a milestone). Privileged Specialist operations
    // (name-changing update, delete, switch) route THROUGH this seam; in this milestone the
    // user-facing confirmation is the /customize Skill's chat-text review, so the gateway always
    // approves. Swapping in the future standard-card ACP gateway requires no dispatcher/Skill/contract
    // change — only this injected implementation. It holds no pending state (no second approval store).
    approvalGateway: passthroughApprovalGateway,
    // SwitchNotifier broadcasts ONLY the session id + target public name (null = Main Agent) over the
    // existing specialist:pending-switch channel — never system instructions, UUIDs, secrets, or tokens.
    // The renderer closure (issue 08b) subscribes; main-side broadcast is owned by this slice.
    switchNotifier: {
      notify: (pending) => {
        broadcastToRenderers(SPECIALIST_IPC.PENDING_SWITCH, pending)
      }
    },
    // Catalog invalidation after a successful privileged mutation: reconnect live sessions so the
    // agent respawns (re-provisioning skills) and re-applies the updated Specialist whitelist. The
    // ProfileService already broadcasts specialist:catalog-changed on update/delete; this refreshes the
    // RUNTIME capability resolution (mirrors the Settings IPC path's onProfilesChanged callback).
    invalidateCatalog: () => void runtime.requestSkillsReload(),
    persistSessionSpecialist: async (sessionId, specialistId) => {
      const allSessions = await sessionRepository.loadAll()
      const session = allSessions.sessions.find((s) => s.id === sessionId)
      if (!session) {
        // The calling session is a fresh unsent draft that is not yet on disk. Stash the approved
        // binding so the save path flushes it on first persist — otherwise an app restart before the
        // first save would silently lose the approved switch (only the in-memory binding survives).
        pendingSpecialistBindings.stash(sessionId, specialistId)
        specialistPersistLog.debug(
          'session not yet durable; stashed specialist binding for first save',
          {
            sessionId,
            specialistId
          }
        )
        return
      }
      // The session is already durable: this write is authoritative, so drop any stale stash.
      pendingSpecialistBindings.take(sessionId)
      await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId)
    }
  })
  const notebookRpcServer = new NotebookLocalRpcServer(notebookService, {
    connectorService,
    computeService: computeServiceWithRegistry,
    skillImporter: conversationSkillImporter,
    artifactProvenance: {
      createVersion: (request) =>
        sessionPersistenceCoordinator.runSessionMutation(
          request.projectId,
          request.appSessionId,
          () => artifactProvenanceRepository.createVersion(request)
        ),
      replayVersion: (request) =>
        sessionPersistenceCoordinator.runSessionMutation(
          request.projectId,
          request.appSessionId,
          () => artifactProvenanceRepository.replayVersion(request)
        )
    },
    inputRegistry: notebookInputRegistry,
    agentsService
  })
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(({ sessionId, projectId }) =>
    notebookRpcServer.issueControlConnection(sessionId, projectId)
  )
  // The renderer's approval card responds here; the broker resolves the held connector call.
  declareElectronAdapter('connector-approvals', () => {
    ipcMainHandle('connectors:approval-respond', (_event, request: RespondApprovalRequest) => {
      approvalBroker.respond(request.id, request.decision)
    })
    ipcMainHandle(
      'skills:conversation-import-respond',
      (_event, response: ConversationSkillImportApprovalResponse) => {
        skillImportApprovalBroker.respond(response)
      }
    )
    ipcMainHandle('skills:conversation-import-replay-pending', () => {
      skillImportApprovalBroker.replayPending()
    })
  })

  const initialConnectorSkillsReady = waitForInitialConnectorRefresh(
    refreshConnectorSkillDocs(
      settingsService,
      resolveStorageRoot(),
      mcpClientManager,
      (connectors) => {
        connectorsSnapshot = connectors
      }
    ),
    {
      // If custom MCP discovery outlives the startup barrier, the first agent may already have
      // materialized the old connector docs. Rotate it once the late refresh settles so the next
      // session/prompt uses the refreshed skills instead of waiting for another settings change.
      onLateSettled: () => runtimeRef.current?.requestSkillsReload()
    }
  )

  // Repair soft-owner grants left behind if the app stopped between deleting a Connector/ComputeHost
  // and pruning its authority. A failed/timeout Connector refresh leaves that owner class untouched;
  // app-owned MCP catalog ids are non-UUID and are never guessed to be stale.
  void initialConnectorSkillsReady
    .then(async () => {
      const hosts = await hostRepository.list()
      await reconcilePermissionGrantOwners(permissionGrantRegistry, {
        ...(connectorsSnapshot
          ? {
              customServerIds: connectorsSnapshot.customMcpServers?.map((server) => server.id) ?? []
            }
          : {}),
        computeProviderIds: hosts.map((host) => host.providerId)
      })
    })
    .catch((error) =>
      permissionGrantsLog.error(
        'permission grant owner reconciliation failed',
        errorLogFields(error)
      )
    )

  declareElectronAdapter('desktop-utilities', () => {
    registerFileSaveHandlers({ resolveManagedFilePath, resolveSessionArtifactFilePath })
    registerLogsIpcHandlers()
    registerGithubIpcHandlers()
    registerCliInstallIpcHandlers()
    registerWindowIpcHandlers()
    registerWindowFindIpcHandlers()
  })
  // ACP identity resolution and the Specialist settings IPC must use the same service instance.
  // Creating it only for settings leaves create-session unable to resolve a selected UUID.
  const runtime = await modules.add(
    {
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      uploadRepository,
      notebookRpcServer,
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      permissionGrantRegistry,
      taskNotifications,
      onSessionTurnStarted: (sessionId, turnToken) =>
        skillImportApprovalBroker.beginSessionTurn(sessionId, turnToken),
      onSessionTurnEnded: (sessionId, turnToken) =>
        skillImportApprovalBroker.endSessionTurn(sessionId, turnToken),
      onSkillImportAttachmentEligible: (sessionId, turnToken, attachmentUri) =>
        skillImportApprovalBroker.allowSessionTurnAttachment(sessionId, turnToken, attachmentUri),
      onSessionCancellationRequested: (sessionId) =>
        skillImportApprovalBroker.cancelSession(sessionId),
      onSessionUnavailable: (sessionId) => skillImportApprovalBroker.cancelSession(sessionId),
      onAllSessionsCancellationRequested: () => skillImportApprovalBroker.cancelAll(),
      beforeSessionDelete: (sessionId) =>
        notebookService.shutdownSession(sessionId).then(() => undefined),
      initializationBarrier: initialConnectorSkillsReady,
      profileService
    },
    (options) => {
      const runtime = createAcpRuntime(options)
      return {
        name: 'acp-runtime',
        capability: runtime,
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        rollback: () =>
          backendTeardownOwnedByCoordinator
            ? undefined
            : runtime.shutdownForQuit().then(() => undefined)
      }
    }
  )
  surfaceAdapters = afterAcpAdapters
  runtimeRef.current = runtime
  permissionGrantRegistry.subscribe(() => runtime.notifyPermissionGrantsChanged())
  // Single shared teardown owner for both the before-quit handler (index.ts) and the pre-update-install
  // gate. Update handling is deliberately constructed below, after this dependency is complete.
  const shutdownCoordinator = new BackendShutdownCoordinator({
    runtime,
    notebook: notebookService,
    log: createLogger('shutdown')
  })
  // Construct update handling only after its backend-shutdown gate exists. The in-place strategy owns
  // this immutable dependency from construction; the manifest fallback ignores it because it does not
  // quit the running app to install.
  const updateStrategy = createUpdateStrategy(process.platform, {
    installGate: () => shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS)
  })
  let stopUpdateScheduler: (() => void) | undefined
  await modules.add(undefined, () => ({
    name: 'update-scheduler',
    capability: undefined,
    dispose: () => stopUpdateScheduler?.()
  }))
  declareElectronAdapter('update', () => {
    const updateService = registerUpdateIpcHandlers(updateStrategy)
    stopUpdateScheduler = startUpdateScheduler(updateService)
  })
  // Spawn-config changes rotate the coordinator's runtime for future sessions. Existing sessions retain
  // their owning runtime, so a framework/provider switch cannot interrupt an in-flight turn.
  let invalidatePermissionProjection = (): void => {
    broadcastToRenderers('permissions:changed', { revision: Date.now() })
  }
  declareElectronAdapter('settings', () =>
    registerSettingsIpcHandlers({
      service: settingsService,
      onActiveProviderChanged: () => void runtime.requestProviderReconnect(),
      onAgentFrameworkChanged: () => void runtime.requestAgentFrameworkSwitch(),
      onReasoningEffortChanged: (effort) => runtime.applyReasoningEffortChange(effort),
      onSkillsChanged: () => void runtime.requestSkillsReload(),
      // Re-sync bundled + custom skill docs and refresh the in-memory snapshot the connector
      // service reads, then request a skills reload. The reload respawns the agent on next idle so a
      // non-Claude framework (Codex, opencode) — whose connector docs are materialized into its own
      // home at spawn — picks up the change too, not just the Claude config dir.
      onConnectorsChanged: () => {
        // Connector policy shadows or reactivates grants without mutating them. Republish the shared
        // projection immediately so both Settings surfaces describe the same effective decision.
        invalidatePermissionProjection()
        void wireConnectorReload(
          () =>
            refreshConnectorSkillDocs(
              settingsService,
              resolveStorageRoot(),
              mcpClientManager,
              (connectors) => {
                connectorsSnapshot = connectors
              }
            ),
          () => void runtime.requestSkillsReload()
        )
      },
      onCustomServerRemoved: (serverId) =>
        permissionGrantRegistry.prune({ kind: 'mcp_server', serverId }).then(() => undefined),
      onCustomServerSecurityChanged: async (serverId) => {
        const guard = connectorService.beginCustomServerSecurityChange(serverId)
        try {
          await permissionGrantRegistry.prune({ kind: 'mcp_server', serverId })
          return guard
        } catch (error) {
          guard.rollback()
          throw error
        }
      },
      onAppIconVariantChanged,
      listAppIconPreviews
    })
  )
  declareElectronAdapter('notebook', () => registerNotebookIpcHandlers(notebookService))
  // Wire session deletion to the binding store so stale in-memory bindings do not accumulate.
  // The renderer calls sessions:delete-session (via sessionPersistenceBackend) and acp:delete-session
  // separately; both paths should clear the binding. Override the backend deleteSession callback here
  // so all durable-path deletions — regardless of whether the ACP session was attached — clear the
  // binding in one place.
  const originalDeleteSession =
    sessionPersistenceBackend.deleteSession.bind(sessionPersistenceBackend)
  sessionPersistenceBackend.deleteSession = async (projectId, sessionId) => {
    await originalDeleteSession(projectId, sessionId)
    sessionBindingService.clearSession(sessionId)
  }
  const specialistPersistLog = createLogger('specialist:persist')
  declareElectronAdapter('specialist', () =>
    registerSpecialistIpcHandlers(
      profileService,
      sessionBindingService,
      // Persist only the specialist UUID to the durable session file — never a profile snapshot.
      // Read the current session file, patch specialistId, and save so the binding survives restarts.
      // Reading all sessions to locate the target is intentional: sessionId alone is not sufficient to
      // open the file (it lives under sessions/<projectId>/<sessionId>.json), and this operation is
      // infrequent enough that the scan cost is acceptable.
      async (sessionId, specialistId) => {
        const allSessions = await sessionRepository.loadAll()
        const session = allSessions.sessions.find((s) => s.id === sessionId)
        if (!session) {
          // The session has not yet been persisted (created but not saved). The specialistId will be
          // written when the renderer calls sessions:save-session for the first time.
          specialistPersistLog.debug(
            'session not yet durable; specialistId will be written on first save',
            {
              sessionId,
              specialistId
            }
          )
          return
        }
        await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId)
      },
      // Apply the switch to the live agent runtime. `runtime` is assigned above (registerAcpIpcHandlers),
      // but the closure is invoked per-request so a late-bound reference is unnecessary.
      (sessionId, specialistId) => runtime.switchSpecialist(sessionId, specialistId),
      // A specialist capability edit (skills/connectors/enabled) must reach live sessions on the next
      // turn: reconnect so the agent respawns (re-provisioning skills) and resumes with the updated
      // specialist whitelist in the session _meta.
      () => void runtime.requestSkillsReload()
    )
  )
  // Runtime selection UI (Settings/Onboarding): survey managed+external per language, persist the
  // choice, and pick an interpreter file. The runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  declareElectronAdapter('notebook-runtime', () =>
    registerRuntimeIpcHandlers({
      settingsService,
      runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
      // WS10: revoke a disabled runtime from any live session bound to it (mark binding unavailable).
      onRuntimeDisabled: (language, envId, force) =>
        notebookService.revokeRuntime(language, envId, { force }),
      // WS11: live-session usage of a runtime, for the disable-impact warning.
      describeRuntimeUsage: (language, envId) =>
        notebookService.describeRuntimeUsage(language, envId),
      prepareExternalPython: async (selection, root) => {
        const configuredMirror = await settingsService.getPackageMirror()
        const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
        await prepareExternalPythonRuntime(selection, root, {
          pypiIndex: mirror.pypiIndex,
          caBundle: mirror.caBundle
        })
      }
    })
  )
  declareElectronAdapter('managed-preview', () => {
    registerManagedPreviewIpcHandlers(previewResources)
    registerManagedPreviewProtocol(previewResources)
  })
  declareElectronAdapter('office-preview-runtime', () =>
    registerOfficePreviewRuntimeProtocol(
      {
        runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html'),
        devServerUrl: process.env['ELECTRON_RENDERER_URL'],
        fetchRuntime: (targetUrl, request) =>
          net.fetch(targetUrl, {
            // Runtime assets are public application files. Forwarding custom-protocol headers or its
            // abort signal makes Chromium treat the local fetch as a cross-site renderer request.
            method: request.method
          })
      },
      protocol
    )
  )
  const officePreviewSupervisor = new OfficePreviewSupervisor({
    inspectResource: ({ source, path }) => previewResources.inspect({ source, path }),
    acquireResource: (ownerId, request, snapshot, maxBytes) =>
      previewResources.acquire(
        ownerId,
        { source: request.source, path: request.path },
        { snapshot, maxBytes }
      ),
    releaseResource: (ownerId, resourceId) => previewResources.release(ownerId, { resourceId }),
    createSessionId: randomUUID,
    createRuntimeUrl: createOfficePreviewRuntimeUrl,
    resolveFrameProcess: createOfficePreviewFrameProcessResolver(webContents),
    getProcessMemoryUsageBytes: createOfficePreviewProcessMemoryReader(app),
    publishState: (ownerId, state) =>
      webContents.fromId(ownerId)?.send(OFFICE_PREVIEW_STATE_CHANNEL, state)
  })
  declareElectronAdapter('office-preview', () =>
    registerOfficePreviewIpcHandlers(officePreviewSupervisor)
  )

  // Resolve the shared conda base under the app data root (relocatable, where the runtime install
  // lives) and start the env readiness gate. The conda channel comes from the effective package mirror
  // (configured override, else the region default from locale). Runtime packs use the official CDN base
  // with OPEN_SCIENCE_ENV_CDN_BASE available for private/self-hosted deployments.
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
    provisioner = createProductionProvisioner({
      root: provisioningRoot,
      channel: mirror.condaChannel ?? process.env.OPEN_SCIENCE_CONDA_CHANNEL ?? 'conda-forge',
      caBundle: mirror.caBundle,
      micromamba: { resourcesPath: process.resourcesPath },
      // Self-guard the provisioner's prefix writes (startup restore/upgrade/repair, named create, lazy
      // materialize) against a prefix crash-recovery could not confirm free of a live orphan — closes
      // the startup-gate path the UI-only assertProvisionAllowed guard did not cover. Reads the live
      // blocked set at call time (recovery is awaited before the gate touches any prefix).
      isPrefixBlocked: (prefix) => notebookService.isPrefixRecoveryBlocked(prefix),
      // An explicit user Reset (repair with force) clears the in-memory block; the provisioner also
      // clears the retained journal record + sidecar so the quarantine doesn't re-arm next startup.
      clearPrefixBlock: (prefix) => notebookService.clearRecoveryBlock(prefix),
      // Reset also clears an interrupted install's runtime-ID block, or bound sessions would still be
      // rejected after the env rebuilds until the next restart.
      clearRuntimeBlock: (runtimeId) => notebookService.clearRuntimeRecoveryBlock(runtimeId),
      // A force Reset that finds the journal itself corrupt moves it aside and releases just THAT prefix
      // from the global corrupt-journal barrier — other envs stay blocked until their own Reset/restart.
      clearCorruptBlock: (prefix) => notebookService.clearCorruptRecoveryBlock(prefix),
      // On an unconfirmed-child prefix-write failure, block the prefix in-process immediately so an
      // in-session retry can't begin() a second op that races the first's possibly-live orphan.
      blockPrefix: (prefix) => notebookService.blockPrefixRecovery(prefix),
      // Lets a force Reset refuse a prefix an interrupted install (or prefix write) this session left with
      // a possibly-live orphan — the provisioner can't see install failures in its own set.
      isPrefixLiveUnconfirmed: (prefix) => notebookService.isPrefixLiveUnconfirmed(prefix),
      // Share the service's per-env install lock so a default-env create/repair/upgrade serializes with
      // a package install into the same env prefix instead of racing it on a separate lock.
      withPrefixLock: (envName, fn) => notebookService.withEnvLock(envName, fn)
    })
    // One serialized wrapper shared by the startup gate and the notebook service's on-demand default
    // provisioning, so a concurrent build of the same default env (UI R-tab + an agent R run) can't
    // race the provisioner's shared in-flight flag; materialize is also idempotent as a backstop.
    serialized = serializeProvisioner(provisioner)
  } catch (error) {
    // micromamba missing (e.g. dev without a staged binary): the notebook env stays unprovisioned and
    // the UI surfaces "runtime unavailable" rather than crashing startup or dropping the IPC handlers.
    console.error('Notebook environment provisioning unavailable:', error)
  }
  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight (orphan
  // download staging, a half-built prefix, an interrupted install). Kicked off HERE — before the env
  // IPC gate below — so recoverInterruptedOperations() publishes its barrier synchronously and every
  // prefix-touching path (the startup gate's restore/upgrade/repair, UI provision/repair, named-env
  // create, on-demand materialize, install) can await it and never race recovery's cleanup/delete.
  // Fire-and-forget so a slow/failed recovery never blocks IPC registration; the barrier itself is what
  // actually orders the prefix work.
  void notebookService
    .recoverInterruptedOperations()
    .catch((error) => console.error('Notebook operation recovery failed:', error))
  const waitForRecovery = (): Promise<void> => notebookService.ensureRecovered()
  // Lets UI provision/repair refuse when recovery left the default env's prefix blocked (an
  // unknown-liveness orphan may still be writing it) — throws with an actionable message.
  const assertProvisionAllowed = (language: NotebookLanguage): void => {
    if (notebookService.isDefaultEnvRecoveryBlocked(language)) {
      throw new Error(
        `The ${language} runtime is recovering from an interrupted operation whose process could not be ` +
          'confirmed stopped. Restart the app to re-check and recover it before setting it up again.'
      )
    }
  }

  // Always register the handlers (serialized is undefined when the provisioner could not be built). The
  // recovery barrier is threaded in so the startup gate and UI provision/repair await recovery first.
  declareElectronAdapter('notebook-environment', () =>
    registerNotebookEnvIpcHandlers(
      serialized,
      provisioningRoot,
      waitForRecovery,
      assertProvisionAllowed,
      (language) => notebookService.completeRuntimeRepair(language)
    )
  )
  if (provisioner && serialized) {
    // Back the notebook service's manage_environments tool with the same provisioner that owns the env
    // gate (it is a DefaultRuntimeProvisioner, which implements createNamedEnvironment/listEnvironments/
    // removeEnvironment). Wired after construction like the mcp/mirror resolvers above.
    notebookService.setEnvironmentManager(provisioner as unknown as NotebookEnvironmentManager)
    // On first agent use of a not-yet-built default env, build it from the offline bundle (via the
    // shared serialized provisioner) instead of erroring — keeps R lazy but avoids the agent creating
    // a redundant named env.
    notebookService.setDefaultEnvProvisioner(serialized, broadcastNotebookEnvProgress)
  }

  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  declareElectronAdapter('storage', () =>
    registerStorageIpcHandlers({
      runtime,
      notebook: notebookService,
      getActivePromptSessions: () => runtime.getActivePromptSessions(),
      settingsService
    })
  )
  declareElectronAdapter('artifacts', () =>
    registerArtifactIpcHandlers(
      artifactRepository,
      artifactRunRegistry,
      () => (runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : []),
      artifactProvenanceRepository,
      (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
    )
  )
  declareElectronAdapter('uploads', () =>
    registerUploadIpcHandlers(uploadRepository, {
      withSessionMutation: (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
    })
  )
  declareElectronAdapter('notebook-input-preview', () => {
    ipcMainHandle('notebook:read-input-preview', (_event, request) =>
      notebookInputRegistry.readPreview(request)
    )
  })
  declareElectronAdapter('session-persistence', () =>
    registerSessionPersistenceIpcHandlers(sessionPersistenceBackend, reviewRepository)
  )
  declareElectronAdapter('conversation-export', () =>
    registerConversationExportIpcHandler(
      createConversationExportService({
        loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
        isSessionActive: (projectId, sessionId) =>
          runtime
            .getActivePromptSessions()
            .some(
              (activeSession) =>
                activeSession.projectName === projectId && activeSession.sessionId === sessionId
            )
      })
    )
  )
  declareElectronAdapter('permission-grants', () => {
    const permissionGrantIpc = registerPermissionGrantIpcHandlers({
      registry: permissionGrantRegistry,
      projects: {
        list: async () => {
          await projectDeletionCoordinator.recoverPendingDeletions()
          return projectRepository.list()
        }
      },
      sessions: {
        metadataSnapshot: () =>
          loadSessionMetadataAfterProjectRecovery(
            projectDeletionCoordinator,
            sessionPersistenceCoordinator
          )
      },
      connectors: {
        get: async () => ({
          ...(await settingsService.getConnectors()),
          bundledConnectorIds: ALL_CONNECTOR_IDS
        })
      }
    })
    invalidatePermissionProjection = permissionGrantIpc.invalidateProjection
  })
  declareElectronAdapter('project-files', () =>
    registerProjectFilesIpcHandlers(
      projectFilesRepository,
      sessionPersistenceCoordinator,
      projectDeletionCoordinator
    )
  )
  declareElectronAdapter('projects', () =>
    registerProjectIpcHandlers(
      projectRepository,
      previewStateRepository,
      projectDeletionCoordinator
    )
  )
  declareElectronAdapter('lifecycle', () => registerLifecycleIpcHandlers())
  // Compute IPC handlers are registered earlier (before the notebook RPC server) so computeService
  // can be injected into the RPC server for the computeCall route. See above.
  // Wire the reviewer backend into the app lifecycle: installs ipcMainHandle('reviewer:run', ...)
  // and 'reviewer:get-for-session' so the renderer's fire-and-forget reviewer calls resolve to
  // real handlers instead of no-ops. Passing the already-constructed AcpRuntime so the reviewer
  // can spawn sessions under the same agent connection.
  declareElectronAdapter('reviewer', () => {
    registerReviewerIpcHandlers({
      acpRuntime: runtime,
      artifactProvenanceRepository,
      withSessionMutation: (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
    })
  })

  // The shared coordinator is the sole normal owner of ACP + Notebook teardown. Register it last so
  // reverse disposal executes the existing bounded backend shutdown before supporting modules stop.
  await modules.add({ shutdownCoordinator }, ({ shutdownCoordinator: coordinator }) => ({
    name: 'backend-shutdown-coordinator',
    capability: undefined,
    disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS + APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
    dispose: () => coordinator.runForQuit().then(() => undefined)
  }))
  backendTeardownOwnedByCoordinator = true

  return {
    taskNotifications,
    settingsService,
    sessionDeletionCapability: sessionPersistenceCoordinator,
    detectActiveSessions: () => detectActiveSessions({ runtime, notebook: notebookService }),
    electronAdapters: {
      beforeCompute: beforeComputeAdapters,
      compute: computeIpcModule,
      beforeAcp: beforeAcpAdapters,
      acp: { runtime, taskNotifications },
      afterAcp: afterAcpAdapters
    }
  }
}

const registerIpcHandlers = async (options: IpcRegistrationOptions): Promise<IpcRegistration> => {
  const applicationRuntime = await composeApplicationRuntimeWithAdapters(
    (modules) => createApplicationModules(options, modules),
    installElectronRuntimeAdapters
  )
  return {
    ...applicationRuntime.interfaces,
    dispose: applicationRuntime.dispose
  }
}

export { registerIpcHandlers }
