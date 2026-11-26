import { subscribeWebBranchChanges } from '../web/evidence-lifecycle'
import { WebInvocationOwner } from '../web/invocation-owner'
import {
  getWebInvocationStore,
  type WebInvocationBinding,
  type WebInvocationScope
} from '../web/invocation-store'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { sanitizeRawToolPayload, sanitizeToolContent } from '../../shared/tool-detail-sanitizer'
import { SearchService } from '../web/search-service'
import { WebSessionSlots } from '../web/limits'
import { WebService } from '../web/service'
import { getWebSnapshotStore } from '../web/snapshot-store'
import { WebEvidenceLifecycle } from '../web/evidence-lifecycle'
import { WebRuntimeEvidence } from '../web/runtime-evidence'
import type { PdfAnnotationAgentTools } from '../pdf-annotations/agent-tools'
import type { SandboxNetworkApprovalOwner } from './sandbox-network-approval-owner'
import { AuthorizedDirectoryNotices } from '../local-fs/authorized-directories'
import { createLogger, diagnosticErrorFields, errorLogFields } from '@aipoch/diagnostics/node'
import { LiteratureCitationFormatter } from '@aipoch/literature-citations'
import { LiteratureLatexBundle } from '@aipoch/literature-citations/documents'
import { LiteratureReferenceResolver } from '@aipoch/literature-discovery'
import type {
  LiteratureCatalogReceipt,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import { resolveEffectiveSpecialistSkills } from '@aipoch/specialists'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AcpRuntimeEvent, AcpStateUpdate } from '../../shared/acp'
