// Ordered fragments keep the public registration order when capabilities interleave.
import type {
  SessionDiagnosticRequest,
  SessionDiagnosticInspection,
  SessionDiagnosticExportRequest,
  SessionDiagnosticExportResult
} from '../session-diagnostics'

import type { MessageSearchRequest, MessageSearchPage } from '../message-search'

import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatRelayDeliveredEvent,
  SideChatRuntimeEvent,
  SideChatSessionRequest,
  SideChatSnapshotList,
  SideChatStartRequest,
  SideChatStartResponse
} from '../side-chat'

import type { SessionDeletedEvent, SessionUpsertEvent } from '../lifecycle-events'

import type {
  HandoffEventsRequest,
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffRetryRequest
} from '../handoff-lifecycle'

import type {
  BackgroundResultDeliveryProjectRequest,
  BackgroundResultDeliverySessionRequest,
  ProjectBackgroundActivity,
  ProjectBackgroundActivityChangedEvent,
  SessionBackgroundResultActivity
} from '../background-result-delivery'

import type {
  DeleteSessionRequest,
  DelegationPolicy,
  EditSessionDetailsRequest,
  FilterSessionPdfContextCandidatesRequest,
  FilterSessionPdfContextCandidatesResult,
  LinkSessionPdfContextRequest,
  SessionDeletionResult,
  LoadAllSessionsResult,
  ListSessionSummariesResult,
  LoadSessionRequest,
  OpenSessionRecoveryFolderRequest,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  SessionRuntimeContext,
  SessionUsageProjection,
  UnlinkSessionPdfContextRequest,
  UpdateSessionArchiveRequest
} from '../session-persistence'

