import { homedir } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { app } from 'electron'

import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateUpdate } from '../../shared/acp'
import type { ShellRuntimeBinding } from '../../shared/notebook'
import { DEFAULT_ARTIFACT_PROJECT_ID } from '../../shared/artifacts'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/settings'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { imageAttachmentMimeType } from '../../shared/uploads'
import {
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import {
  filterSpecialistConnectorSkills,
  resolveEffectiveSpecialistSkills
} from '../../shared/specialist'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import { resolveAllowedImportFilePath } from '../artifacts/storage-access'
import type { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { createLogger, errorLogFields } from '../logger'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { getNotebookSessionRoot } from '../notebook/repository'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import {
  runTaskNotificationInBackground,
  type TaskNotificationService
} from '../notifications/task-notifications'
import type { NotificationInboxController } from '../notifications/notification-inbox-controller'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { getProjectDbClient } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import { createAcpRuntimeEventBroadcastCoalescer } from './runtime-event-broadcast-coalescer'
import type { AcpSettingsCapabilities } from '../settings/service-capabilities'
import { CodexTransportFallbackLogObserver } from '../settings/codex-transport-fallback-log'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix
} from '../specialist/identity'
import type { SpecialistService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { UploadRepository } from '../uploads/repository'
import type {
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import type { LiteratureDocumentReader } from '../literature/document-reader'
import type { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import type { LiteratureCatalog } from '../literature/catalog'
import { LiteratureReferenceResolver } from '../literature/reference-resolver'
import { netFetchStandard } from '../skills/net-fetch'
import { LiteratureCitationDocument } from '../literature/citation-document'
import { LiteratureCitationFormatter } from '../literature/citation-formatter'
import { LiteratureLatexBundle } from '../literature/latex-bundle'
import {
  LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT,
  type LiteratureLibraryScope
} from '../literature/library-mcp-server'
import type { LiteratureCatalogReceipt, LiteratureItemView } from '../../shared/literature'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { ResolvedAgentBackend } from '../agent-framework'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import { AgentMcpHttpHost } from './mcp-http-host'
import { projectRegistrySessionGrants } from './permission-broker'
import { AcpRuntime, type AcpRuntimeCallbacks, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
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
  mcpEntryPath: string
  uploadRepository: UploadRepository
  notebookRpcServer: NotebookLocalRpcServer
  wslSetupSessions?: AcpRuntimeOptions['wslSetupSessions']
  getShellRuntimeBinding?: () => ShellRuntimeBinding | Promise<ShellRuntimeBinding>
  peekNotebookHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
  authorizeSkillImportReferencedUploads: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
  settingsService: AcpSettingsCapabilities
  // The SQLite-backed granted-roots store ("Grant folder access"); the linked-folder file-reference
  // resolver reads it fresh per resolution. Absent only in tests — linked-folder references then
  // fail closed (no root resolves).
  grantedRootsRepository?: Pick<GrantedLocalRootsRepository, 'list'>
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
  sessionPersistenceCoordinator?: SessionRuntimeContextCommands & SessionMutation & SessionCatalog
  literatureReader?: Pick<LiteratureDocumentReader, 'readCurrent' | 'searchAttachment'>
  literatureAttachments?: Pick<LiteratureAttachmentAuthority, 'resolveVersion'>
  literatureCatalog?: Pick<LiteratureCatalog, 'getMany' | 'searchForAgent' | 'transact'>
  literaturePdfAcquisition?: Pick<
    import('../literature/agent-pdf-acquisition').AgentPdfAcquisition,
    'acquire'
  >
  delegatedWork?: RootDelegatedWorkControl
  fixedBackend?: ResolvedAgentBackend
  runtimeCallbacks?: AcpRuntimeCallbacks
  delegatedNotebookConnection?: NotebookRpcConnection
  delegatedArtifactCurrentRunFile?: string
  spawnAgent?: () => ChildProcessWithoutNullStreams
  sideChatRelays?: AcpRuntimeOptions['sideChatRelays']
  imageInputCompatibility?: AcpRuntimeOptions['imageInputCompatibility']
  resolveComputeExecutionTargetIds?: AcpRuntimeOptions['resolveComputeExecutionTargetIds']
  memory?: AcpRuntimeOptions['memory']
  auxiliaryUsage?: AcpRuntimeOptions['auxiliaryUsage']
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
  mcpEntryPath,
  repository,
  runRegistry,
  provenanceRepository,
  managedFileVersions,
  uploadRepository,
  notebookRpcServer,
  wslSetupSessions,
  getShellRuntimeBinding,
  peekNotebookHandoffContext,
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
  literatureReader,
  literatureAttachments,
  literatureCatalog,
  literaturePdfAcquisition,
  delegatedWork,
  fixedBackend,
  runtimeCallbacks,
  delegatedNotebookConnection,
  delegatedArtifactCurrentRunFile,
  spawnAgent,
  sideChatRelays,
  imageInputCompatibility,
  resolveComputeExecutionTargetIds,
  memory,
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
  const defaultCwd = homedir()
  const runtimeCoordinatorRef: { current?: AcpRuntimeCoordinator } = {}
  // One lazily-shared repository for Agent Context lookups; getProjectDbClient caches the client.
  const projectRepository = new ProjectRepository(() => getProjectDbClient(resolveConfigRoot()))
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

  const runtimeCoordinator = new AcpRuntimeCoordinator(
    (runtimeCallbacks, permissionGrantStore, target) => {
      const selection = fixedBackend
        ? undefined
        : target
          ? undefined
          : settingsService.captureActiveAgentBackendSelection()
      const runtimeOptions: AcpRuntimeOptions = {
        appVersion: app.getVersion(),
        auxiliaryUsage,
        // Packaged macOS apps often start with cwd at "/" or the app bundle; use home instead.
        defaultCwd,
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
        mcpHttpHost: new AgentMcpHttpHost(),
        wslSetupSessions,
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
                readDocument: (request) => literatureReader.readCurrent(request)
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
                      'PDF_READER_UNAVAILABLE: Literature PDF reading is unavailable.'
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
                      'PDF_ATTACHMENT_NOT_FOUND: This Literature Item has no matching PDF attachment.'
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
          needForceLoad: (ids) => settingsService.skillsNeedingForceLoad(ids),
          namesForIds: (ids) => settingsService.skillNudgeNamesForIds(ids),
          descriptorsForIds: (ids, codexHome) =>
            settingsService.codexSkillDescriptorsForIds(ids, codexHome),
          catalogForCodexHome: (codexHome) => settingsService.codexSkillCatalog(codexHome),
          catalogForCodeBuddyRoot: (root) => settingsService.codeBuddySkillCatalog(root)
        },
        ...(!delegatedNotebookConnection || delegatedArtifactCurrentRunFile
          ? {
              artifacts: {
                configRoot,
                dataRoot,
                projectId: DEFAULT_ARTIFACT_PROJECT_ID,
                mcpEntryPath,
                repository,
                runRegistry,
                provenance: provenanceRepository,
                managedFileVersions,
                getRpcConnection: () => notebookRpcServer.ensureStarted(),
                issueRpcCapability: (binding) =>
                  notebookRpcServer.issueArtifactRunCapability(binding),
                revokeRpcCapability: (token) =>
                  notebookRpcServer.revokeArtifactRunCapability(token),
                ...(delegatedArtifactCurrentRunFile
                  ? { currentRunFile: delegatedArtifactCurrentRunFile }
                  : {})
              }
            }
          : {}),
        ...(delegatedNotebookConnection ? {} : { uploads: { repository: uploadRepository } }),
        grantedRoots: grantedRootsRepository
          ? {
              // Read fresh so revocation and access changes govern every subsequent resolution.
              resolveRoot: async (rootId) =>
                (await grantedRootsRepository.list()).find((root) => root.id === rootId)
            }
          : undefined,
        notebook: {
          projectId: DEFAULT_ARTIFACT_PROJECT_ID,
          mcpEntryPath,
          memoryTools: !delegatedNotebookConnection,
          isMemoryEnabled: () => memory?.isEnabled?.() ?? Promise.resolve(false),
          getShellRuntimeBinding,
          getRpcConnection: ({ sessionId, projectId, memoryTools }) =>
            delegatedNotebookConnection
              ? Promise.resolve(delegatedNotebookConnection)
              : notebookRpcServer.issueSessionConnection(
                  sessionId,
                  projectId,
                  `root-frame-${sessionId}`,
                  memoryTools
                ),
          ...(delegatedNotebookConnection
            ? {}
            : {
                registerSessionAlias: (aliasSessionId, sessionId) =>
                  notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
                releaseSessionCapabilities: (sessionId) =>
                  notebookRpcServer.releaseSessionCapabilities(sessionId),
                registerSessionSpecialist: (sessionId, specialistId) =>
                  notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
                authorizeExecution: (authorization) =>
                  notebookRpcServer.authorizeExecution(authorization),
                setArtifactTurnBinding: (sessionId, binding) =>
                  notebookRpcServer.setArtifactTurnBinding(sessionId, binding),
                clearArtifactTurnBinding: (sessionId, ownerExecutionId) =>
                  notebookRpcServer.clearArtifactTurnBinding(sessionId, ownerExecutionId),
                registerTurnInputs: (request) =>
                  notebookRpcServer.registerNotebookTurnInputs(request),
                peekHandoffContext: peekNotebookHandoffContext
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
                releaseSessionCapabilities: (sessionId: string) =>
                  notebookRpcServer.releaseSessionCapabilities(sessionId),
                authorizeReferencedUploads: authorizeSkillImportReferencedUploads
              }
            }),
        ...(!delegatedNotebookConnection && sessionPersistenceCoordinator
          ? {
              permissionWait: {
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
                getRpcConnection: ({ sessionId, projectId }) =>
                  notebookRpcServer.issuePlanConnection(sessionId, projectId),
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
              } catch {
                // Profile not found or corrupt
                return undefined
              }
              if (!profile.enabled) return undefined
              const append = buildSpecialistIdentityAppend(profile)
              const prefix = buildSpecialistIdentityPrefix(profile)
              if (frameworkId === 'claude-code') return { append, prefix: '' }
              return { append: '', prefix }
            }
          : undefined,
        resolveSpecialistSkills: specialistService
          ? async (specialistId) => {
              try {
                const profile = await specialistService.resolveRunnableById(specialistId)
                if (!profile.enabled) {
                  return { kind: 'unavailable', reason: 'The bound specialist is disabled.' }
                }
                const effective = resolveEffectiveSpecialistSkills(
                  profile,
                  await settingsService.listSpecialistSkillCatalog()
                )
                if (effective.kind === 'specialist') {
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
              } catch {
                return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
              }
            }
          : undefined,
        resolveProjectAgentContext: createProjectAgentContextResolver(projectRepository),
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
      onSessionCancellationRequested,
      onAllSessionsCancellationRequested,
      onSessionDeleteStarted,
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
