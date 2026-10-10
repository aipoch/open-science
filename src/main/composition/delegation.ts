import { runtimeMetadata } from '../runtime-metadata'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { parseUploadVersionReference } from '../../shared/uploads'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { createAcpRuntime } from '../acp/runtime-composition'
import {
  shouldPersistSessionAgentConfiguration,
  toSessionAgentConfiguration,
  type SessionAgentTargetResolver
} from '../acp/session-agent-target'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createDefaultArtifactRepository, type ArtifactHandlers } from '../artifacts/ipc'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { finalizeDelegatedArtifactPublication } from '../delegation/delegated-artifact-publication'
import {
  DelegateMessageParkedError,
  DelegateMessagePreAcceptanceError
} from '../delegation/execution-port'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { createProductionDelegatedFrameworkRuntime } from '../delegation/production-framework-runtime'
import { createDelegationSettlementContinuationDispatch } from '../delegation/settlement-continuation-dispatch'
import { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { resolveAvailableShellRuntimeBinding } from '../notebook/configured-shell-runtime'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import { type ReviewerCommandOwner } from '../reviewer/ipc'
import type {
  SessionPersistenceCommands,
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { createSessionRuntimeLookup } from '../session-persistence/runtime-lookup'
import { SettingsService } from '../settings/service'
import { SpecialistService } from '../specialist/service'
import { resolveDataRoot } from '../storage-root'
import { createDefaultUploadRepository } from '../uploads/ipc'

export function composeDelegation({
  getAvailableShellRuntimeBinding,
  settingsService,
  resolveSessionAgentTarget,
  uploadRepository,
  managedFileVersionService,
  runtimeRef,
  sessionRepository,
  artifactRepository,
  artifactProvenanceRepository,
  artifactRunRegistry,
  grantedRootsRepository,
  artifactHandlersRef,
  reviewerCommandOwnerRef,
  permissionGrantRegistry,
  sessionPersistenceCoordinator,
  archiveCoordinator,
  notebookService,
  specialistService,
  findRuntimeSessions,
  conversationSkillImporter,
  dataRoot,
  mainEntryPath
}: {
  getAvailableShellRuntimeBinding: () => Promise<
    Awaited<ReturnType<typeof resolveAvailableShellRuntimeBinding>>
  >
  settingsService: SettingsService
  resolveSessionAgentTarget: SessionAgentTargetResolver
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  artifactRepository: ReturnType<typeof createDefaultArtifactRepository>
  artifactProvenanceRepository: ArtifactProvenanceRepository
  artifactRunRegistry: ArtifactRunRegistry
  grantedRootsRepository: GrantedLocalRootsRepository
  artifactHandlersRef: { current: ArtifactHandlers | undefined }
  reviewerCommandOwnerRef: { current: ReviewerCommandOwner | undefined }
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  sessionPersistenceCoordinator: SessionCatalog &
    SessionMutation &
    SessionRuntimeContextCommands &
    Pick<
      SessionPersistenceCommands,
      | 'acknowledgeUncertainMessage'
      | 'admitMessageCommand'
      | 'admitQuestion'
      | 'applyAgentEvent'
      | 'attachDelegatedMessageArtifacts'
      | 'cancelQuestions'
      | 'completeChildTurn'
      | 'confirmQuestion'
      | 'createChildren'
      | 'readChildren'
      | 'saveSession'
      | 'settleMessage'
      | 'startAttemptRuntime'
      | 'startContinuationAttempt'
      | 'startMessageDispatch'
      | 'startPendingMessageTurn'
      | 'submitStructuredOutput'
      | 'transitionAttempt'
      | 'updateQuestionDraft'
    >
  archiveCoordinator: ArchiveCoordinator
  notebookService: NotebookRuntimeService
  specialistService: SpecialistService
  findRuntimeSessions: ReturnType<typeof createSessionRuntimeLookup>
  conversationSkillImporter: import('../skills/conversation-import').ConversationSkillImporter
  dataRoot: ReturnType<typeof resolveDataRoot>
  mainEntryPath: string
}): {
  notebookRpcServerRef: { current?: NotebookLocalRpcServer }
  delegatedWorkRef: {
    current?: ReturnType<typeof createProductionDelegatedWorkComposition>
  }
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
} {
  const notebookRpcServerRef: { current?: NotebookLocalRpcServer } = {}
  const requireNotebookRpcServer = (): NotebookLocalRpcServer => {
    if (!notebookRpcServerRef.current) throw new Error('Notebook RPC server is not composed yet.')
    return notebookRpcServerRef.current
  }
  const delegatedFrameworks = createProductionDelegatedFrameworkRuntime({
    capacity: 4,
    dataRoot: resolveDataRoot(),
    runtime: {
      appVersion: runtimeMetadata().version,
      mcpEntryPath: mainEntryPath,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      provenanceRepository: artifactProvenanceRepository,
      managedFileVersions: managedFileVersionService,
      uploadRepository,
      canOwnRuntimeBindingDecision: (request) =>
        notebookService.canOwnRuntimeBindingDecision(request),
      peekNotebookHandoffContext: (sessionId) => notebookService.peekHandoffContext(sessionId),
      authorizeSkillImportReferencedUploads: (projectId, sessionId, paths) =>
        conversationSkillImporter.authorizeReferencedUploads(projectId, sessionId, paths),
      settingsService,
      permissionGrantRegistry,
      grantedRootsRepository,
      specialistService,
      sessionPersistenceCoordinator,
      getShellRuntimeBinding: getAvailableShellRuntimeBinding
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
    resolvePermissionPrompts: (sessionId) => runtimeRef.current?.getPermissionPrompts(sessionId),
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
      findSessions: findRuntimeSessions
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
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('ACP runtime is not available.')
        const session = await sessionRepository.loadSession(
          delivery.session.projectId,
          delivery.session.sessionId
        )
        const graph = session?.conversationGraph
        const rootFrame = graph?.frames.find((frame) => frame.id === delivery.targetFrameId)
        const rootBranch = graph?.branches.find((branch) => branch.id === rootFrame?.activeBranchId)
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
              // Suppressed continuations create no user node; replies retain the durable origin.
              promptMessageId: delivery.originMessageId,
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
            const latestRoot = latestGraph?.frames.find(({ id }) => id === delivery.targetFrameId)
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
            const started = await delivery.startDispatch()
            if (started !== 'started') {
              throw new DelegateMessageParkedError(
                'Parent message dispatch fence was not acquired.'
              )
            }
          },
          delivery.messageId,
          delivery.onRootAdmissionQueued,
          (operation) =>
            archiveCoordinator.withProjectDeletionAdmission(delivery.session.projectId, operation)
        )
      }
    }
  })
  return { notebookRpcServerRef, delegatedWorkRef, delegatedWork }
}
