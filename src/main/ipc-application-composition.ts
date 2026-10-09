import { composeAgentActivation } from './composition/agent-activation'
import { composeAgentCompletion, composeAgentWorkflows } from './composition/agent-completion'
import { composeAgentControls } from './composition/agent-controls'
import { composeAgentRuntime } from './composition/agent-runtime'
import { composeArtifactSurfaces } from './composition/artifact-surfaces'
import { composeBackendLifecycle } from './composition/backend-lifecycle'
import { composeBackgroundResults } from './composition/background-results'
import { composeCommandDependencies } from './composition/command-dependencies'
import { composeComputeAdmission, composeComputeServices } from './composition/compute'
import { composeComputeRecovery } from './composition/compute-recovery'
import { composeConnectorRecovery, composeConnectors } from './composition/connectors'
import { composeDelegation } from './composition/delegation'
import { composeDesktopUtilities } from './composition/desktop-utilities'
import { composeDocumentReading } from './composition/document-reading'
import { composeHandoff, composeStorageHandoff } from './composition/handoff'
import { composeManagedFiles } from './composition/managed-files'
import { composeManagedExecution } from './composition/managed-execution'
import { registerRunObservationIpc } from './run-observation/ipc'
import { registerBrowserRecordingIpc } from './browser-recordings/ipc'
import { registerResearchRunInspectionIpc } from './research-runs/ipc'
import { registerResearchDemoIpc } from './research-demos/ipc'
import { registerResearchExecutionProfileIpc } from './research-execution-profiles/ipc'
import { composeNotebookBridge } from './composition/notebook-bridge'
import { composeNotebookRuntime } from './composition/notebook-runtime'
import { composeNotebookSurfaces } from './composition/notebook-surfaces'
import { composeNotifications } from './composition/notifications'
import { composeProjectLifecycle, composeProjectRecovery } from './composition/project-lifecycle'
import { composeResearchCatalog } from './composition/research-catalog'
import { composeSessionAuthority } from './composition/session-authority'
import { composeSessionFoundation } from './composition/session-foundation'
import {
  composeSessionPackageSurfaces,
  composeSessionPackages
} from './composition/session-packages'
import { composeSessionProjection } from './composition/session-projection'
import { composeSessionSurfaces } from './composition/session-surfaces'
import { composeSettingsBootstrap } from './composition/settings-bootstrap'
import { composeSettingsEffects } from './composition/settings-effects'
import { composeSideChat } from './composition/side-chat'
import {
  composeSessionSpecialists,
  composeSpecialistCatalog,
  composeSpecialistPackages
} from './composition/specialists'
import { composeStorageStartup } from './composition/storage-startup'
import { composeUploadStorage } from './composition/upload-storage'

import { app } from 'electron'

import { type ApplicationCommandComposition } from './application-command-composition'
import { createApplicationEventModule, type ApplicationEventSource } from './application-events'
import { type ApplicationModuleBuilder } from './application-runtime'
import { registerApplicationCommandComposition } from './composition/application-commands'

import { createAcpRuntime } from './acp/runtime-composition'
import { ArchiveCoordinator } from './archive/coordinator'
import { SessionEnabledComputeHostsOwner } from './compute/session-enabled-hosts-owner'