import type {
  SessionPersistenceFlushAbortedEvent,
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from '../session-persistence-flush'

import type { ExportConversationRequest, ExportConversationResult } from '../conversation-export'

import type {
  SessionPackageRequest,
  SessionPackageExportResult,
  SessionPackageImportRequest,
  SessionPackageImportResult
} from '../session-package'

import {
  callable,
  ELECTRON,
  type AcpListener,
  type RemoveListener,
  ELECTRON_EVENT,
  WEB,
  RUNTIME_VALIDATED,
  MAPPED_ELECTRON,
  POSITIONAL,
  EVENT,
  SESSION_SAVE,
  SESSION_SAVE_JSON,
  SEND
} from './definition'

export const backgroundResultDeliveryGetSessionActivityContracts = {
  'backgroundResultDelivery.getSessionActivity': callable<
    (request: BackgroundResultDeliverySessionRequest) => Promise<SessionBackgroundResultActivity>
  >()('background-result-delivery', ['background-result-delivery:session-activity', ELECTRON]),
  'backgroundResultDelivery.getProjectActivity': callable<
    (request: BackgroundResultDeliveryProjectRequest) => Promise<ProjectBackgroundActivity>
  >()('background-result-delivery', ['background-result-delivery:project-activity', ELECTRON]),
  'backgroundResultDelivery.onChanged': callable<
    (listener: AcpListener<ProjectBackgroundActivityChangedEvent>) => RemoveListener
  >()('background-result-delivery', ['background-result-delivery:changed', ELECTRON_EVENT])
} as const

export const handoffListContracts = {
  'handoff.list': callable<
    (request: HandoffEventsRequest) => Promise<readonly HandoffLifecycleEvent[]>
  >()('handoff', ['handoff-lifecycle:list', ELECTRON]),
  'handoff.onChanged': callable<
    (listener: AcpListener<HandoffLifecycleChange>) => RemoveListener
  >()('handoff', ['handoff-lifecycle:changed', ELECTRON_EVENT]),
  'handoff.retry': callable<(request: HandoffRetryRequest) => Promise<void>>()('handoff', [
    'handoff-lifecycle:retry',
    ELECTRON
  ])
} as const

export const sessionsDeleteSessionContracts = {
  'sessions.deleteSession': callable<
    (request: DeleteSessionRequest) => Promise<SessionDeletionResult>
  >()('sessions', ['sessions:delete-session', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.editDetails': callable<
    (request: EditSessionDetailsRequest) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:edit-details', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.exportConversation': callable<
    (request: ExportConversationRequest) => Promise<ExportConversationResult>
  >()('sessions', ['sessions:export-conversation', MAPPED_ELECTRON]),
  'sessions.inspectDiagnostics': callable<
    (request: SessionDiagnosticRequest) => Promise<SessionDiagnosticInspection>
  >()('sessions', [
    'sessions:inspect-diagnostics',
    MAPPED_ELECTRON,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.exportDiagnostics': callable<
    (request: SessionDiagnosticExportRequest) => Promise<SessionDiagnosticExportResult>
  >()('sessions', [
    'sessions:export-diagnostics',
    MAPPED_ELECTRON,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.cancelDiagnostics': callable<(request: { operationId: string }) => Promise<void>>()(
    'sessions',
    ['sessions:cancel-diagnostics', MAPPED_ELECTRON, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'sessions.fork': callable<
    (request: SessionPackageRequest) => Promise<SessionPackageRequest | null>
  >()('sessions', ['sessions:fork', MAPPED_ELECTRON, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.exportPackage': callable<
    (request: SessionPackageRequest) => Promise<SessionPackageExportResult>
  >()('sessions', [
    'sessions:export-package',
    MAPPED_ELECTRON,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.importPackage': callable<
    (request?: SessionPackageImportRequest, file?: File) => Promise<SessionPackageImportResult>
  >()('sessions', [
    'sessions:import-package',
    MAPPED_ELECTRON,
    'session-package-import-file',
    POSITIONAL,
    RUNTIME_VALIDATED
  ]),
  'sessions.packageOperation': callable<
    (
      request: import('../session-package').PackageOperationRequest
    ) => Promise<import('../session-package').PackageOperationSnapshot | null>
  >()('sessions', [
    'sessions:package-operation',
    MAPPED_ELECTRON,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.onPackageOperation': callable<
    (
      listener: (snapshot: import('../session-package').PackageOperationSnapshot) => void
    ) => RemoveListener
  >()('sessions', ['sessions:package-operation-changed', EVENT]),
  'sessions.list': callable<() => Promise<ListSessionSummariesResult>>()('sessions', [
    'sessions:list'
  ]),
  'sessions.filterPdfContextCandidates': callable<
    (
      request: FilterSessionPdfContextCandidatesRequest
    ) => Promise<FilterSessionPdfContextCandidatesResult>
  >()('sessions', [
    'sessions:filter-pdf-context-candidates',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessions.linkPdfContext': callable<
    (request: LinkSessionPdfContextRequest) => Promise<SessionRuntimeContext>
  >()('sessions', ['sessions:link-pdf-context', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.loadAll': callable<() => Promise<LoadAllSessionsResult>>()('sessions', [
    'sessions:load-all'
  ]),
  'sessions.searchMessages': callable<
    (request: MessageSearchRequest) => Promise<MessageSearchPage>
  >()('sessions', ['sessions:search-messages']),
  'sessions.loadOne': callable<
    (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  >()('sessions', ['sessions:load-one']),
  'sessions.loadUsage': callable<() => Promise<SessionUsageProjection>>()('sessions', [
    'sessions:load-usage'
  ]),
  'sessions.openRecoveryFolder': callable<
    (request: OpenSessionRecoveryFolderRequest) => Promise<void>
  >()('sessions', ['sessions:open-recovery-folder', MAPPED_ELECTRON], { optionalMember: true }),
  'sessions.onCreated': callable<(listener: AcpListener<SessionUpsertEvent>) => RemoveListener>()(
    'sessions',
    ['session:created', EVENT]
  ),
  'sessions.onDeleted': callable<(listener: AcpListener<SessionDeletedEvent>) => RemoveListener>()(
    'sessions',
    ['session:deleted', EVENT]
  ),
  'sessions.onFlushAborted': callable<
    (listener: AcpListener<SessionPersistenceFlushAbortedEvent | undefined>) => RemoveListener
  >()('sessions', ['sessions:flush-aborted', EVENT], { optionalMember: true }),
  'sessions.onFlushRequest': callable<
    (listener: AcpListener<SessionPersistenceFlushRequest>) => RemoveListener
  >()('sessions', ['sessions:flush-request', EVENT], { optionalMember: true }),
  'sessions.onUpdated': callable<(listener: AcpListener<SessionUpsertEvent>) => RemoveListener>()(
    'sessions',
    ['session:updated', EVENT]
  ),
  'sessions.saveManifest': callable<(request: SaveSessionManifestRequest) => Promise<void>>()(
    'sessions',
    ['sessions:save-manifest']
  ),
  'sessions.saveSession': callable<
    (session: PersistedChatSession, options?: SaveSessionOptions) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:save-session', WEB, SESSION_SAVE, SESSION_SAVE_JSON]),
  'sessions.setDelegationPolicy': callable<
    (
      projectId: string,
      sessionId: string,
      policy: DelegationPolicy
    ) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:set-delegation-policy', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.sendFlushResponse': callable<(response: SessionPersistenceFlushResponse) => void>()(
    'sessions',
    ['sessions:flush-response', SEND],
    { optionalMember: true }
  ),
  'sessions.updateArchive': callable<
    (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  >()('sessions', ['sessions:update-archive', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessions.unlinkPdfContext': callable<
    (request: UnlinkSessionPdfContextRequest) => Promise<SessionRuntimeContext>
  >()('sessions', ['sessions:unlink-pdf-context', WEB, undefined, undefined, RUNTIME_VALIDATED])
} as const

export const sideChatCancelContracts = {
  'sideChat.cancel': callable<(request: SideChatSessionRequest) => Promise<void>>()('side-chat', [
    'side-chat:cancel',
    ELECTRON
  ]),
  'sideChat.close': callable<(request: SideChatCloseRequest) => Promise<void>>()('side-chat', [
    'side-chat:close',
    ELECTRON
  ]),
  'sideChat.list': callable<() => Promise<SideChatSnapshotList>>()('side-chat', [
    'side-chat:list',
    ELECTRON
  ]),
  'sideChat.onEvent': callable<(listener: AcpListener<SideChatRuntimeEvent>) => RemoveListener>()(
    'side-chat',
    ['side-chat:event', ELECTRON_EVENT]
  ),
  'sideChat.onRelayDelivered': callable<
    (listener: AcpListener<SideChatRelayDeliveredEvent>) => RemoveListener
  >()('side-chat', ['side-chat:relay-delivered', ELECTRON_EVENT]),
  'sideChat.send': callable<(request: SideChatPromptRequest) => Promise<void>>()('side-chat', [
    'side-chat:send',
    ELECTRON
  ]),
  'sideChat.start': callable<(request: SideChatStartRequest) => Promise<SideChatStartResponse>>()(
    'side-chat',
    ['side-chat:start', ELECTRON]
  )
} as const
