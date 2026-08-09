import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { customConnectorSlug } from '../shared/custom-connector'

import {
  app,
  BrowserWindow,
  dialog,
  net,
  Notification,
  protocol,
  shell,
  webContents,
  type WebContents
} from 'electron'

import { createIpcHandlerInstallationScope, ipcMainHandle } from './ipc-handler-registry'
import {
  APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
  composeApplicationRuntimeWithAdapters,
  type ApplicationModuleBuilder
} from './application-runtime'
import {
  createApplicationCommandComposition,
  type ApplicationCommandComposition,
  type ApplicationCommandCompositionDependencies
} from './application-command-composition'
import { registerApplicationCommandElectronAdapter } from './application-command-electron-adapter'
import type { ApplicationInvocation } from './application-command-router'
import { createApplicationEventModule, type ApplicationEventSource } from './application-events'

import { createAcpRuntime } from './acp/runtime-composition'
import { createAcpCreateSessionWorkflow } from './acp/create-session-workflow'
import { createAcpHandlerWorkflows } from './acp/handler-workflows'
import { createAcpTaskAgentPort } from './acp/task-agent-port'
import { ArtifactCodeReconstructionRunner } from './acp/artifact-code-reconstruction-runner'
import { ArchiveCoordinator } from './archive/coordinator'
import { ArtifactCodeReconstructionService } from './artifacts/code-reconstruction'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  registerArtifactIpcHandlers
} from './artifacts/ipc'
import { ArtifactProvenanceRepository } from './artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from './artifacts/provenance-message-snapshot'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { createComputeIpcModule } from './compute/ipc'
import { attachEnabledComputeHosts } from './compute/enabled-hosts-registry'
import { createComputeJobRuntime } from './compute/job-runtime'
import { waitForInitialConnectorRefresh } from './connector-reload'
import { ApprovalBroker } from './connectors/approval-broker'
import { McpClientManager } from './connectors/mcp-client-manager'
import { isCustomMcpServerRouteSafe, toCustomMcpConfig } from './connectors/custom-mcp-bootstrap'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorRuntimeSettingsProjection } from './connectors/runtime-settings-projection'
import { ConnectorService } from './connectors/service'
import { registerFileSaveHandlers } from './file-save'
import { ImmutableInputAuthority } from './immutable-input-authority'
import { createSessionArtifactFileResolver } from './session-artifact-file-resolver'
import { createCliCommandOwner, registerCliInstallIpcHandlers } from './cli-install/ipc'
import { createGithubCommandOwner, registerGithubIpcHandlers } from './github-ipc'
import {
  BackendShutdownOutcomeError,
  BackendShutdownCoordinator,
  QUIT_SHUTDOWN_BUDGET_MS,
  UPDATE_SHUTDOWN_BUDGET_MS,
  type ShutdownStepOutcome
} from './lifecycle-shutdown'
import { registerLifecycleIpcHandlers } from './lifecycle-broadcast'
import { createLogsCommandOwner, registerLogsIpcHandlers } from './logs-ipc'
import { registerNetworkIpcHandlers } from './network-ipc'
import { registerWindowIpcHandlers } from './window-ipc'
import { registerWindowFindIpcHandlers } from './window-find-ipc'
import { TaskNotificationService } from './notifications/task-notifications'
import { createNotificationInboxController } from './notifications/notification-inbox-controller'
import { registerNotificationInboxIpcAdapter } from './notifications/notification-inbox-ipc'
import { NotificationInboxDbRepository } from './notifications/notification-inbox-repository'
import { bindNotificationInboxDeletionRuntime } from './notifications/notification-inbox-runtime'
import {
  buildSkillImportApprovalBroadcast,
  buildConnectorApprovalBroadcast,
  buildTaskNotificationShow
} from './notifications/electron-wiring'
import { createLogger, diagnosticErrorFields, errorLogFields } from './logger'
import { startDiagnosticOperation } from './diagnostics/operation'
import { broadcastNotebookEnvProgress, registerNotebookEnvIpcHandlers } from './notebook/env-ipc'
import {
  createNotebookApplicationModule,
  createNotebookLocalRpcModule,
  installNotebookEnvironmentSurface
} from './notebook/application'
import { serializeProvisioner } from './notebook/environment-operation-foundation'
import { createNotebookEnvironmentLifecycle } from './notebook/environment-lifecycle-workflows'
import {
  createManagedPreviewOwnerRegistry,
  installManagedPreviewElectronAdapter
} from './managed-preview-ipc'
import { ManagedPreviewResources } from './managed-preview-resources'
import type { ManagedPreviewSource } from '../shared/preview-resources'
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
import { NotebookRunRepository, getRuntimeRoot } from './notebook/repository'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { NotebookInputRegistry } from './notebook/input-registry'
import { effectiveMirrorAsync } from './notebook/mirror-probe'
import { createProductionProvisioner, type RuntimeProvisioner } from './notebook/provisioner'
import { createProductionMicromambaRunner } from './notebook/windows-micromamba-runner'
import { createRuntimeSelectionWorkflows } from './notebook/runtime-selection-workflows'
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
  createProjectHandlers,
  registerPreviewStateIpcHandlers
} from './projects/ipc'
import { createReviewerCommandOwner, registerReviewerIpcHandlers } from './reviewer/ipc'
import {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers
} from './session-persistence/ipc'
import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from './session-persistence/conversation-export'
import { createProjectFilesHandlers, registerProjectFilesIpcHandlers } from './project-files/ipc'
import { createManagedFileIndexRepository } from './project-files/repository'
import { ProjectDeletionCoordinator } from './projects/deletion-coordinator'
import { getProjectDbClient } from './projects/prisma-client'
import { seedDefaultPermissionGrants } from './permission-grants/defaults'
import { createPermissionGrantRegistry } from './permission-grants/registry'
import { isPermissionGrantScopeLive } from './permission-grants/scope-liveness'
import { registerPermissionGrantIpcAdapter } from './permission-grants/ipc'
import { createPermissionGrantProjectionController } from './permission-grants/projection-controller'
import { reconcilePermissionGrantOwners } from './permission-grants/reconciliation'
import { SessionPersistenceCoordinator } from './session-persistence/coordinator'
import { type SessionPersistenceBackend } from './session-persistence/ipc'
import { tryDecryptKey } from './settings/crypto'
import { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers } from './settings/ipc'
import { registerLocalFsIpcHandlers } from './local-fs/ipc'
import { LocalFsService } from './local-fs/service'
import { getAppClaudeConfigDir } from './settings/provider-env'
import { SettingsService } from './settings/service'
import { SettingsRepository } from './settings/repository'
import type { NotebookRuntimeSettings } from './settings/capabilities'
import type { WindowSettingsCapabilities } from './settings/service-capabilities'
import { createSettingsWorkflows } from './settings/workflows'
import { showSettingsSaveDialog } from './settings/save-dialog'
import { ProfileService } from './specialist/service'
import { SpecialistRepository } from './specialist/repository'
import { BuiltinSpecialistRegistry } from './specialist/builtin-registry'
import { composeBuiltinSkillCatalog } from './specialist/package/builtin-skill-catalog'
import { SpecialistPackageService } from './specialist/package/service'
import {
  saveSpecialistExport,
  saveSpecialistPackageReport,
  selectSpecialistArchive
} from './specialist/package/electron-adapter'
import { UserSkillSpecialistPackageAdapter } from './skills/specialist-package-adapter'
import { BundledSkillSpecialistPackageAdapter } from './skills/builtin-specialist-package-adapter'
import { saveSkillExport } from './skills/export'
import { AgentsService } from './agents/agents-service'
import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  createCompletionGatedControlToolInterceptor,
  createCompletionGateSwitchNotifier
} from './agents/completion-gate'
import { createProductionAppHandoffRuntime } from './agents/app-handoff-runtime'
import {
  AcpSpecialistApprovalGateway,
  createAcpBackedSpecialistBridge
} from './agents/specialist-approval-gateway'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository
} from './agents/completion-handoff-lifecycle'
import { registerCompletionHandoffIpcHandlers } from './agents/completion-handoff-ipc'
import {
  registerClaudeCodeCompletionGateRuntime,
  selectPersistedUserTaskContext
} from './agents/claude-code-handoff'
import { installCompletionGateDiagnostics } from './agents/completion-gate-diagnostics'
import { PendingSessionSpecialistBindings } from './agents/pending-session-specialist-bindings'
import { createCodexCompletionGateRuntime } from './acp/codex-completion-handoff'
import { createOpenCodeImmediateHandoffRuntime } from './acp/opencode-immediate-handoff'
import { registerSpecialistIpcHandlers } from './specialist/ipc'
import {
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from './specialist/package/contribution-template'
import { SessionBindingService } from './specialist/session-binding'
import { SPECIALIST_IPC } from '../shared/specialist'
import {
  CONNECTOR_TEMPLATE_MAX_BYTES,
  type AppIconPreview,
  type AppIconVariant,
  type RespondApprovalRequest
} from '../shared/settings'
import { registerStorageIpcHandlers } from './storage/ipc'
import { createStorageCommandOwner } from './storage/command-owner'
import { withDataRootWrite } from './storage/migration-state'
import { normalizeLegacyDataPaths } from './storage/normalize-legacy-paths'
import { detectActiveSessions } from './storage/detect-active'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot,
  resolveStorageRoot,
  samePath
} from './storage-root'
import { createUpdateCommandOwner, registerUpdateIpcHandlers } from './update/ipc'
import { createUpdateStrategy } from './update/create-strategy'
import { startUpdateScheduler } from './update/scheduler'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'
import { createUploadCommandOwner } from './uploads/command-owner'
import { broadcastToRenderers, installRendererBroadcastEventHub } from './renderer-broadcast'
import {
  installElectronRuntimeAdapters,
  type ElectronRuntimeAdapterInterfaces,
  type NamedElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { ConversationSkillImporter, SkillImportApprovalBroker } from './skills/conversation-import'
import { HostSkillsService, type HostSkillsCatalog } from './skills/host-skills-service'
import type { ConversationSkillImportApprovalResponse } from '../shared/settings'
import type { TaskAgentPort } from './tasks/task-runner'

const permissionGrantsLog = createLogger('permission-grants')

type IpcRegistrationOptions = {
  mainEntryPath: string
  // Headless web-serve launches (--serve) have no local desktop user; task notifications are
  // disabled there by contract, not just incidentally via Notification.isSupported().
  headless?: boolean
  // Applies a newly-selected app-icon variant to the window + dock/taskbar and the Windows tray.
  // Supplied by the desktop startup path; absent in web/headless mode (no local window to re-skin).
  onAppIconVariantChanged?: (variant: AppIconVariant) => void
  // Renders the built-in icon variants to preview data URLs for the Appearance picker.
  listAppIconPreviews?: () => AppIconPreview[]
  // Retained as an explicit startup marker while the app owns the only handoff composition.
  handoffRuntime?: 'production'
}

export type ApplicationRuntimeInterfaces = {
  applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
  applicationEvents: ApplicationEventSource
  bindRemoteAccess: ApplicationCommandComposition['bindRemoteAccess']
  taskNotifications: Pick<
    TaskNotificationService,
    'setActivationHandler' | 'setAttentionHandlers' | 'setPendingOpenSession'
  >
  notificationInbox: Pick<
    import('./notifications/notification-inbox-controller').NotificationInboxController,
    'configureDesktop' | 'syncViewState' | 'handleAppFocus' | 'handleWindowCreated' | 'refreshBadge'
  >
  settingsService: WindowSettingsCapabilities
  taskAgent: TaskAgentPort
  sessionDeletionCapability: Pick<SessionPersistenceCoordinator, 'setSessionDeletionHandlers'>
  archiveCapability: Pick<ArchiveCoordinator, 'isSessionAvailableById' | 'setMarkReadSessions'>
  detectActiveSessions: () => ReturnType<typeof detectActiveSessions>
  prepareForQuit: () => Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
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
  const declareElectronAdapter = (name: string, install: () => void | (() => void)): void => {
    surfaceAdapters.push({
      name,
      install: () => {
        const scope = createIpcHandlerInstallationScope()
        try {
          const cleanup = install()
          return scope.complete(typeof cleanup === 'function' ? cleanup : undefined)
        } catch (error) {
          scope.rollback()
          throw error
        }
      }
    })
  }
  const applicationEvents = await modules.add(
    installRendererBroadcastEventHub,
    createApplicationEventModule
  )
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsRepository = new SettingsRepository(resolveStorageRoot())
  const settingsService = await modules.add(undefined, () => ({
    capability: new SettingsService({ repository: settingsRepository })
  }))
  const storedSettings = await settingsService.getStoredSettings()
  const storageLog = createLogger('storage')
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot)
  const notificationInbox = createNotificationInboxController({
    headless,
    repository: new NotificationInboxDbRepository(() => getProjectDbClient(resolveStorageRoot())),
    onChanged: (event) => applicationEvents.publish('notifications:changed', event),
    onError: (error) =>
      createLogger('notifications').warn('message center operation failed', errorLogFields(error))
  })
  await notificationInbox.restore()
  // Record only the location class. Absolute paths (including reversible code-point renderings) can
  // expose usernames and folder names in a support bundle.
  storageLog.info('data root resolved', {
    location: samePath(resolveDataRoot(), computeDefaultDataRoot()) ? 'default' : 'custom'
  })

  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const uploadRepository = createDefaultUploadRepository()
  try {
    await uploadRepository.recoverStagingUploads()
  } catch (error) {
    // Ready bytes remain fail-closed; keep startup available so Files can surface unaffected rows and
    // the next launch can retry any recoverable staging Version.
    storageLog.error(
      'staging upload recovery incomplete; will retry next launch',
      diagnosticErrorFields(error)
    )
  }
  // Session reads and permission scope validation both need a late-bound view of ACP ownership:
  // startup runs before the runtime exists, while later reads must preserve live prompt state.
  const runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined } = {
    current: undefined
  }
  const sessionRepository = createDefaultSessionRepository((projectId, sessionId) =>
    (runtimeRef.current?.getActivePromptSessions() ?? []).some(
      (session) => session.projectName === projectId && session.sessionId === sessionId
    )
  )
  const projectRepository = createDefaultProjectRepository()
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    const normalizationOperation = startDiagnosticOperation(storageLog, {
      operation: 'legacy-data-root-normalization',
      fields: { mode: 'legacy-normalize' }
    })
    normalizationOperation.phase('rewrite-paths')
    try {
      await normalizeLegacyDataPaths({
        sessionRepository,
        sessionUploads: uploadRepository,
        previewStateRepository,
        projectRepository,
        dataRoot: resolveDataRoot()
      })
      normalizationOperation.phase('persist-marker')
      await settingsService.markPathsNormalized()
      normalizationOperation.complete()
    } catch (error) {
      normalizationOperation.fail(error)
    }
  }

  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const immutableInputAuthority = new ImmutableInputAuthority({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot())
  })
  const artifactProvenanceRepository = new ArtifactProvenanceRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveStorageRoot()),
    inputAuthority: immutableInputAuthority,
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
    inputAuthority: immutableInputAuthority
  })
  // Shared local-fs service backs both the "This computer" browser IPC and the managed-preview
  // resolver below, so path validation stays identical across both entry points.
  const localFsService = new LocalFsService()
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    source: ManagedPreviewSource,
    request: { path: string; projectId?: string; sessionId?: string }
  ): Promise<string> => {
    if (source === 'artifact') {
      const versionIdentity = parseArtifactVersionLocator(request.path)
      return versionIdentity
        ? artifactProvenanceRepository
            .resolveVersionContent(versionIdentity)
            .then((resolved) => resolved.path)
        : artifactRepository.resolveManagedFilePath(request)
    }
    if (source === 'upload') {
      return uploadRepository.resolveManagedUploadPath(request, {
        projectId: request.projectId,
        sessionId: request.sessionId
      })
    }
    if (source === 'notebook-input') {
      return notebookInputRegistry
        .resolvePreviewKey(request.path)
        .then((target) => target.absolutePath)
    }
    // 'local' is the only remaining source, and it is the one that resolves an arbitrary host path.
    // Falling through to it by default would silently widen any future source added to the union, so
    // name it and reject anything unknown.
    if (source === 'local') return localFsService.resolveFilePath(request)
    const unhandled: never = source
    return Promise.reject(new Error(`Unsupported managed preview source: ${String(unhandled)}`))
  }
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
  const managedPreviewOwners = createManagedPreviewOwnerRegistry(previewResources)

  const notebookActivityRef: {
    current:
      { getActiveNotebookSessions(): { projectName: string; sessionId: string }[] } | undefined
  } = { current: undefined }

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
  await seedDefaultPermissionGrants(permissionGrantRegistry, await getProjectDbClient(configRoot))
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
  const uploadCommandOwner = createUploadCommandOwner(uploadRepository, {
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  const reviewRepository = createDefaultReviewRepository()
  const projectDeletionCoordinator = new ProjectDeletionCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    previewStateRepository,
    reviewRepository,
    artifactProvenanceRepository,
    permissionGrantRegistry
  )
  const detectArchiveBlockingSessions = (): ReturnType<typeof detectActiveSessions> =>
    detectActiveSessions({
      runtime: {
        getActivePromptSessions: () => runtimeRef.current?.getActivePromptSessions() ?? []
      },
      notebook: {
        getActiveNotebookSessions: () =>
          notebookActivityRef.current?.getActiveNotebookSessions() ?? []
      }
    })
  const archiveCoordinator = new ArchiveCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    {
      isSessionBusy: (projectId, sessionId) =>
        detectArchiveBlockingSessions().some(
          (session) => session.projectId === projectId && session.sessionId === sessionId
        ),
      isProjectBusy: (projectId) =>
        detectArchiveBlockingSessions().some((session) => session.projectId === projectId),
      liveSessionProjectId: (sessionId) => runtimeRef.current?.liveSessionProjectId(sessionId)
    }
  )
  notificationInbox.setSessionAvailability((sessionId) =>
    archiveCoordinator.isSessionAvailableById(sessionId)
  )
  archiveCoordinator.setMarkReadSessions((sessionIds) =>
    notificationInbox.markSessionsRead(sessionIds)
  )
  bindNotificationInboxDeletionRuntime({
    inbox: notificationInbox,
    sessionPersistenceCoordinator
  })
  const projectHandlers = createProjectHandlers(projectRepository, projectDeletionCoordinator, {
    updateArchive: (request) => archiveCoordinator.updateProjectArchive(request)
  })
  const projectFilesHandlers = createProjectFilesHandlers(
    projectFilesRepository,
    sessionPersistenceCoordinator,
    projectDeletionCoordinator
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
    updateArchive: async (request) => {
      await projectDeletionCoordinator.recoverPendingDeletions()
      return archiveCoordinator.updateSessionArchive(request)
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
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // One runner owns Windows integrity/preflight/fallback state for every production micromamba
  // consumer in this main-process generation. Each consumer receives only its narrow resolve seam.
  const micromambaRunner = createProductionMicromambaRunner({
    home: dirname(dirname(provisioningRoot)),
    resourcesPath: process.resourcesPath
  })
  const notebookRuntimeSettings: Pick<NotebookRuntimeSettings, 'getSnapshot'> = {
    getSnapshot: async (language) => {
      const [runtimeSelection, runtimeEnablement, manualInterpreters, packageMirror] =
        await Promise.all([
          settingsService.getRuntimeSelection(language),
          settingsService.getRuntimeEnablement(language),
          settingsService.getManualInterpreters(language),
          settingsService.getPackageMirror()
        ])
      return {
        language,
        runtimeSelection,
        runtimeEnablement,
        manualInterpreters,
        packageMirror
      }
    }
  }
  const notebookApplication = await modules.add(
    {
      configRoot: resolveConfigRoot(),
      dataRoot: resolveDataRoot(),
      projectName: DEFAULT_ARTIFACT_PROJECT_NAME,
      repository: new NotebookRunRepository(resolveDataRoot()),
      getPackageMirror: () => settingsService.getPackageMirror(),
      notebookRuntimeSettings,
      micromambaRunner,
      locale: app.getLocale(),
      appVersion: app.getVersion(),
      events: applicationEvents,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
      isBackendTeardownOwned: () => backendTeardownOwnedByCoordinator
    },
    createNotebookApplicationModule
  )
  const {
    runtime: notebookService,
    commands: notebookCommands,
    localRpc: notebookLocalRpc
  } = notebookApplication
  notebookActivityRef.current = notebookService

  // Builtins are validated once at startup from read-only repository resources. Package imports use
  // the same repository while keeping their dynamic Connector/custom-Skill catalog separate.
  const specialistRepository = new SpecialistRepository(resolveStorageRoot())
  const appVersion = app.getVersion()
  const specialistSkills = await settingsService.listSpecialistSkillCatalog()
  const specialistPackageSkillAdapter = new UserSkillSpecialistPackageAdapter(resolveStorageRoot())
  const builtinSpecialistPackageSkillAdapter = new BundledSkillSpecialistPackageAdapter()
  const packageSkills = await specialistPackageSkillAdapter.snapshot()
  const builtinRegistry = new BuiltinSpecialistRegistry({
    appVersion,
    builtinSkills: composeBuiltinSkillCatalog(appVersion, specialistSkills),
    skills: specialistSkills.map((skill) => {
      const packageSkill = packageSkills.find((candidate) => candidate.id === skill.id)
      return {
        id: skill.id,
        builtin: skill.source === 'featured',
        displayName: skill.displayName,
        source: skill.source,
        ...(packageSkill ?? {})
      }
    }),
    connectorIds: ALL_CONNECTOR_IDS,
    protectedSpecialistIds: ['reviewer'],
    protectedSpecialistNames: ['Reviewer']
  })
  const profileService = new ProfileService(specialistRepository, builtinRegistry)
  await profileService.ensureBuiltinCatalogReady()
  const specialistPackageService = new SpecialistPackageService({
    storageDir: resolveStorageRoot(),
    repository: specialistRepository,
    catalog: async () => {
      const appVersion = app.getVersion()
      const [skills, packageSkills, connectorSettings] = await Promise.all([
        settingsService.listSpecialistSkillCatalog(),
        specialistPackageSkillAdapter.snapshot(),
        settingsService.getConnectors()
      ])
      const customMcpServers = connectorSettings?.customMcpServers ?? []
      const baseCatalog = {
        appVersion,
        builtinSkills: composeBuiltinSkillCatalog(appVersion, skills),
        skills: skills.map((skill) => {
          const packageSkill = packageSkills.find((candidate) => candidate.id === skill.id)
          return {
            id: skill.id,
            builtin: skill.source === 'featured',
            displayName: skill.displayName,
            source: skill.source,
            ...(packageSkill ?? {})
          }
        }),
        connectorIds: Array.from(
          new Set([
            ...ALL_CONNECTOR_IDS,
            ...customMcpServers
              .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
              .map(customConnectorSlug)
          ])
        ),
        connectorAliases: Object.fromEntries(
          customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .flatMap((server) => {
              const slug = customConnectorSlug(server)
              return [
                [server.name, slug],
                [server.id, slug]
              ]
            })
        ),
        protectedSpecialistIds: ['reviewer'],
        protectedSpecialistNames: ['Reviewer']
      }
      const builtinSpecialists = await new BuiltinSpecialistRegistry(baseCatalog).load()
      return {
        ...baseCatalog,
        protectedSpecialistIds: [
          ...baseCatalog.protectedSpecialistIds,
          ...builtinSpecialists.entries.map((entry) => entry.id)
        ],
        protectedSpecialistNames: [
          ...(baseCatalog.protectedSpecialistNames ?? []),
          ...builtinSpecialists.entries.flatMap((entry) => [
            entry.name,
            entry.displayName ?? entry.name
          ])
        ]
      }
    },
    skillPort: specialistPackageSkillAdapter,
    builtinSkillPort: builtinSpecialistPackageSkillAdapter,
    onCommitted: () => {
      broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
      void runtime.requestSkillsReload()
    }
  })
  settingsService.setSkillDeletionGuard((skillId) =>
    specialistPackageService.assertSkillDeletionAllowed(skillId)
  )
  // Per-session specialist binding store. Shared between the SET_SESSION_SPECIALIST barrier
  // (validate + record) and the runtime switch so a hot-switch lands on the same source of truth.
  const sessionBindingService = new SessionBindingService(profileService)
  // Compose the interceptor before ACP because Notebook construction precedes runtime construction.
  // Startup registers the complete production adapter below before any IPC surface becomes callable.
  const completionGateRuntimeRegistry = new CompletionGateRuntimeRegistry()
  const completionHandoffLifecycle = new CompletionHandoffLifecycle(
    new FileCompletionHandoffRepository(join(resolveStorageRoot(), 'specialist-handoffs')),
    completionGateRuntimeRegistry,
    Date.now,
    (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE_CHANGED, event),
    async ({ targetName }) => {
      if (targetName === null) return undefined
      const profile = await profileService.resolveRunnableByName(targetName)
      return { specialistId: profile.id, revision: profile.revision }
    }
  )
  registerCompletionHandoffIpcHandlers(completionHandoffLifecycle)
  const completionGateCoordinator = new CompletionGateCoordinator(
    completionGateRuntimeRegistry,
    completionHandoffLifecycle
  )
  await modules.add({ completionGateCoordinator }, ({ completionGateCoordinator: coordinator }) => {
    let disposeDiagnostics: (() => void) | undefined
    return {
      name: 'completion-handoff-diagnostics',
      capability: undefined,
      start: () => {
        disposeDiagnostics = installCompletionGateDiagnostics(coordinator, {
          log: createLogger('completion-handoff'),
          broadcast: (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE, event)
        })
      },
      dispose: () => disposeDiagnostics?.()
    }
  })
  // The delivery callback is intentionally a no-op: the Notebook runtime itself returns a normal
  // disposition to the existing repl_execute caller. Captured dispositions never return that value.
  notebookService.setControlCompletionInterceptor(
    createCompletionGatedControlToolInterceptor(completionGateCoordinator, async () => undefined)
  )
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
    inbox: notificationInbox,
    onInboxError: (error) =>
      notificationsLog.warn('message center recording failed', errorLogFields(error))
  })
  // The renderer peeks once sessions are hydrated, then conditionally consumes the same target.
  // This lets partial recovery open an already-loaded conversation while retaining an omitted one
  // for retry, without an older IPC round trip clearing a newer click target.
  declareElectronAdapter('task-notifications', () => {
    registerNotificationInboxIpcAdapter(notificationInbox)
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
    const manager = new McpClientManager({
      openExternal: (url) => shell.openExternal(url),
      saveOAuthState: (serverId, state) =>
        settingsService.saveCustomServerOAuthState(serverId, state)
    })
    return {
      name: 'mcp-client-manager',
      capability: manager,
      dispose: () => manager.closeAll()
    }
  })
  const connectorRuntimeSettings = new ConnectorRuntimeSettingsProjection({
    readConnectors: () => settingsService.getConnectors(),
    skillsDir: join(getAppClaudeConfigDir(resolveStorageRoot()), 'skills'),
    mcpClientManager
  })
  settingsService.setMaterializedCustomSkillNamesProvider(() =>
    connectorRuntimeSettings.materializedCustomSkillNames()
  )
  settingsService.setCustomServerAuthenticator(
    async (serverId) => {
      const server = (await settingsService.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === serverId
      )
      if (!server) throw new Error(`Unknown custom connector: ${serverId}`)
      await mcpClientManager.authenticate(toCustomMcpConfig(server))
    },
    (serverId) => mcpClientManager.cancelAuthentication(serverId)
  )
  // Bridges un-trusted connector calls to the renderer approval card. A tool call that isn't
  // pre-allowed or skip-approved is held here until the user decides (or it auto-denies on timeout).
  const approvalBroker = new ApprovalBroker({
    generateId: () => randomUUID(),
    onSettled: (id, state) => void taskNotifications.settleAuthorization('connector', id, state),
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
    onSettled: (id) => broadcastToRenderers('skills:conversation-import-settled', id),
    onLifecycleSettled: (id, state) =>
      void taskNotifications.settleAuthorization('skill-import', id, state)
  })
  const conversationSkillImporter = new ConversationSkillImporter({
    uploads: uploadRepository,
    createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
      skillImportApprovalBroker.createCancellationGuard(sessionId, turnToken, attachmentUri),
    createSessionCancellationGuard: (sessionId) =>
      skillImportApprovalBroker.createSessionCancellationGuard(sessionId),
    previewBundle: (bundle) => settingsService.previewSkillArchive(bundle),
    importBundle: (bundle, items) => settingsService.importSkillArchiveBatch(bundle, items),
    scanGitHub: async (url) => (await settingsService.scanRepoSkills({ repo: url })).skills,
    importGitHub: (url) => settingsService.importSkill({ url }),
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
    getConnectors: () => connectorRuntimeSettings.current(),
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
        return await profileService.resolveRunnableById(specialistId)
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
    permissionGrantRegistry,
    settingsRepository
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
  // immediate-handoff lifecycle. The catalog adapter delegates to the authoritative
  // SettingsService + ProfileService; switch() reuses the SAME SessionBindingService and durable
  // session-file persistence seam the SET_SESSION_SPECIALIST IPC handler uses (no parallel switch
  // service). The runtime reconfigure callback is intentionally NOT wired here — it runs at the safe
  // next-message boundary, not inside the SDK call. Privileged operations use the existing ACP
  // permission broker/card; its response is the only approve/decline authority.
  const specialistApprovalGateway = new AcpSpecialistApprovalGateway({
    bridge: createAcpBackedSpecialistBridge({
      request: async (payload, session) => {
        const sessionId = session.sessionId
        const runtime = runtimeRef.current
        if (!sessionId || !runtime) {
          return { outcome: 'declined', reason: 'The approval surface is unavailable.' }
        }
        const target = payload.kind === 'switch' ? payload.targetName : undefined
        const approved = await runtime.requestAppApproval({
          sessionId,
          title:
            payload.kind === 'switch'
              ? target === null
                ? 'Switch to Main Agent?'
                : `Switch to ${target}?`
              : payload.kind === 'delete'
                ? `Delete ${payload.name}?`
                : `Rename ${payload.name} to ${payload.newName}?`,
          rawInput: { specialistApproval: payload }
        })
        return approved ? { outcome: 'approved' } : { outcome: 'declined' }
      }
    })
  })
  const agentsService = new AgentsService({
    profileService,
    catalog: {
      listSkillCatalog: () => settingsService.listSpecialistSkillCatalog(),
      getConnectors: () => settingsService.getConnectors()
    },
    sessionBinding: sessionBindingService,
    approvalGateway: specialistApprovalGateway,
    approvalLifecycle: completionHandoffLifecycle,
    // The completion gate is the sole execution authority. The legacy pending-switch renderer
    // broadcast is intentionally not emitted: lifecycle events are a read-only projection and can
    // neither delay nor re-run the approved continuation.
    switchNotifier: createCompletionGateSwitchNotifier(completionGateCoordinator),
    deleteSpecialist: (request) => specialistPackageService.deleteSpecialist(request),
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
  const hostSkillsCatalog: HostSkillsCatalog = {
    list: () => settingsService.listHostSkills(),
    withSkillRead: (id, read) => settingsService.withHostSkillRead(id, read),
    publishPersonalDirectory: (slug, sourcePath, overwrite) =>
      settingsService.publishHostSkill(slug, sourcePath, overwrite),
    deletePublished: async (id) => {
      await settingsService.deleteSkill({ id })
    }
  }
  const hostSkillsService = new HostSkillsService({
    storageRoot: configRoot,
    catalog: hostSkillsCatalog,
    approveDelete: async (payload, session) => {
      const runtime = runtimeRef.current
      if (!session.sessionId || !runtime) return false
      return runtime.requestAppApproval({
        sessionId: session.sessionId,
        title: `Delete ${payload.name}?`,
        rawInput: { skillApproval: { kind: 'delete', ...payload } }
      })
    },
    onPublishedSkillsChanged: () => void runtimeRef.current?.requestSkillsReload()
  })
  const notebookRpcServer = await modules.add(
    new NotebookLocalRpcServer(notebookLocalRpc, {
      onSessionReleased: (sessionId) => completionGateCoordinator.releaseSession(sessionId),
      connectorService,
      computeService: computeServiceWithRegistry,
      skillImporter: conversationSkillImporter,
      planService: {
        call: (input) => {
          const runtime = runtimeRef.current
          if (!runtime) return Promise.reject(new Error('ACP runtime is not available.'))
          return runtime.callSessionPlan(input)
        }
      },
      requestUserInput: (request) => {
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('ACP runtime is not initialized.')
        return runtime.requestUserInput(request)
      },
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
      agentsService,
      skillsService: hostSkillsService
    }),
    createNotebookLocalRpcModule
  )
  // Register ownership before ACP construction. Reverse disposal therefore drains ACP + Notebook
  // through the coordinator first, then releases the local bridge without creating a second runtime
  // shutdown owner; rollback also closes a server started during partial composition.
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
    ipcMainHandle('connectors:approval-replay', (_event, id: unknown) =>
      typeof id === 'string' ? approvalBroker.getPending(id) : null
    )
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
    connectorRuntimeSettings.refresh(),
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
        ...(connectorRuntimeSettings.current()
          ? {
              customServerIds:
                connectorRuntimeSettings.current()?.customMcpServers?.map((server) => server.id) ??
                []
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

  const cliCommandOwner = createCliCommandOwner()
  const githubCommandOwner = createGithubCommandOwner()
  const logsCommandOwner = createLogsCommandOwner()
  declareElectronAdapter('desktop-utilities', () => {
    registerFileSaveHandlers({ resolveManagedFilePath, resolveSessionArtifactFilePath })
    registerLogsIpcHandlers(logsCommandOwner)
    registerGithubIpcHandlers({}, githubCommandOwner)
    registerNetworkIpcHandlers()
    registerCliInstallIpcHandlers(cliCommandOwner)
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
      peekNotebookHandoffContext: (sessionId) => notebookService.peekHandoffContext(sessionId),
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      permissionGrantRegistry,
      taskNotifications,
      notificationInbox,
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
      profileService,
      sessionPersistenceCoordinator
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
  // Archive availability is checked at the final admission point, rather than trusting renderer
  // visibility, so an archived Project/Session cannot restart work through another surface.
  runtime.setPromptAdmissionGuard((sessionId) =>
    archiveCoordinator.assertSessionAvailableById(sessionId)
  )
  const codeReconstructionLog = createLogger('artifacts:code-reconstruction')
  const codeReconstructionRunner = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context)
    },
    (options) => {
      const runner = new ArtifactCodeReconstructionRunner(options)
      return {
        name: 'artifact-code-reconstruction-runner',
        capability: runner,
        dispose: () => runner.shutdown()
      }
    }
  )
  void codeReconstructionRunner
    .sweepStaleProfiles()
    .catch((error) =>
      codeReconstructionLog.error(
        'stale reconstruction profile cleanup failed',
        diagnosticErrorFields(error)
      )
    )
  const codeReconstruction = new ArtifactCodeReconstructionService({
    provenance: artifactProvenanceRepository,
    runner: codeReconstructionRunner
  })
  const createSessionWorkflow = createAcpCreateSessionWorkflow(runtime, {
    assertProjectAvailable: (projectId) => archiveCoordinator.assertProjectAvailable(projectId)
  })
  const acpHandlerWorkflows = createAcpHandlerWorkflows(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    sessionRepository
  )
  const taskAgent = createAcpTaskAgentPort(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator
  )
  {
    // Framework-specific adapters declare their own session selector. The registry resolves those
    // selectors before its generic fallback, so registration order cannot route a Codex/OpenCode
    // completion through the wrong continuation path.
    completionGateRuntimeRegistry.register(
      createCodexCompletionGateRuntime({
        runtime,
        resolveApprovedSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createOpenCodeImmediateHandoffRuntime({
        runtime,
        resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
        reportHandoffFailure: async (failure) =>
          runtime.reportApprovedHandoffFailure(failure.sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createProductionAppHandoffRuntime({
        runtime,
        sessionBinding: sessionBindingService
      })
    )
  }
  // Claude's Specialist identity is baked into agent session creation. Its selector joins the Codex
  // and OpenCode selectors above; the generic runtime remains fallback-only.
  registerClaudeCodeCompletionGateRuntime(completionGateRuntimeRegistry, {
    sessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
    cancelPrompt: (request) => runtime.cancelPrompt(request),
    waitForPromptOwnershipRelease: (sessionId) => runtime.waitForPromptOwnershipRelease(sessionId),
    resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
    resolveSwitchReadBack: async (sessionId, targetName) => {
      const specialistId = sessionBindingService.getBinding(sessionId)
      const revision = specialistId
        ? (await profileService.resolveRunnableById(specialistId)).revision
        : undefined
      return {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId,
          specialistId,
          targetName,
          ...(revision === undefined ? {} : { revision })
        }
      }
    },
    prepareReplayContext: async (input) => {
      const persisted = (await sessionRepository.loadAll()).sessions.find(
        (session) => session.id === input.sessionId
      )
      runtime.prepareClaudeCodeHandoffReplay({
        ...input,
        supportedTaskContext: selectPersistedUserTaskContext(persisted?.messages ?? [])
      })
    },
    discardReplayContext: async (sessionId) => runtime.discardClaudeCodeHandoffReplay(sessionId),
    switchSpecialist: (sessionId, specialistId) =>
      runtime.switchSpecialist(sessionId, specialistId),
    createContinuationRequest: (input) => runtime.createClaudeCodeContinuationRequest(input),
    sendAppContinuation: (request) => runtime.sendAppContinuation(request),
    reportHandoffFailure: async (_error, _handoff, context) => {
      runtime.reportApprovedHandoffFailure(context.sessionId)
    }
  })
  void completionHandoffLifecycle.recover().catch((error: unknown) => {
    createLogger('completion-handoff').error(
      'failed to recover approved handoffs',
      errorLogFields(error)
    )
  })
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
  const updateCommandOwner = createUpdateCommandOwner(updateStrategy)
  let stopUpdateScheduler: (() => void) | undefined
  await modules.add(undefined, () => ({
    name: 'update-scheduler',
    capability: undefined,
    dispose: () => stopUpdateScheduler?.()
  }))
  declareElectronAdapter('update', () => {
    registerUpdateIpcHandlers(updateStrategy, updateCommandOwner)
    stopUpdateScheduler = startUpdateScheduler(updateStrategy)
  })
  const permissionGrantProjection = await modules.add(
    {
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
    },
    (dependencies) => {
      const owner = createPermissionGrantProjectionController({
        ...dependencies,
        publishChanged: (payload) => broadcastToRenderers('permissions:changed', payload)
      })
      return {
        name: 'permission-grant-projection',
        capability: owner,
        dispose: () => owner.dispose()
      }
    }
  )
  // Spawn-config changes rotate the coordinator's runtime for future sessions. Existing sessions retain
  // their owning runtime, so a framework/provider switch cannot interrupt an in-flight turn.
  const settingsWorkflows = createSettingsWorkflows(settingsService, {
    runtime: {
      requestProviderReconnect: () => void runtime.requestProviderReconnect(),
      requestAgentFrameworkSwitch: () => void runtime.requestAgentFrameworkSwitch(),
      applyReasoningEffort: (effort) => runtime.applyReasoningEffortChange(effort),
      applyModelChange: (target) => runtime.applyModelChange(target)
    },
    skills: { requestSkillsReload: () => void runtime.requestSkillsReload() },
    connectors: {
      invalidatePermissionProjection: () => permissionGrantProjection.invalidateProjection(),
      refreshConnectorSkillDocs: () => connectorRuntimeSettings.refresh(),
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      pruneCustomServerPermissions: (serverId) =>
        permissionGrantRegistry.prune({ kind: 'mcp_server', serverId }).then(() => undefined),
      beginCustomServerSecurityChange: (serverId) =>
        connectorService.beginCustomServerSecurityChange(serverId),
      clearCustomServerFailure: (serverId) => connectorService.clearCustomServerFailure(serverId)
    },
    appearance: { applyAppIconVariant: onAppIconVariantChanged ?? (() => undefined) }
  })
  declareElectronAdapter('settings', () =>
    registerSettingsIpcHandlers({
      service: settingsService,
      workflows: settingsWorkflows,
      listAppIconPreviews,
      connectorTemplateFiles: {
        select: async () => {
          const selected = await dialog.showOpenDialog({
            title: 'Import Connector configuration',
            properties: ['openFile'],
            filters: [{ name: 'Connector configuration', extensions: ['json'] }]
          })
          const filePath = selected.filePaths[0]
          if (selected.canceled || !filePath) return { cancelled: true as const }
          if ((await stat(filePath)).size > CONNECTOR_TEMPLATE_MAX_BYTES) {
            throw new Error('Connector configuration files must be 256 KiB or smaller')
          }
          return {
            cancelled: false as const,
            fileName: basename(filePath),
            contents: await readFile(filePath, 'utf8')
          }
        },
        save: async (suggestedFileName, contents, sender) => {
          const selected = await showSettingsSaveDialog(sender, {
            title: 'Export Connector configuration',
            defaultPath: suggestedFileName,
            filters: [{ name: 'Connector configuration', extensions: ['json'] }]
          })
          if (selected.canceled || !selected.filePath) return false
          await writeFile(selected.filePath, contents, 'utf8')
          return true
        }
      },
      skillExportFiles: {
        save: (archive, sender) =>
          saveSkillExport(
            {
              showSaveDialog: (options) => showSettingsSaveDialog(sender, options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive
          )
      }
    })
  )
  declareElectronAdapter('notebook', () => registerNotebookIpcHandlers(notebookCommands))
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
  const sessionPersistenceHandlers = createSessionPersistenceHandlers(
    sessionPersistenceBackend,
    reviewRepository
  )
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
      // Apply the switch to the live agent runtime. The closure is invoked per-request, so a
      // late-bound reference is unnecessary.
      (sessionId, specialistId) => runtime.switchSpecialist(sessionId, specialistId),
      // A specialist capability edit (skills/connectors/enabled) must reach live sessions on the next
      // turn: reconnect so the agent respawns (re-provisioning skills) and resumes with the updated
      // specialist whitelist in the session _meta.
      () => void runtime.requestSkillsReload(),
      createContributionTemplateExporter({
        appVersion: app.getVersion(),
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        readReadme: () => readFile(resolveContributionTemplateReadmePath(app.getAppPath()), 'utf8'),
        writeFile: (filePath, bytes) => writeFile(filePath, bytes)
      }),
      {
        service: specialistPackageService,
        selectArchive: () =>
          selectSpecialistArchive({
            showOpenDialog: (options) => dialog.showOpenDialog(options),
            readFile,
            getFileSize: async (filePath) => (await stat(filePath)).size
          }),
        saveReport: (report) =>
          saveSpecialistPackageReport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, contents) => writeFile(filePath, contents, 'utf8')
            },
            report
          ),
        saveExport: (archive) =>
          saveSpecialistExport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive
          )
      }
    )
  )
  // Runtime selection UI (Settings/Onboarding): survey managed+external per language, persist the
  // choice, and pick an interpreter file. The runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  const runtimeSelectionWorkflows = createRuntimeSelectionWorkflows({
    settingsService,
    runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
    micromambaRunner,
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
  declareElectronAdapter('notebook-runtime', () =>
    registerRuntimeIpcHandlers(runtimeSelectionWorkflows)
  )
  declareElectronAdapter('managed-preview', () =>
    installManagedPreviewElectronAdapter(previewResources, undefined, managedPreviewOwners)
  )
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
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
    provisioner = createProductionProvisioner(
      {
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
      },
      { runner: micromambaRunner }
    )
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

  const notebookEnvironmentLifecycle = createNotebookEnvironmentLifecycle({
    provisioner: serialized,
    root: provisioningRoot,
    projectProgress: broadcastNotebookEnvProgress,
    waitForRecovery,
    assertProvisionAllowed,
    onRepairCompleted: (language) => notebookService.completeRuntimeRepair(language)
  })
  // Always register the handlers (serialized is undefined when the provisioner could not be built).
  // Start maintenance only after all four Electron channels exist, preserving the previous startup
  // ordering while construction remains application-owned and single-instance.
  declareElectronAdapter('notebook-environment', () => {
    installNotebookEnvironmentSurface(notebookEnvironmentLifecycle, registerNotebookEnvIpcHandlers)
  })
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
  const storageCommandOwner = createStorageCommandOwner({
    runtime,
    notebook: notebookService,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    settingsService,
    micromambaRunner
  })
  declareElectronAdapter('storage', () =>
    registerStorageIpcHandlers(
      {
        runtime,
        notebook: notebookService,
        getActivePromptSessions: () => runtime.getActivePromptSessions(),
        settingsService
      },
      storageCommandOwner
    )
  )
  const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
    getActiveArtifactRunIds: () =>
      runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : [],
    provenance: artifactProvenanceRepository,
    codeReconstruction,
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  declareElectronAdapter('artifacts', () =>
    registerArtifactIpcHandlers(
      artifactRepository,
      artifactRunRegistry,
      () => (runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : []),
      artifactProvenanceRepository,
      (projectId, sessionId, mutation) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
      artifactHandlers
    )
  )
  declareElectronAdapter('uploads', () =>
    registerUploadIpcHandlers(uploadCommandOwner, {
      // Standalone "Save as artifact" uploads have no session mutation to piggyback on, so the
      // Files panel only learns about them through this broadcast.
      onStandaloneUploadSaved: (projectId, sessionId) =>
        broadcastToRenderers('project-files:changed', {
          projectId,
          sessionId,
          sources: ['upload'],
          kind: 'upsert'
        })
    })
  )
  declareElectronAdapter('notebook-input-preview', () => {
    ipcMainHandle('notebook:read-input-preview', (_event, request) =>
      notebookInputRegistry.readPreview(request)
    )
  })
  declareElectronAdapter('session-persistence', () =>
    registerSessionPersistenceIpcHandlers(
      sessionPersistenceBackend,
      reviewRepository,
      sessionPersistenceHandlers
    )
  )
  const conversationExportService = createConversationExportService({
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    isSessionActive: (projectId, sessionId) =>
      runtime
        .getActivePromptSessions()
        .some(
          (activeSession) =>
            activeSession.projectName === projectId && activeSession.sessionId === sessionId
        )
  })
  declareElectronAdapter('conversation-export', () =>
    registerConversationExportIpcHandler(conversationExportService)
  )
  declareElectronAdapter('permission-grants', () =>
    registerPermissionGrantIpcAdapter(permissionGrantProjection)
  )
  declareElectronAdapter('project-files', () =>
    registerProjectFilesIpcHandlers(
      projectFilesRepository,
      sessionPersistenceCoordinator,
      projectDeletionCoordinator,
      projectFilesHandlers
    )
  )
  // Backs the "This computer" browser; shares localFsService with the managed-preview resolver.
  declareElectronAdapter('local-fs', () => registerLocalFsIpcHandlers(localFsService))
  declareElectronAdapter('preview-state', () =>
    registerPreviewStateIpcHandlers(previewStateRepository)
  )
  declareElectronAdapter('lifecycle', () => registerLifecycleIpcHandlers())
  // Compute IPC handlers are registered earlier (before the notebook RPC server) so computeService
  // can be injected into the RPC server for the computeCall route. See above.
  // Wire the reviewer backend into the app lifecycle: installs ipcMainHandle('reviewer:run', ...)
  // and 'reviewer:get-for-session' so the renderer's fire-and-forget reviewer calls resolve to
  // real handlers instead of no-ops. Passing the already-constructed AcpRuntime so the reviewer
  // can spawn sessions under the same agent connection.
  const reviewerOptions = {
    acpRuntime: runtime,
    mcpEntryPath: mainEntryPath,
    artifactProvenanceRepository,
    withSessionMutation: <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ) => sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  }
  const reviewerCommandOwner = createReviewerCommandOwner(reviewerOptions)
  declareElectronAdapter('reviewer', () => {
    registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)
  })

  const electronSenderFor = (
    invocation: ApplicationInvocation<readonly unknown[]>
  ): WebContents => {
    const senderId = Number(invocation.callerContext.clientId)
    const sender =
      Number.isSafeInteger(senderId) && senderId > 0 ? webContents.fromId(senderId) : null
    if (!sender || sender.isDestroyed()) {
      throw new Error('Electron command caller is no longer available.')
    }
    return sender
  }
  const applicationCommandDependencies: ApplicationCommandCompositionDependencies = {
    acp: {
      runtime,
      workflows: acpHandlerWorkflows,
      archiveAvailability: archiveCoordinator
    },
    notebook: {
      workflows: notebookCommands,
      readInputPreview: (request) => notebookInputRegistry.readPreview(request)
    },
    notebookEnvironment: notebookEnvironmentLifecycle,
    notebookRuntime: {
      workflows: runtimeSelectionWorkflows,
      pickInterpreter: async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        return result.filePaths[0] ?? null
      }
    },
    settingsCore: {
      service: settingsService,
      appearance: settingsWorkflows.appearance,
      emitInstallEvent: (event) => broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event),
      listAppIconPreviews
    },
    settingsIntegration: {
      skills: settingsWorkflows.skills,
      connectors: settingsWorkflows.connectors,
      connectorApprovals: approvalBroker,
      skillImportApprovals: skillImportApprovalBroker
    },
    settingsRuntime: { workflows: settingsWorkflows.runtime },
    compute: {
      compute: computeIpcModule.handlers,
      bookmarks: {
        get: (providerId) => settingsService.getComputeBookmarks(providerId),
        set: (providerId, folders) => settingsService.setComputeBookmarks(providerId, folders)
      },
      enabledHosts: hostsRegistry
    },
    permissionGrants: permissionGrantProjection,
    dataContent: {
      artifacts: artifactHandlers,
      electron: {
        exportConversationFromInvokingWindow: (invocation) => {
          const sender = electronSenderFor(invocation)
          return conversationExportService.exportConversation(
            invocation.args[0],
            BrowserWindow.fromWebContents(sender) ?? undefined
          )
        },
        stageLocalFileWithProgress: (invocation) => {
          const sender = electronSenderFor(invocation)
          return uploadCommandOwner.stageLocalFile(invocation, {
            report: (progress) => sender.send('uploads:transfer-progress', progress)
          })
        }
      },
      events: applicationEvents,
      managedPreview: managedPreviewOwners,
      preview: {
        load: (request) => previewStateRepository.get(request.projectId),
        save: (request) => previewStateRepository.save(request.projectId, request.state),
        delete: (request) => previewStateRepository.delete(request.projectId)
      },
      projectFiles: projectFilesHandlers,
      projects: projectHandlers,
      sessions: sessionPersistenceHandlers,
      uploads: uploadCommandOwner,
      withDataRootWrite
    },
    host: {
      cli: cliCommandOwner,
      github: githubCommandOwner,
      localFs: localFsService,
      logs: logsCommandOwner,
      notifications: {
        getSnapshot: () => notificationInbox.getSnapshot(),
        markRead: (request) => notificationInbox.markRead(request.ids),
        markAllRead: (request) => notificationInbox.markAllRead(request.throughSequence),
        markSessionCompletionsRead: (request) =>
          notificationInbox.markSessionCompletionsRead(request.sessionIds),
        peekPendingOpenSession: () => taskNotifications.peekPendingOpenSession(),
        takePendingOpenSession: (expectedToken) =>
          taskNotifications.takePendingOpenSession(expectedToken)
      },
      reviewer: reviewerCommandOwner,
      storage: storageCommandOwner,
      update: updateCommandOwner
    }
  }

  // The shared coordinator remains the sole ACP + Notebook teardown owner. Register command routing
  // after it so reverse disposal removes adapters, then the router, before any underlying owner stops.
  await modules.add({ shutdownCoordinator }, ({ shutdownCoordinator: coordinator }) => ({
    name: 'backend-shutdown-coordinator',
    capability: undefined,
    disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS + APPLICATION_MODULE_DISPOSAL_BUDGET_MS,
    dispose: async () => BackendShutdownOutcomeError.assertClean(await coordinator.runForQuit())
  }))
  backendTeardownOwnedByCoordinator = true
  const applicationCommandComposition = await modules.add(
    applicationCommandDependencies,
    (dependencies) => {
      const composition = createApplicationCommandComposition(dependencies)
      return {
        name: 'application-command-composition',
        capability: composition,
        dispose: () => composition.dispose()
      }
    }
  )
  declareElectronAdapter('application-projects', () =>
    registerApplicationCommandElectronAdapter(applicationCommandComposition.electron)
  )

  return {
    applicationCommands: {
      localWeb: applicationCommandComposition.localWeb,
      remoteWeb: applicationCommandComposition.remoteWeb,
      task: applicationCommandComposition.task
    },
    applicationEvents,
    bindRemoteAccess: applicationCommandComposition.bindRemoteAccess,
    taskNotifications,
    notificationInbox,
    settingsService,
    taskAgent,
    sessionDeletionCapability: sessionPersistenceCoordinator,
    archiveCapability: archiveCoordinator,
    detectActiveSessions: () => detectActiveSessions({ runtime, notebook: notebookService }),
    prepareForQuit: () => runtime.prepareForQuit(),
    electronAdapters: {
      beforeCompute: beforeComputeAdapters,
      compute: computeIpcModule,
      beforeAcp: beforeAcpAdapters,
      acp: { runtime, workflows: acpHandlerWorkflows },
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
