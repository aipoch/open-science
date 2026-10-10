import { runtimeMetadata } from '../runtime-metadata'
import { ImageInputCompatibilityOwner } from '../acp/image-input-compatibility-owner'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { createDefaultArtifactRepository, type ArtifactHandlers } from '../artifacts/ipc'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { bindComputeApprovalSessionLifecycle } from '../compute/approval-session-lifecycle'
import { createComputeIpcModule } from '../compute/ipc'
import { waitForInitialConnectorRefresh } from '../connector-reload'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { AgentPdfAcquisition } from '../literature/agent-pdf-acquisition'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { LiteratureCatalog } from '../literature/catalog'
import { LiteratureDocumentReader } from '../literature/document-reader'
import { PdfElementAgentReader } from '../literature/pdf-structure/agent-reader'
import { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { MemoryService } from '../memory/service'
import { resolveAvailableShellRuntimeBinding } from '../notebook/configured-shell-runtime'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createNotificationInboxController } from '../notifications/notification-inbox-controller'
import { TaskNotificationService } from '../notifications/task-notifications'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { type SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import type {
  SessionPersistenceCommands,
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import { MainMessageAttributionAuthority } from '../session-persistence/message-attribution-authority'
import { SettingsService } from '../settings/service'
import { createMainPromptSideChatRelay } from '../side-chat/main-prompt-relay'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { SpecialistService } from '../specialist/service'
import { createDefaultUploadRepository } from '../uploads/ipc'
import { WslSetupSessionOwner } from '../wsl/wsl-setup-session-owner'

export async function composeAgentRuntime({
  wslSetupSessions,
  getAvailableShellRuntimeBinding,
  settingsService,
  notificationInbox,
  uploadRepository,
  managedFileVersionService,
  sideChatOwnerRef,
  recordAuxiliaryUsage,
  artifactRepository,
  artifactProvenanceRepository,
  literatureAttachmentAuthority,
  artifactRunRegistry,
  grantedRootsRepository,
  artifactHandlersRef,
  messageAttributionAuthority,
  permissionGrantRegistry,
  artifactReproducibilityAttemptOwnerRef,
  sessionPersistenceCoordinator,
  runtimeSessionOwner,
  stopManagedSession,
  pdfElementReader,
  literatureDocumentReader,
  mainPromptSideChatRelay,
  backendTeardownOwnedByCoordinator,
  notebookService,
  specialistService,
  memoryService,
  literatureCatalog,
  literaturePdfAcquisition,
  taskNotifications,
  conversationSkillImporter,
  credentialRequestBroker,
  skillImportApprovalBroker,
  computeIpcModule,
  hostsRegistry,
  delegatedWork,
  notebookRpcServer,
  imageInputCompatibility,
  initialConnectorSkillsReady,
  mainEntryPath,
  modules
}: {
  wslSetupSessions: WslSetupSessionOwner
  getAvailableShellRuntimeBinding: () => Promise<
    Awaited<ReturnType<typeof resolveAvailableShellRuntimeBinding>>
  >
  settingsService: SettingsService
  notificationInbox: ReturnType<typeof createNotificationInboxController>
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
  sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined }
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  artifactRepository: ReturnType<typeof createDefaultArtifactRepository>
  artifactProvenanceRepository: ArtifactProvenanceRepository
  literatureAttachmentAuthority: LiteratureAttachmentAuthority
  artifactRunRegistry: ArtifactRunRegistry
  grantedRootsRepository: GrantedLocalRootsRepository
  artifactHandlersRef: { current: ArtifactHandlers | undefined }
  messageAttributionAuthority: MainMessageAttributionAuthority
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  }
  sessionPersistenceCoordinator: SessionCatalog &
    SessionMutation &
    SessionRuntimeContextCommands &
    Pick<SessionPersistenceCommands, 'sessionProjectId'>
  runtimeSessionOwner?: import('../session-persistence/runtime-session-owner').RuntimeSessionOwner
  stopManagedSession?: (projectId: string, sessionId: string) => Promise<void>
  pdfElementReader: PdfElementAgentReader
  literatureDocumentReader: LiteratureDocumentReader
  mainPromptSideChatRelay: ReturnType<typeof createMainPromptSideChatRelay>
  backendTeardownOwnedByCoordinator: { current: boolean }
  notebookService: NotebookRuntimeService
  specialistService: SpecialistService
  memoryService: MemoryService
  literatureCatalog: LiteratureCatalog
  literaturePdfAcquisition: AgentPdfAcquisition
  taskNotifications: TaskNotificationService
  conversationSkillImporter: import('../skills/conversation-import').ConversationSkillImporter
  credentialRequestBroker: import('../connectors/credential-request-broker').CredentialRequestBroker
  skillImportApprovalBroker: import('../skills/conversation-import').SkillImportApprovalBroker
  computeIpcModule: ReturnType<typeof createComputeIpcModule>
  hostsRegistry: import('../compute/enabled-hosts-registry').EnabledComputeHostsRegistry
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
  notebookRpcServer: NotebookLocalRpcServer
  imageInputCompatibility: ImageInputCompatibilityOwner
  initialConnectorSkillsReady: ReturnType<typeof waitForInitialConnectorRefresh>
  mainEntryPath: string
  modules: ApplicationModuleBuilder
}): Promise<{ runtime: ReturnType<typeof createAcpRuntime> }> {
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
      appVersion: runtimeMetadata().version,
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      managedFileVersions: managedFileVersionService,
      uploadRepository,
      notebookRpcServer,
      wslSetupSessions,
      getShellRuntimeBinding: getAvailableShellRuntimeBinding,
      canOwnRuntimeBindingDecision: (request) =>
        notebookService.canOwnRuntimeBindingDecision(request),
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
        if (projectId) await stopManagedSession?.(projectId, sessionId)
        const operation = async (): Promise<void> => {
          await notebookService.shutdownSession(sessionId)
          if (projectId) await notebookService.deleteSessionInputs(projectId, sessionId)
        }
        const owner = artifactReproducibilityAttemptOwnerRef.current
        if (projectId && owner) await owner.withSessionStopped(projectId, sessionId, operation)
        else await operation()
      },
      afterSessionDelete: (sessionId, retained) =>
        computeIpcModule.handlers.approvalFinishSessionDeletion(sessionId, retained),
      initializationBarrier: initialConnectorSkillsReady,
      specialistService,
      sessionPersistenceCoordinator,
      runtimeSessionOwner,
      finalizeRuntimeArtifacts: async (request) => {
        const handlers = artifactHandlersRef.current
        if (!handlers) throw new Error('Artifact finalization is not initialized.')
        return handlers.finalizeRunArtifacts(request)
      },
      literatureReader: literatureDocumentReader,
      pdfElementReader,
      literatureAttachments: literatureAttachmentAuthority,
      literatureCatalog,
      literaturePdfAcquisition,
      delegatedWork: delegatedWork.root,
      sideChatRelays: mainPromptSideChatRelay,
      hasPendingCredentialRequest: (sessionId) =>
        credentialRequestBroker.hasPendingForSession(sessionId),
      imageInputCompatibility,
      memory: memoryService,
      classifySkills: settingsService.classification.selectSkills,
      classifyReadingRoute: settingsService.classification.selectReadingRoute,
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
          backendTeardownOwnedByCoordinator.current
            ? undefined
            : runtime.shutdownForQuit().then(() => undefined)
      }
    }
  )
  return { runtime }
}