import type { AcpPermissionRequest } from '../../shared/acp-permission-contract'
import { SPECIALIST_CAPABILITY_READ_FAILED_MESSAGE } from '../../shared/failure/messages'
import { DEFAULT_ARTIFACT_PROJECT_ID, type ArtifactFile } from '../../shared/artifacts'
import {
  resolveActiveConversationMessages,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import {
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import type { ShellRuntimeBinding } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings-runtime'
import { filterSpecialistConnectorSkills } from '../../shared/specialist'
import { imageAttachmentMimeType } from '../../shared/uploads'
import type { ResolvedAgentBackend } from '../agent-framework'
import { codeBuddyStorageDir } from '../agent-framework/codebuddy'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { opencodeStorageDir } from '../agent-framework/opencode'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { resolveAllowedImportFilePath } from '../artifacts/storage-access'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import type { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import type { LiteratureCatalog } from '../literature/catalog'
import { LiteratureCitationDocument } from '../literature/citation-document'
import type { LiteratureDocumentReader } from '../literature/document-reader'
import { LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT } from '../literature/library-mcp-contract'
import type { LiteratureLibraryScope } from '../literature/library-mcp-contract'
import type { PdfElementTools } from '../literature/pdf-structure/agent-reader'
import type { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { netFetchStandard } from '../network-fetch'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import { getNotebookSessionRoot } from '../notebook/repository'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import type { NotificationInboxController } from '../notifications/notification-inbox-controller'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { getProjectDbClient } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import type {
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { SessionReplayRepository } from '../session-replay/repository'
import { SessionReadingOwner } from '../session-replay/session-reading'
import { CodexTransportFallbackLogObserver } from '../settings/codex-transport-fallback-log'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import type { SpecialistService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { UploadRepository } from '../uploads/repository'
import { AgentMcpHttpHost } from './mcp-http-host'
import { projectRegistrySessionGrants } from './permission-broker'
import { AcpRuntime } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeCallbacks, AcpRuntimeOptions } from './runtime-contract'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { createAcpRuntimeEventBroadcastCoalescer } from './runtime-event-broadcast-coalescer'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

const log = createLogger('acp')
const MAX_LITERATURE_CANDIDATE_FILE_BYTES = 2 * 1024 * 1024
const MAX_LITERATURE_CITATION_DOCUMENT_BYTES = 64 * 1024 * 1024

// Builds the session-setup resolver for a project's Agent Context system-prompt append. The ACP
// projectId carries the Project id; unknown ids (e.g. the DEFAULT_ARTIFACT_PROJECT_ID fallback
// namespace) and blank contexts yield undefined. Lookup failures stay fatal so a Session cannot
// silently start without a configured policy boundary.
const createProjectAgentContextResolver = (repository: {
  get: (id: string) => Promise<{ agentContext?: string } | null>
}): ((projectId: string) => Promise<string | undefined>) => {
  return async (projectId) => {
    try {
      const project = await repository.get(projectId)
      const context = project?.agentContext?.trim()
      return context ? context : undefined
    } catch (error) {
      log.warn('project Agent Context lookup failed', errorLogFields(error))
      throw new Error(
        'Project Agent Context could not be loaded. Retry after Project storage recovers.'
      )
    }
  }
}

const sessionHasReplayableImageHistory = (
  session: Pick<PersistedChatSession, 'messages' | 'conversationGraph'>
): boolean => {
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  return messages.some(
    (message) =>
      (message.images?.length ?? 0) > 0 ||
      (message.uploads ?? []).some((upload) =>
        Boolean(imageAttachmentMimeType(upload.name, upload.mimeType))
      )
  )
}

type AcpRuntimeArtifacts = {
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  provenanceRepository?: Pick<
    ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  >
}

type AcpRuntimeCompositionOptions = AcpRuntimeArtifacts & {
  schedules?: import('../schedules/mcp').ScheduleMcp
  appVersion: string
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  wslSetupSessions?: AcpRuntimeOptions['wslSetupSessions']
  getShellRuntimeBinding?: () => ShellRuntimeBinding | Promise<ShellRuntimeBinding>
  bindTaskNotebookRuntime?: NonNullable<AcpRuntimeOptions['notebook']>['bindTaskRuntime']
  canOwnRuntimeBindingDecision?: NonNullable<
    AcpRuntimeOptions['notebook']
  >['canOwnRuntimeBindingDecision']
  peekNotebookHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
  isReplNamespaceUnavailable?: NonNullable<
    AcpRuntimeOptions['notebook']
  >['isReplNamespaceUnavailable']
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  settingsService: AcpSettingsCapabilities
  // The SQLite-backed granted-roots store ("Grant folder access"); the linked-folder file-reference
  // resolver reads it fresh per resolution. Absent only in tests — linked-folder references then
  // fail closed (no root resolves).
  grantedRootsRepository?: Pick<GrantedLocalRootsRepository, 'list'> &
    Partial<Pick<GrantedLocalRootsRepository, 'authorizedSnapshot'>>
  permissionGrantRegistry?: PermissionGrantRegistry
  permissionGrantContext?: Readonly<{ projectId: string; sessionId: string }>
  initializationBarrier?: Promise<unknown>
  taskNotifications?: TaskNotificationService
  notificationInbox?: Pick<
    NotificationInboxController,
    'record' | 'settleAction' | 'settleAuthorization'
  >
  managedFileVersions: Pick<
    import('../managed-file-versions/service').ManagedFileVersionService,
    'openLatest' | 'openVersion' | 'openUnpublishedVersion'
  >
  pptxAgent?: import('../pptx-edit/agent-handler').PptxAgentHandler
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onTrustedMessageAttribution?: (projectId: string, event: AcpRuntimeEvent) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  onDisconnected?: () => void
  onSessionDeleteStarted?: (sessionId: string) => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  afterSessionDelete?: (sessionId: string, retained: boolean) => void
  specialistService?: SpecialistService
  sandboxNetworkApprovalOwner?: SandboxNetworkApprovalOwner
  sessionPersistenceCoordinator?: SessionRuntimeContextCommands &
    SessionMutation &
    SessionCatalog &
    Partial<
      Pick<
        import('../session-persistence/coordinator').SessionPersistenceCommands,
        'recordRuntimeTerminalFailure'
      >
    >
  finalizeRuntimeArtifacts?: (request: {
    claimId: string
    messageId: string
  }) => Promise<ArtifactFile[]>
  literatureReader?: Pick<LiteratureDocumentReader, 'readCurrent' | 'searchAttachment'>
  pdfAnnotationAgent?: PdfAnnotationAgentTools
  pdfElementReader?: PdfElementTools
  literatureAttachments?: Pick<LiteratureAttachmentAuthority, 'resolveVersion'>
  literatureCatalog?: Pick<LiteratureCatalog, 'getMany' | 'searchForAgent' | 'transact'>
  literaturePdfAcquisition?: Pick<
    import('../literature/agent-pdf-acquisition').AgentPdfAcquisition,
    'acquire'
  >
  delegatedWork?: RootDelegatedWorkControl
  fixedBackend?: ResolvedAgentBackend
  runtimeCallbacks?: AcpRuntimeCallbacks
  preparedSkills?: Awaited<
    ReturnType<NonNullable<AcpSettingsCapabilities['prepareDelegatedSkills']>>
  >
  delegatedNotebookConnection?: NotebookRpcConnection & {
    refreshExecutionIntent?(
      intent: import('../notebook/execution-intent').NotebookExecutionIntent
    ): Promise<NotebookRpcConnection>
  }
  // Disposable delegated framework homes contain copied authentication and Skill material.
  // Keep the per-attempt home protected even when a parent data directory is granted.
  delegatedRuntimeHome?: string
  delegatedArtifactCurrentRunFile?: string
  spawnAgent?: () => ChildProcessWithoutNullStreams
  spawnProcess?: AcpRuntimeOptions['spawnProcess']
  registerOpenCodeStoreRelease?: AcpRuntimeOptions['registerOpenCodeStoreRelease']
  hasPendingCredentialRequest?: AcpRuntimeOptions['hasPendingCredentialRequest']
  sideChatRelays?: AcpRuntimeOptions['sideChatRelays']
  imageInputCompatibility?: AcpRuntimeOptions['imageInputCompatibility']
  resolveComputeExecutionTargetIds?: AcpRuntimeOptions['resolveComputeExecutionTargetIds']
  memory?: AcpRuntimeOptions['memory']
  auxiliaryUsage?: AcpRuntimeOptions['auxiliaryUsage']
  classifySkills?: AcpRuntimeOptions['classifySkills']
  classifyReadingRoute?: AcpRuntimeOptions['classifyReadingRoute']
}

const isLiteratureItemInScope = (
  item: LiteratureItemView,
  request: {
    projectId: string
    scope?: LiteratureLibraryScope
    collectionId?: string
  }
): boolean => {
  const scope = request.scope ?? 'project'
  if (scope === 'project') return item.projectIds.includes(request.projectId)
  if (scope === 'collection') {
    return Boolean(request.collectionId && item.collectionIds.includes(request.collectionId))
  }
  // Library scopes are per-call query filters, not grants derived from a previous search.
  // For `items`, the read's explicit itemId is the selection; no search-selection token exists.
  // The separate Reading document tool enforces its Session PDF context in readCurrent.
  return scope === 'library' || scope === 'items'
}

const isPdfAttachmentVersion = (version: { filename: string; contentType: string }): boolean =>
  version.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
  version.filename.toLowerCase().endsWith('.pdf')

// Composes the compatibility façade while the coordinator remains the cross-generation Session owner.
const createAcpRuntime = ({
  schedules,
  appVersion,
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  managedFileVersions,
  pptxAgent,
  uploadRepository,
  notebookRpcServer,
  wslSetupSessions,
  getShellRuntimeBinding,
  canOwnRuntimeBindingDecision,
  bindTaskNotebookRuntime,
  peekNotebookHandoffContext,
  isReplNamespaceUnavailable,
  authorizeSkillImportReferencedUploads,
  settingsService,
  grantedRootsRepository,
  permissionGrantRegistry,
  permissionGrantContext,
  initializationBarrier,
  taskNotifications,
  notificationInbox,
  onSessionTurnStarted,
  onSessionTurnEnded,
  onSkillImportAttachmentEligible,
  onTrustedMessageAttribution,
  onSessionCancellationRequested,
  onSessionUnavailable,
  onAllSessionsCancellationRequested,
  onDisconnected,
  onSessionDeleteStarted,
  beforeSessionDelete,
  afterSessionDelete,
  specialistService,
  sessionPersistenceCoordinator,
  sandboxNetworkApprovalOwner,
  finalizeRuntimeArtifacts,
  literatureReader,
  pdfElementReader,
  pdfAnnotationAgent,
  literatureAttachments,
  literatureCatalog,
  literaturePdfAcquisition,
  delegatedWork,
  fixedBackend,
  runtimeCallbacks,
  preparedSkills,
  delegatedNotebookConnection,
  delegatedRuntimeHome,
  delegatedArtifactCurrentRunFile,
  spawnAgent,
  spawnProcess,
  registerOpenCodeStoreRelease,
  sideChatRelays,
  hasPendingCredentialRequest,
  imageInputCompatibility,
  resolveComputeExecutionTargetIds,
  memory,
  classifySkills,
  classifyReadingRoute,
  auxiliaryUsage
}: AcpRuntimeCompositionOptions): AcpRuntimeCoordinator => {
  const literatureReferenceResolver = new LiteratureReferenceResolver(netFetchStandard)
  const literatureCitationDocument = literatureCatalog
    ? new LiteratureCitationDocument(literatureCatalog)
    : undefined
  const literatureLatexBundle = literatureCatalog
    ? new LiteratureLatexBundle(literatureCatalog)
    : undefined
  const literatureCitationFormatter = literatureCatalog
    ? new LiteratureCitationFormatter()
    : undefined
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const webSessionSlots = new WebSessionSlots()
  const webSnapshots = getWebSnapshotStore(join(dataRoot, 'web-evidence'))
  const webSearchService = new SearchService({ sessionSlots: webSessionSlots })
  const webService = new WebService({
    sessionSlots: webSessionSlots,
    store: webSnapshots
  })
  const webEvidenceLifecycle = new WebEvidenceLifecycle(
    webSnapshots,
    async (projectId, sessionId) =>
      sessionPersistenceCoordinator?.loadSessionForContinuation(projectId, sessionId)
  )
  const webRuntimeEvidence = new WebRuntimeEvidence({
    service: webService,
    loadSession: ({ projectId, sessionId }) => {
      if (!sessionPersistenceCoordinator)
        throw new Error('Web execution requires durable Session authority')
      return sessionPersistenceCoordinator.loadSessionForContinuation(projectId, sessionId)
    },
    ensureBranchOwnership: (session, branchId) =>
      webEvidenceLifecycle.ensureBranchOwnership(session, branchId)
  })
  const readWebScope = async (binding: WebInvocationBinding): Promise<WebInvocationScope> => {
    if (!sessionPersistenceCoordinator)
      throw new Error('Web execution requires durable Session authority')
    const session = await sessionPersistenceCoordinator.loadSessionForContinuation(
      binding.projectId,
      binding.sessionId
    )
    if (session.packageOrigin) throw new Error('Imported Sessions cannot execute Web tools')
    const graph = session.conversationGraph
    const frame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
    if (!graph || !frame || frame.kind !== 'root')
      throw new Error('Web execution requires the active primary Session branch')
    const path = resolveMessageBranchPath(graph, frame.activeBranchId)
    const prompt = path.findLast((message) => message.role === 'user')
    if (!prompt?.runtimeSegmentId) throw new Error('Web execution has no durable prompt scope')
    return {
      ...binding,
      branchId: frame.activeBranchId,
      promptMessageId: prompt.id,
      agentFrameId: frame.id,
      runtimeSegmentId: prompt.runtimeSegmentId
    }
  }
  let publishWebEvent: (event: AcpRuntimeEvent) => void = () => undefined
  const webInvocations = new WebInvocationOwner({
    store: getWebInvocationStore(join(dataRoot, 'web-invocations')),
    scope: readWebScope,
    publishSnapshot: (scope, snapshotId, authorize) =>
      webRuntimeEvidence.commit(scope, snapshotId, authorize),
    execute: (scope, operation, input, context) =>
      operation === 'search'
        ? webSearchService.search(scope.sessionId, input, {
            ...context,
            sessionSlotKey: JSON.stringify([scope.projectId, scope.sessionId])
          })
        : webRuntimeEvidence.fetch(scope, input, context),
    publish: async (record, status, result, disposition) => {
      const event: AcpRuntimeEvent = {
        id: randomUUID(),
        kind: 'tool',
        level: 'info',
        timestamp: Date.now(),
        sessionId: record.sessionId,
        promptMessageId: record.promptMessageId,
        agentFrameId: record.agentFrameId,
        messageBranchId: record.branchId,
        ...(status === 'in_progress' ? {} : { publicationOwner: 'main' as const }),
        appOwned: true,
        executionInvocationId: record.invocationId,
        toolCallId: record.invocationId,
        title: `mcp__open_science_web__web_${record.operation}`,
        providerToolName: `mcp__open_science_web__web_${record.operation}`,
        toolKind: record.operation === 'search' ? 'search' : 'fetch',
        status,
        webInvocation: webInvocations.metadataFor(record, record.invocationId) ?? {
          attempt: record.attempt,
          configGeneration: record.configGeneration
        },
        rawInput: sanitizeRawToolPayload(record.input, 8000),
        ...(disposition ? { toolDisposition: disposition } : {}),
        ...(result
          ? {
              toolContent: sanitizeToolContent([
                { type: 'content', content: { type: 'text', text: JSON.stringify(result) } }
              ]) as AcpRuntimeEvent['toolContent']
            }
          : {})
      }
      if (status === 'in_progress') {
        // The Web invocation journal already owns attempt history. The harness publishes the
        // final tool event after the receipt commits, including the journaled attempt metadata.
        // Live progress must stay off the Session queue used for authority and receipt checks.
        return publishWebEvent(event)
      }
      await sessionPersistenceCoordinator!.mutateRuntimeSession(record, (session) => {
        const graph = session.conversationGraph
        const frame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
        if (
          session.packageOrigin ||
          (!disposition &&
            (frame?.id !== record.agentFrameId || frame.activeBranchId !== record.branchId))
        )
          throw new Error('Web tool Session branch changed before publication')
        return applyRuntimeSessionEvents(
          session,
          {
            promptMessageId: record.promptMessageId,
            agentFrameId: record.agentFrameId,
            messageBranchId: record.branchId,
            runtimeSegmentId: record.runtimeSegmentId
          },
          [event]
        )
      })
      return publishWebEvent(event)
    }
  })
  const webControlsRef = new WeakRef(webInvocations)
  const unsubscribeWebBranches = subscribeWebBranchChanges((change) => {
    const controls = webControlsRef.deref()
    if (controls) controls.branchChanged(change, change.branchId)
    else unsubscribeWebBranches()
  })
  const defaultCwd = homedir()
  const delegatedProtectedReadRoots = [
    delegatedRuntimeHome,
    getAppClaudeConfigDir(configRoot),
    opencodeStorageDir(configRoot),
    codexStorageDir(configRoot),
    codexSubscriptionStorageDir(configRoot),
    codeBuddyStorageDir(configRoot)
  ].filter((path): path is string => Boolean(path))
  const runtimeCoordinatorRef: { current?: AcpRuntimeCoordinator } = {}
  // One lazily-shared repository for Agent Context lookups; getProjectDbClient caches the client.
  const projectRepository = new ProjectRepository(
    () => getProjectDbClient(resolveConfigRoot()),
    configRoot
  )
  const runtimeSessionOwner =
    !delegatedNotebookConnection && sessionPersistenceCoordinator && finalizeRuntimeArtifacts
      ? new RuntimeSessionOwner({
          loadSession: (scope) =>
            sessionPersistenceCoordinator.loadSessionForContinuation(
              scope.projectId,
              scope.sessionId
            ),
          mutateSession: (scope, mutate, options) =>
            sessionPersistenceCoordinator.mutateRuntimeSession(scope, mutate, options),
          finalizeArtifacts: finalizeRuntimeArtifacts,
          onTerminalCommitExhausted: (_scope, event, retry, waitForWriteRelease) =>
            sessionPersistenceCoordinator.recordRuntimeTerminalFailure?.(
              event,
              retry,
              waitForWriteRelease
            )
        })
      : undefined
  const eventBroadcast = createAcpRuntimeEventBroadcastCoalescer({
    publish: (events) => broadcastToRenderers('acp:event', events)
  })
  const defaultCallbacks: AcpRuntimeCallbacks = {
    onStateChanged: (state: AcpStateUpdate) => broadcastToRenderers('acp:state', state),
    onEvent: (event: AcpRuntimeEvent) => {
      const projectId = event.sessionId
        ? runtimeCoordinatorRef.current?.liveSessionProjectId(event.sessionId)
        : undefined
      if (event.attribution && projectId) onTrustedMessageAttribution?.(projectId, event)
      eventBroadcast.enqueue(event)
      // Fire-and-forget: a notification hiccup must never stall the renderer event stream.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handleRuntimeEvent(event),
          (error) => log.warn('task notification event failed', errorLogFields(error))
        )
      }
    },
    onPermissionRequest: (request: AcpPermissionRequest) => {
      broadcastToRenderers('acp:permission-request', request)
      // A pending approval parks the turn; an unfocused user gets a desktop nudge.
      if (taskNotifications) {
        runTaskNotificationInBackground(
          () => taskNotifications.handlePermissionRequest(request),
          (error) => log.warn('permission notification failed', errorLogFields(error))
        )
      }
    },
    onPermissionSettled: (requestId, state) => {
      if (!notificationInbox) return
      runTaskNotificationInBackground(
        () => notificationInbox.settleAuthorization('agent-tool', requestId, state),
        (error) => log.warn('permission inbox settlement failed', errorLogFields(error))
      )
    }
  }
  const clientCallbacks = runtimeCallbacks ?? defaultCallbacks
  const codexTransportFallbackLog = new CodexTransportFallbackLogObserver()
  const rememberCodexHttps = (): void => {
    void settingsService
      .rememberCodexAutoHttpsFallback()
      .then((remembered) =>
        remembered
          ? runtimeCoordinatorRef.current?.requestProviderReconnect(
              [CODEX_SUBSCRIPTION_PROVIDER_ID],
              true
            )
          : undefined
      )
      .catch((error) =>
        log.warn('Codex automatic transport memory update failed', errorLogFields(error))
      )
  }
  const callbacks: AcpRuntimeCallbacks = {
    ...clientCallbacks,
    onEvent: (incoming) => {
      let event = incoming
      const projectId = event.sessionId
        ? runtimeCoordinatorRef.current?.liveSessionProjectId(event.sessionId)
        : undefined
      const invocationId = event.executionInvocationId ?? event.toolCallId
      const metadata =
        event.appOwned && event.sessionId && invocationId && projectId
          ? webInvocations.metadataFor({ projectId, sessionId: event.sessionId }, invocationId)
          : undefined
      if (metadata) {
        const disposition = webInvocations.dispositionFor(
          { projectId: projectId!, sessionId: event.sessionId! },
          invocationId!
        )
        event = {
          ...event,
          webInvocation: metadata,
          executionInvocationId: invocationId,
          ...(disposition ? { status: 'completed' as const, toolDisposition: disposition } : {})
        }
      }
      runtimeSessionOwner?.accept(event)
      clientCallbacks.onEvent?.(event)
    },
    onPromptStarted: (sessionId, turnToken, promptAttemptId) => {
      codexTransportFallbackLog.begin(
        sessionId,
        runtimeCoordinatorRef.current?.captureSessionBackend(sessionId)
      )
      clientCallbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId)
    },
    onPromptEnded: (sessionId, turnToken) => {
      if (codexTransportFallbackLog.end(sessionId)) rememberCodexHttps()
      clientCallbacks.onPromptEnded?.(sessionId, turnToken)
    },
    // Retain compatibility with adapters that explicitly publish this diagnostic on stderr.
    onCodexWebSocketFallback: () => {
      rememberCodexHttps()
      clientCallbacks.onCodexWebSocketFallback?.()
    }
  }

  publishWebEvent = (event) =>
    event.publicationOwner === 'main'
      ? callbacks.onEvent?.(event)
      : clientCallbacks.onEvent?.(event)

  const runtimeCoordinator = new AcpRuntimeCoordinator(
    (runtimeCallbacks, permissionGrantStore, target) => {
      const selection = fixedBackend
        ? undefined
        : target
          ? undefined
          : settingsService.captureActiveAgentBackendSelection()
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion,
        trackTaskContinuation: (identity, send) =>
          runtimeCoordinator.trackTaskContinuation(identity, send),
        auxiliaryUsage,
        classifySkills: delegatedNotebookConnection ? undefined : classifySkills,
        classifyReadingRoute: delegatedNotebookConnection ? undefined : classifyReadingRoute,
        ...(runtimeSessionOwner ? { runtimeSessions: runtimeSessionOwner } : {}),
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
        ...(delegatedNotebookConnection && fixedBackend?.framework.id === 'opencode'
          ? {
              additionalProtectedReadRoots: [
                ...delegatedProtectedReadRoots,
                fixedBackend.env.XDG_CONFIG_HOME,
                fixedBackend.env.XDG_DATA_HOME,
                fixedBackend.env.XDG_CACHE_HOME,
                fixedBackend.env.XDG_STATE_HOME,
                fixedBackend.env.OPENCODE_TEST_HOME
              ].filter((path): path is string => Boolean(path))
            }
          : {}),
        ...(delegatedNotebookConnection && fixedBackend?.framework.id !== 'opencode'
          ? { additionalProtectedReadRoots: delegatedProtectedReadRoots }
          : {}),
        resolveBackend: async (context) =>
          fixedBackend ??
          (target
            ? settingsService.resolveExplicitAgentBackend(
                {
                  frameworkId: target.frameworkId,
                  providerId: target.providerId,
                  model: target.model
                    ? { kind: 'required', id: target.model }
                    : { kind: 'provider-default' },
                  reasoningEffort: target.reasoningEffort
                },
                context
              )
            : settingsService.resolveAgentBackend(await selection!, context)),
        ...(spawnAgent ? { spawnAgent } : {}),
        ...(spawnProcess ? { spawnProcess } : {}),
        ...(registerOpenCodeStoreRelease ? { registerOpenCodeStoreRelease } : {}),
        web: delegatedNotebookConnection
          ? undefined
          : {
              cancelSession: (sessionId) => webInvocations.cancelSession(sessionId),
              handlerFor: (sessionId, projectId) => ({
                search: (input, context) =>
                  webInvocations.execute({ projectId, sessionId }, 'search', input, context),
                fetchPage: (input, context) =>
                  webInvocations.execute({ projectId, sessionId }, 'fetch', input, context),
                reconcileResult: (query) =>
                  webInvocations.reconcileResult({ projectId, sessionId }, query),
                cancelUndispatched: (query) =>
                  webInvocations.cancelUndispatched({ projectId, sessionId }, query),
                receiptSignal: (id) => webInvocations.receiptSignal({ projectId, sessionId }, id),
                receiptCommitted: (result) =>
                  webInvocations.receiptCommitted({ projectId, sessionId }, result)
              })
            },
        schedules: delegatedNotebookConnection ? undefined : schedules,
        mcpHttpHost: new AgentMcpHttpHost({
          receiptDirectory: join(dataRoot, 'open-science-agent', 'tool-receipts')
        }),
        wslSetupSessions,
        ...(pptxAgent ? { pptx: { agent: pptxAgent } } : {}),
        ...(literatureReader && literatureAttachments && sessionPersistenceCoordinator
          ? {
              literature: {
                isEnabled: async (appSessionId: string, projectId: string) => {
                  try {
                    return Boolean(
                      (
                        await sessionPersistenceCoordinator.readSessionRuntimeContext(
                          projectId,
                          appSessionId
                        )
                      ).pdfContext
                    )
                  } catch {
                    return false
                  }
                },
                resolveAttachmentVersion: (versionId) =>
                  literatureAttachments.resolveVersion(versionId),
                readDocument: (request) => literatureReader.readCurrent(request),
                ...(pdfElementReader ? { elements: pdfElementReader } : {}),
                ...(pdfAnnotationAgent ? { annotations: pdfAnnotationAgent } : {})
              }
            }
          : {}),
        ...(literatureCatalog
          ? {
              literatureLibrary: {
                ...(literaturePdfAcquisition
                  ? {
                      acquirePdf: async (request) =>
                        literaturePdfAcquisition.acquire({
                          candidate: request.candidate,
                          pdfUrl: request.pdfUrl,
                          signal: request.signal,
                          origin: {
                            kind: 'agent',
                            projectId: request.projectId,
                            sessionId: request.sessionId
                          }
                        })
                    }
                  : {}),
                resolveSaveReferences: (references, signal) =>
                  literatureReferenceResolver.resolve(references, signal),
                readCandidateFile: async ({
                  projectId,
                  sessionId,
                  workspaceCwd,
                  filename,
                  signal
                }) => {
                  signal?.throwIfAborted()
                  const notebookRoot = getNotebookSessionRoot(dataRoot, projectId, sessionId)
                  const notebookDataDir = join(notebookRoot, 'data')
                  const sourcePath = await resolveAllowedImportFilePath(
                    filename,
                    [notebookRoot, workspaceCwd],
                    [notebookDataDir, workspaceCwd, notebookRoot],
                    'literature'
                  )
                  if ((await stat(sourcePath)).size > MAX_LITERATURE_CANDIDATE_FILE_BYTES) {
                    throw Object.assign(
                      new Error('Literature candidate file exceeds the 2 MB limit.'),
                      { code: 'CANDIDATE_FILE_TOO_LARGE' }
                    )
                  }
                  return readFile(sourcePath, { encoding: 'utf8', signal })
                },
                formatReferences: async ({ itemIds, styleId, locale }) => {
                  const items = await literatureCatalog.getMany(itemIds)
                  const itemsById = new Map(items.map((item) => [item.id, item]))
                  const references = itemIds.map((itemId) => {
                    const item = itemsById.get(itemId)
                    if (!item) throw new Error(`Literature Item is unavailable: ${itemId}`)
                    return { id: itemId, item: item.item }
                  })
                  return {
                    references: await literatureCitationFormatter!.formatReferences(
                      references,
                      styleId,
                      locale
                    )
                  }
                },
                formatCitationDocument: async ({
                  projectId,
                  sessionId,
                  workspaceCwd,
                  filename,
                  styleId,
                  locale
                }) => {
                  const notebookRoot = getNotebookSessionRoot(dataRoot, projectId, sessionId)
                  const notebookDataDir = join(notebookRoot, 'data')
                  const sourcePath = await resolveAllowedImportFilePath(
                    filename,
                    [notebookRoot, workspaceCwd],
                    [notebookDataDir, workspaceCwd, notebookRoot],
                    'literature'
                  )
                  if (extname(sourcePath).toLowerCase() !== '.docx') {
                    throw new Error('Citation document must be a DOCX file.')
                  }
                  if ((await stat(sourcePath)).size > MAX_LITERATURE_CITATION_DOCUMENT_BYTES) {
                    throw new Error('Citation document exceeds the 64 MB limit.')
                  }
                  const result = await literatureCitationDocument!.format({
                    content: new Uint8Array(await readFile(sourcePath)),
                    styleId,
                    locale
                  })
                  const stem = basename(sourcePath, extname(sourcePath))
                  const outputFilename = `${stem}.cited-${randomUUID().slice(0, 8)}.docx`
                  return {
                    filename: outputFilename,
                    citationCount: result.citationCount,
                    referenceCount: result.referenceCount,
                    contentBase64: Buffer.from(result.content).toString('base64'),
                    literature: result.sidecar.literature
                  }
                },
                prepareLatexBundle: async ({ projectId, sessionId, workspaceCwd, filename }) => {
                  const notebookRoot = getNotebookSessionRoot(dataRoot, projectId, sessionId)
                  const notebookDataDir = join(notebookRoot, 'data')
                  const sourcePath = await resolveAllowedImportFilePath(
                    filename,
                    [notebookRoot, workspaceCwd],
                    [notebookDataDir, workspaceCwd, notebookRoot],
                    'literature'
                  )
                  if (extname(sourcePath).toLowerCase() !== '.tex') {
                    throw new Error('LaTeX source must be a .tex file.')
                  }
                  if ((await stat(sourcePath)).size > MAX_LITERATURE_CANDIDATE_FILE_BYTES) {
                    throw new Error('LaTeX source exceeds the 2 MB limit.')
                  }
                  const result = await literatureLatexBundle!.prepare({
                    content: await readFile(sourcePath, 'utf8'),
                    sourceName: basename(sourcePath)
                  })
                  const stem = basename(sourcePath, extname(sourcePath))
                  const outputFilename = `${stem}.latex-${randomUUID().slice(0, 8)}.zip`
                  return {
                    filename: outputFilename,
                    citationCount: result.citationCount,
                    referenceCount: result.referenceCount,
                    contentBase64: Buffer.from(result.content).toString('base64'),
                    literature: result.sidecar.literature
                  }
                },
                searchLibrary: async (request) => {
                  const scope = request.scope ?? 'project'
                  const offset = request.offset ?? 0
                  const limit = request.limit ?? LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT
                  const page = await literatureCatalog.searchForAgent({
                    scope: 'library',
                    query: request.query,
                    ...(scope === 'items' ? { itemIds: [...(request.itemIds ?? [])] } : {}),
                    projectId: scope === 'project' ? request.projectId : undefined,
                    collectionId: scope === 'collection' ? request.collectionId : undefined,
                    offset,
                    limit
                  })
                  const items = page.entries.filter(
                    (entry): entry is LiteratureItemView => 'item' in entry
                  )
                  return {
                    items,
                    totalCount: page.totalCount ?? items.length,
                    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
                    hasMore: page.nextOffset !== undefined
                  }
                },
                readAbstract: async (request) => {
                  const item = (await literatureCatalog.getMany([request.itemId]))[0]
                  if (!item || !isLiteratureItemInScope(item, request)) return undefined
                  return {
                    itemId: item.id,
                    metadataRevision: item.metadataRevision,
                    title: item.item.title,
                    abstract: item.item.abstract
                  }
                },
                readPdf: async (request) => {
                  const item = (await literatureCatalog.getMany([request.itemId]))[0]
                  if (!item || !isLiteratureItemInScope(item, request)) return undefined
                  if (!literatureReader) {
                    throw new Error(
                      'PDF_READER_UNAVAILABLE: Literature PDF reading is unavailable in this session. Do not retry; use read_library_abstract or tell the user full text cannot be read.'
                    )
                  }
                  const selected = item.attachments
                    .filter(
                      (attachment) =>
                        !request.attachmentId || attachment.id === request.attachmentId
                    )
                    .flatMap((attachment) =>
                      attachment.versions
                        .filter(isPdfAttachmentVersion)
                        .map((version) => ({ attachment, version }))
                    )[0]
                  if (!selected) {
                    throw new Error(
                      'PDF_ATTACHMENT_NOT_FOUND: This Literature Item has no matching PDF attachment. Omit attachmentId to read the first PDF; if hasPdf is false, use read_library_abstract or acquire_pdf instead.'
                    )
                  }
                  const evidence = await literatureReader.searchAttachment({
                    projectId: request.projectId,
                    attachmentId: selected.attachment.id,
                    attachmentVersionId: selected.version.id,
                    filename: selected.version.filename,
                    sizeBytes: selected.version.sizeBytes,
                    checksum: selected.version.checksum,
                    query: request.query
                  })
                  return {
                    itemTitle: item.item.title,
                    evidence: evidence as Record<string, unknown>
                  }
                },
                saveToInbox: async (request) => {
                  const results: LiteratureCatalogReceipt[] = []
                  for (const candidate of request.candidates) {
                    if (request.signal?.aborted) return { results, cancelled: true }
                    try {
                      results.push(
                        await literatureCatalog.transact({
                          kind: 'stage-candidate',
                          candidate: {
                            ...candidate,
                            origin: {
                              kind: 'agent',
                              projectId: request.projectId,
                              sessionId: request.sessionId
                            }
                          }
                        })
                      )
                    } catch {
                      return {
                        results,
                        failure: {
                          inputIndex: results.length,
                          code: 'INBOX_SAVE_FAILED',
                          message:
                            'Could not save this candidate. Earlier receipts remain valid; later inputs were not attempted.'
                        }
                      }
                    }
                  }
                  return { results }
                }
              }
            }
          : {}),
        skills: {
          preparedSkillIds: preparedSkills?.skillIds,
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids),
          descriptorsForIds: async (ids, codexHome) => {
            if (!preparedSkills) return settingsService.codexSkillDescriptorsForIds(ids, codexHome)
            const names = new Set(await settingsService.skillNudgeNamesForIds(ids))
            return preparedSkills.catalog.filter((entry) => names.has(entry.name))
          },
          catalogForCodexHome: async (codexHome, allowedNames) =>
            preparedSkills?.catalog ?? settingsService.codexSkillCatalog(codexHome, allowedNames),
          catalogForCodeBuddyRoot: async (root, allowedNames) =>
            preparedSkills?.catalog ?? settingsService.codeBuddySkillCatalog(root, allowedNames)
        },
        ...(!delegatedNotebookConnection || delegatedArtifactCurrentRunFile
          ? {
              artifacts: {
                configRoot,
                dataRoot,
                projectId: DEFAULT_ARTIFACT_PROJECT_ID,
                mcpEntryPath,
                enableImageGeneration: true,
                imageMcp: {
                  getPresetId: () =>
                    settingsService.imageModels
                      .resolve()
                      .then((resolved) => resolved?.model.presetId)
                },
                repository,
                runRegistry,
                provenance: provenanceRepository,
                managedFileVersions,
                getRpcConnection: () => notebookRpcServer.ensureStarted(),
                issueRpcCapability: (binding, isOwnerActive) =>
                  notebookRpcServer.issueArtifactRunCapability(binding, undefined, isOwnerActive),
                revokeRpcCapability: (token) =>
                  notebookRpcServer.revokeArtifactRunCapability(token),
                ...(delegatedArtifactCurrentRunFile
                  ? { currentRunFile: delegatedArtifactCurrentRunFile }
                  : {})
              }
            }
          : {}),
        ...(delegatedNotebookConnection ? {} : { uploads: { repository: uploadRepository } }),
        authorizedDirectories: grantedRootsRepository?.authorizedSnapshot
          ? new AuthorizedDirectoryNotices(() => grantedRootsRepository.authorizedSnapshot!())
          : undefined,
        grantedRoots: grantedRootsRepository
          ? {
              list: () => grantedRootsRepository.list(),
              // Read fresh so revocation and access changes govern every subsequent resolution.
              resolveRoot: async (rootId) =>
                (await grantedRootsRepository.list()).find((root) => root.id === rootId)
            }
          : undefined,
        notebook: {
          ...(!delegatedNotebookConnection
            ? {
                bindTaskRuntime: bindTaskNotebookRuntime,
                createExecutionIntent: (
                  scope: import('../notebook/execution-intent').NotebookExecutionIntentScope
                ) => notebookRpcServer.createExecutionIntent(scope),
                currentExecutionIntent: (
                  scope: import('../notebook/execution-intent').NotebookExecutionIntentScope
                ) => notebookRpcServer.currentExecutionIntent(scope)
              }
            : {}),
          rememberExecutionIntent: (scope, promptId, intent) =>
            notebookRpcServer.rememberExecutionIntent(scope, promptId, intent),
          resolveExecutionIntent: (scope, promptId) =>
            notebookRpcServer.resolveExecutionIntent(scope, promptId),
          canOwnRuntimeBindingDecision: async (request) => {
            const trustedRequest = notebookRpcServer.runtimeBindingAdmissionRequest(
              request,
              delegatedNotebookConnection
            )
            return trustedRequest && canOwnRuntimeBindingDecision
              ? canOwnRuntimeBindingDecision(trustedRequest)
              : false
          },
          authorizeRuntimeBindingAdmission: (admission) =>
            notebookRpcServer.authorizeRuntimeBindingAdmission(
              admission,
              delegatedNotebookConnection
            ),
          projectId: DEFAULT_ARTIFACT_PROJECT_ID,
          mcpEntryPath,
          memoryTools: !delegatedNotebookConnection,
          isMemoryEnabled: () => memory?.isEnabled?.() ?? Promise.resolve(false),
          getShellRuntimeBinding,
          getRpcConnection: ({ sessionId, projectId, memoryTools, executionIntent }) =>
            delegatedNotebookConnection
              ? executionIntent && delegatedNotebookConnection.refreshExecutionIntent
                ? delegatedNotebookConnection.refreshExecutionIntent(executionIntent)
                : Promise.resolve(delegatedNotebookConnection)
              : notebookRpcServer.issueSessionConnection(
                  sessionId,
                  projectId,
                  `root-frame-${sessionId}`,
                  memoryTools,
                  executionIntent
                ),
          ...(delegatedNotebookConnection
            ? {}
            : {
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                releaseSessionCapabilities: (sessionId, capabilityTokens) =>
                  notebookRpcServer.releaseSessionCapabilitiesIfOwned(sessionId, capabilityTokens),
                registerSessionSpecialist: (sessionId, specialistId) =>
                  notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
                authorizeExecution: (authorization) =>
                  notebookRpcServer.authorizeExecution(authorization),
                setArtifactTurnBinding: (sessionId, binding) =>
                  notebookRpcServer.setArtifactTurnBinding(sessionId, binding),
                clearArtifactTurnBinding: (sessionId, ownerExecutionId) =>
                  notebookRpcServer.clearArtifactTurnBinding(sessionId, ownerExecutionId),
                prepareTurnInputs: (request) =>
                  notebookRpcServer.prepareNotebookTurnInputs(request),
                registerTurnInputs: (request) =>
                  notebookRpcServer.registerNotebookTurnInputs(request),
                peekHandoffContext: peekNotebookHandoffContext,
                isReplNamespaceUnavailable
              })
        },
        ...(delegatedNotebookConnection
          ? {}
          : {
              skillImport: {
                mcpEntryPath,
                isEnabled: () => settingsService.getConversationSkillImportEnabled(),
                getRpcConnection: ({ sessionId }: { sessionId: string }) =>
                  notebookRpcServer.issueSkillImportConnection(sessionId),
                registerSessionAlias: (aliasSessionId: string, sessionId: string) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                releaseSessionCapabilities: (
                  sessionId: string,
                  capabilityTokens: readonly string[]
                ) =>
                  notebookRpcServer.releaseSessionCapabilitiesIfOwned(sessionId, capabilityTokens),
                authorizeReferencedUploads: authorizeSkillImportReferencedUploads
              }
            }),
        ...(!delegatedNotebookConnection && sessionPersistenceCoordinator
          ? {
              permissionWait: {
                networkApprovalOwner: sandboxNetworkApprovalOwner,
                allowNetworkDestination:
                  settingsService.allowNotebookNetworkDestination?.bind(settingsService),
                allowNetworkDomain:
                  settingsService.allowNotebookNetworkDomain?.bind(settingsService),
                sessions: sessionPersistenceCoordinator,
                onSessionUpdated: (session) => {
                  try {
                    broadcastToRenderers('session:updated', {
                      session,
                      originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
                    })
                  } catch (error) {
                    // The durable commit remains authoritative when a renderer projection is gone.
                    log.warn('permission wait Session publication failed', errorLogFields(error))
                  }
                },
                onContinuationSessionUpdated: (session) => {
                  try {
                    broadcastToRenderers('session:updated', {
                      session,
                      originClientId: MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID
                    })
                  } catch (error) {
                    log.warn(
                      'durable continuation Session publication failed',
                      errorLogFields(error)
                    )
                  }
                }
              }
            }
          : {}),
        ...(sessionPersistenceCoordinator
          ? {
              plan: {
                mcpEntryPath,
                getRpcConnection: ({ sessionId, projectId, replaceExisting }) =>
                  notebookRpcServer.issuePlanConnection(sessionId, projectId, { replaceExisting }),
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                sessions: sessionPersistenceCoordinator,
                onApprovalRequested: (request) => {
                  if (taskNotifications) {
                    runTaskNotificationInBackground(
                      () => taskNotifications.handlePlanApproval(request),
                      (error) =>
                        log.warn('plan approval notification failed', errorLogFields(error))
                    )
                    return
                  }
                  if (notificationInbox) {
                    runTaskNotificationInBackground(
                      () =>
                        notificationInbox.record({
                          dedupeKey: `authorization:session-plan:${request.artifactVersionId}`,
                          kind: 'authorization.required',
                          source: 'session-plan',
                          attentionReason: 'waiting-plan-approval',
                          projectId: request.projectId,
                          sessionId: request.sessionId,
                          originId: request.artifactVersionId,
                          title: 'Plan approval needed',
                          summary: 'A plan needs your approval.',
                          actionState: 'pending'
                        }),
                      (error) =>
                        log.warn('plan approval inbox record failed', errorLogFields(error))
                    )
                  }
                },
                onApprovalSettled: (request) => {
                  if (!notificationInbox) return
                  runTaskNotificationInBackground(
                    () =>
                      notificationInbox.settleAuthorization(
                        'session-plan',
                        request.artifactVersionId,
                        request.state
                      ),
                    (error) => log.warn('plan approval inbox settle failed', errorLogFields(error))
                  )
                }
              }
            }
          : {}),
        callbacks: runtimeCallbacks,
        sideChatRelays,
        prepareSessionReading:
          !delegatedNotebookConnection && sessionPersistenceCoordinator
            ? (request) =>
                new SessionReadingOwner(
                  new SessionReplayRepository(() => getProjectDbClient(resolveConfigRoot())),
                  sessionPersistenceCoordinator
                ).prepare(request)
            : undefined,
        hasPendingCredentialRequest,
        ...(!delegatedNotebookConnection && memory ? { memory } : {}),
        permissionGrantStore,
        permissionGrantRegistry,
        permissionGrantContext,
        imageInputCompatibility,
        ...(sessionPersistenceCoordinator
          ? {
              hasReplayableImageHistory: async (projectId: string, sessionId: string) => {
                const persisted = await sessionPersistenceCoordinator.loadSessionForContinuation(
                  projectId,
                  sessionId
                )
                return sessionHasReplayableImageHistory(persisted)
              }
            }
          : {}),
        resolveSpecialistIdentity: specialistService
          ? async (specialistId: string, frameworkId: string) => {
              let profile
              try {
                profile = await specialistService.resolveRunnableById(specialistId)
              } catch (error) {
                log.warn('bound specialist profile resolution failed', {
                  operation: 'specialist-resolution',
                  phase: 'profile',
                  resolver: 'identity',
                  specialistId,
                  frameworkId,
                  reason: 'profile-read-failed',
                  ...diagnosticErrorFields(error)
                })
                return undefined
              }
              if (!profile.enabled) {
                log.warn('bound specialist profile resolution failed', {
                  operation: 'specialist-resolution',
                  phase: 'profile',
                  resolver: 'identity',
                  specialistId,
                  frameworkId,
                  reason: 'disabled'
                })
                return undefined
              }
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: specialistService
          ? async (specialistId, context) => {
              let profile
              try {
                profile = await specialistService.resolveRunnableById(specialistId)
              } catch (error) {
                log.warn('bound specialist profile resolution failed', {
                  sessionId: context?.sessionId,
                  frameworkId: context?.frameworkId,
                  modelRoute: context?.modelRoute,
                  operation: 'specialist-resolution',
                  phase: 'profile',
                  resolver: 'skills',
                  specialistId,
                  reason: 'profile-read-failed',
                  ...diagnosticErrorFields(error)
                })
                return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
              }
              if (!profile.enabled) {
                log.warn('bound specialist profile resolution failed', {
                  sessionId: context?.sessionId,
                  frameworkId: context?.frameworkId,
                  modelRoute: context?.modelRoute,
                  operation: 'specialist-resolution',
                  phase: 'profile',
                  resolver: 'skills',
                  specialistId,
                  reason: 'disabled'
                })
                return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
              }
              let stage = 'skills'
              try {
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
                  stage = 'connectors'
                  const [provisioned, connectors] = await Promise.all([
                    settingsService.provisionedConnectorSkillNames(),
                    settingsService.getConnectors()
                  ])
                  const publicNameByLocalId = new Map(
                    (connectors?.customMcpServers ?? []).map((server) => [server.id, server.name])
                  )
                  const publicName = (id: string): string => publicNameByLocalId.get(id) ?? id
                  const runtimeProfile = {
                    ...profile,
                    fullAccess: {
                      ...profile.fullAccess,
                      excludedConnectorIds: profile.fullAccess.excludedConnectorIds.map(publicName)
                    },
                    selectedCapabilities: {
                      ...profile.selectedCapabilities,
                      connectorIds: profile.selectedCapabilities.connectorIds.map(publicName)
                    }
                  }
                  const connectorSkills = filterSpecialistConnectorSkills(
                    provisioned,
                    runtimeProfile
                  )
                  if (connectorSkills.length > 0) {
                    return {
                      ...effective,
                      frameworkNames: [...effective.frameworkNames, ...connectorSkills]
                    }
                  }
                }
                return effective
              } catch (error) {
                log.warn('bound specialist capability resolution failed', {
                  sessionId: context?.sessionId,
                  frameworkId: context?.frameworkId,
                  modelRoute: context?.modelRoute,
                  operation: 'specialist-resolution',
                  specialistId,
                  phase: stage,
                  reason: 'capability-read-failed',
                  ...diagnosticErrorFields(error)
                })
                return { kind: 'unavailable', reason: SPECIALIST_CAPABILITY_READ_FAILED_MESSAGE }
              }
            }
          : undefined,
        resolveProjectAgentContext: createProjectAgentContextResolver(projectRepository),
        resolveProjectTracing: async (projectId) =>
          (await projectRepository.get(projectId))?.sessionDefaults?.agentTracingEnabled === true,
        ...(resolveComputeExecutionTargetIds ? { resolveComputeExecutionTargetIds } : {})
      }
      const baseOwners = composeAcpRuntimeBaseOwners(runtimeOptions)
      return new AcpRuntime(
        runtimeOptions,
        baseOwners,
        composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)
      )
    },
    callbacks,
    defaultCwd,
    initializationBarrier,
    onDisconnected,
    onSessionUnavailable,
    {
      onSessionTurnStarted,
      onSessionTurnEnded,
      onSkillImportAttachmentEligible,
      onSessionCancellationRequested: (sessionId) => {
        webInvocations.cancelSession(sessionId)
        onSessionCancellationRequested?.(sessionId)
      },
      onAllSessionsCancellationRequested: () => {
        webInvocations.cancelAll()
        onAllSessionsCancellationRequested?.()
      },
      onSessionDeleteStarted: (sessionId) => {
        webInvocations.cancelSession(sessionId)
        onSessionDeleteStarted?.(sessionId)
      },
      beforeSessionDelete,
      afterSessionDelete
    },
    permissionGrantRegistry
      ? () => projectRegistrySessionGrants(permissionGrantRegistry.listCached())
      : undefined,
    delegatedWork
  )
  runtimeCoordinatorRef.current = runtimeCoordinator
  return runtimeCoordinator
}

export { createAcpRuntime, createProjectAgentContextResolver, sessionHasReplayableImageHistory }
export type { AcpRuntimeCompositionOptions }
