import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'

import {
  app,
  BrowserWindow,
  dialog,
  net,
  Notification,
  protocol,
  session,
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
import { TagRepository } from './tags/repository'
import { TagResourceCatalog } from './tags/resource-catalog'
import { TagService } from './tags/service'
import { MemoryRepository } from './memory/repository'
import { MemoryService } from './memory/service'
import {
  LIFECYCLE_CHANNELS,
  MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
  MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID
} from '../shared/lifecycle-events'

import { createAcpRuntime } from './acp/runtime-composition'
import { SideChatRelayOwner } from './acp/side-chat-relay-owner'
import { createAcpCreateSessionWorkflow } from './acp/create-session-workflow'
import { createAcpHandlerWorkflows } from './acp/handler-workflows'
import { createAcpTaskAgentPort } from './acp/task-agent-port'
import {
  resolveValidatedSessionAgentTarget,
  shouldPersistSessionAgentConfiguration,
  toSessionAgentConfiguration,
  type SessionAgentTargetResolver
} from './acp/session-agent-target'
import { ArtifactCodeReconstructionRunner } from './acp/artifact-code-reconstruction-runner'
import { RestrictedInferenceRunner } from './acp/restricted-inference-runner'
import { ImageInputCompatibilityOwner } from './acp/image-input-compatibility-owner'
import { VisionEvidenceRepository } from './acp/vision-evidence-repository'
import { ArtifactTurnOwner } from './acp/artifact-turn-owner'
import { ArchiveCoordinator } from './archive/coordinator'
import { ArtifactCodeReconstructionService } from './artifacts/code-reconstruction'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  registerArtifactIpcHandlers,
  type ArtifactHandlers
} from './artifacts/ipc'
import { ArtifactProvenanceRepository } from './artifacts/provenance-repository'
import { ProvenanceMessageSnapshotRepository } from './artifacts/provenance-message-snapshot'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { createComputeIpcModule } from './compute/ipc'
import { createComputeArtifactResolver } from './compute/compute-service'
import { bindComputeApprovalSessionLifecycle } from './compute/approval-session-lifecycle'
import type { ComputeJobOwnerLiveness } from './compute/job-deletion-owner'
import { hasImmutableExecutionFileEvidenceReference } from '../shared/execution-file-evidence'
import { AgentComputeService } from './compute/agent-compute-service'
import { createSessionCatalogHydration } from './compute/session-catalog-hydration'
import { SessionEnabledComputeHostsOwner } from './compute/session-enabled-hosts-owner'
import { createComputeJobRuntime } from './compute/job-runtime'
import { LiteratureFullTextIndex } from './literature/full-text-index'
import { waitForInitialConnectorRefresh } from './connector-reload'
import { createConnectorApplicationModule } from './connectors/application'
import { isCustomMcpServerRouteSafe } from './connectors/custom-mcp-bootstrap'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { connectorSkillSourceDir } from './connectors/provision'
import { registerFileSaveHandlers } from './file-save'
import { publishUserFile } from './user-file-publisher'
import { ImmutableInputAuthority } from './immutable-input-authority'
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
import {
  createWebSessionPersistenceFlush,
  rendererSessionPersistenceFlushBlocksShutdown,
  type RendererSessionPersistenceFlushPolicy,
  type RendererSessionPersistenceSurface,
  type RendererSessionPersistenceTarget
} from './session-persistence/renderer-flush'
import { createLogsCommandOwner, registerLogsIpcHandlers } from './logs-ipc'
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
  buildConnectorCredentialRequestBroadcast,
  buildTaskNotificationShow,
  getTaskNotificationAvailability,
  showTestTaskNotification
} from './notifications/electron-wiring'
import { createLogger, diagnosticErrorFields, errorLogFields } from './logger'
import { startDiagnosticOperation, type DiagnosticOperation } from './diagnostics/operation'
import { broadcastNotebookEnvProgress, registerNotebookEnvIpcHandlers } from './notebook/env-ipc'
import {
  createNotebookApplicationModule,
  createNotebookLocalRpcModule,
  installNotebookEnvironmentSurface
} from './notebook/application'
import type { NotebookRuntimeService } from './notebook/runtime-service'
import { PermissionApprovalPresence } from './permission-approval-presence'
import { serializeProvisioner } from './notebook/environment-operation-foundation'
import { createNotebookEnvironmentLifecycle } from './notebook/environment-lifecycle-workflows'
import { NotebookNetworkSandboxOwner } from './notebook/network-sandbox-owner'
import { resolveNotebookTrustBundle } from './notebook/trust-bundle'
import {
  createManagedPreviewOwnerRegistry,
  installManagedPreviewElectronAdapter
} from './managed-preview-ipc'
import { ManagedPreviewResources } from './managed-preview-resources'
import type { PreviewProtocolRegistrar } from './managed-preview-protocol'
import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewSource
} from '../shared/preview-resources'
import { resolveEffectiveSpecialistSkills } from '../shared/specialist'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from './office-preview/office-preview-electron'
import { registerOfficePreviewIpcHandlers } from './office-preview/office-preview-ipc'
import {
  createOfficePreviewRuntimeUrl,
  createReviewerPagedPreviewRuntimeUrl,
  OFFICE_PREVIEW_RUNTIME_ORIGIN,
  registerOfficePreviewRuntimeProtocol
} from './office-preview/office-preview-runtime-protocol'
import { OfficePreviewSupervisor } from './office-preview/office-preview-supervisor'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { registerRuntimeIpcHandlers } from './notebook/runtime-ipc'
import { NotebookRunRepository, getRuntimeRoot } from './notebook/repository'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { createNotebookArtifactSourceScopeProvider } from './notebook/artifact-source-scope'
import {
  reconcileComputeJobFileEvidence,
  recoverPublishedComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from './notebook/working-file-observer'
import { NotebookInputRegistry } from './notebook/input-registry'
import { effectiveMirrorAsync } from './notebook/mirror-probe'
import { createProductionProvisioner, type RuntimeProvisioner } from './notebook/provisioner'
import { createProductionMicromambaRunner } from './notebook/windows-micromamba-runner'
import { createRuntimeWorkflows } from './notebook/runtime-workflows'
import { runtimeRoot } from './notebook/runtime-paths'
import { HostArtifactsService } from './notebook/host-artifacts-service'
import { HostLineageService } from './notebook/host-lineage-service'
import { HostFramesService } from './notebook/host-frames-service'
import { HostSessionsService } from './notebook/host-sessions-service'
import { HostModelService } from './notebook/host-model-service'
import { HostViewImageService } from './notebook/host-view-image-service'
import { parseArtifactVersionLocator } from '../shared/artifact-provenance'
import { PENDING_UPLOAD_SESSION_ID, parseUploadVersionReference } from '../shared/uploads'
import { DEFAULT_ARTIFACT_PROJECT_ID } from '../shared/artifacts'
import type { NotebookLanguage } from '../shared/notebook'
import { MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID } from '../shared/lifecycle-events'
import {
  OFFICE_PREVIEW_STATE_CHANNEL,
  type OfficePreviewOpenRequest
} from '../shared/office-preview'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  createProjectHandlers,
  registerPreviewStateIpcHandlers
} from './projects/ipc'
import {
  createReviewerCommandOwner,
  registerReviewerIpcHandlers,
  type ReviewerCommandOwner
} from './reviewer/ipc'
import { ReviewerModelRuntimeOwner } from './reviewer/model-runtime-owner'
import { ReviewerProjectRuntimeOwner } from './reviewer/project-runtime-owner'
import { createReviewerPagedContentResolver } from './reviewer/paged-preview-resolver'
import { renderPdfPagePreviews } from './uploads/attachment-media'
import {
  canReconcileSessionAbsences,
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlersWithAttributionAuthority,
  loadSessionMetadataAfterProjectRecovery,
  recoverProjectDeletionsForSessionRead,
  registerSessionPersistenceIpcHandlers,
  withSessionDeletionCleanup
} from './session-persistence/ipc'
import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from './session-persistence/conversation-export'
import { SessionProjectionDiagnostics } from './session-persistence/projection-diagnostics'
import { createProjectFilesHandlers, registerProjectFilesIpcHandlers } from './project-files/ipc'
import { createManagedFileIndexRepository } from './project-files/repository'
import {
  createManagedFileVersionHandlers,
  registerManagedFileVersionIpcHandlers
} from './managed-file-versions/ipc'
import { ManagedFileVersionService } from './managed-file-versions/service'
import {
  ProjectDeletionCoordinator,
  ProjectDeletionRecoveryLoop
} from './projects/deletion-coordinator'
import { ProjectRuntimeQuiescenceOwner } from './projects/project-runtime-quiescence-owner'
import { getProjectDbClient } from './projects/prisma-client'
import { seedDefaultPermissionGrants } from './permission-grants/defaults'
import { createPermissionGrantRegistry } from './permission-grants/registry'
import { isPermissionGrantScopeLive } from './permission-grants/scope-liveness'
import { registerPermissionGrantIpcAdapter } from './permission-grants/ipc'
import { createPermissionGrantProjectionController } from './permission-grants/projection-controller'
import {
  reconcilePendingCustomServerDeletions,
  reconcilePermissionGrantOwners
} from './permission-grants/reconciliation'
import {
  SessionPersistenceCoordinator,
  type ComputeJobDeletionParticipant,
  type SessionDeletion
} from './session-persistence/coordinator'
import { withSessionCacheDeletion } from './compute/session-cache-owner'
import { createMainPromptSideChatRelay } from './side-chat/main-prompt-relay'
import { registerSideChatIpcHandlers } from './side-chat/ipc'
import { SideChatRuntimeOwner } from './side-chat/runtime-owner'
import {
  coordinateSessionPersistenceWithProjectDeletions,
  type SessionPersistenceBackend
} from './session-persistence/ipc'
import { MainMessageAttributionAuthority } from './session-persistence/message-attribution-authority'
import {
  SessionAuxiliaryTurnUsageRecorder,
  type SessionAuxiliaryTurnUsageRecord
} from './session-persistence/auxiliary-turn-usage'
import { SessionPdfContextOwner } from './session-persistence/pdf-context-owner'
import { linkPdfContextWithCapability } from './session-persistence/pdf-context-link-workflow'
import { LiteratureDocumentReader } from './literature/document-reader'
import { SessionDeletionOwner } from './session-deletion/owner'
import { buildSessionDetailsUserPrompt, createSessionDetailsOwner } from './session-details/owner'
import { tryDecryptKey } from './settings/crypto'
import { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers } from './settings/ipc'
import { registerLocalFsIpcHandlers } from './local-fs/ipc'
import { GrantedLocalRootsRepository } from './local-fs/granted-roots-repository'
import { LocalFsService } from './local-fs/service'
import { SettingsService } from './settings/service'
import { SettingsRepository } from './settings/repository'
import { SettingsSnapshotCommitOwner } from './settings/settings-snapshot-commit-owner'
import type { SettingsDocumentStore } from './settings/document-store'
import { NetworkProxyRuntime } from './settings/network-proxy-runtime'
import type { NotebookRuntimeSettings } from './settings/capabilities'
import type { WindowSettingsCapabilities } from './settings/service-capabilities'
import { createProductionDelegatedWorkComposition } from './delegation/production-composition'
import { createProductionDelegatedFrameworkRuntime } from './delegation/production-framework-runtime'
import { finalizeDelegatedArtifactPublication } from './delegation/delegated-artifact-publication'
import {
  DelegateMessageParkedError,
  DelegateMessagePreAcceptanceError
} from './delegation/execution-port'
import { createDelegationSettlementContinuationDispatch } from './delegation/settlement-continuation-dispatch'
import { createSettingsWorkflows } from './settings/workflows'
import { showSettingsSaveDialog } from './settings/save-dialog'
import { SpecialistService } from './specialist/service'
import { SpecialistRepository } from './specialist/repository'
import { BuiltinSpecialistRegistry } from './specialist/builtin-registry'
import { composeBuiltinSkillCatalog } from './specialist/package/builtin-skill-catalog'
import { SpecialistPackageService } from './specialist/package/service'
import { OFFICIAL_MARKETPLACE_SOURCE } from './specialist/marketplace/official-source'
import { MarketplaceRepository } from './specialist/marketplace/repository'
import { MarketplaceService } from './specialist/marketplace/service'
import { MarketplaceOperationCoordinator } from './specialist/marketplace/operation-coordinator'
import {
  saveSpecialistExport,
  saveSpecialistPackageReport,
  selectSpecialistArchive
} from './specialist/package/electron-adapter'
import { UserSkillSpecialistPackageAdapter } from './skills/specialist-package-adapter'
import { saveSkillExport } from './skills/export'
import { netFetchStandard } from './skills/net-fetch'
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
import {
  SessionSpecialistReconfiguration,
  type PersistedSessionSpecialistBinding
} from './specialist/session-reconfiguration'
import { SPECIALIST_IPC } from '../shared/specialist'
import {
  CONNECTOR_TEMPLATE_MAX_BYTES,
  type AppIconPreview,
  type AppIconVariant,
  type RespondApprovalRequest,
  type SessionAgentConfiguration
} from '../shared/settings'
import type { AcpSessionAgentTarget } from '../shared/acp'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionSummary
} from '../shared/session-persistence'
import { registerStorageIpcHandlers } from './storage/ipc'
import { createStorageCommandOwner } from './storage/command-owner'
import {
  initializeDataRootWriteAvailability,
  isMigrationInProgress,
  isMigrationPending,
  runDataRootStartupRecovery,
  withDataRootWrite
} from './storage/migration-state'
import { isDataRootMissing } from './storage/path-presence'
import { normalizeLegacyDataPaths } from './storage/normalize-legacy-paths'
import { DataRootCleanupJournal } from './storage/data-root-cleanup'
import {
  markManagedProjectWorkspacesRetained,
  markManagedWorkspaceRetained,
  reconcileProvisionalManagedWorkspaces,
  restoreManagedProjectWorkspacesActive,
  restoreManagedWorkspaceActive
} from './storage/managed-workspace-ownership'
import { deleteSources } from './storage/data-migration'
import { removeMicromambaCacheForRoot } from './notebook/micromamba-cache'
import { removeNotebookWorkloadCache } from './notebook/notebook-workload-cache-paths'
import { createDelegatedActivityProjection, detectActiveSessions } from './storage/detect-active'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot,
  samePath
} from './storage-root'
import { createUpdateCommandOwner, registerUpdateIpcHandlers } from './update/ipc'
import { createUpdateStrategy } from './update/create-strategy'
import {
  createActiveResearchSafeInstallGate,
  createDataRootResearchSafeInstallGate,
  createDurableInstallGate,
  type InstallReadiness
} from './update/strategy'
import type { UpdateBlocker } from '../shared/update'
import { startUpdateScheduler } from './update/scheduler'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'
import { createUploadCommandOwner } from './uploads/command-owner'
import { broadcastToRenderers, installRendererBroadcastEventHub } from './renderer-broadcast'
import {
  installElectronRuntimeAdapters,
  type ElectronRuntimeAdapterInterfaces,
  type NamedElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { HostSkillsService, type HostSkillsCatalog } from './skills/host-skills-service'
import { UserSkillCatalogObserver } from './skills/user-skill-catalog-observer'
import type { ConversationSkillImportApprovalResponse } from '../shared/settings'
import type { TaskControlPorts } from './tasks/task-control-ports'
import type { TaskAgentPort } from './tasks/task-runner'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'

const permissionGrantsLog = createLogger('permission-grants')
const notebookStartupLog = createLogger('notebook:startup')

type IpcRegistrationOptions = {
  mainEntryPath: string
  // Startup and the application runtime share one settings.json transaction owner. Tests and
  // non-desktop compositions may omit it and receive the existing default store.
  settingsStore?: SettingsDocumentStore
  translate?: NativeTranslator
  managedPreviewProtocol: PreviewProtocolRegistrar
  // Headless web-serve launches (--serve) have no local desktop user; task notifications are
  // disabled there by contract, not just incidentally via Notification.isSupported().
  headless?: boolean
  // Applies a newly-selected app-icon variant to the window + dock/taskbar and the Windows tray.
  // Supplied by the desktop startup path; absent in web/headless mode (no local window to re-skin).
  onAppIconVariantChanged?: (variant: AppIconVariant) => void
  // Renders the built-in icon variants to preview data URLs for the Appearance picker.
  listAppIconPreviews?: () => AppIconPreview[]
  // Flushes renderer-owned Session/Preview state after backend teardown and before an in-place
  // handoff (update install or data-root switch). Desktop startup supplies the late-bound window.
  confirmRendererDurability?: (
    policy?: RendererSessionPersistenceFlushPolicy,
    surface?: RendererSessionPersistenceSurface
  ) => Promise<boolean>
  notifyRendererDurabilityAborted?: () => void
  // Retained as an explicit startup marker while the app owns the only handoff composition.
  handoffRuntime?: 'production'
}

export type ApplicationRuntimeInterfaces = {
  applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb' | 'task'>
  applicationEvents: ApplicationEventSource
  permissionApprovalPresence: PermissionApprovalPresence
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
  commitClosePreference: (
    preference: Parameters<WindowSettingsCapabilities['setClosePreference']>[0]
  ) => Promise<void>
  taskAgent: TaskAgentPort
  taskControls: TaskControlPorts
  computePreferences: Pick<SessionEnabledComputeHostsOwner, 'withReservation' | 'set'>
  sessionDeletionCapability: Pick<SessionDeletion, 'setSessionDeletionHandlers'>
  archiveCapability: Pick<ArchiveCoordinator, 'isSessionAvailableById' | 'setMarkReadSessions'>
  detectActiveSessions: () => ReturnType<typeof detectActiveSessions>
  hasActiveReviewerWork: () => boolean
  getActiveSettingsInstallId: () => string | undefined
  holdSettingsInstallAdmission: () => () => void
  prepareForQuit: () => Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
  abortQuitPreparation: () => void
}

type ApplicationModuleInterfaces = ApplicationRuntimeInterfaces & {
  readonly electronAdapters: ElectronRuntimeAdapterInterfaces
}

type IpcRegistration = ApplicationRuntimeInterfaces & {
  dispose: () => Promise<void>
}

// Constructs application-owned modules and their narrow Electron adapter interfaces. The factory does
// not register a channel or protocol; transport installation happens only after construction succeeds.
const createApplicationModules = async (
  {
    mainEntryPath,
    settingsStore,
    managedPreviewProtocol,
    headless = false,
    translate = englishNativeTranslator,
    onAppIconVariantChanged,
    listAppIconPreviews,
    confirmRendererDurability = () => Promise.resolve(true),
    notifyRendererDurabilityAborted = () => undefined
  }: IpcRegistrationOptions,
  modules: ApplicationModuleBuilder,
  composition: DiagnosticOperation
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
  const permissionApprovalPresence = new PermissionApprovalPresence()
  const webSessionPersistenceFlush = createWebSessionPersistenceFlush(applicationEvents)
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const specialistPackageSkillAdapter = new UserSkillSpecialistPackageAdapter(resolveConfigRoot())
  const specialistPackageRecovery = {
    current: undefined as (<T>(operation: () => Promise<T>) => Promise<T>) | undefined
  }
  const settingsRepository = new SettingsRepository(
    settingsStore ?? resolveConfigRoot(),
    (operation) => specialistPackageSkillAdapter.runMutationExclusive(operation)
  )
  const networkProxyRuntime = new NetworkProxyRuntime({
    setProxy: (config) => session.defaultSession.setProxy(config)
  })
  const settingsServiceRef: { current?: SettingsService } = {}
  const grantedRootsRepositoryRef: { current?: GrantedLocalRootsRepository } = {}
  const notebookPolicyLifecycle: {
    current?: Pick<NotebookRuntimeService, 'shutdownAll'>
  } = {}
  const notebookPolicyLog = createLogger('notebook:policy')
  const shutdownNotebooksBeforePolicyChange = async (
    trigger: 'ca-bundle' | 'granted-roots'
  ): Promise<void> => {
    const operation = startDiagnosticOperation(notebookPolicyLog, {
      operation: 'notebook-policy-shutdown',
      fields: { trigger }
    })
    if (!notebookPolicyLifecycle.current) {
      const error = new Error('Notebook policy lifecycle is not ready.')
      operation.fail(error)
      throw error
    }
    try {
      const result = await notebookPolicyLifecycle.current.shutdownAll()
      operation.complete({ reaped: result.reaped })
    } catch (error) {
      operation.fail(error)
      throw error
    }
  }
  const notebookNetworkSandbox = await modules.add(undefined, () => {
    const capability = new NotebookNetworkSandboxOwner({
      resourceRoot: app.isPackaged
        ? join(process.resourcesPath, 'notebook-network-sandbox')
        : join(app.getAppPath(), 'packages', 'notebook-network-sandbox', 'vendor'),
      getSettings: async () => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return service.getNotebookNetwork()
      },
      getCaBundlePath: async () => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return (await service.getPackageMirror()).caBundle
      },
      getGrantedLocalRoots: async () => grantedRootsRepositoryRef.current?.list() ?? [],
      persistAlwaysAllow: async (hostname) => {
        const service = settingsServiceRef.current
        if (!service) throw new Error('Settings are not ready.')
        return service.allowNotebookNetworkDomain(hostname)
      },
      requestDecision: async ({ sessionId, hostname, port, runtime, reason, signal }) => {
        if (headless && !permissionApprovalPresence.isAvailable()) return 'unavailable'
        const coordinator = runtimeRef.current
        if (!coordinator || signal.aborted) return 'deny'
        const selected = await coordinator
          .requestAppPermission({
            sessionId,
            title: `Connect to ${hostname}?`,
            rawInput: {
              notebookNetworkApproval: {
                hostname,
                ...(port === undefined ? {} : { port }),
                ...(runtime === undefined ? {} : { runtime }),
                ...(reason === undefined ? {} : { reason })
              }
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
              {
                optionId: 'always-allow',
                name: 'Global',
                kind: 'allow_always',
                scope: 'global'
              },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ],
            signal
          })
          .catch(() => undefined)
        return selected === 'always-allow'
          ? 'alwaysAllow'
          : selected === 'allow-once'
            ? 'allowOnce'
            : 'deny'
      },
      getParentProxy: async () => {
        const environment = networkProxyRuntime.getChildProcessProxyEnvironment()
        if (!environment) return undefined
        const parentProxy = {
          http: environment.HTTP_PROXY ?? environment.http_proxy ?? environment.ALL_PROXY,
          https: environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.ALL_PROXY,
          noProxy: environment.NO_PROXY ?? environment.no_proxy
        }
        return parentProxy.http || parentProxy.https ? parentProxy : undefined
      }
    })
    return {
      capability,
      rollback: () => capability.dispose(),
      dispose: () => capability.dispose()
    }
  })
  const settingsService = await modules.add(undefined, () => {
    const capability = new SettingsService({
      repository: settingsRepository,
      skillRuntimeMcpEntryPath: mainEntryPath,
      openAlexFetch: netFetchStandard,
      applyNetworkProxy: async (settings) => {
        await networkProxyRuntime.apply(settings)
        await notebookNetworkSandbox.updateParentProxy()
      },
      withUserSkillRecoveryBarrier: (operation) =>
        specialistPackageRecovery.current?.(operation) ?? operation(),
      applyNotebookNetwork: async (settings) => notebookNetworkSandbox.applySettings(settings),
      validatePackageMirror: async (settings) => {
        await resolveNotebookTrustBundle(settings.caBundle)
      },
      applyPackageMirror: async () => {
        await notebookNetworkSandbox.updateTrustBundle()
      },
      beforePackageMirrorCaBundleChange: () => shutdownNotebooksBeforePolicyChange('ca-bundle'),
      getNotebookNetworkStatus: () => notebookNetworkSandbox.status(),
      installNotebookNetwork: () => notebookNetworkSandbox.installWindows(),
      removeNotebookNetwork: () => notebookNetworkSandbox.removeWindows(),
      resolveCodexProxyEnvironment: () =>
        Promise.resolve(networkProxyRuntime.getChildProcessProxyEnvironment())
    })
    return {
      name: 'settings-service',
      capability,
      rollback: () => capability.dispose(),
      dispose: () => capability.dispose(),
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS
    }
  })
  settingsServiceRef.current = settingsService
  const settingsSnapshotCommits = new SettingsSnapshotCommitOwner(
    settingsService,
    applicationEvents
  )
  const resolveSessionAgentTarget: SessionAgentTargetResolver = async (source) =>
    resolveValidatedSessionAgentTarget(source, await settingsService.getSettingsView())
  const resolveDefaultSessionAgentTarget = async (): Promise<AcpSessionAgentTarget> => {
    const target = await settingsService.captureActiveExplicitAgentBackendTarget()
    return {
      frameworkId: target.frameworkId,
      providerId: target.providerId,
      ...(target.model.kind === 'required' ? { model: target.model.id } : {}),
      reasoningEffort: target.reasoningEffort
    }
  }
  const storedSettings = await settingsService.getStoredSettings()
  const storageLog = createLogger('storage')
  await networkProxyRuntime.apply(storedSettings.networkProxy)
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot)
  const configuredDataRootMissing =
    Boolean(storedSettings.dataRoot?.trim()) && (await isDataRootMissing(resolveDataRoot()))
  initializeDataRootWriteAvailability(configuredDataRootMissing)
  const dataRootCleanupJournal = new DataRootCleanupJournal(resolveConfigRoot())
  await runDataRootStartupRecovery(
    async () => {
      const cleanup = await dataRootCleanupJournal.recover(
        resolveDataRoot(),
        deleteSources,
        (sourceRoot) => {
          const runtimeRoot = join(sourceRoot, 'runtime')
          const workloadRemoved = removeNotebookWorkloadCache(runtimeRoot)
          const micromambaRemoved = removeMicromambaCacheForRoot(runtimeRoot)
          return workloadRemoved && micromambaRemoved
        }
      )
      if (cleanup.pending) {
        storageLog.warn('old data root cleanup remains pending', {
          cleanupFailureCount: cleanup.failureCount
        })
      }
    },
    {
      reportFailure: (error) =>
        storageLog.warn('old data root cleanup recovery failed', diagnosticErrorFields(error))
    }
  )
  const notificationInbox = createNotificationInboxController({
    headless,
    repository: new NotificationInboxDbRepository(() => getProjectDbClient(resolveConfigRoot())),
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
  composition.phase('data-root')

  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const uploadRepository = createDefaultUploadRepository()
  await runDataRootStartupRecovery(() => uploadRepository.recoverStagingUploads(), {
    reportFailure: (error) => {
      // Ready bytes remain fail-closed; keep startup available so Files can surface unaffected rows and
      // the next launch can retry any recoverable staging Version.
      storageLog.error(
        'staging upload recovery incomplete; will retry next launch',
        diagnosticErrorFields(error)
      )
    }
  })
  const managedFileVersionService = new ManagedFileVersionService({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })
  // Session reads and permission scope validation both need a late-bound view of ACP ownership:
  // startup runs before the runtime exists, while later reads must preserve live prompt state.
  const runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined } = {
    current: undefined
  }
  const userSkillCatalogObserverRef: { current: UserSkillCatalogObserver | undefined } = {
    current: undefined
  }
  const requestSkillCatalogRefresh = (): void => {
    const observer = userSkillCatalogObserverRef.current
    if (observer) {
      void observer.notifyCatalogChanged()
      return
    }
    if (runtimeRef.current) {
      void settingsService
        .registeredHelperCatalog()
        .refresh()
        .then(() => {
          broadcastToRenderers('skills:catalog-changed', undefined)
          return runtimeRef.current?.requestSkillsReload()
        })
        .catch((error) => {
          createLogger('skills').warn(
            'Skill catalog reconciliation failed',
            diagnosticErrorFields(error)
          )
        })
    }
  }
  const sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined } = {
    current: undefined
  }
  const sessionRepository = createDefaultSessionRepository(
    (projectId, sessionId) =>
      (runtimeRef.current?.getActivePromptSessions() ?? []).some(
        (session) => session.projectId === projectId && session.sessionId === sessionId
      ),
    (projectId, sessionId) => runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false
  )
  const auxiliaryUsageLog = createLogger('session-usage:auxiliary')
  const auxiliaryUsageRecorder = new SessionAuxiliaryTurnUsageRecorder(() =>
    getProjectDbClient(resolveConfigRoot())
  )
  const recordAuxiliaryUsage = async (record: SessionAuxiliaryTurnUsageRecord): Promise<void> => {
    try {
      await auxiliaryUsageRecorder.record(record)
    } catch (error) {
      auxiliaryUsageLog.warn('auxiliary turn Usage persistence failed', {
        source: record.source,
        ...diagnosticErrorFields(error)
      })
    }
  }
  const projectRepository = createDefaultProjectRepository()
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    let normalizationOperation: DiagnosticOperation | undefined
    await runDataRootStartupRecovery(
      async () => {
        normalizationOperation = startDiagnosticOperation(storageLog, {
          operation: 'legacy-data-root-normalization',
          fields: { mode: 'legacy-normalize' }
        })
        normalizationOperation.phase('rewrite-paths')
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
      },
      {
        reportFailure: (error) => normalizationOperation?.fail(error)
      }
    )
  }

  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const immutableInputAuthority = new ImmutableInputAuthority({
    storageRoot: resolveDataRoot(),
    managedFileVersions: managedFileVersionService
  })
  const artifactProvenanceRepository = new ArtifactProvenanceRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot()),
    inputAuthority: immutableInputAuthority,
    managedFileVersions: managedFileVersionService,
    compatibilityRepository: artifactRepository,
    loadSession: (projectId, appSessionId) => sessionRepository.loadSession(projectId, appSessionId)
  })
  const provenanceMessageSnapshots = new ProvenanceMessageSnapshotRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })
  const artifactRunRegistry = new ArtifactRunRegistry()
  // The upload repository above is shared so staging recovery, Session upgrade, prompt finalization,
  // and previews all observe one durable Version authority.
  // Shared local-fs service backs both the "This computer" browser IPC and the managed-preview
  // resolver below, so path validation stays identical across both entry points. Granted folder
  // roots persist in the SQLite project DB behind the local-fs:granted-roots:* channels; the
  // settings service is passed as the legacy store so a pre-existing settings.json
  // grantedLocalRoots field is imported into the DB once on first use.
  const grantedRootsRepository = new GrantedLocalRootsRepository(
    () => getProjectDbClient(resolveConfigRoot()),
    settingsService
  )
  grantedRootsRepositoryRef.current = grantedRootsRepository
  const localFsService = new LocalFsService(grantedRootsRepository, () =>
    shutdownNotebooksBeforePolicyChange('granted-roots')
  )
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    _source: Extract<ManagedPreviewSource, 'local'>,
    request: {
      path: string
      projectId?: string
      sessionId?: string
      fileId?: string
      versionId?: string
    }
  ): Promise<string> => {
    return localFsService.resolveFilePath(request)
  }
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    resolvePath: resolveManagedFilePath,
    openLatestManagedFile: (source, request) =>
      managedFileVersionService.openLatest({ source, ...request }),
    openManagedFileVersion: (source, request) =>
      managedFileVersionService.openVersion(
        { source, projectId: request.projectId, fileId: request.fileId },
        request.versionId
      ),
    openNotebookInput: (request) => notebookInputRegistry.openPreviewKey(request.path)
  })
  const managedPreviewOwners = createManagedPreviewOwnerRegistry(previewResources)

  // Permission scope validation starts before the ACP coordinator is constructed. Keep the late-bound
  // reference here so a first-turn Session grant can recognize its live owner before the renderer's
  // asynchronous session persistence finishes.
  const artifactHandlersRef: { current: ArtifactHandlers | undefined } = { current: undefined }
  const reviewerCommandOwnerRef: { current: ReviewerCommandOwner | undefined } = {
    current: undefined
  }
  const reviewerProjectRuntime = new ReviewerProjectRuntimeOwner()
  const messageAttributionAuthority = new MainMessageAttributionAuthority()
  const notebookActivityRef: {
    current: { getActiveNotebookSessions(): { projectId: string; sessionId: string }[] } | undefined
  } = { current: undefined }

  // Construct one storage/index/deletion graph for every related IPC surface. Sharing these instances
  // is essential: separate coordinators would have independent queues and recovery gates.
  const configRoot = resolveConfigRoot()
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
  composition.phase('permission-grants')
  const projectFilesRepository = createManagedFileIndexRepository(
    getProjectDbClient,
    configRoot,
    resolveDataRoot(),
    managedFileVersionService,
    uploadRepository
  )
  const notebookInputRegistry = new NotebookInputRegistry({
    storageRoot: resolveDataRoot(),
    inputAuthority: immutableInputAuthority,
    resolveArtifactVersionIdentity: async (projectId, versionId) => {
      const [artifact] = await projectFilesRepository.readHostArtifactCatalog({
        projectId,
        versionId,
        finalizedArtifactsOnly: true
      })
      return artifact?.source === 'artifact' ? { sourceFileId: artifact.sourceFileId } : undefined
    }
  })
  const isComputeJobOwnerLive = async ({
    projectId,
    sessionId
  }: {
    projectId: string
    sessionId: string
  }): Promise<ComputeJobOwnerLiveness> => {
    if (!(await projectRepository.get(projectId))) return false
    const owner = await sessionRepository.loadSessionWithDiagnostics(projectId, sessionId)
    if (owner.status === 'unreadable') return 'unknown'
    return owner.status === 'found'
  }
  const computeJobDeletionRef: {
    current?: Required<ComputeJobDeletionParticipant> & {
      reconcileProjectOrphanJobs(
        projectId: string,
        isOwnerLive: typeof isComputeJobOwnerLive
      ): Promise<void>
    }
  } = {}
  const computeJobActivityRef: {
    current?: {
      findNonTerminal(): Promise<Array<{ project_id: string }>>
      countNonTerminalBySession(sessionId: string): Promise<number>
    }
  } = {}
  const sessionCacheOwnerRef: {
    current?: {
      removeSession(projectId: string, sessionId: string): Promise<void>
      removeProject(projectId: string): Promise<void>
      reconcileActiveSessions(
        sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
      ): Promise<void>
    }
  } = {}
  const projectRuntimeQuiescenceRef: { current?: ProjectRuntimeQuiescenceOwner } = {}
  const computeJobDeletionPort = {
    restoreProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.restoreProjectJobDeletion(projectId)
    },
    prepareSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.prepareSessionJobDeletion(projectId, sessionId)
    },
    commitSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.commitSessionJobDeletion(projectId, sessionId)
    },
    prepareProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.prepareProjectJobDeletion(projectId)
    },
    commitProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.commitProjectJobDeletion(projectId)
    },
    abortSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.abortSessionJobDeletion(projectId, sessionId)
    },
    abortProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.abortProjectJobDeletion(projectId)
    }
  }
  // Delegated execution can outlive its root Turn and therefore is absent from the ACP runtime's
  // active-prompt list. Keep a synchronous projection of durable delegated mutations for the
  // close/quit and storage-migration safety gates. The selector deliberately ignores active routes:
  // inactive-branch work still owns processes/files and must block disruptive operations.
  const delegatedActivity = createDelegatedActivityProjection()
  const getActiveDelegatedSessions = (): { projectId: string; sessionId: string }[] =>
    delegatedActivity.getActiveDelegatedSessions()
  const getActiveSideChatSessions = (): { projectId: string; sessionId: string }[] =>
    (sideChatOwnerRef.current?.list().chats ?? [])
      .filter((chat) => chat.running)
      .map((chat) => ({ projectId: chat.projectId, sessionId: chat.parentSessionId }))

  const managedWorkspaceRecoveryCutoff = Date.now()
  const sessionPersistenceCoordinator = new SessionPersistenceCoordinator(
    sessionRepository,
    projectFilesRepository,
    (event) => broadcastToRenderers('project-files:changed', event),
    provenanceMessageSnapshots,
    uploadRepository,
    artifactProvenanceRepository,
    {
      reconcileSessions: async (sessions) => {
        await reconcilePermissionGrantOwners(permissionGrantRegistry, { sessions })
        await sessionCacheOwnerRef.current?.reconcileActiveSessions(sessions)
      }
    },
    undefined,
    computeJobDeletionPort,
    (session, owner) => {
      if (owner === 'runtime-context') {
        broadcastToRenderers(LIFECYCLE_CHANNELS.sessionUpdated, {
          session,
          originClientId: MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID
        })
        return
      }
      delegatedActivity.recordSession(session)
      broadcastToRenderers(LIFECYCLE_CHANNELS.sessionUpdated, {
        session,
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID
      })
    },
    (session) => {
      // Re-enabling Delegation invalidates the last admission rejection, so the Subagent
      // availability notice disappears instead of waiting for the next successful delegation.
      if (session.delegationPolicy === 'allow') {
        delegatedWorkRef.current?.root.clearUnavailableReason?.(session.id)
      }
    },
    {
      reconcileProvisional: (sessions) =>
        reconcileProvisionalManagedWorkspaces(sessions, managedWorkspaceRecoveryCutoff),
      markProjectRetained: markManagedProjectWorkspacesRetained,
      restoreProjectActive: restoreManagedProjectWorkspacesActive,
      markRetained: markManagedWorkspaceRetained,
      restoreActive: restoreManagedWorkspaceActive
    }
  )
  const sessionPdfContextOwner = new SessionPdfContextOwner({
    inputs: immutableInputAuthority,
    pendingUploads: {
      resolveContent: ({ projectId, path }) =>
        uploadRepository.resolveManagedUploadPath(
          { path },
          { projectId, sessionId: PENDING_UPLOAD_SESSION_ID }
        )
    },
    sessions: sessionPersistenceCoordinator
  })
  const literatureContextLog = createLogger('literature-reading-context')
  let stopLiteratureIndexRetention: (() => Promise<void>) | undefined
  await modules.add(undefined, () => ({
    name: 'literature-index-retention',
    capability: undefined,
    start: () => {
      stopLiteratureIndexRetention = LiteratureFullTextIndex.startRetentionSweep(
        resolveDataRoot(),
        (error) => {
          literatureContextLog.error('Literature index maintenance failed', errorLogFields(error))
        }
      )
    },
    dispose: () => stopLiteratureIndexRetention?.()
  }))
  const literatureDocumentReader = new LiteratureDocumentReader({
    storageRoot: resolveDataRoot(),
    inputs: immutableInputAuthority,
    sessions: sessionPersistenceCoordinator
  })
  const sideChatRelay = new SideChatRelayOwner({
    targetState: (parentSessionId) => {
      const runtime = runtimeRef.current
      if (!runtime) return 'completed'
      const snapshot = runtime.getSnapshot()
      if (snapshot.promptInFlightSessionIds.includes(parentSessionId)) {
        return snapshot.pendingPermissions.some(
          (permission) => permission.sessionId === parentSessionId
        )
          ? 'waiting'
          : 'running'
      }
      return runtime.liveSessionProjectId(parentSessionId) ? 'idle' : 'completed'
    },
    appendRelay: ({ projectId, parentSessionId, sideChatId, relay }) =>
      sessionPersistenceCoordinator.appendSideChatRelay({
        projectId,
        sessionId: parentSessionId,
        sideChatId,
        relay
      })
  })
  const mainPromptSideChatRelay = createMainPromptSideChatRelay({
    relay: sideChatRelay,
    steerAdvisory: async (request) =>
      runtimeRef.current
        ? runtimeRef.current.steerSideChatAdvisory(request)
        : Object.freeze({ injected: false }),
    commitSideChatRelays: (command) => sessionPersistenceCoordinator.commitSideChatRelays(command),
    onDelivered: (event) => broadcastToRenderers('side-chat:relay-delivered', event)
  })
  const uploadCommandOwner = createUploadCommandOwner(uploadRepository, {
    openLatestManagedFile: (request) =>
      managedFileVersionService.openLatest({
        source: 'upload',
        projectId: request.projectId!,
        fileId: request.fileId!
      }),
    openManagedFileVersion: (request) =>
      managedFileVersionService.openVersion(
        { source: 'upload', projectId: request.projectId!, fileId: request.fileId! },
        request.versionId
      ),
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  const reviewRepository = createDefaultReviewRepository()
  const projectDeletionCoordinator = new ProjectDeletionCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    reviewRepository,
    artifactProvenanceRepository,
    permissionGrantRegistry,
    {
      beforeProjectDelete: async (projectId) => {
        const owner = projectRuntimeQuiescenceRef.current
        if (!owner) throw new Error('Project runtime cleanup is not initialized.')
        await archiveCoordinator.withProjectDeletion(projectId, async () => {
          notebookService.beginProjectDeletion(projectId)
          await owner.quiesceProject(projectId)
        })
      },
      restoreProjectDeletion: async (projectId) => {
        archiveCoordinator.restoreProjectDeletion(projectId)
        notebookService.beginProjectDeletion(projectId)
        reviewerProjectRuntime.restoreProjectDeletion(projectId)
        await computeJobDeletionPort.restoreProjectJobDeletion(projectId)
      },
      finalizeProjectDeletion: async (projectId) => {
        const owner = sideChatOwnerRef.current
        if (!owner) throw new Error('Side chat runtime cleanup is not initialized.')
        await owner.completeProjectDeletion(projectId)
        await notebookService.deleteProjectFileEvidence(projectId)
        await notebookService.deleteProjectInputs(projectId)
      },
      completeProjectDeletion: (projectId) => {
        archiveCoordinator.releaseProjectDeletion(projectId)
        notebookService.releaseProjectDeletion(projectId)
        reviewerProjectRuntime.releaseProjectDeletion(projectId)
      },
      abortProjectDeletion: async (projectId) => {
        archiveCoordinator.releaseProjectDeletion(projectId)
        notebookService.releaseProjectDeletion(projectId)
        reviewerProjectRuntime.releaseProjectDeletion(projectId)
        sideChatOwnerRef.current?.restoreProject(projectId)
        await computeJobDeletionPort.abortProjectJobDeletion(projectId)
      }
    },
    applicationEvents
  )
  const detectArchiveBlockingSessions = (): ReturnType<typeof detectActiveSessions> =>
    detectActiveSessions({
      runtime: {
        getActivePromptSessions: () => runtimeRef.current?.getActivePromptSessions() ?? []
      },
      sideChat: { getActivePromptSessions: getActiveSideChatSessions },
      delegated: { getActiveDelegatedSessions },
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
        sideChatOwnerRef.current?.hasForParent(sessionId) === true ||
        detectArchiveBlockingSessions().some(
          (session) => session.projectId === projectId && session.sessionId === sessionId
        ),
      isProjectBusy: async (projectId) => {
        if (
          reviewerProjectRuntime.isProjectBusy(projectId) ||
          detectArchiveBlockingSessions().some((session) => session.projectId === projectId)
        ) {
          return true
        }
        const computeJobs = computeJobActivityRef.current
        if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
        return (await computeJobs.findNonTerminal()).some((job) => job.project_id === projectId)
      },
      liveSessionProjectId: (sessionId) => runtimeRef.current?.liveSessionProjectId(sessionId)
    }
  )
  notificationInbox.setSessionAvailability((sessionId) =>
    archiveCoordinator.isSessionAvailableById(sessionId)
  )
  archiveCoordinator.setMarkReadSessions((sessionIds) =>
    notificationInbox.markSessionsRead(sessionIds)
  )
  const sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner } = {}
  const visionEvidenceRepository = new VisionEvidenceRepository(() =>
    getProjectDbClient(configRoot)
  )
  bindNotificationInboxDeletionRuntime({
    inbox: notificationInbox,
    sessionPersistenceCoordinator,
    onSessionsDeleted: async (sessionIds) => {
      await Promise.all([
        sessionEnabledComputeHostsOwnerRef.current?.clear(sessionIds),
        sideChatOwnerRef.current?.invalidateParents(sessionIds),
        visionEvidenceRepository.deleteSessions(sessionIds)
      ])
    },
    onSessionsReconciled: async (sessionIds) => {
      await visionEvidenceRepository.reconcileSessions(sessionIds)
    }
  })
  const projectHandlers = createProjectHandlers(projectRepository, projectDeletionCoordinator, {
    updateArchive: (request) => archiveCoordinator.updateProjectArchive(request),
    onAgentContextChanged: () => {
      // Runtime generations capture Project Agent Context during Session setup. Retiring them marks
      // idle Sessions for resume immediately; an in-flight turn drains before its next prompt.
      void runtimeRef.current?.requestProjectAgentContextReload()
    }
  })
  const projectFilesHandlers = createProjectFilesHandlers(
    projectFilesRepository,
    sessionPersistenceCoordinator,
    projectDeletionCoordinator
  )
  const managedFileVersionHandlers = createManagedFileVersionHandlers(managedFileVersionService, {
    withDataRootWrite,
    onChanged: (event) => broadcastToRenderers('project-files:changed', event)
  })
  // Stashed host.agents.switch bindings for sessions that are not yet durable (fresh unsent drafts),
  // flushed to disk on the session's first save so an approved switch survives an app restart before
  // the next message. Shared by persistSessionSpecialist (stash) and saveSession (flush).
  const pendingSpecialistBindings = new PendingSessionSpecialistBindings()
  const sessionCatalogHydration = createSessionCatalogHydration({
    owner: () => {
      if (!sessionEnabledComputeHostsOwnerRef.current) {
        throw new Error('Session enabled Compute Host ownership is not initialized.')
      }
      return sessionEnabledComputeHostsOwnerRef.current
    },
    projectRecovery: projectDeletionCoordinator,
    sessionLoader: sessionPersistenceCoordinator
  })
  const loadAllSessions = (): Promise<LoadAllSessionsResult> => sessionCatalogHydration.loadAll()
  const sessionProjectionDiagnostics = new SessionProjectionDiagnostics()
  const ensureSessionProjection = async (): Promise<{
    result?: LoadAllSessionsResult
    sessions: SessionSummary[]
  }> => {
    // Reconcile a JSON write from a committed Project tombstone before deletion recovery removes
    // that temporary authority. Its SQLite facts remain part of retained Project history.
    await sessionRepository.reconcilePendingSessionProjection()
    const recovery = await sessionCatalogHydration.recoverProjectDeletions()
    if (!recovery.isComplete) {
      const result = recovery.result
      const sessions = await sessionRepository.summarizeReadOnlyAuthority(result)
      await sessionPersistenceCoordinator.replaceSessionMetadata(sessions, false)
      return { result, sessions }
    }
    const projection = await sessionRepository.ensureSessionProjection(loadAllSessions)
    const result = projection.result
    await sessionPersistenceCoordinator.replaceSessionMetadata(
      projection.sessions,
      result ? canReconcileSessionAbsences(result) : true
    )
    return { ...projection, result }
  }
  const uncoordinatedSessionPersistenceBackend: SessionPersistenceBackend = {
    loadAll: loadAllSessions,
    list: async () => {
      const projection = await ensureSessionProjection()
      return {
        sessions: projection.sessions,
        manifest: projection.result?.manifest ?? (await sessionRepository.loadManifest()),
        diagnostics: sessionProjectionDiagnostics.resolve(projection.result?.diagnostics)
      }
    },
    loadUsage: async () => {
      await ensureSessionProjection()
      return sessionRepository.loadSessionUsageProjection()
    },
    loadOne: async ({ projectId, sessionId }) => {
      const recovery = await recoverProjectDeletionsForSessionRead(
        projectDeletionCoordinator,
        sessionPersistenceCoordinator
      )
      if (!recovery.isComplete) {
        return recovery.result.sessions.find(
          (session) => session.projectId === projectId && session.id === sessionId
        )
      }
      const session = await sessionRepository.loadSession(projectId, sessionId)
      return session && sessionEnabledComputeHostsOwnerRef.current
        ? sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)
        : session
    },
    saveSession: async (session, options, authority) => {
      const created =
        (await sessionRepository.loadSession(session.projectId, session.id)) === undefined
      const save = (candidate: PersistedChatSession): Promise<PersistedChatSession> =>
        authority
          ? sessionPersistenceCoordinator.saveSession(candidate, options, authority)
          : sessionPersistenceCoordinator.saveSession(candidate, options)
      let durableSession = created
        ? await (() => {
            if (!sessionEnabledComputeHostsOwnerRef.current) {
              throw new Error('Session enabled Compute Host ownership is not initialized.')
            }
            return sessionEnabledComputeHostsOwnerRef.current.createSession(session, save)
          })()
        : await save(session)
      // Flush any approved host.agents.switch binding stashed while this session was not yet durable,
      // so the approved target survives a restart before the next message (the in-memory binding
      // alone does not persist across restart).
      durableSession = await pendingSpecialistBindings.flush(
        durableSession.id,
        durableSession,
        (binding) =>
          sessionPersistenceCoordinator.saveSessionSpecialistBinding(
            durableSession,
            binding.specialistId,
            binding.specialistBindingPending
          )
      )
      return { created, session: durableSession }
    },
    setDelegationPolicy: async (projectId, sessionId, policy) => {
      return sessionPersistenceCoordinator.setSessionDelegationPolicy(projectId, sessionId, policy)
    },
    updateArchive: async (request) => {
      return archiveCoordinator.updateSessionArchive(request)
    },
    deleteSession: withSessionDeletionCleanup(
      (projectId, sessionId) => sessionPersistenceCoordinator.deleteSession(projectId, sessionId),
      (projectId, sessionId) =>
        permissionGrantRegistry.prune({ kind: 'session', projectId, sessionId })
    ),
    saveManifest: async (request) => {
      return sessionPersistenceCoordinator.saveManifest(request)
    }
  }
  const sessionPersistenceBackend = coordinateSessionPersistenceWithProjectDeletions(
    uncoordinatedSessionPersistenceBackend,
    projectDeletionCoordinator
  )
  let backendTeardownOwnedByCoordinator = false
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // One runner owns Windows integrity/preflight/fallback state for every production micromamba
  // consumer in this main-process generation. Each consumer receives only its narrow resolve seam.
  const micromambaRunner = createProductionMicromambaRunner({
    home: dirname(dirname(provisioningRoot)),
    resourcesPath: process.resourcesPath
  })
  const notebookRuntimeSettings: Pick<
    NotebookRuntimeSettings,
    'getSnapshot' | 'setEnvironmentEnabled'
  > = {
    getSnapshot: async (language) => {
      const [runtimeEnablement, manualInterpreters, packageMirror] = await Promise.all([
        settingsService.getRuntimeEnablement(language),
        settingsService.getManualInterpreters(language),
        settingsService.getPackageMirror()
      ])
      return {
        language,
        runtimeEnablement,
        manualInterpreters,
        packageMirror
      }
    },
    setEnvironmentEnabled: (language, envId, enabled) =>
      settingsService.setEnvironmentEnabled(language, envId, enabled)
  }
  const notebookApplication = await modules.add(
    {
      configRoot: resolveConfigRoot(),
      dataRoot: resolveDataRoot(),
      projectId: DEFAULT_ARTIFACT_PROJECT_ID,
      repository: new NotebookRunRepository(resolveDataRoot()),
      getPackageMirror: () => settingsService.getPackageMirror(),
      getAgentEnvironmentCreationEnabled: () =>
        settingsService.getAgentEnvironmentCreationEnabled(),
      notebookRuntimeSettings,
      micromambaRunner,
      locale: app.getLocale(),
      appVersion: app.getVersion(),
      translate,
      helperModuleCatalog: settingsService.registeredHelperCatalog(),
      processSandbox: notebookNetworkSandbox,
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
  notebookPolicyLifecycle.current = notebookService
  notebookActivityRef.current = notebookService
  composition.phase('notebook-runtime')

  // Builtins are validated once at startup from read-only repository resources. Package imports use
  // the same repository while keeping their dynamic Connector/custom-Skill catalog separate.
  const specialistRepository = new SpecialistRepository(resolveConfigRoot())
  const appVersion = app.getVersion()
  const specialistSkills = await settingsService.listSpecialistSkillCatalog({ bundledOnly: true })
  composition.phase('specialist-catalog')
  const builtinRegistry = new BuiltinSpecialistRegistry({
    appVersion,
    builtinSkills: composeBuiltinSkillCatalog(appVersion, specialistSkills),
    skills: specialistSkills.map((skill) => {
      return {
        id: skill.id,
        name: skill.frameworkName,
        builtin: skill.source === 'featured',
        displayName: skill.displayName,
        source: skill.source,
        mainEnabled: skill.mainEnabled
      }
    }),
    connectorIds: ALL_CONNECTOR_IDS,
    protectedSpecialistIds: ['reviewer'],
    protectedSpecialistNames: ['Reviewer']
  })
  const specialistService = new SpecialistService(
    specialistRepository,
    builtinRegistry,
    (operation) => specialistPackageRecovery.current?.(operation) ?? operation()
  )
  const marketplaceRepository = new MarketplaceRepository(resolveConfigRoot())
  const marketplaceOperationCoordinator = new MarketplaceOperationCoordinator()
  await specialistService.ensureBuiltinCatalogReady()
  composition.phase('builtin-specialists')
  const tagService = new TagService(
    new TagRepository(() => getProjectDbClient(configRoot)),
    new TagResourceCatalog({
      listSkills: () => settingsService.listSkills(),
      listConnectors: () => settingsService.listConnectors(),
      listSpecialists: async () =>
        (await specialistService.listForSettings()).filter(({ kind }) => kind !== 'reviewer')
    }),
    applicationEvents
  )
  const memoryService = new MemoryService(
    new MemoryRepository(() => getProjectDbClient(configRoot)),
    applicationEvents
  )
  const tagCleanupLog = createLogger('tags:cleanup')
  const removeResourceTagsOrThrow = async (
    resources: Parameters<TagService['removeResources']>[0]
  ): Promise<void> => tagService.removeResources(resources)
  const removeResourceTags = async (
    resources: Parameters<TagService['removeResources']>[0]
  ): Promise<void> => {
    try {
      await removeResourceTagsOrThrow(resources)
    } catch (error) {
      tagCleanupLog.warn('resource deletion Tag cleanup failed', { error, resources })
    }
  }
  const specialistPackageService = new SpecialistPackageService({
    storageDir: resolveConfigRoot(),
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
            name: skill.frameworkName,
            builtin: skill.source === 'featured',
            displayName: skill.displayName,
            source: skill.source,
            mainEnabled: skill.mainEnabled,
            ...(packageSkill ?? {})
          }
        }),
        connectorIds: [
          ...ALL_CONNECTOR_IDS,
          ...customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .map((server) => server.id)
        ],
        connectorAliases: Object.fromEntries([
          ...ALL_CONNECTOR_IDS.map((id) => [id, id] as const),
          ...customMcpServers
            .filter((server) => isCustomMcpServerRouteSafe(server, customMcpServers))
            .map((server) => [server.id, server.name] as const)
        ]),
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
    marketplaceOperationCoordinator,
    onSpecialistDeleted: (specialistId) =>
      marketplaceRepository.removeInstallationsForSpecialist(specialistId),
    onSkillsDeleted: async (skillIds) => {
      if (skillIds.length > 0) {
        // User Skills are default-on. Remove disabled-ID tombstones so reinstalling the same
        // package does not inherit the deleted Skill's old Main Agent state.
        await settingsRepository.setSkillsEnabled([...skillIds], true)
      }
    },
    onResourcesDeleted: (specialistId, skillIds) =>
      removeResourceTagsOrThrow([
        { resourceType: 'catalog.specialist', resourceId: specialistId },
        ...skillIds.map((resourceId) => ({
          resourceType: 'catalog.skill' as const,
          resourceId
        }))
      ]),
    onCommitted: () => {
      broadcastToRenderers(SPECIALIST_IPC.CATALOG_CHANGED, undefined)
      void runtime.requestSkillsReload()
    }
  })
  specialistPackageRecovery.current = (operation) =>
    specialistPackageService.withRecoveryBarrier(operation)
  await settingsService.migrateAgentHomeSkillIdentities()
  composition.phase('agent-home-skill-identity-migration')
  const marketplaceService = new MarketplaceService({
    repository: marketplaceRepository,
    operationCoordinator: marketplaceOperationCoordinator,
    packages: specialistPackageService,
    fetch: netFetchStandard,
    officialSource: OFFICIAL_MARKETPLACE_SOURCE,
    getDisabledSkillIds: async () =>
      (await settingsRepository.getSettings()).disabledSkillIds ?? [],
    getInstalledSpecialists: async () =>
      (await specialistService.list()).map((profile) => ({
        id: profile.id,
        revision: profile.revision,
        ...(profile.modifiedSinceImport === undefined
          ? {}
          : { modifiedSinceImport: profile.modifiedSinceImport }),
        ...(profile.origin ? { origin: profile.origin } : {}),
        ...(profile.importBaseline?.archiveDigest
          ? { archiveDigest: profile.importBaseline.archiveDigest }
          : {})
      })),
    markMarketplaceManaged: async (id, expectedRevision) => {
      await specialistService.markMarketplaceManaged(id, expectedRevision)
    },
    setSkillsMainEnabled: async (ids, enabled) => {
      await settingsRepository.setSkillsEnabled([...new Set(ids)], enabled)
      // Startup recovery runs before the ACP runtime exists, so its initial catalog reads the
      // restored settings directly. Later recovery must refresh the already-live catalog.
      requestSkillCatalogRefresh()
    }
  })
  try {
    await marketplaceService.recover()
  } catch (error) {
    createLogger('specialist:marketplace').error(
      'Marketplace install recovery incomplete; Marketplace remains fail-closed',
      diagnosticErrorFields(error)
    )
  }
  composition.phase('marketplace-recover')
  settingsService.setSkillDeletionGuard((skillId) =>
    specialistPackageService.assertSkillDeletionAllowed(skillId)
  )
  // Per-session specialist binding store. Shared between the SET_SESSION_SPECIALIST barrier
  // (validate + record) and the runtime switch so a hot-switch lands on the same source of truth.
  const sessionBindingService = new SessionBindingService(specialistService)
  const specialistPersistLog = createLogger('specialist:persist')
  const loadSessionSpecialistBinding = async (
    sessionId: string
  ): Promise<PersistedSessionSpecialistBinding | undefined> => {
    const session = (await sessionRepository.loadAll()).sessions.find(
      (candidate) => candidate.id === sessionId
    )
    return session
      ? {
          specialistId: session.specialistId,
          specialistBindingPending: session.specialistBindingPending
        }
      : undefined
  }
  const persistSessionSpecialistBinding = async (
    sessionId: string,
    specialistId: string | undefined,
    pending: boolean
  ): Promise<void> => {
    const allSessions = await sessionRepository.loadAll()
    const session = allSessions.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) {
      // Fresh unsent drafts are not durable yet. Carry both the desired ID and pending marker into
      // their first save; the marker can also be cleared here when runtime applies before that save.
      pendingSpecialistBindings.stash(sessionId, specialistId, pending)
      specialistPersistLog.debug('session not yet durable; stashed Specialist binding state', {
        sessionId,
        specialistId,
        pending
      })
      return
    }
    pendingSpecialistBindings.take(sessionId)
    await sessionPersistenceCoordinator.saveSessionSpecialistBinding(session, specialistId, pending)
  }
  const sessionSpecialistReconfiguration = new SessionSpecialistReconfiguration({
    sessionBinding: sessionBindingService,
    loadBinding: loadSessionSpecialistBinding,
    persistBinding: persistSessionSpecialistBinding,
    discardPendingBinding: (sessionId) => {
      pendingSpecialistBindings.take(sessionId)
    },
    applyRuntime: async (sessionId, specialistId) => {
      const runtime = runtimeRef.current
      if (!runtime) throw new Error('Agent runtime is not initialized.')
      return runtime.switchSpecialist(sessionId, specialistId)
    }
  })
  // Compose the interceptor before ACP because Notebook construction precedes runtime construction.
  // Startup registers the complete production adapter below before any IPC surface becomes callable.
  const completionGateRuntimeRegistry = new CompletionGateRuntimeRegistry()
  const completionHandoffLifecycle = new CompletionHandoffLifecycle(
    new FileCompletionHandoffRepository(join(resolveConfigRoot(), 'specialist-handoffs')),
    completionGateRuntimeRegistry,
    Date.now,
    (event) => broadcastToRenderers(SPECIALIST_IPC.HANDOFF_LIFECYCLE_CHANGED, event),
    async ({ targetName }) => {
      if (targetName === null) return undefined
      const profile = await specialistService.resolveRunnableByName(targetName)
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
  const taskNotificationDeliveryDeps = {
    notificationCtor: Notification,
    liveNotifications,
    log: notificationsLog,
    headless,
    translate
  }
  const taskNotifications = new TaskNotificationService({
    isEnabled: () => settingsService.getNotificationsEnabled(),
    showContent: () => settingsService.getShowNotificationContent(),
    isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    translate,
    show: buildTaskNotificationShow(taskNotificationDeliveryDeps),
    onDeliveryError: (error) =>
      notificationsLog.warn('task notification delivery failed', errorLogFields(error)),
    onAttentionError: (error) =>
      notificationsLog.warn('desktop attention handler failed', errorLogFields(error)),
    hasNonTerminalComputeJobs: async (sessionId) => {
      const computeJobs = computeJobActivityRef.current
      if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
      return (await computeJobs.countNonTerminalBySession(sessionId)) > 0
    },
    inbox: notificationInbox,
    onInboxError: (error) =>
      notificationsLog.warn('message center recording failed', errorLogFields(error))
  })
  // The renderer peeks once sessions are hydrated, then conditionally consumes the same target.
  // This lets partial recovery open an already-loaded conversation while retaining an omitted one
  // for retry, without an older IPC round trip clearing a newer click target.
  declareElectronAdapter('task-notifications', () => {
    registerNotificationInboxIpcAdapter(notificationInbox)
    ipcMainHandle('notifications:get-desktop-availability', () =>
      getTaskNotificationAvailability(taskNotificationDeliveryDeps)
    )
    ipcMainHandle('notifications:send-test', () =>
      showTestTaskNotification(taskNotificationDeliveryDeps)
    )
    ipcMainHandle('notifications:peek-pending-open-session', () =>
      taskNotifications.peekPendingOpenSession()
    )
    ipcMainHandle('notifications:take-pending-open-session', (_event, expectedToken: unknown) =>
      typeof expectedToken === 'number' && Number.isSafeInteger(expectedToken) && expectedToken > 0
        ? taskNotifications.takePendingOpenSession(expectedToken)
        : null
    )
  })
  // The connector application owns MCP, connector/skill approval, runtime projection, and service
  // construction. Late-bound local tools remain composition-root dependencies and are passed in.
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (sessionId, input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(sessionId, input)
    }
  })
  const connectorApplication = await modules.add(
    {
      settings: settingsService,
      skillsDir: connectorSkillSourceDir(resolveConfigRoot()),
      openExternal: (url) => shell.openExternal(url),
      notifyStatusChanged: () =>
        broadcastToRenderers('settings:connector-runtime-changed', undefined),
      broadcastConnectorApproval: buildConnectorApprovalBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('connector approval notification failed', errorLogFields(error))
      }),
      onConnectorApprovalSettled: (id, state) => {
        try {
          broadcastToRenderers('connectors:approval-settled', id)
        } finally {
          void taskNotifications.settleAuthorization('connector', id, state)
        }
      },
      replayConnectorApproval: (request) =>
        broadcastToRenderers('connectors:approval-request', request),
      broadcastCredentialRequest: buildConnectorCredentialRequestBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('connector credential notification failed', errorLogFields(error))
      }),
      replayCredentialRequest: (request) =>
        broadcastToRenderers('connectors:credential-request', request),
      onCredentialRequestSettled: (id, configured) => {
        try {
          broadcastToRenderers('connectors:credential-settled', id)
        } finally {
          void taskNotifications.settleConnectorCredentialRequest(id, configured)
        }
      },
      broadcastSkillImportApproval: buildSkillImportApprovalBroadcast({
        broadcastToRenderers,
        taskNotifications,
        onNotificationError: (error) =>
          notificationsLog.warn('skill import approval notification failed', errorLogFields(error))
      }),
      onSkillImportSettled: (id) => broadcastToRenderers('skills:conversation-import-settled', id),
      onSkillImportLifecycleSettled: (id, state) =>
        void taskNotifications.settleAuthorization('skill-import', id, state),
      uploads: uploadRepository,
      managedFileVersions: managedFileVersionService,
      fetchImpl: netFetchStandard,
      resolveApiKey: (ref) => tryDecryptKey(ref),
      canRequestCredential: () => !headless && BrowserWindow.getAllWindows().length > 0,
      permissionGrantRegistry,
      resolveSpecialistProfile: async (specialistId) => {
        try {
          return await specialistService.resolveRunnableById(specialistId)
        } catch {
          return undefined
        }
      },
      localToolHandlers: { 'molecule/preview_molecule': moleculePreviewHandler },
      onSkillsChanged: requestSkillCatalogRefresh
    } satisfies Parameters<typeof createConnectorApplicationModule>[0],
    createConnectorApplicationModule
  )
  const {
    connectorService,
    runtimeSettings: connectorRuntimeSettings,
    mcpClientManager,
    skillImporter: conversationSkillImporter,
    connectorApprovals: approvalBroker,
    credentialRequests: credentialRequestBroker,
    skillImportApprovals: skillImportApprovalBroker
  } = connectorApplication
  composition.phase('connectors')
  // Register compute IPC handlers early so computeService can be wired into the notebook RPC server.
  // The approval broker in compute/ipc.ts broadcasts via BrowserWindow.getAllWindows(), which requires
  // Electron to be ready — this is always the case here since we're inside registerIpcHandlers.
  // Absolute Compute inputs may be legacy managed artifacts or exact immutable files staged for
  // the submitting Notebook Session. Both resolvers enforce their own storage boundary.
  const computeArtifactResolver = createComputeArtifactResolver(resolveDataRoot(), (path) =>
    artifactRepository.resolveManagedFilePath({ path })
  )
  const sessionLimitPersistence = {
    load: async (): Promise<readonly (readonly [string, number])[]> => {
      const catalog = await loadAllSessions()
      if (!canReconcileSessionAbsences(catalog)) {
        throw new Error('Session concurrency limits could not be restored authoritatively.')
      }
      return catalog.sessions.flatMap((session) =>
        session.computeConcurrencyLimit === undefined
          ? []
          : [[session.id, session.computeConcurrencyLimit] as const]
      )
    },
    save: async (sessionId: string, limit: number): Promise<void> => {
      const session = await withDataRootWrite(async () => {
        const projectId = await sessionPersistenceCoordinator.sessionProjectId(sessionId)
        if (!projectId)
          throw new Error(`Cannot persist concurrency for missing Session ${sessionId}.`)
        return sessionPersistenceCoordinator.setSessionComputeConcurrencyLimit(
          projectId,
          sessionId,
          limit
        )
      })
      applicationEvents.publish('session:updated', {
        session,
        originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
      })
    }
  }
  const computeIpcModule = createComputeIpcModule(
    undefined,
    undefined,
    computeArtifactResolver,
    undefined,
    taskNotifications,
    permissionGrantRegistry,
    settingsRepository,
    {
      pruneSessionEnabledHosts: async (providerId, afterPrune) => {
        if (!sessionEnabledComputeHostsOwnerRef.current) {
          throw new Error('Session enabled Compute Host ownership is not initialized.')
        }
        const sessions = await sessionEnabledComputeHostsOwnerRef.current.pruneProvider(
          providerId,
          afterPrune
        )
        for (const session of sessions) {
          try {
            applicationEvents.publish('session:updated', {
              session,
              originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
            })
          } catch {
            // The durable repair and cache projection have committed; lifecycle delivery is best effort.
          }
        }
      }
    },
    sessionLimitPersistence
  )
  surfaceAdapters = beforeAcpAdapters
  const {
    computeService,
    connectionBroker,
    jobDeletionOwner,
    jobRepository,
    operationRepository,
    hostRepository,
    sessionCacheOwner,
    enabledComputeHostsRegistry: hostsRegistry
  } = computeIpcModule
  computeJobActivityRef.current = jobRepository
  const sessionEnabledComputeHostsOwner = new SessionEnabledComputeHostsOwner({
    registry: hostsRegistry,
    hostExists: async (providerId) => (await hostRepository.get(providerId)) !== null,
    listHostIds: async () => (await hostRepository.list()).map((host) => host.providerId),
    sessionAuthority: sessionPersistenceCoordinator,
    projectSessionConcurrencyLimit: async (sessionId, limit) => {
      const concurrencyManager = computeIpcModule.handlers.concurrencyManager
      if (!concurrencyManager) throw new Error('Session concurrency ownership is not initialized.')
      await concurrencyManager.projectPersistedSessionLimit(sessionId, limit)
    },
    clearSessionConcurrencyLimits: async (sessionIds) => {
      const concurrencyManager = computeIpcModule.handlers.concurrencyManager
      if (!concurrencyManager) throw new Error('Session concurrency ownership is not initialized.')
      await concurrencyManager.clearProjectedSessionLimits(sessionIds)
    },
    withDataRootWrite
  })
  sessionEnabledComputeHostsOwnerRef.current = sessionEnabledComputeHostsOwner
  sessionCacheOwnerRef.current = sessionCacheOwner
  computeJobDeletionRef.current = withSessionCacheDeletion(jobDeletionOwner, sessionCacheOwner)
  await runDataRootStartupRecovery(() =>
    projectDeletionCoordinator.restorePendingDeletionBarriers()
  )
  await runDataRootStartupRecovery(
    async () => {
      await withDataRootWrite(() => managedFileVersionService.recoverPendingWrites())
    },
    {
      reportFailure: (error) => {
        storageLog.error(
          'managed file version recovery incomplete; will retry next launch',
          diagnosticErrorFields(error)
        )
      }
    }
  )
  void managedFileVersionService
    .auditActiveVersionIntegrity()
    .then((integrityErrors) => {
      if (integrityErrors.length > 0) {
        storageLog.error('managed file version integrity audit found corrupt active content', {
          count: integrityErrors.length
        })
      }
    })
    .catch((error) =>
      storageLog.error(
        'managed file version integrity audit incomplete; will retry next launch',
        diagnosticErrorFields(error)
      )
    )
  await jobDeletionOwner.restoreOrphanJobDeletionBarriers(isComputeJobOwnerLive)
  composition.phase('deletion-barriers')
  const dataRoot = resolveDataRoot()
  // The Notebook RPC receives only this Session-admitted facade, never the unrestricted service
  // used by Settings and internal runtimes.
  const agentComputeService = new AgentComputeService(computeService, hostsRegistry)
  // host.agents control-plane SDK (issue 02/05): read Specialist/catalog surface plus the durable
  // immediate-handoff lifecycle. The catalog adapter delegates to the authoritative
  // SettingsService + SpecialistService; switch() reuses the SAME SessionBindingService and durable
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
    specialistService,
    catalog: {
      listSkillCatalog: () => settingsService.listSpecialistSkillCatalog(),
      getConnectors: () => settingsService.getConnectors()
    },
    customServerAvailability: (id) => connectorRuntimeSettings.customServerAvailability(id),
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
    // SpecialistService already broadcasts specialist:catalog-changed on update/delete; this refreshes the
    // RUNTIME capability resolution (mirrors the Settings IPC path's onProfilesChanged callback).
    invalidateCatalog: () => void runtime.requestSkillsReload(),
    persistSessionSpecialist: (sessionId, specialistId) =>
      sessionSpecialistReconfiguration.commitDesired(sessionId, specialistId)
  })
  const notebookRpcServerRef: { current?: NotebookLocalRpcServer } = {}
  const requireNotebookRpcServer = (): NotebookLocalRpcServer => {
    if (!notebookRpcServerRef.current) throw new Error('Notebook RPC server is not composed yet.')
    return notebookRpcServerRef.current
  }
  const delegatedFrameworks = createProductionDelegatedFrameworkRuntime({
    capacity: 4,
    dataRoot: resolveDataRoot(),
    runtime: {
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      managedFileVersions: managedFileVersionService,
      uploadRepository,
      peekNotebookHandoffContext: (sessionId) => notebookService.peekHandoffContext(sessionId),
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      permissionGrantRegistry,
      specialistService,
      sessionPersistenceCoordinator
    },
    notebookRpcServer: requireNotebookRpcServer,
    readSession: ({ projectId, sessionId }) => sessionRepository.loadSession(projectId, sessionId),
    resolvePermissionProfile: (sessionId) =>
      runtimeRef.current?.getSnapshot().permissionProfiles[sessionId]?.selectedProfile
  })
  const delegatedArtifactTurns = new ArtifactTurnOwner({
    dataRoot,
    repository: artifactRepository,
    runRegistry: artifactRunRegistry,
    notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(dataRoot),
    issueRpcCapability: (binding) => requireNotebookRpcServer().issueArtifactRunCapability(binding),
    revokeRpcCapability: (token) => requireNotebookRpcServer().revokeArtifactRunCapability(token),
    provenance: artifactProvenanceRepository
  })
  const delegatedWorkRef: {
    current?: ReturnType<typeof createProductionDelegatedWorkComposition>
  } = {}
  const delegatedWork = createProductionDelegatedWorkComposition({
    dataRoot: resolveDataRoot(),
    resolveExecutionModel: async (session) => {
      if (!session.agentFrameworkId) {
        throw new Error('The originating Session has no Agent Framework identity.')
      }
      const backend = runtimeRef.current?.captureSessionBackend(session.id)
      if (!backend) throw new Error('The originating Session runtime is unavailable.')
      return settingsService.admitSubagentExecutionModel(session.agentFrameworkId, {
        providerId: backend.providerId,
        backendId: backend.backendId,
        modelRoute: backend.modelRoute,
        model: backend.context.model,
        reasoningEffort: backend.session.effort
      })
    },
    onAgentRuntimeUpdate: (update) => broadcastToRenderers('acp:agent-runtime-update', update),
    settlementContinuations: {
      dispatch: createDelegationSettlementContinuationDispatch({
        sendAppContinuationObserved: (request, onProviderPromptAccepted) => {
          const activeRuntime = runtimeRef.current
          if (!activeRuntime) {
            throw new DelegateMessagePreAcceptanceError('The Main Agent runtime is unavailable.')
          }
          return activeRuntime.sendAppContinuationObserved(request, onProviderPromptAccepted)
        },
        onPromptEnded: (sessionId, promptId) =>
          delegatedWorkRef.current?.root.settlementPromptEnded?.(sessionId, promptId)
      })
    },
    sessions: {
      commands: sessionPersistenceCoordinator,
      readSession: ({ projectId, sessionId }) =>
        sessionRepository.loadSession(projectId, sessionId),
      findSessions: async (sessionId) =>
        (await sessionRepository.loadAll()).sessions.filter((session) => session.id === sessionId)
    },
    async resolveInput(identity, session) {
      const artifact = parseArtifactVersionLocator(identity)
      const upload = parseUploadVersionReference(identity)
      if (!artifact && !upload) {
        throw new Error('Delegated input is not an immutable Version identity.')
      }
      const source = artifact ? 'artifact' : 'upload'
      const projectId = artifact?.projectId ?? upload?.projectId
      const sessionId = artifact?.appSessionId ?? upload?.sessionId
      const fileId = artifact?.artifactId ?? upload?.fileId
      const versionId = artifact?.versionId ?? upload?.versionId
      if (
        projectId !== session.projectId ||
        sessionId !== session.sessionId ||
        !fileId ||
        !versionId
      ) {
        throw new Error('Managed Version input has incomplete or mismatched logical identity.')
      }
      const lease = await managedFileVersionService.openVersion(
        { source, projectId, fileId },
        versionId
      )
      if (lease.logicalFile.sessionId !== session.sessionId) {
        await lease.close().catch(() => undefined)
        throw new Error('Managed Version belongs to a different Session.')
      }
      return {
        path: lease.path,
        filename: lease.logicalFile.displayName,
        copyTo: (destinationPath: string) => lease.copyTo(destinationPath),
        close: () => lease.close()
      }
    },
    frameworks: delegatedFrameworks,
    resolveSpecialist: (profileId) => specialistService.resolveRunnableById(profileId),
    resolveSpecialistReference: (profileReference) =>
      specialistService.resolveRunnableByReference(profileReference),
    artifactEvidence: {
      turns: delegatedArtifactTurns,
      artifactStorageSessionId: ({ sessionId }) => sessionId,
      finalizePublication: async (publication, terminalMessageId, scope) => {
        const handlers = artifactHandlersRef.current
        if (!handlers) throw new Error('Artifact finalization owner is not available.')
        await finalizeDelegatedArtifactPublication({
          publication,
          terminalMessageId,
          scope,
          commands: sessionPersistenceCoordinator,
          handlers
        })
      },
      project: (scope) =>
        scope.terminalMessageId
          ? artifactRepository.listMessageFiles({
              projectId: scope.session.projectId,
              sessionId: scope.session.sessionId,
              messageId: scope.terminalMessageId
            })
          : Promise.resolve([])
    },
    reviewEvidence: {
      loadSession: ({ projectId, sessionId }) =>
        sessionRepository.loadSession(projectId, sessionId),
      reviews: {
        run: (request) => {
          const owner = reviewerCommandOwnerRef.current
          if (!owner) return Promise.reject(new Error('Reviewer owner is not available.'))
          return owner.run(request)
        },
        getForSession: (request) => {
          const owner = reviewerCommandOwnerRef.current
          if (!owner) return Promise.reject(new Error('Reviewer owner is not available.'))
          return owner.getForSession(request)
        }
      }
    },
    parentMessages: {
      async deliver(delivery) {
        return archiveCoordinator.withProjectDeletionAdmission(
          delivery.session.projectId,
          async () => {
            const runtime = runtimeRef.current
            if (!runtime) throw new Error('ACP runtime is not available.')
            const session = await sessionRepository.loadSession(
              delivery.session.projectId,
              delivery.session.sessionId
            )
            const graph = session?.conversationGraph
            const rootFrame = graph?.frames.find((frame) => frame.id === delivery.targetFrameId)
            const rootBranch = graph?.branches.find(
              (branch) => branch.id === rootFrame?.activeBranchId
            )
            if (
              !session ||
              session.id !== delivery.session.sessionId ||
              session.projectId !== delivery.session.projectId ||
              graph?.rootFrameId !== delivery.targetFrameId ||
              !rootBranch ||
              !graph.messages.some((message) => message.id === delivery.originMessageId)
            ) {
              throw new Error('Parent message durable root provenance is unavailable.')
            }
            return runtime.startContinuationWhenDispatchAdmitted(
              {
                sessionId: delivery.session.sessionId,
                text:
                  `[Delegated ${delivery.kind} from Frame ${delivery.sourceFrameId}, ` +
                  `Attempt ${delivery.sourceAttemptId}]\n\n${delivery.text}`,
                suppressUserMessage: true,
                provenanceContext: {
                  promptMessageId: delivery.rootPromptMessageId,
                  originMessageId: delivery.originMessageId,
                  rootFrameId: graph.rootFrameId,
                  agentFrameId: graph.rootFrameId,
                  messageBranchId: delivery.rootBranchId,
                  messageBranchAncestry: [delivery.rootBranchId],
                  messageAncestry: [delivery.originMessageId],
                  runtimeSegmentId: `delegated-message-${delivery.messageId}`
                }
              },
              async () => {
                let latest = await sessionRepository.loadSession(
                  delivery.session.projectId,
                  delivery.session.sessionId
                )
                const latestGraph = latest?.conversationGraph
                const latestRoot = latestGraph?.frames.find(
                  ({ id }) => id === delivery.targetFrameId
                )
                const latestBranch = latestGraph?.branches.find(
                  ({ id }) => id === latestRoot?.activeBranchId
                )
                if (
                  !latest ||
                  latestBranch?.id !== delivery.rootBranchId ||
                  `${latestBranch.id}:${latestBranch.createdAt}` !== delivery.rootBranchRevision
                ) {
                  throw new DelegateMessageParkedError(
                    'Parent message root Branch changed before dispatch.'
                  )
                }
                const agentTarget = await resolveSessionAgentTarget(latest)
                if (
                  agentTarget &&
                  shouldPersistSessionAgentConfiguration(latest.agentConfiguration, agentTarget)
                ) {
                  latest = await sessionPersistenceCoordinator.saveSession({
                    ...latest,
                    agentConfiguration: toSessionAgentConfiguration(agentTarget)
                  })
                }
                const started = await delivery.startDispatch()
                if (started !== 'started') {
                  throw new DelegateMessageParkedError(
                    'Parent message dispatch fence was not acquired.'
                  )
                }
                if (!runtime.hasLiveSession(latest.projectId, latest.id) || agentTarget) {
                  await runtime.resumeSession({
                    sessionId: latest.id,
                    cwd: latest.cwd,
                    projectId: latest.projectId,
                    ...(latest.permissionProfile
                      ? { permissionProfile: latest.permissionProfile }
                      : {}),
                    memoryEnabled: latest.memoryEnabled !== false,
                    ...(latest.agentFrameworkId
                      ? { previousFrameworkId: latest.agentFrameworkId }
                      : {}),
                    ...(latest.agentBackendId ? { previousBackendId: latest.agentBackendId } : {}),
                    ...(latest.specialistId ? { specialistId: latest.specialistId } : {}),
                    ...(latest.specialistBindingPending === true
                      ? { specialistBindingPending: true }
                      : {}),
                    ...(latest.providerSessionId
                      ? { providerSessionId: latest.providerSessionId }
                      : {}),
                    ...(latest.providerContinuityToken
                      ? { providerContinuityToken: latest.providerContinuityToken }
                      : {}),
                    ...(agentTarget ? { agentTarget } : {})
                  })
                }
              }
            )
          }
        )
      }
    }
  })

  const hostSkillsCatalog: HostSkillsCatalog = {
    list: () => settingsService.listHostSkills(),
    withSkillRead: (id, read) => settingsService.withHostSkillRead(id, read),
    publishPersonalDirectory: (name, sourcePath, overwrite) =>
      settingsService.publishHostSkill(name, sourcePath, overwrite),
    deletePublished: async (id) => {
      await settingsService.deleteSkill({ id })
      await removeResourceTags([{ resourceType: 'catalog.skill', resourceId: id }])
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
    onPublishedSkillsChanged: requestSkillCatalogRefresh
  })
  const hostLlmLog = createLogger('notebook:host-llm')
  const hostModelService = new HostModelService({
    captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
    captureSessionModel: (sessionId) => runtimeRef.current?.captureSessionModel(sessionId),
    captureModelCatalog: async () => {
      const settings = await settingsService.getSettingsView()
      return {
        providers: settings.providers,
        claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId
      }
    },
    runner: new RestrictedInferenceRunner({
      appVersion: app.getVersion(),
      configRoot,
      profileNamespace: 'host-llm',
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context)
    }),
    recordUsage: recordAuxiliaryUsage
  })
  const hostViewImageService = new HostViewImageService({
    catalog: projectFilesRepository,
    managedFileVersions: managedFileVersionService,
    captureBackend: (sessionId) => {
      const backend = runtimeRef.current?.captureSessionBackend(sessionId)
      return backend
        ? {
            frameworkId: backend.framework.id,
            backendId: backend.backendId,
            modelRoute: backend.modelRoute,
            model: backend.context.model ?? backend.session.model,
            supportsImageInput: backend.context.supportsImageInput,
            generationToken: backend
          }
        : undefined
    }
  })
  const resolveHostReferencedSession = async (
    context: { sessionId: string },
    referencedSessionId: string
  ): Promise<{ projectId: string } | undefined> => {
    if (!runtimeRef.current?.isSessionReferenceAllowed(context.sessionId, referencedSessionId)) {
      return undefined
    }
    const summary = (await sessionRepository.loadSessionSummaries()).find(
      (candidate) => candidate.id === referencedSessionId && candidate.archivedAt === undefined
    )
    if (!summary) return undefined
    const project = await projectRepository.get(summary.projectId)
    return project && project.archivedAt === undefined
      ? { projectId: summary.projectId }
      : undefined
  }
  const notebookRpcServer = await modules.add(
    new NotebookLocalRpcServer(notebookLocalRpc, {
      // The Notebook REPL runs in a process sandbox whose only TCP egress is the approval gateway.
      // Keep its privileged Host SDK channel on an explicitly shared local socket instead.
      transport: 'pipe',
      onSessionReleased: (sessionId) => completionGateCoordinator.releaseSession(sessionId),
      isHostSkillsAvailable: (sessionId) =>
        runtimeRef.current?.getSessionFramework(sessionId) !== 'codebuddy',
      resolveSpecialistSkillIds: async (specialistId) => {
        const profile = await specialistService.resolveRunnableById(specialistId)
        if (!profile.enabled) return []
        const effective = resolveEffectiveSpecialistSkills(
          profile,
          await settingsService.listSpecialistSkillCatalog()
        )
        return effective.kind === 'specialist' ? [...new Set(effective.skillIds)] : []
      },
      connectorService,
      computeService: agentComputeService,
      memoryService,
      isMemoryEnabledForSession: async (sessionId) =>
        (runtimeRef.current?.isSessionMemoryEnabled(sessionId) ?? false) &&
        (await memoryService.isEnabled()),
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
        reserveWrite: (request) => artifactProvenanceRepository.reserveWrite(request),
        releaseWriteReservation: (request) =>
          artifactProvenanceRepository.releaseWriteReservation(request),
        releaseRunWriteReservations: (request) =>
          artifactProvenanceRepository.releaseRunWriteReservations(request),
        releaseAllWriteReservations: () =>
          artifactProvenanceRepository.releaseAllWriteReservations(),
        createVersion: (request, signal) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.createVersion(request, signal)
          ),
        replayVersion: (request) =>
          sessionPersistenceCoordinator.runSessionMutation(
            request.projectId,
            request.appSessionId,
            () => artifactProvenanceRepository.replayVersion(request)
          )
      },
      hostArtifacts: new HostArtifactsService(projectFilesRepository, immutableInputAuthority),
      delegationInputCatalog: projectFilesRepository,
      hostLineage: new HostLineageService({
        catalog: projectFilesRepository,
        provenance: artifactProvenanceRepository
      }),
      hostFrames: new HostFramesService(
        {
          readProject: (projectId) =>
            sessionRepository.loadProjectWithDiagnostics(projectId, { mode: 'read-only' }),
          readSession: (projectId, sessionId) =>
            sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
              mode: 'read-only'
            })
        },
        resolveHostReferencedSession
      ),
      hostSessions: new HostSessionsService(
        {
          readProject: (projectId) =>
            sessionRepository.loadProjectWithDiagnostics(projectId, { mode: 'read-only' }),
          readSession: (projectId, sessionId) =>
            sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
              mode: 'read-only'
            })
        },
        { getSnapshot: () => runtimeRef.current?.getSnapshot() },
        resolveHostReferencedSession
      ),
      inputRegistry: notebookInputRegistry,
      agentsService,
      delegatedWorkService: delegatedWork.host,
      skillsService: hostSkillsService,
      hostModel: hostModelService,
      hostViewImage: hostViewImageService
    }),
    createNotebookLocalRpcModule
  )
  // Reverse module disposal cancels active inference before the RPC server waits for its handlers.
  await modules.add(hostModelService, (service) => ({
    name: 'host-model-service',
    capability: service,
    dispose: () => service.shutdown()
  }))
  void hostModelService
    .sweepStaleProfiles()
    .catch((error) =>
      hostLlmLog.error('stale host.llm profile cleanup failed', diagnosticErrorFields(error))
    )
  const visionInferenceRunner = new RestrictedInferenceRunner({
    appVersion: app.getVersion(),
    configRoot,
    profileNamespace: 'vision-evidence',
    resolveTarget: (target, context) =>
      settingsService.resolveExplicitAgentBackend(target, context),
    allowNativeCodexSubscription: true
  })
  void visionInferenceRunner
    .sweepStaleProfiles()
    .catch((error) =>
      hostLlmLog.error('stale Vision model profile cleanup failed', diagnosticErrorFields(error))
    )
  const imageInputCompatibility = await modules.add(
    new ImageInputCompatibilityOwner({
      captureTarget: () => settingsService.admitVisionModel(),
      runner: visionInferenceRunner,
      evidenceRepository: visionEvidenceRepository,
      recordUsage: recordAuxiliaryUsage
    }),
    (owner) => ({
      name: 'image-input-compatibility',
      capability: owner,
      dispose: () => {
        owner.clear()
        return visionInferenceRunner.shutdown()
      }
    })
  )
  notebookRpcServerRef.current = notebookRpcServer
  composition.phase('notebook-rpc')
  // Register ownership before ACP construction. Reverse disposal therefore drains ACP + Notebook
  // through the coordinator first, then releases the local bridge without creating a second runtime
  // shutdown owner; rollback also closes a server started during partial composition.
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(
    ({ sessionId, projectId, agentFrameId, attemptId, executionCwd }) =>
      notebookRpcServer.issueControlConnection(
        sessionId,
        projectId,
        agentFrameId,
        attemptId ? { role: 'delegate', attemptId } : { role: 'main' },
        executionCwd
      )
  )
  // The renderer's approval card responds here; the broker resolves the held connector call.
  declareElectronAdapter('connector-approvals', () => {
    ipcMainHandle('connectors:approval-respond', (_event, request: RespondApprovalRequest) => {
      approvalBroker.respond(request.id, request.decision)
    })
    ipcMainHandle('connectors:approval-replay', (_event, id: unknown) =>
      typeof id === 'string' ? approvalBroker.getPending(id) : null
    )
    ipcMainHandle('connectors:approval-replay-pending', () => approvalBroker.replayPending())
    ipcMainHandle(
      'connectors:credential-respond',
      (_event, request: { id: string; configured: boolean }) =>
        credentialRequestBroker.respond(request.id, request.configured)
    )
    ipcMainHandle('connectors:credential-replay-pending', () =>
      credentialRequestBroker.replayPending()
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

  const recoverPendingCustomServerDeletions = async (): Promise<void> => {
    const pendingCustomServerDeletionIds =
      (await settingsRepository.getSettings()).connectors?.pendingCustomServerDeletionIds ?? []
    await reconcilePendingCustomServerDeletions(permissionGrantRegistry, {
      pendingCustomServerDeletionIds,
      removeTagsForConnector: (serverId) =>
        removeResourceTagsOrThrow([{ resourceType: 'catalog.connector', resourceId: serverId }]),
      completeCustomServerDeletion: (serverId) =>
        settingsRepository.completeCustomServerDeletion(serverId)
    })
  }
  const initialConnectorSkillsReady = waitForInitialConnectorRefresh(
    recoverPendingCustomServerDeletions()
      .catch((error) =>
        permissionGrantsLog.error(
          'pending Connector relationship cleanup failed',
          errorLogFields(error)
        )
      )
      .then(() => connectorRuntimeSettings.refresh()),
    {
      // If custom MCP discovery outlives the startup barrier, the first agent may already have
      // materialized the old connector docs. Rotate it once the late refresh settles so the next
      // session/prompt uses the refreshed skills instead of waiting for another settings change.
      onLateSettled: () => runtimeRef.current?.requestSkillsReload()
    }
  )

  // Repair legacy UUID Connector grants and ComputeHost grants left behind without a deletion
  // journal. A failed/timeout Connector refresh leaves that owner class untouched; app-owned MCP
  // catalog ids are non-UUID and are never guessed to be stale.
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
  // Reconcile an existing legacy AppImage shim before startup completes. The owner scopes the
  // operation to Linux AppImage and records any filesystem failure without aborting the app.
  await cliCommandOwner.ensureCurrent()
  const githubCommandOwner = createGithubCommandOwner({ fetch: netFetchStandard })
  const logsCommandOwner = createLogsCommandOwner()
  declareElectronAdapter('desktop-utilities', () => {
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openLatestManagedFile: (source, request) =>
        managedFileVersionService.openLatest({ source, ...request }),
      openManagedFileVersion: (source, request) =>
        managedFileVersionService.openVersion(
          { source, projectId: request.projectId, fileId: request.fileId },
          request.versionId
        ),
      openNotebookInput: (request) => notebookInputRegistry.openPreviewKey(request.path),
      translate
    })
    registerLogsIpcHandlers(logsCommandOwner)
    registerGithubIpcHandlers({}, githubCommandOwner)
    registerCliInstallIpcHandlers(cliCommandOwner)
    registerWindowIpcHandlers()
    registerWindowFindIpcHandlers()
  })
  // ACP identity resolution and the Specialist settings IPC must use the same service instance.
  // Creating it only for settings leaves create-session unable to resolve a selected UUID.
  const approvalSessionLifecycle = bindComputeApprovalSessionLifecycle(
    {
      onSessionTurnStarted: (sessionId, turnToken) =>
        skillImportApprovalBroker.beginSessionTurn(sessionId, turnToken),
      onSessionTurnEnded: (sessionId, turnToken) =>
        skillImportApprovalBroker.endSessionTurn(sessionId, turnToken),
      onSkillImportAttachmentEligible: (sessionId, turnToken, attachmentUri) =>
        skillImportApprovalBroker.allowSessionTurnAttachment(sessionId, turnToken, attachmentUri),
      onSessionCancellationRequested: (sessionId) =>
        skillImportApprovalBroker.cancelSession(sessionId),
      onSessionUnavailable: (sessionId) => skillImportApprovalBroker.cancelSession(sessionId),
      onAllSessionsCancellationRequested: () => skillImportApprovalBroker.cancelAll()
    },
    computeIpcModule.handlers
  )
  const runtime = await modules.add(
    {
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      managedFileVersions: managedFileVersionService,
      uploadRepository,
      notebookRpcServer,
      peekNotebookHandoffContext: (sessionId) => notebookService.peekHandoffContext(sessionId),
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      grantedRootsRepository,
      permissionGrantRegistry,
      taskNotifications,
      notificationInbox,
      onSessionTurnStarted: approvalSessionLifecycle.onSessionTurnStarted,
      onSessionTurnEnded: approvalSessionLifecycle.onSessionTurnEnded,
      onSkillImportAttachmentEligible: approvalSessionLifecycle.onSkillImportAttachmentEligible,
      onTrustedMessageAttribution: (projectId, event) =>
        messageAttributionAuthority.recordRuntimeEvent(projectId, event),
      onSessionCancellationRequested: approvalSessionLifecycle.onSessionCancellationRequested,
      onSessionUnavailable: approvalSessionLifecycle.onSessionUnavailable,
      onAllSessionsCancellationRequested:
        approvalSessionLifecycle.onAllSessionsCancellationRequested,
      onSessionDeleteStarted: (sessionId) =>
        computeIpcModule.handlers.approvalBeginSessionDeletion(sessionId),
      beforeSessionDelete: async (sessionId) => {
        await sideChatOwnerRef.current?.invalidateParents([sessionId])
        const projectId = await sessionPersistenceCoordinator.sessionProjectId(sessionId)
        await notebookService.shutdownSession(sessionId)
        if (projectId) await notebookService.deleteSessionInputs(projectId, sessionId)
      },
      afterSessionDelete: (sessionId, retained) =>
        computeIpcModule.handlers.approvalFinishSessionDeletion(sessionId, retained),
      initializationBarrier: initialConnectorSkillsReady,
      specialistService,
      sessionPersistenceCoordinator,
      literatureReader: literatureDocumentReader,
      delegatedWork: delegatedWork.root,
      sideChatRelays: mainPromptSideChatRelay,
      imageInputCompatibility,
      memory: memoryService,
      auxiliaryUsage: {
        projectIdForSession: (sessionId) =>
          sessionPersistenceCoordinator.sessionProjectId(sessionId),
        record: recordAuxiliaryUsage
      },
      resolveComputeExecutionTargetIds: (sessionId) => hostsRegistry.getSelected(sessionId)
    } satisfies Parameters<typeof createAcpRuntime>[0],
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
  composition.phase('acp-runtime')
  runtime.setSessionResumeObserver(async (request) => {
    if (request.specialistBindingPending !== true) return
    await sessionSpecialistReconfiguration.completeResume(request.sessionId, request.specialistId)
  })
  const userSkillCatalogObserver = await modules.add(
    {
      storageRoot: configRoot,
      catalog: { list: () => settingsService.listUserSkills() },
      onCatalogChanged: async () => {
        await settingsService.registeredHelperCatalog().refresh()
        broadcastToRenderers('skills:catalog-changed', undefined)
        await runtime.requestSkillsReload()
      }
    } satisfies ConstructorParameters<typeof UserSkillCatalogObserver>[0],
    (options) => {
      const observer = new UserSkillCatalogObserver(options)
      return {
        name: 'user-skill-catalog-observer',
        capability: observer,
        start: () => observer.start(),
        rollback: () => observer.dispose(),
        dispose: () => observer.dispose()
      }
    }
  )
  userSkillCatalogObserverRef.current = userSkillCatalogObserver
  composition.phase('skills')
  const sideChatLog = createLogger('side-chat')
  const sideChatRuntime = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context),
      relay: sideChatRelay,
      deliverRelay: (parentSessionId, queued) =>
        mainPromptSideChatRelay.tryInject(parentSessionId, queued),
      persistence: {
        save: ({ projectId, parentSessionId, sideChat }) =>
          sessionPersistenceCoordinator.saveSideChatProjection({
            projectId,
            sessionId: parentSessionId,
            sideChat
          }),
        clear: ({ projectId, parentSessionId, sideChatId }) =>
          sessionPersistenceCoordinator.clearSideChat({
            projectId,
            sessionId: parentSessionId,
            sideChatId
          })
      },
      recordUsage: recordAuxiliaryUsage,
      onEvent: (event) => broadcastToRenderers('side-chat:event', event),
      setParentInteractionsPaused: (sessionId, paused) => {
        if (paused) {
          approvalBroker.pauseSession(sessionId)
          computeIpcModule.handlers.approvalPauseSession(sessionId)
          return
        }
        approvalBroker.resumeSession(sessionId)
        computeIpcModule.handlers.approvalResumeSession(sessionId)
      }
    } satisfies ConstructorParameters<typeof SideChatRuntimeOwner>[0],
    (options) => {
      const owner = new SideChatRuntimeOwner(options)
      return {
        name: 'side-chat-runtime',
        capability: owner,
        dispose: () => owner.shutdown()
      }
    }
  )
  sideChatOwnerRef.current = sideChatRuntime
  projectRuntimeQuiescenceRef.current = new ProjectRuntimeQuiescenceOwner({
    acp: {
      listSessionIds: () => runtime.getOwnedSessionIds(),
      liveSessionProjectId: (sessionId) => runtime.liveSessionProjectId(sessionId),
      deleteSession: (sessionId) => runtime.deleteSession({ sessionId })
    },
    delegation: {
      deleteProject: (projectId) => delegatedWork.root.deleteProject(projectId)
    },
    notebook: {
      shutdownProject: (projectId) => notebookService.shutdownProject(projectId)
    },
    reviewer: reviewerProjectRuntime,
    sideChat: sideChatRuntime,
    compute: {
      reconcileProject: async (projectId) => {
        const deletionOwner = computeJobDeletionRef.current
        if (!deletionOwner) throw new Error('Compute Job deletion is not initialized.')
        await deletionOwner.reconcileProjectOrphanJobs(projectId, isComputeJobOwnerLive)
      }
    }
  })
  try {
    const persistedSideChats = await sessionPersistenceCoordinator.loadPersistedSideChats()
    sideChatRuntime.hydrate(persistedSideChats.sideChats)
    sideChatRelay.hydrate(persistedSideChats.relays)
    await sideChatRuntime.sweepStaleProfiles(
      new Set(persistedSideChats.sideChats.map(({ sideChat }) => sideChat.id)),
      persistedSideChats.isComplete
    )
  } catch (error) {
    sideChatLog.error('durable Side chat hydration failed', diagnosticErrorFields(error))
  }
  composition.phase('side-chat')
  // Start the JobPoller wired to the shared broadcaster only after Project runtime quiescence and
  // Side Chat recovery are available. Queue startup loads the Session catalog, which may first need
  // to finish a pending Project deletion through those owners before restoring concurrency limits.
  await modules.add(
    {
      computeService,
      connectionBroker,
      jobDeletionOwner,
      hostRepository,
      jobRepository,
      operationRepository,
      storageRoot: dataRoot
    },
    (dependencies) => {
      const jobPoller = createComputeJobRuntime(dependencies)
      return {
        name: 'compute-job-runtime',
        capability: undefined,
        start: async () => {
          try {
            const owners = await jobRepository.listOwners()
            const jobs = (
              await Promise.all(owners.map((owner) => jobRepository.findByOwner(owner)))
            ).flat()
            for (const [index, job] of jobs.entries()) {
              if (
                job.status !== 'error' ||
                hasImmutableExecutionFileEvidenceReference(job.file_evidence)
              ) {
                continue
              }
              const fileEvidence = await recoverPublishedComputeJobFileEvidence({
                storageRoot: dataRoot,
                projectId: job.project_id,
                sessionId: job.session_id,
                jobId: job.job_id,
                producerRunId: job.producer_run_id
              })
              if (!fileEvidence) continue
              const updated = await jobRepository.update(job.job_id, { fileEvidence })
              jobs[index] = updated
              await settleComputeJobFileEvidence({
                storageRoot: dataRoot,
                projectId: job.project_id,
                sessionId: job.session_id,
                jobId: job.job_id,
                producerRunId: job.producer_run_id,
                fileEvidence
              }).catch((error) =>
                createLogger('compute:file-evidence').warn(
                  'Recovered Compute Job file-evidence receipt remains for reconciliation.',
                  { jobId: job.job_id, ...errorLogFields(error) }
                )
              )
            }
            await reconcileComputeJobFileEvidence(dataRoot, jobs)
          } catch (error) {
            createLogger('compute:file-evidence').warn(
              'Compute Job file-evidence startup reconciliation failed closed.',
              diagnosticErrorFields(error)
            )
          }
          await jobPoller.start()
        },
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        dispose: () => jobPoller.stop()
      }
    }
  )
  // Recovery quiesces every runtime owner, so do not start its first attempt until ACP, Delegation,
  // Notebook, Side Chat, and the composed quiescence boundary are all initialized. The bounded
  // durable barrier restoration above still runs early enough to block admission during startup.
  const projectDeletionRecovery = new ProjectDeletionRecoveryLoop(
    async () => {
      // A retained child Session plan must finish before its parent Project intent can prepare.
      await jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive)
      // Replay a pending Session JSON write from the tombstone before Project recovery removes that
      // temporary authority. The retained SQLite facts then remain available to historical Usage.
      await sessionRepository.reconcilePendingSessionProjection()
      await projectDeletionCoordinator.recoverPendingDeletions()
    },
    {
      onError: (error) =>
        createLogger('compute-job-deletion').error(
          'background deletion recovery failed; retry scheduled',
          diagnosticErrorFields(error)
        ),
      onStatusChanged: () =>
        applicationEvents.publish(LIFECYCLE_CHANNELS.projectDeletionCleanupChanged, undefined)
    }
  )
  projectDeletionCoordinator.setRecoveryLoop(projectDeletionRecovery)
  const removeProjectDeletionRecoveryWake = applicationEvents.subscribe((event) => {
    if (event.channel === 'project:deleted' && event.payload.status === 'cleanup-pending') {
      projectDeletionRecovery.wake()
    }
  })
  await modules.add(projectDeletionRecovery, (recovery) => ({
    name: 'project-deletion-recovery',
    capability: undefined,
    start: () => recovery.start(),
    dispose: async () => {
      removeProjectDeletionRecoveryWake()
      await recovery.stop()
    }
  }))
  declareElectronAdapter('side-chat', () =>
    registerSideChatIpcHandlers(sideChatRuntime, {
      loadParentSession: (projectId, sessionId) =>
        sessionRepository.loadSession(projectId, sessionId),
      hasLiveParentSession: (projectId, sessionId) => runtime.hasLiveSession(projectId, sessionId),
      withParentAvailable: (sessionId, operation) =>
        archiveCoordinator.withSessionAvailableById(sessionId, operation)
    })
  )
  // Archive availability is checked at the final admission point, rather than trusting renderer
  // visibility, so an archived Project/Session cannot restart work through another surface.
  runtime.setPromptAdmissionGuard(async (sessionId) => {
    await archiveCoordinator.assertSessionAvailableById(sessionId)
    await sessionSpecialistReconfiguration.assertUserPromptReady(sessionId)
    if (!(await completionHandoffLifecycle.canStartUserPrompt(sessionId))) {
      throw new Error('The approved Specialist handoff must finish or be cancelled before sending.')
    }
    if (sideChatRuntime.hasForParent(sessionId)) {
      throw new Error('Close Side chat before sending a message to Main.')
    }
  })
  runtime.setPromptDispatchAdmissionGuard((sessionId, dispatch) =>
    archiveCoordinator.withSessionDeletionAdmissionById(sessionId, dispatch)
  )
  const codeReconstructionLog = createLogger('artifacts:code-reconstruction')
  const codeReconstructionRunner = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      captureTarget: () => settingsService.captureActiveExplicitAgentBackendTarget(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context),
      recordUsage: recordAuxiliaryUsage
    } satisfies ConstructorParameters<typeof ArtifactCodeReconstructionRunner>[0],
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
    withProjectAvailable: (projectId, operation) =>
      archiveCoordinator.withProjectAvailable(projectId, operation)
  })
  const acpHandlerWorkflows = createAcpHandlerWorkflows(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    sessionRepository,
    (sessionId) => {
      if (sideChatRuntime.hasForParent(sessionId)) {
        throw new Error('Close Side chat before saving this conversation as a Skill.')
      }
    }
  )
  const taskAgent = createAcpTaskAgentPort(
    runtime,
    createSessionWorkflow,
    taskNotifications,
    archiveCoordinator,
    resolveSessionAgentTarget,
    resolveDefaultSessionAgentTarget
  )
  {
    // Framework-specific adapters declare their own session selector. The registry resolves those
    // selectors before its generic fallback, so registration order cannot route a Codex/OpenCode
    // completion through the wrong continuation path.
    completionGateRuntimeRegistry.register(
      createCodexCompletionGateRuntime({
        runtime: {
          isSessionUsingFramework: (sessionId, frameworkId) =>
            runtime.isSessionUsingFramework(sessionId, frameworkId),
          cancelPrompt: (request) => runtime.cancelPrompt(request),
          waitForPromptRelease: (sessionId) => runtime.waitForPromptRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          continueApprovedHandoff: (sessionId, text) =>
            runtime.continueApprovedHandoff(sessionId, text)
        },
        resolveApprovedSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createOpenCodeImmediateHandoffRuntime({
        runtime: {
          getSessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
          capturePromptForHandoff: (sessionId) => runtime.capturePromptForHandoff(sessionId),
          cancelPrompt: (request) => runtime.cancelPrompt(request),
          waitForPromptOwnershipRelease: (sessionId) =>
            runtime.waitForPromptOwnershipRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          startContinuation: (request) => runtime.startContinuation(request)
        },
        resolveSpecialistId: (sessionId) => sessionBindingService.getBinding(sessionId),
        reportHandoffFailure: async (failure) =>
          runtime.reportApprovedHandoffFailure(failure.sessionId)
      })
    )
    completionGateRuntimeRegistry.register(
      createProductionAppHandoffRuntime({
        runtime: {
          cancelPrompt: (request) => runtime.cancelPrompt(request),
          waitForPromptOwnershipRelease: (sessionId) =>
            runtime.waitForPromptOwnershipRelease(sessionId),
          switchSpecialist: (sessionId, specialistId) =>
            sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
          sendAppContinuation: (request) => runtime.sendAppContinuation(request)
        },
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
        ? (await specialistService.resolveRunnableById(specialistId)).revision
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
      sessionSpecialistReconfiguration.applyPersisted(sessionId, specialistId),
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
  delegatedWorkRef.current = delegatedWork
  permissionGrantRegistry.subscribe(() => runtime.notifyPermissionGrantsChanged())
  // Single shared teardown owner for both the before-quit handler (index.ts) and the pre-update-install
  // gate. Update handling is deliberately constructed below, after this dependency is complete.
  let reviewerModelRuntimeShutdown:
    | Pick<ReviewerModelRuntimeOwner, 'hasActiveWork' | 'shutdown' | 'shutdownForUpdateGate'>
    | undefined
  const shutdownCoordinator = new BackendShutdownCoordinator({
    runtime: {
      shutdownForQuit: async () => {
        const [main, reviewer] = await Promise.all([
          runtime.shutdownForQuit(),
          reviewerModelRuntimeShutdown
            ? reviewerModelRuntimeShutdown.shutdown()
            : Promise.resolve({ reaped: true })
        ])
        return { reaped: main.reaped && reviewer.reaped }
      },
      shutdownForUpdateGate: async () => {
        const [main, reviewer] = await Promise.all([
          runtime.shutdownForUpdateGate(),
          reviewerModelRuntimeShutdown
            ? reviewerModelRuntimeShutdown.shutdownForUpdateGate()
            : Promise.resolve({ reaped: true })
        ])
        return { reaped: main.reaped && reviewer.reaped }
      }
    },
    notebook: notebookService,
    sideChat: {
      shutdown: () => sideChatRuntime.shutdown(),
      suspendAll: (options) => sideChatRuntime.suspendAll(options)
    },
    log: createLogger('shutdown')
  })
  const durableBackendHandoffGate = createDurableInstallGate(
    () =>
      shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, {
        holdSideChatAdmission: true
      }),
    () => confirmRendererDurability()
  )
  const detectResearchBlockers = (): UpdateBlocker[] => {
    const blockers: UpdateBlocker[] = detectActiveSessions({
      runtime: { getActivePromptSessions: () => runtime.getQuitBlockingPromptSessions() },
      sideChat: { getActivePromptSessions: getActiveSideChatSessions },
      delegated: { getActiveDelegatedSessions },
      notebook: notebookService
    }).map((session) => session.kind)
    if (reviewerModelRuntimeShutdown?.hasActiveWork()) blockers.push('reviewer')
    if (settingsService.hasActiveInstall()) blockers.push('settings-install')
    return blockers
  }
  const durableDataRootHandoffGate = (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ): Promise<InstallReadiness> =>
    createDurableInstallGate(
      createDataRootResearchSafeInstallGate(
        detectResearchBlockers,
        () =>
          shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, {
            holdSideChatAdmission: true
          }),
        confirmedInterruption
      ),
      async () => {
        if (target.surface !== 'web-renderer') {
          return confirmRendererDurability('data-root-handoff', target.surface)
        }
        const outcome = await webSessionPersistenceFlush.flush(target.lifecycleClientId)
        const blocked = rendererSessionPersistenceFlushBlocksShutdown(outcome, 'data-root-handoff')
        if (blocked) webSessionPersistenceFlush.notifyAborted()
        return !blocked
      }
    )()
  // Construct update handling only after its backend-shutdown gate exists. The in-place strategy owns
  // this immutable dependency from construction; the manifest fallback ignores it because it does not
  // quit the running app to install.
  let releaseSettingsInstallAdmission: (() => void) | undefined
  const abortUpdateHandoff = (): void => {
    const releaseAdmission = releaseSettingsInstallAdmission
    releaseSettingsInstallAdmission = undefined
    releaseAdmission?.()
    try {
      sideChatRuntime.resumeAfterHandoff()
    } finally {
      notifyRendererDurabilityAborted()
    }
  }
  const updateInstallGate = createActiveResearchSafeInstallGate(
    detectResearchBlockers,
    durableBackendHandoffGate,
    () => isMigrationInProgress() || isMigrationPending()
  )
  const updateStrategy = createUpdateStrategy(process.platform, {
    translate,
    installGate: async () => {
      releaseSettingsInstallAdmission = settingsService.holdInstallAdmission()
      return updateInstallGate()
    },
    releaseInstallHandoff: abortUpdateHandoff
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
  // Framework changes rotate future runtime ownership; provider edits and authentication changes
  // reconnect generations that use the affected provider. Active provider/model/effort selections are
  // persisted defaults only and never flow through this effects port to mutate existing Sessions.
  const settingsWorkflows = createSettingsWorkflows(settingsService, {
    runtime: {
      requestProviderReconnect: (providerIds, includeDefault = true) => {
        void runtime.requestProviderReconnect(providerIds, includeDefault)
        if (includeDefault) void sideChatRuntime.requestProviderReconnect()
      },
      requestAgentFrameworkSwitch: (frameworkId) => {
        void runtime.requestAgentFrameworkSwitch(frameworkId)
        void sideChatRuntime.requestProviderReconnect()
      }
    },
    skills: {
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      notifySkillCatalogChanged: requestSkillCatalogRefresh,
      removeTagsForSkill: (resourceId) =>
        removeResourceTags([{ resourceType: 'catalog.skill', resourceId }])
    },
    connectors: {
      invalidatePermissionProjection: () => permissionGrantProjection.invalidateProjection(),
      refreshConnectorSkillDocs: (customServerId) =>
        customServerId
          ? connectorRuntimeSettings.refreshCustomServer(customServerId)
          : connectorRuntimeSettings.refresh(),
      requestSkillsReload: () => void runtime.requestSkillsReload(),
      pruneCustomServerPermissions: (serverId) =>
        permissionGrantRegistry.prune({ kind: 'mcp_server', serverId }).then(() => undefined),
      removeTagsForConnector: (resourceId) =>
        removeResourceTagsOrThrow([{ resourceType: 'catalog.connector', resourceId }]),
      beginCustomServerSecurityChange: (serverId) =>
        connectorService.beginCustomServerSecurityChange(serverId),
      clearCustomServerFailure: (serverId) => connectorService.clearCustomServerFailure(serverId),
      resetCustomServerClient: (serverId) => mcpClientManager.close(serverId)
    },
    appearance: { applyAppIconVariant: onAppIconVariantChanged ?? (() => undefined) }
  })
  declareElectronAdapter('settings', () =>
    registerSettingsIpcHandlers({
      service: settingsService,
      workflows: settingsWorkflows,
      snapshotCommits: settingsSnapshotCommits,
      listAppIconPreviews,
      connectorTemplateFiles: {
        select: async () => {
          const selected = await dialog.showOpenDialog({
            title: translate('Import Connector configuration'),
            properties: ['openFile'],
            filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
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
            title: translate('Export Connector configuration'),
            defaultPath: suggestedFileName,
            filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
          })
          if (selected.canceled || !selected.filePath) return false
          await publishUserFile(selected.filePath, (temporaryPath) =>
            writeFile(temporaryPath, contents, 'utf8')
          )
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
            archive,
            translate
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
  sessionPersistenceBackend.deleteSession = withSessionDeletionCleanup(
    originalDeleteSession,
    (_projectId, sessionId) => sessionSpecialistReconfiguration.clearSession(sessionId)
  )
  const sessionPersistenceHandlers = createSessionPersistenceHandlersWithAttributionAuthority(
    sessionPersistenceBackend,
    reviewRepository,
    messageAttributionAuthority
  )
  const sessionDetailsOwner = await modules.add(
    {
      appVersion: app.getVersion(),
      configRoot,
      settingsService,
      sessionPersistenceBackend,
      sessionPersistenceCoordinator
    },
    (dependencies) => {
      const log = createLogger('session-details')
      const inference = new RestrictedInferenceRunner({
        appVersion: dependencies.appVersion,
        configRoot: dependencies.configRoot,
        profileNamespace: 'session-details',
        resolveTarget: (target, context) =>
          dependencies.settingsService.resolveExplicitAgentBackend(target, context)
      })
      const owner = createSessionDetailsOwner({
        sessions: {
          listSessions: async () =>
            (await dependencies.sessionPersistenceBackend.loadAll()).sessions,
          mutateSession: (projectId, sessionId, mutation) =>
            dependencies.sessionPersistenceCoordinator.mutateSessionDetailsAuthority(
              projectId,
              sessionId,
              (session) => {
                const result = mutation(session)
                return result.kind === 'write' ? result.session : undefined
              }
            )
        },
        targets: {
          resolve: async (session) => {
            const admission =
              await dependencies.settingsService.admitSessionDetailsExecutionTarget(session)
            if (admission.mode === 'disabled') return { mode: 'disabled' }
            if (!inference.supportsTarget(admission.target)) return { mode: 'unavailable' }
            return {
              mode: 'admitted',
              frameworkId: admission.target.frameworkId,
              providerId: admission.target.providerId,
              model:
                admission.target.model.kind === 'required'
                  ? admission.target.model.id
                  : 'provider-default',
              reasoningEffort: admission.target.reasoningEffort
            }
          }
        },
        inference: {
          generate: async (request) => {
            if (!request.target.providerId) {
              throw new Error('Session details inference requires a provider target.')
            }
            const result = await inference.run({
              prompt: buildSessionDetailsUserPrompt(request.firstMessage),
              target: {
                frameworkId: request.target.frameworkId,
                providerId: request.target.providerId,
                model: { kind: 'required', id: request.target.model },
                reasoningEffort: request.target.reasoningEffort
              },
              systemPrompt: request.systemInstruction,
              agentName: 'Session details',
              description: 'Generate a Session title and description',
              signal: request.signal,
              outputLimitBytes: 8_192
            })
            return { output: result.text, usage: result.usage }
          }
        },
        lifecycle: {
          publish: (session) =>
            applicationEvents.publish(LIFECYCLE_CHANNELS.sessionUpdated, {
              session,
              originClientId: MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID
            })
        },
        log
      })
      return {
        name: 'session-details',
        capability: owner,
        start: async () => {
          await inference
            .sweepStaleProfiles()
            .catch((error) =>
              log.warn('stale Session details profile cleanup failed', diagnosticErrorFields(error))
            )
          await owner.start()
        },
        dispose: async () => {
          await owner.shutdown()
          await inference.shutdown()
        }
      }
    }
  )
  declareElectronAdapter('specialist', () =>
    registerSpecialistIpcHandlers(
      specialistService,
      sessionBindingService,
      sessionSpecialistReconfiguration,
      // A specialist capability edit (skills/connectors/enabled) must reach live sessions on the next
      // turn: reconnect so the agent respawns (re-provisioning skills) and resumes with the updated
      // specialist whitelist in the session _meta.
      () => void runtime.requestSkillsReload(),
      createContributionTemplateExporter({
        appVersion: app.getVersion(),
        translate,
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        readReadme: () => readFile(resolveContributionTemplateReadmePath(app.getAppPath()), 'utf8'),
        writeFile: (filePath, bytes) => writeFile(filePath, bytes)
      }),
      {
        service: specialistPackageService,
        selectArchive: () =>
          selectSpecialistArchive(
            {
              showOpenDialog: (options) => dialog.showOpenDialog(options),
              readFile,
              getFileSize: async (filePath) => (await stat(filePath)).size
            },
            translate
          ),
        saveReport: (report) =>
          saveSpecialistPackageReport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, contents) => writeFile(filePath, contents, 'utf8')
            },
            report,
            translate
          ),
        saveExport: (archive) =>
          saveSpecialistExport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive,
            translate
          )
      },
      marketplaceService
    )
  )
  // Runtime Settings UI: discover managed/external environments and pick an interpreter file. The
  // runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  const runtimeWorkflows = createRuntimeWorkflows({
    settingsService,
    runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
    micromambaRunner,
    // WS10: revoke a disabled runtime from any live session bound to it (mark binding unavailable).
    onRuntimeDisabled: (language, envId, force) =>
      notebookService.revokeRuntime(language, envId, { force }),
    // WS11: live-session usage of a runtime, for the disable-impact warning.
    describeRuntimeUsage: (language, envId) => notebookService.describeRuntimeUsage(language, envId)
  })
  declareElectronAdapter('notebook-runtime', () => registerRuntimeIpcHandlers(runtimeWorkflows))
  declareElectronAdapter('managed-preview', () =>
    installManagedPreviewElectronAdapter(
      previewResources,
      managedPreviewProtocol,
      managedPreviewOwners
    )
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
  const toManagedPreviewRequest = (
    request: OfficePreviewOpenRequest
  ): AcquireManagedPreviewRequest =>
    request.source === 'notebook-input'
      ? { source: request.source, path: request.path }
      : {
          source: request.source,
          projectId: request.projectId,
          fileId: request.fileId,
          ...(request.versionId ? { versionId: request.versionId } : {})
        }
  const officePreviewSupervisor = new OfficePreviewSupervisor({
    inspectResource: (request) => previewResources.inspect(toManagedPreviewRequest(request)),
    acquireResource: (ownerId, request, snapshot, maxBytes) =>
      previewResources.acquire(ownerId, toManagedPreviewRequest(request), { snapshot, maxBytes }),
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
  // lives) and start the env readiness gate. Named environments resolve the effective conda channel
  // lazily because they are the only path that solves online; default runtime packs use the official
  // CDN and must not wait for mirror probing during application startup.
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const effectiveMirror = (): ReturnType<typeof effectiveMirrorAsync> =>
      effectiveMirrorAsync(configuredMirror, app.getLocale())
    provisioner = createProductionProvisioner(
      {
        root: provisioningRoot,
        processSandbox: notebookNetworkSandbox,
        channel: async () =>
          (await effectiveMirror()).condaChannel ??
          process.env.OPEN_SCIENCE_CONDA_CHANNEL ??
          'conda-forge',
        // Mirror probing never changes the configured enterprise CA bundle, so it is safe to pass
        // through synchronously while channel selection warms in the background.
        caBundle: configuredMirror?.caBundle,
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
    // Warm the process-local mirror cache after provisioner construction succeeds. This stays outside
    // the startup critical path; a later named-env create awaits the same memoized probe if necessary.
    void effectiveMirror().catch((error) =>
      notebookStartupLog.error('package mirror warmup failed', errorLogFields(error))
    )
    // One serialized wrapper shared by the startup gate and the notebook service's on-demand default
    // provisioning, so a concurrent build of the same default env (UI R-tab + an agent R run) can't
    // race the provisioner's shared in-flight flag; materialize is also idempotent as a backstop.
    serialized = serializeProvisioner(provisioner)
  } catch (error) {
    // micromamba missing (e.g. dev without a staged binary): the notebook env stays unprovisioned and
    // the UI surfaces "runtime unavailable" rather than crashing startup or dropping the IPC handlers.
    notebookStartupLog.error('environment provisioning unavailable', errorLogFields(error))
  }
  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight (orphan
  // download staging, a half-built prefix, an interrupted install). Kicked off HERE — before the env
  // IPC gate below — so recoverInterruptedOperations() publishes its barrier synchronously and every
  // prefix-touching path (the startup gate's restore/upgrade/repair, UI provision/repair, named-env
  // create, on-demand materialize, install) can await it and never race recovery's cleanup/delete.
  // Fire-and-forget so a slow/failed recovery never blocks IPC registration; the barrier itself is what
  // actually orders the prefix work.
  void runDataRootStartupRecovery(() => notebookService.recoverInterruptedOperations(), {
    reportFailure: (error) =>
      notebookStartupLog.error('operation recovery failed', errorLogFields(error))
  })
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
    onRepairStarting: (language, target) => notebookService.prepareRuntimeRepair(language, target),
    onRepairCompleted: (language) => notebookService.completeRuntimeRepair(language)
  })
  // Always register the handlers (serialized is undefined when the provisioner could not be built).
  // Start maintenance only after all four Electron channels exist, preserving the previous startup
  // ordering while construction remains application-owned and single-instance.
  declareElectronAdapter('notebook-environment', () => {
    const startup = installNotebookEnvironmentSurface(
      notebookEnvironmentLifecycle,
      registerNotebookEnvIpcHandlers
    )
    notebookService.setEnvironmentStartupBarrier(startup)
  })
  if (provisioner && serialized) {
    // Back the notebook service's manage_environments tool with the same provisioner that owns the env
    // gate (it is a DefaultRuntimeProvisioner, which implements createNamedEnvironment/listEnvironments/
    // removeEnvironment). Wired after construction like the mcp/mirror resolvers above.
    notebookService.setEnvironmentManager(provisioner)
    // On first agent use of a not-yet-built default env, build it from the offline bundle (via the
    // shared serialized provisioner) instead of erroring — keeps R lazy but avoids the agent creating
    // a redundant named env.
    notebookService.setDefaultEnvProvisioner(serialized, broadcastNotebookEnvProgress)
  }
  composition.phase('notebook-provisioner')

  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  let releaseDataRootInstallAdmission: (() => void) | undefined
  const abortDataRootInstallAdmission = (): void => {
    const releaseAdmission = releaseDataRootInstallAdmission
    releaseDataRootInstallAdmission = undefined
    releaseAdmission?.()
  }
  const storageCommandOwner = createStorageCommandOwner({
    runtime,
    notebook: notebookService,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    getActiveSideChatSessions,
    getActiveDelegatedSessions,
    hasActiveReviewerWork: () => reviewerModelRuntimeShutdown?.hasActiveWork() ?? false,
    settingsService,
    micromambaRunner,
    acknowledgeWebRendererFlush: webSessionPersistenceFlush.acknowledge,
    notifyDataRootHandoffAborted: () => {
      abortDataRootInstallAdmission()
      try {
        sideChatRuntime.resumeAfterHandoff()
      } finally {
        try {
          notifyRendererDurabilityAborted()
        } finally {
          webSessionPersistenceFlush.notifyAborted()
        }
      }
    },
    prepareDataRootHandoff: async (target, confirmedInterruption) => {
      let prepared = false
      releaseDataRootInstallAdmission ??= settingsService.holdInstallAdmission()
      try {
        const readiness = await durableDataRootHandoffGate(target, confirmedInterruption)
        prepared = readiness.completed && readiness.reaped
        return prepared
      } finally {
        if (!prepared) {
          abortDataRootInstallAdmission()
          sideChatRuntime.resumeAfterHandoff()
        }
      }
    },
    cleanupJournal: dataRootCleanupJournal
  })
  declareElectronAdapter('storage', () =>
    registerStorageIpcHandlers(
      {
        runtime,
        notebook: notebookService,
        getActivePromptSessions: () => runtime.getActivePromptSessions(),
        getActiveSideChatSessions,
        getActiveDelegatedSessions,
        hasActiveReviewerWork: () => reviewerModelRuntimeShutdown?.hasActiveWork() ?? false,
        settingsService
      },
      storageCommandOwner
    )
  )
  const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
    provenance: artifactProvenanceRepository,
    openLatestManagedFile: (request) =>
      managedFileVersionService.openLatest({
        source: 'artifact',
        projectId: request.projectId!,
        fileId: request.fileId!
      }),
    openManagedFileVersion: (request) =>
      managedFileVersionService.openVersion(
        { source: 'artifact', projectId: request.projectId!, fileId: request.fileId! },
        request.versionId
      ),
    codeReconstruction,
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
    recoverPendingArtifacts: (request) =>
      sessionPersistenceCoordinator.retryArtifactFinalization(request)
  })
  artifactHandlersRef.current = artifactHandlers
  declareElectronAdapter('artifacts', () =>
    registerArtifactIpcHandlers(
      artifactRepository,
      artifactRunRegistry,
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
  const sessionDeletionOwner = new SessionDeletionOwner({
    runtime,
    persistence: {
      deleteSession: (request) =>
        withDataRootWrite(() =>
          sessionPersistenceBackend.deleteSession(request.projectId, request.sessionId)
        )
    }
  })
  declareElectronAdapter('session-persistence', () => {
    registerSessionPersistenceIpcHandlers(
      sessionPersistenceBackend,
      reviewRepository,
      sessionPersistenceHandlers,
      async (session) => {
        sessionDetailsOwner.afterSessionSaved(session)
        try {
          await delegatedWork.root.wakeMessages?.(session.id)
        } catch (error) {
          createLogger('delegation:messages').warn(
            'message wake after Session activation failed',
            diagnosticErrorFields(error)
          )
        }
      },
      async (request) => {
        const error = await shell.openPath(sessionRepository.recoveryFolderPath(request.projectId))
        if (error) throw new Error('Session recovery folder could not be opened.')
      }
    )
  })
  const conversationExportService = createConversationExportService({
    translate,
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    isSessionActive: (projectId, sessionId) =>
      runtime
        .getActivePromptSessions()
        .some(
          (activeSession) =>
            activeSession.projectId === projectId && activeSession.sessionId === sessionId
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
  declareElectronAdapter('managed-file-versions', () =>
    registerManagedFileVersionIpcHandlers(managedFileVersionHandlers)
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
  const reviewerModelRuntime = await modules.add(
    {
      appVersion: app.getVersion(),
      isDataRootHandoffActive: () => isMigrationInProgress() || isMigrationPending(),
      captureModel: () => settingsService.admitReviewerExecutionModel(),
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context)
    } satisfies ConstructorParameters<typeof ReviewerModelRuntimeOwner>[0],
    (options) => {
      const owner = new ReviewerModelRuntimeOwner(options)
      reviewerModelRuntimeShutdown = owner
      return {
        name: 'reviewer-model-runtime',
        capability: owner,
        disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
        dispose: async () => {
          try {
            if (!(await owner.shutdown()).reaped) {
              throw new BackendShutdownOutcomeError('degraded')
            }
          } finally {
            if (reviewerModelRuntimeShutdown === owner) reviewerModelRuntimeShutdown = undefined
          }
        }
      }
    }
  )
  const reviewerOptions = {
    acpRuntime: runtime,
    modelRuntime: reviewerModelRuntime,
    projectRuntime: reviewerProjectRuntime,
    withProjectAvailable: <Result>(projectId: string, operation: () => Promise<Result>) =>
      archiveCoordinator.withProjectAvailable(projectId, operation),
    mcpEntryPath: mainEntryPath,
    managedFileVersions: managedFileVersionService,
    artifactCatalog: projectFilesRepository,
    artifactProvenanceRepository,
    pagedContentResolver: createReviewerPagedContentResolver({
      createWindow: () => {
        const previewWindow = new BrowserWindow({
          show: false,
          width: 1_024,
          height: 1_280,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            partition: 'reviewer-paged-preview'
          }
        })
        previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        previewWindow.webContents.on('will-navigate', (event, url) => {
          const target = new URL(url)
          const runtime = new URL(OFFICE_PREVIEW_RUNTIME_ORIGIN)
          if (target.protocol !== runtime.protocol || target.hostname !== runtime.hostname) {
            event.preventDefault()
          }
        })
        previewWindow.webContents.session.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false)
        )
        return previewWindow
      },
      createSessionId: randomUUID,
      createRuntimeUrl: createReviewerPagedPreviewRuntimeUrl,
      acquireResource: (
        ownerId,
        resolvedPath,
        filename,
        verifiedObservation,
        verifiedChecksum,
        maxBytes
      ) =>
        previewResources.acquireResolvedFile(
          ownerId,
          {
            path: resolvedPath,
            mimeType: filename.endsWith('.docx')
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            verifiedObservation,
            verifiedChecksum
          },
          maxBytes
        ),
      releaseResource: (ownerId, resourceId) => previewResources.release(ownerId, { resourceId }),
      renderPdfPages: renderPdfPagePreviews,
      getProcessMemoryUsageBytes: createOfficePreviewProcessMemoryReader(app)
    }),
    resolveSessionAgentTarget,
    saveSessionAgentConfiguration: (
      session: PersistedChatSession,
      configuration: SessionAgentConfiguration
    ) =>
      sessionPersistenceCoordinator.saveSession({
        ...session,
        agentConfiguration: configuration
      }),
    withSessionMutation: <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ) => sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
    recordUsage: recordAuxiliaryUsage
  }
  const reviewerCommandOwner = createReviewerCommandOwner(reviewerOptions)
  reviewerCommandOwnerRef.current = reviewerCommandOwner
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
      archiveAvailability: archiveCoordinator,
      respondDelegatedQuestion: (input) => {
        if (!delegatedWork.root.respondQuestion) {
          throw new Error('Delegated question response owner is unavailable.')
        }
        return delegatedWork.root.respondQuestion(input)
      }
    },
    notebook: {
      workflows: notebookCommands,
      readInputPreview: (request) => notebookInputRegistry.readPreview(request)
    },
    notebookEnvironment: notebookEnvironmentLifecycle,
    notebookRuntime: {
      workflows: runtimeWorkflows,
      pickInterpreter: async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        return result.filePaths[0] ?? null
      }
    },
    settingsCore: {
      service: settingsService,
      appearance: settingsWorkflows.appearance,
      snapshotCommits: settingsSnapshotCommits,
      emitInstallEvent: (event) => broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event),
      listAppIconPreviews
    },
    settingsIntegration: {
      skills: settingsWorkflows.skills,
      connectors: settingsWorkflows.connectors,
      snapshotCommits: settingsSnapshotCommits,
      connectorApprovals: approvalBroker,
      skillImportApprovals: skillImportApprovalBroker
    },
    settingsRuntime: {
      workflows: settingsWorkflows.runtime,
      snapshotCommits: settingsSnapshotCommits
    },
    compute: {
      compute: computeIpcModule.handlers,
      bookmarks: {
        get: (providerId) => settingsService.getComputeBookmarks(providerId),
        set: (providerId, folders) => settingsService.setComputeBookmarks(providerId, folders)
      },
      enabledHosts: sessionEnabledComputeHostsOwner,
      events: applicationEvents
    },
    permissionGrants: permissionGrantProjection,
    tags: tagService,
    memory: {
      snapshot: () => memoryService.snapshot(),
      setEnabled: async (request) => {
        const before = await memoryService.isEnabled()
        const snapshot = await memoryService.setEnabled(request)
        if (before !== snapshot.enabled) await runtime.requestSkillsReload()
        return snapshot
      },
      createCategory: (request) => memoryService.createCategory(request),
      updateCategory: (request) => memoryService.updateCategory(request),
      deleteCategory: (request) => memoryService.deleteCategory(request),
      createEntry: (request) => memoryService.createEntry(request),
      updateEntry: (request) => memoryService.updateEntry(request),
      deleteEntry: (request) => memoryService.deleteEntry(request),
      clearAll: () => memoryService.clearAll()
    },
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
        save: (request) =>
          previewStateRepository.save(request.projectId, request.state, request.expectedRevision),
        delete: (request) => previewStateRepository.delete(request.projectId)
      },
      projectFiles: projectFilesHandlers,
      projects: projectHandlers,
      sessions: {
        ...sessionPersistenceHandlers,
        filterPdfContextCandidates: (request) => sessionPdfContextOwner.filterCandidates(request),
        linkPdfContext: (request) =>
          linkPdfContextWithCapability({
            read: () =>
              sessionPersistenceCoordinator.readSessionRuntimeContext(
                request.projectId,
                request.sessionId
              ),
            link: () => sessionPdfContextOwner.linkWithResult(request),
            enable: () =>
              runtimeRef.current?.enableLiteratureContext(request.sessionId) ?? Promise.resolve(),
            rollback: (linked, previous) =>
              sessionPersistenceCoordinator
                .patchSessionRuntimeContext({
                  projectId: request.projectId,
                  sessionId: request.sessionId,
                  expectedRevision: linked.revision,
                  patch: { pdfContext: previous.pdfContext }
                })
                .then(() => undefined),
            onRollbackError: (error) => {
              literatureContextLog.error('PDF context link rollback failed', {
                sessionId: request.sessionId,
                ...errorLogFields(error)
              })
            }
          }),
        unlinkPdfContext: async (request) => {
          const context = await sessionPdfContextOwner.unlink(request)
          if ((context.pdfContext?.bindings.length ?? 0) === 0) {
            try {
              await runtimeRef.current?.disableLiteratureContext(request.sessionId)
            } catch (error) {
              literatureContextLog.warn('Literature capability disable failed after PDF unlink', {
                sessionId: request.sessionId,
                ...errorLogFields(error)
              })
            }
          }
          return context
        },
        editDetails: (request) => sessionDetailsOwner.edit(request),
        stageTaskCompletion: (request) =>
          sessionPersistenceCoordinator.stageTaskCompletion(request),
        settleTaskCompletion: (request) =>
          sessionPersistenceCoordinator.settleTaskCompletion(request),
        failTaskRun: (request) => sessionPersistenceCoordinator.failTaskRun(request),
        updateSessionConfiguration: (session, expectedRevision) =>
          sessionPersistenceCoordinator.updateSessionConfiguration(session, expectedRevision),
        saveSession: async (session, options, authority) => {
          const result = authority
            ? await sessionPersistenceHandlers.saveSession(session, options, authority)
            : await sessionPersistenceHandlers.saveSession(session, options)
          sessionDetailsOwner.afterSessionSaved(result.session)
          return result
        },
        deleteSession: (request) => sessionDeletionOwner.delete(request)
      },
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

  // The shared coordinator remains the sole ACP + Notebook teardown owner.
  // It also coordinates Side Chat suspension/shutdown. Register command routing after it so reverse
  // disposal removes adapters, then the router, before any underlying owner stops.
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
  composition.phase('commands')

  return {
    applicationCommands: {
      localWeb: applicationCommandComposition.localWeb,
      remoteWeb: applicationCommandComposition.remoteWeb,
      task: applicationCommandComposition.task
    },
    applicationEvents,
    permissionApprovalPresence,
    bindRemoteAccess: applicationCommandComposition.bindRemoteAccess,
    taskNotifications,
    notificationInbox,
    settingsService,
    commitClosePreference: async (preference) => {
      await settingsSnapshotCommits.currentSnapshotAfter(
        settingsService.setClosePreference(preference)
      )
    },
    taskAgent,
    taskControls: {
      specialists: {
        resolve: (reference) => specialistService.resolveRunnableByReference(reference)
      }
    },
    computePreferences: sessionEnabledComputeHostsOwner,
    sessionDeletionCapability: sessionPersistenceCoordinator,
    archiveCapability: archiveCoordinator,
    detectActiveSessions: () =>
      detectActiveSessions({
        runtime: { getActivePromptSessions: () => runtime.getQuitBlockingPromptSessions() },
        sideChat: { getActivePromptSessions: getActiveSideChatSessions },
        delegated: { getActiveDelegatedSessions },
        notebook: notebookService
      }),
    hasActiveReviewerWork: () => reviewerModelRuntimeShutdown?.hasActiveWork() ?? false,
    getActiveSettingsInstallId: () => settingsService.getActiveInstallId(),
    holdSettingsInstallAdmission: () => settingsService.holdInstallAdmission(),
    prepareForQuit: () => runtime.prepareForQuit(),
    abortQuitPreparation: () => runtime.abortQuitPreparation(),
    electronAdapters: {
      beforeCompute: beforeComputeAdapters,
      compute: {
        handlers: computeIpcModule.handlers,
        enabledHosts: sessionEnabledComputeHostsOwner
      },
      beforeAcp: beforeAcpAdapters,
      acp: {
        runtime,
        workflows: acpHandlerWorkflows,
        sessionAdmission: {
          withSessionAvailableById: (sessionId, operation) =>
            archiveCoordinator.withSessionAvailableById(sessionId, operation)
        },
        resolveMemoryEnabled: async ({ sessionId }) => {
          const projectId = await sessionPersistenceCoordinator.sessionProjectId(sessionId)
          if (!projectId) return undefined
          const session = await sessionRepository.loadSession(projectId, sessionId)
          return session ? session.memoryEnabled !== false : undefined
        }
      },
      afterAcp: afterAcpAdapters
    }
  }
}

const registerIpcHandlers = async (options: IpcRegistrationOptions): Promise<IpcRegistration> => {
  const composition = startDiagnosticOperation(createLogger('startup'), {
    operation: 'application-composition',
    cpuUsage: process.cpuUsage
  })
  try {
    const applicationRuntime = await composeApplicationRuntimeWithAdapters(
      (modules) => createApplicationModules(options, modules, composition),
      installElectronRuntimeAdapters
    )
    composition.phase('ipc-adapters')
    composition.complete()
    return {
      ...applicationRuntime.interfaces,
      dispose: applicationRuntime.dispose
    }
  } catch (error) {
    composition.fail(error)
    throw error
  }
}

export { registerIpcHandlers }