import type { SessionSummary } from '../shared/session-persistence'
import { type AppIconPreview, type AppIconVariant } from '../shared/settings'
import { registerReviewerComposition } from './composition/reviewer'
import { type DiagnosticOperation } from './diagnostics/operation'
import { createLogger, diagnosticErrorFields } from './logger'
import { createElectronSurfaceAdapter } from './ipc-surfaces/adapter'
import { createConnectorApprovalElectronSurface } from './ipc-surfaces/connector-approvals'
import { createCoreElectronSurfaces } from './ipc-surfaces/core'
import { type ShutdownStepOutcome } from './lifecycle-shutdown'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import type { PreviewProtocolRegistrar } from './managed-preview-protocol'
import { TaskNotificationService } from './notifications/task-notifications'
import { PermissionApprovalPresence } from './permission-approval-presence'
import { installRendererBroadcastEventHub } from './renderer-broadcast'
import {
  type ElectronRuntimeAdapterInterfaces,
  type NamedElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { type SessionDeletion } from './session-persistence/coordinator'
import {
  createWebSessionPersistenceFlush,
  type RendererSessionPersistenceFlushPolicy,
  type RendererSessionPersistenceSurface
} from './session-persistence/renderer-flush'
import type { SettingsDocumentStore } from './settings/document-store'
import type { WindowSettingsCapabilities } from './settings/service-capabilities'
import { detectActiveSessions } from './storage/detect-active'
import {
  isMigrationInProgress,
  isMigrationPending,
  runDataRootStartupRecovery,
  withDataRootWrite
} from './storage/migration-state'
import type { TaskControlPorts } from './tasks/task-control-ports'
import type { TaskAgentPort } from './tasks/task-runner'
import type { TrayNavigationSession } from './tray-navigation'

export type IpcRegistrationOptions = {
  mainEntryPath: string
  // Startup and the application runtime share one settings.json transaction owner. Tests and
  // non-desktop compositions may omit it and receive the existing default store.
  settingsStore?: SettingsDocumentStore
  translate?: NativeTranslator
  desktopLocale?: () => import('../shared/locale').Locale
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
  openSessionPackageFile: (path: string | null) => void
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
  managedExecution: import('./managed-execution-external-port').ManagedExecutionExternalPort
  sessionPackageTransfer: import('./session-package-external-port').SessionPackageExternalPort
  taskControls: TaskControlPorts
  computePreferences: Pick<SessionEnabledComputeHostsOwner, 'withReservation' | 'set'>
  sessionDeletionCapability: Pick<SessionDeletion, 'setSessionDeletionHandlers'>
  archiveCapability: Pick<ArchiveCoordinator, 'isSessionAvailableById' | 'setMarkReadSessions'>
  detectActiveSessions: () => ReturnType<typeof detectActiveSessions>
  listTrayNavigationSessions: () => Promise<readonly TrayNavigationSession[]>
  hasActiveReviewerWork: () => boolean
  getActiveSettingsInstallId: () => string | undefined
  holdSettingsInstallAdmission: () => () => void
  prepareForQuit: () => Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
  abortQuitPreparation: () => void
}

type ApplicationModuleInterfaces = ApplicationRuntimeInterfaces & {
  readonly electronAdapters: ElectronRuntimeAdapterInterfaces
}

export type IpcRegistration = ApplicationRuntimeInterfaces & {
  dispose: () => Promise<void>
}

// Constructs application-owned modules and their narrow Electron adapter interfaces. The factory does
// not register a channel or protocol; transport installation happens only after construction succeeds.
export const createApplicationModules = async (
  {
    mainEntryPath,
    settingsStore,
    managedPreviewProtocol,
    headless = false,
    translate = englishNativeTranslator,
    desktopLocale,
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
    surfaceAdapters.push(createElectronSurfaceAdapter(name, install))
  }
  const applicationEvents = await modules.add(
    installRendererBroadcastEventHub,
    createApplicationEventModule
  )
  const permissionApprovalPresence = new PermissionApprovalPresence()
  const webSessionPersistenceFlush = createWebSessionPersistenceFlush(applicationEvents)
  const settingsBootstrap = await composeSettingsBootstrap({
    applicationEvents,
    permissionApprovalPresence,
    getRuntimeRef: () => runtimeRef,
    getSpecialistRepository: () => specialistCatalog.specialistRepository,
    getSpecialistService: () => specialistCatalog.specialistService,
    mainEntryPath,
    settingsStore,
    headless,
    modules
  })
  const storageStartup = await composeStorageStartup({
    applicationEvents,
    ...settingsBootstrap,
    headless,
    composition
  })
  const uploadStorage = await composeUploadStorage({ storageStartup })
  // Session reads and permission scope validation both need a late-bound view of ACP ownership:
  // startup runs before the runtime exists, while later reads must preserve live prompt state.
  const runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined } = {
    current: undefined
  }
  const backgroundResults = await composeBackgroundResults({
    applicationEvents,
    ...settingsBootstrap,
    runtimeRef,
    getSessionRepository: () => sessionFoundation.sessionRepository,
    getSessionPersistenceCoordinator: () => sessionAuthority.sessionPersistenceCoordinator,
    getNotebookCommands: () => notebookRuntime.notebookCommands,
    getJobRepository: () => computeAdmission.jobRepository,
    getHostRepository: () => computeAdmission.hostRepository,
    modules
  })
  const sessionFoundation = await composeSessionFoundation({
    ...settingsBootstrap,
    runtimeRef,
    modules
  })
  const sessionPackages = await composeSessionPackages({
    ...settingsBootstrap,
    ...storageStartup,
    uploadRepository: uploadStorage.uploadRepository,
    ...sessionFoundation,
    getDetectSessionExportBlockingSessions: () =>
      projectLifecycle.detectSessionExportBlockingSessions,
    modules
  })
  const managedFiles = composeManagedFiles({
    ...settingsBootstrap,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    ...sessionFoundation,
    getNotebookInputRegistry: () => sessionAuthority.notebookInputRegistry
  })
  const sessionAuthority = await composeSessionAuthority({
    uploadRepository: uploadStorage.uploadRepository,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    runtimeRef,
    ...sessionFoundation,
    ...sessionPackages,
    ...managedFiles,
    getDelegatedWorkRef: () => delegation.delegatedWorkRef,
    composition
  })
  const documentReading = await composeDocumentReading({
    sessionPackageService: sessionPackages.sessionPackageService,
    declareElectronAdapter,
    applicationEvents,
    pdfUploadImporter: uploadStorage.pdfUploadImporter,
    uploadRepository: uploadStorage.uploadRepository,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    modules,
    settingsService: settingsBootstrap.settingsService
  })
  const projectLifecycle = composeProjectLifecycle({
    stopManagedProject: (projectId) => managedExecution.stopProject(projectId),
    applicationEvents,
    ...storageStartup,
    uploadRepository: uploadStorage.uploadRepository,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    runtimeRef,
    ...backgroundResults,
    ...sessionFoundation,
    ...sessionPackages,
    ...managedFiles,
    ...sessionAuthority,
    getNotebookService: () => notebookRuntime.notebookService
  })
  const sessionProjection = composeSessionProjection({
    ...settingsBootstrap,
    ...sessionFoundation,
    ...sessionAuthority,
    ...projectLifecycle
  })
  const backendTeardownOwnedByCoordinator: { current: boolean } = { current: false }
  const notebookRuntime = await composeNotebookRuntime({
    applicationEvents,
    ...settingsBootstrap,
    ...backgroundResults,
    ...managedFiles,
    ...sessionAuthority,
    ...projectLifecycle,
    backendTeardownOwnedByCoordinator,
    translate,
    modules,
    composition
  })
  const specialistCatalog = await composeSpecialistCatalog({ ...settingsBootstrap, composition })
  const managedExecution = await composeManagedExecution({
    desktopLocale,
    applicationEvents,
    managedFiles,
    sessionAuthority,
    sessionPackages,
    projectLifecycle,
    notebookRuntime,
    runtimeRef,
    modules
  })
  notebookRuntime.notebookLifecycle = managedExecution.notebookLifecycle
  declareElectronAdapter('research-runs', () =>
    registerResearchRunInspectionIpc(managedExecution.researchRuns)
  )
  declareElectronAdapter('research-demos', () =>
    registerResearchDemoIpc(managedExecution.researchDemos)
  )
  declareElectronAdapter('research-execution-profiles', () =>
    registerResearchExecutionProfileIpc(managedExecution.service)
  )
  declareElectronAdapter('run-observation', () => {
    if (managedExecution.external.observation)
      registerRunObservationIpc(managedExecution.external.observation)
    if (managedExecution.external.projectRecordings)
      registerBrowserRecordingIpc(managedExecution.external.projectRecordings)
  })
  sessionAuthority.notebookActivityRef.current = managedExecution.notebookLifecycle
  const researchCatalog = await composeResearchCatalog({
    applicationEvents,
    ...settingsBootstrap,
    uploadRepository: uploadStorage.uploadRepository,
    ...managedFiles,
    ...sessionAuthority,
    ...documentReading,
    ...specialistCatalog,
    modules
  })
  const specialistPackages = await composeSpecialistPackages({
    ...settingsBootstrap,
    ...sessionFoundation,
    ...specialistCatalog,
    ...researchCatalog,
    composition
  })
  const sessionSpecialists = composeSessionSpecialists({
    runtimeRef,
    ...sessionFoundation,
    ...sessionAuthority,
    ...sessionProjection,
    ...specialistCatalog
  })
  const agentCompletion = await composeAgentCompletion({
    ...notebookRuntime,
    ...specialistCatalog,
    modules
  })
  const notifications = composeNotifications({
    surfaceAdapters,
    settingsBootstrap,
    storageStartup,
    sessionAuthority,
    headless,
    translate
  })
  const connectors = await composeConnectors({
    ...settingsBootstrap,
    uploadRepository: uploadStorage.uploadRepository,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    runtimeRef,
    ...sessionFoundation,
    ...sessionAuthority,
    ...specialistCatalog,
    notificationsLog: notifications.notificationsLog,
    taskNotifications: notifications.taskNotifications,
    headless,
    modules,
    composition
  })
  const computeServices = composeComputeServices({
    applicationEvents,
    ...settingsBootstrap,
    ...backgroundResults,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    ...projectLifecycle,
    taskNotifications: notifications.taskNotifications
  })
  surfaceAdapters = beforeAcpAdapters
  const computeAdmission = await composeComputeAdmission({
    ...storageStartup,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    ...backgroundResults,
    ...sessionAuthority,
    ...projectLifecycle,
    ...computeServices,
    composition
  })
  const agentControls = composeAgentControls({
    ...settingsBootstrap,
    runtimeRef,
    ...specialistCatalog,
    ...specialistPackages,
    ...sessionSpecialists,
    ...agentCompletion,
    ...connectors,
    getRuntime: () => agentRuntime.runtime
  })
  const delegation = composeDelegation({
    ...settingsBootstrap,
    uploadRepository: uploadStorage.uploadRepository,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    runtimeRef,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    ...projectLifecycle,
    ...notebookRuntime,
    ...specialistCatalog,
    ...sessionSpecialists,
    ...connectors,
    ...computeAdmission,
    mainEntryPath
  })
  const notebookBridge = await composeNotebookBridge({
    managedExecution: managedExecution.internal,
    ...settingsBootstrap,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    runtimeRef,
    ...sessionFoundation,
    ...sessionPackages,
    ...managedFiles,
    ...sessionAuthority,
    ...projectLifecycle,
    ...notebookRuntime,
    ...specialistCatalog,
    ...researchCatalog,
    ...agentCompletion,
    ...connectors,
    ...computeAdmission,
    ...agentControls,
    ...delegation,
    modules,
    composition
  })
  surfaceAdapters.push(
    createConnectorApprovalElectronSurface(
      connectors.approvalBroker,
      connectors.credentialRequestBroker,
      connectors.skillImportApprovalBroker
    )
  )
  const connectorRecovery = composeConnectorRecovery({
    ...settingsBootstrap,
    runtimeRef,
    ...sessionAuthority,
    ...researchCatalog,
    ...connectors,
    ...computeAdmission
  })
  const desktopUtilities = await composeDesktopUtilities({
    surfaceAdapters,
    ...uploadStorage,
    managedFiles,
    sessionAuthority,
    translate
  })
  const agentRuntime = await composeAgentRuntime({
    stopManagedSession: (projectId, sessionId) =>
      managedExecution.stopSession(projectId, sessionId),
    runtimeSessionOwner: managedExecution.runtimeSessions,
    ...settingsBootstrap,
    ...storageStartup,
    uploadRepository: uploadStorage.uploadRepository,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    ...documentReading,
    ...projectLifecycle,
    backendTeardownOwnedByCoordinator,
    ...notebookRuntime,
    ...specialistCatalog,
    ...researchCatalog,
    taskNotifications: notifications.taskNotifications,
    ...connectors,
    ...computeServices,
    ...computeAdmission,
    ...delegation,
    ...notebookBridge,
    ...connectorRecovery,
    mainEntryPath,
    modules
  })
  surfaceAdapters = afterAcpAdapters
  await composeAgentActivation({
    settingsBootstrap,
    runtimeRef,
    backgroundResults,
    sessionFoundation,
    sessionAuthority,
    sessionSpecialists,
    agentRuntime,
    modules,
    composition
  })
  const sideChat = await composeSideChat({
    ...settingsBootstrap,
    ...sessionFoundation,
    ...sessionAuthority,
    ...projectLifecycle,
    ...notebookRuntime,
    ...delegation,
    ...agentRuntime,
    modules,
    composition
  })
  await composeComputeRecovery({
    ...backgroundResults,
    ...sessionProjection,
    ...computeServices,
    ...computeAdmission,
    modules,
    composition
  })
  await composeProjectRecovery({
    declareElectronAdapter,
    applicationEvents,
    ...sessionFoundation,
    ...sessionAuthority,
    ...projectLifecycle,
    ...computeAdmission,
    ...agentRuntime,
    ...sideChat,
    modules
  })
  const agentWorkflows = await composeAgentWorkflows({
    ...settingsBootstrap,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    ...projectLifecycle,
    ...specialistCatalog,
    ...sessionSpecialists,
    ...agentCompletion,
    taskNotifications: notifications.taskNotifications,
    ...delegation,
    ...agentRuntime,
    ...sideChat,
    modules
  })
  const handoff = await composeHandoff({
    managedExecution,
    declareElectronAdapter,
    webSessionPersistenceFlush,
    ...settingsBootstrap,
    ...sessionPackages,
    ...sessionAuthority,
    ...notebookRuntime,
    ...agentRuntime,
    ...sideChat,
    translate,
    confirmRendererDurability,
    notifyRendererDurabilityAborted,
    modules
  })
  const settingsEffects = await composeSettingsEffects({
    surfaceAdapters,
    declareElectronAdapter,
    ...settingsBootstrap,
    ...backgroundResults,
    ...sessionFoundation,
    ...sessionPackages,
    ...sessionAuthority,
    ...projectLifecycle,
    ...notebookRuntime,
    ...researchCatalog,
    ...connectors,
    ...agentRuntime,
    ...sideChat,
    translate,
    onAppIconVariantChanged,
    listAppIconPreviews,
    modules
  })
  const sessionSurfaces = await composeSessionSurfaces({
    surfaceAdapters,
    applicationEvents,
    ...settingsBootstrap,
    ...sessionAuthority,
    ...projectLifecycle,
    ...sessionProjection,
    ...specialistCatalog,
    ...specialistPackages,
    ...sessionSpecialists,
    ...computeAdmission,
    ...agentRuntime,
    translate,
    modules,
    composition
  })
  const notebookSurfaces = await composeNotebookSurfaces({
    surfaceAdapters,
    declareElectronAdapter,
    settingsBootstrap,
    backgroundResults,
    managedFiles,
    notebookRuntime,
    managedPreviewProtocol,
    composition
  })
  const storageHandoff = composeStorageHandoff({
    resumeManagedExecution: () => managedExecution.resume(),
    declareElectronAdapter,
    webSessionPersistenceFlush,
    ...settingsBootstrap,
    ...storageStartup,
    ...sessionPackages,
    ...sessionAuthority,
    ...notebookRuntime,
    ...agentRuntime,
    ...sideChat,
    ...handoff,
    notifyRendererDurabilityAborted
  })
  const artifactSurfaces = composeArtifactSurfaces({
    onArtifactsPublished: async (artifacts) => {
      const scopes = new Map<string, { projectId: string; sessionId: string }>()
      for (const artifact of artifacts) {
        if (!artifact.projectId) continue
        const scope = { projectId: artifact.projectId, sessionId: artifact.sessionId }
        scopes.set(JSON.stringify([scope.projectId, scope.sessionId]), scope)
      }
      await Promise.all(
        [...scopes.values()].map((scope) => managedExecution.reconcilePublishedOutputs(scope))
      )
    },
    surfaceAdapters,
    declareElectronAdapter,
    ...storageStartup,
    managedFileVersionService: uploadStorage.managedFileVersionService,
    ...backgroundResults,
    ...sessionFoundation,
    ...managedFiles,
    ...sessionAuthority,
    ...documentReading,
    ...projectLifecycle,
    ...sessionProjection,
    ...notebookRuntime,
    ...delegation,
    ...agentRuntime,
    ...agentWorkflows,
    ...sessionSurfaces,
    translate
  })
  const sessionPackageSurfaces = composeSessionPackageSurfaces({
    declareElectronAdapter,
    applicationEvents,
    ...sessionFoundation,
    ...sessionPackages,
    ...sessionAuthority,
    ...projectLifecycle,
    ...agentRuntime,
    translate
  })
  await runDataRootStartupRecovery(() => managedExecution.recover(), {
    reportFailure: (error) =>
      createLogger('managed-research-execution').error(
        'Managed execution recovery remains pending',
        diagnosticErrorFields(error)
      )
  })
  surfaceAdapters.push(
    ...createCoreElectronSurfaces({
      permissionGrantProjection: settingsEffects.permissionGrantProjection,
      projectFiles: [
        sessionAuthority.projectFilesRepository,
        sessionAuthority.sessionPersistenceCoordinator,
        projectLifecycle.projectDeletionCoordinator,
        projectLifecycle.projectFilesHandlers
      ],
      managedFileVersionHandlers: projectLifecycle.managedFileVersionHandlers,
      localFsService: managedFiles.localFsService,
      previewStateRepository: sessionPackages.previewStateRepository
    })
  )
  // Compute IPC handlers are registered earlier (before the notebook RPC server) so computeService
  // can be injected into the RPC server for the computeCall route. See above.
  // Wire the reviewer backend into the app lifecycle: installs ipcMainHandle('reviewer:run', ...)
  // and 'reviewer:get-for-session' so the renderer's fire-and-forget reviewer calls resolve to
  // real handlers instead of no-ops. Passing the already-constructed AcpRuntime so the reviewer
  // can spawn sessions under the same agent connection.
  const reviewerCommandOwner = await registerReviewerComposition(modules, {
    applicationEvents,
    modelRuntime: {
      appVersion: app.getVersion(),
      isDataRootHandoffActive: () => isMigrationInProgress() || isMigrationPending(),
      captureModel: () => settingsBootstrap.settingsService.admitReviewerExecutionModel(),
      resolveTarget: (target, context) =>
        settingsBootstrap.settingsService.resolveExplicitAgentBackend(target, context)
    },
    options: {
      acpRuntime: agentRuntime.runtime,
      projectRuntime: sessionAuthority.reviewerProjectRuntime,
      admitSessionWork: (projectId, sessionId) =>
        projectLifecycle.archiveCoordinator.admitSessionWork(projectId, sessionId),
      withProjectAvailable: (projectId, operation) =>
        projectLifecycle.archiveCoordinator.withProjectAvailable(projectId, operation),
      mcpEntryPath: mainEntryPath,
      managedFileVersions: uploadStorage.managedFileVersionService,
      artifactCatalog: sessionAuthority.projectFilesRepository,
      artifactProvenanceRepository: managedFiles.artifactProvenanceRepository,
      resolveSessionAgentTarget: settingsBootstrap.resolveSessionAgentTarget,
      sessionReader: {
        loadSession: (projectId, sessionId) =>
          sessionAuthority.sessionPersistenceCoordinator.readSessionSnapshot(projectId, sessionId),
        findSessionById: async (sessionId) => {
          const projectId =
            await sessionAuthority.sessionPersistenceCoordinator.sessionProjectId(sessionId)
          if (!projectId) return undefined
          return sessionAuthority.sessionPersistenceCoordinator.readSessionSnapshot(
            projectId,
            sessionId
          )
        }
      },
      saveSessionAgentConfiguration: (session, configuration) =>
        sessionAuthority.sessionPersistenceCoordinator.saveSession({
          ...session,
          agentConfiguration: configuration
        }),
      withSessionMutation: (projectId, sessionId, mutation) =>
        sessionAuthority.sessionPersistenceCoordinator.runSessionMutation(
          projectId,
          sessionId,
          mutation
        ),
      recordUsage: sessionFoundation.recordAuxiliaryUsage
    },
    previewResources: managedFiles.previewResources,
    runtimeShutdownOwner: handoff.reviewerModelRuntimeShutdown,
    declareElectronAdapter
  })
  sessionAuthority.reviewerCommandOwnerRef.current = reviewerCommandOwner
  const commandDependencies = composeCommandDependencies({
    applicationEvents,
    readObservationBindings: managedExecution.readObservationBindings,
    settingsBootstrap,
    storageStartup,
    ...uploadStorage,
    runtimeRef,
    sessionFoundation,
    sessionPackages,
    managedFiles,
    sessionAuthority,
    documentReading,
    projectLifecycle,
    notebookRuntime,
    researchCatalog,
    ...notifications,
    connectors,
    computeServices,
    computeAdmission,
    delegation,
    ...desktopUtilities,
    agentRuntime,
    agentWorkflows,
    handoff,
    settingsEffects,
    sessionSurfaces,
    ...notebookSurfaces,
    storageHandoff,
    artifactSurfaces,
    sessionPackageSurfaces,
    reviewerCommandOwner,
    listAppIconPreviews
  })
  await composeBackendLifecycle({
    settingsBootstrap,
    managedFiles,
    sessionAuthority,
    backendTeardownOwnedByCoordinator,
    handoff,
    modules
  })
  const applicationCommandComposition = await registerApplicationCommandComposition({
    modules,
    dependencies: commandDependencies.applicationCommandDependencies,
    declareElectronAdapter
  })
  composition.phase('commands')

  return {
    openSessionPackageFile: (path) => {
      if (path === null) sessionPackageSurfaces.sessionPackageDesktop.reportOpenOverflow()
      else sessionPackageSurfaces.sessionPackageDesktop.enqueueFile(path)
    },
    applicationCommands: {
      localWeb: applicationCommandComposition.localWeb,
      remoteWeb: applicationCommandComposition.remoteWeb,
      task: applicationCommandComposition.task
    },
    applicationEvents,
    permissionApprovalPresence,
    bindRemoteAccess: applicationCommandComposition.bindRemoteAccess,
    taskNotifications: notifications.taskNotifications,
    notificationInbox: storageStartup.notificationInbox,
    settingsService: settingsBootstrap.settingsService,
    commitClosePreference: async (preference) => {
      await settingsBootstrap.settingsSnapshotCommits.currentSnapshotAfter(
        settingsBootstrap.settingsService.setClosePreference(preference)
      )
    },
    taskAgent: agentWorkflows.taskAgent,
    managedExecution: managedExecution.external,
    sessionPackageTransfer: sessionPackageSurfaces.sessionPackageHeadless,
    taskControls: {
      specialists: {
        resolve: (reference) =>
          specialistCatalog.specialistService.resolveRunnableByReference(reference)
      }
    },
    computePreferences: computeAdmission.sessionEnabledComputeHostsOwner,
    sessionDeletionCapability: sessionAuthority.sessionPersistenceCoordinator,
    archiveCapability: projectLifecycle.archiveCoordinator,
    detectActiveSessions: () =>
      detectActiveSessions({
        runtime: {
          getActivePromptSessions: () => agentRuntime.runtime.getQuitBlockingPromptSessions()
        },
        sideChat: { getActivePromptSessions: sessionAuthority.getActiveSideChatSessions },
        delegated: { getActiveDelegatedSessions: sessionAuthority.getActiveDelegatedSessions },
        notebook: notebookRuntime.notebookLifecycle
      }),
    listTrayNavigationSessions: () =>
      withDataRootWrite(async () => {
        let summaries: SessionSummary[]
        try {
          summaries = await sessionFoundation.sessionRepository.loadSessionSummaries()
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Session projection is not ready.')
            throw error
          await sessionProjection.ensureSessionProjection()
          summaries = await sessionFoundation.sessionRepository.loadSessionSummaries()
        }
        const projects = await sessionPackages.projectRepository.list()
        const projectsById = new Map(
          projects
            .filter((project) => project.archivedAt === undefined)
            .map((project) => [project.id, project])
        )
        return summaries.flatMap((summary) => {
          const project = projectsById.get(summary.projectId)
          if (!project || summary.archivedAt !== undefined) return []
          return [
            {
              id: summary.id,
              title: summary.title,
              projectName: project.name,
              updatedAt: summary.updatedAt,
              presentedStatus: summary.presentedStatus,
              pinned: summary.pinned === true
            }
          ]
        })
      }),
    hasActiveReviewerWork: () =>
      handoff.reviewerModelRuntimeShutdown.current?.hasActiveWork() ?? false,
    getActiveSettingsInstallId: () => settingsBootstrap.settingsService.getActiveInstallId(),
    holdSettingsInstallAdmission: () => settingsBootstrap.settingsService.holdInstallAdmission(),
    prepareForQuit: () => agentRuntime.runtime.prepareForQuit(),
    abortQuitPreparation: () => agentRuntime.runtime.abortQuitPreparation(),
    electronAdapters: {
      beforeCompute: beforeComputeAdapters,
      compute: {
        handlers: computeServices.computeIpcModule.handlers,
        enabledHosts: computeAdmission.sessionEnabledComputeHostsOwner
      },
      beforeAcp: beforeAcpAdapters,
      acp: {
        runtime: agentRuntime.runtime,
        workflows: agentWorkflows.acpHandlerWorkflows,
        sessionAdmission: {
          withSessionAvailableById: (sessionId, operation) =>
            projectLifecycle.archiveCoordinator.withSessionAvailableById(sessionId, operation)
        },
        resolveMemoryEnabled: async ({ sessionId }) => {
          const projectId =
            await sessionAuthority.sessionPersistenceCoordinator.sessionProjectId(sessionId)
          if (!projectId) return undefined
          const session = await sessionFoundation.sessionRepository.loadSession(
            projectId,
            sessionId
          )
          return session ? session.memoryEnabled !== false : undefined
        }
      },
      afterAcp: afterAcpAdapters
    }
  }
}
