import type { AuthorizedDirectoryNotices } from '../local-fs/authorized-directories'
import type { EffectiveSpecialistSkills } from '@aipoch/specialists'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  AcpPermissionSettlementState,
  AcpRuntimeEvent,
  AcpStateUpdate
} from '../../shared/acp'
import type { AcpPermissionRequest } from '../../shared/acp-permission-contract'
import type { ArtifactLiteratureRequest } from '../../shared/artifact-literature'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import type { FileReference } from '../../shared/artifacts'
import type { LiteratureLibrarySaveResult } from '../../shared/literature-save'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type {
  NotebookExecutionRpcMethod,
  NotebookPromptInput,
  ShellRuntimeBinding
} from '../../shared/notebook'
import type { SideChatSendMessageRequest, SideChatSendMessageResult } from '../../shared/side-chat'
import type { UploadedAttachment } from '../../shared/uploads'
import type { AgentFramework, ResolvedAgentBackend } from '../agent-framework/types'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactRunRegistry } from '../artifacts/run-registry'
import type { LiteratureLibraryDiscovery } from '../literature/discovery-contract'
import type {
  LiteratureLibraryFormatDocumentResult,
  LiteratureLibraryFormatReferencesResult,
  LiteratureLibraryPrepareLatexResult,
  LiteratureLibraryReadAbstractResult,
  LiteratureLibraryReadPdfResult,
  LiteratureLibraryScope,
  LiteratureLibrarySearchResult
} from '../literature/library-mcp-server'
import type { LiteratureReadDocumentRequest } from '../literature/mcp-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type {
  AuthorizeNotebookRuntimeBindingAdmission,
  CanOwnNotebookRuntimeBindingDecision
} from '../notebook/runtime-binding-admission'
import type { NotebookHandoffContext } from '../notebook/session-read-model'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type {
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import type { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import type { PlanServiceDependencies } from '../session-plan/plan-service'
import type { PrepareSessionReading } from '../session-replay/session-reading'
import type { SkillImportRpcConnection } from '../skills/mcp-server'
import type { UploadRepository } from '../uploads/repository'
import type { ContextUsageTracker } from './context-usage-tracker'
import type { ImageInputCompatibilityPort } from './image-input-compatibility-port'
import type { AgentMcpHttpHost } from './mcp-http-host'
import type { ConversationPermissionGrantStore } from './permission-broker'
import type { SessionCapabilityPolicy } from './session-capability-owner'
import type { AcpTurnSkillHooks } from './turn-skill-owner'

export type AcpRuntimeCallbacks = {
  onStateChanged?: (state: AcpStateUpdate) => void
  onEvent?: (event: AcpRuntimeEvent) => void
  onPermissionRequest?: (request: AcpPermissionRequest) => void
  onPermissionSettled?: (requestId: string, state: AcpPermissionSettlementState) => void
  onPromptStarted?: (sessionId: string, turnToken: string, promptAttemptId?: string) => void
  // Fires after the provider prompt yields its first update/terminal response. Reaching this point
  // proves startup did not reject before the provider accepted the request.
  onProviderPromptAccepted?: (sessionId: string, promptAttemptId?: string) => void
  onCodexWebSocketFallback?: () => void
  onPromptEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onRetired?: () => void
}

export type AcpRuntimeOptions = {
  prepareSessionReading?: PrepareSessionReading
  classifySkills?: import('../../shared/classification').ClassifySkills
  classifyReadingRoute?: import('../../shared/classification').ClassifyReadingRoute
  hasPendingCredentialRequest?: (sessionId: string) => boolean
  appVersion: string
  defaultCwd: string
  // Disposable framework homes must retain the same read protection as app-owned config roots.
  additionalProtectedReadRoots?: readonly string[]
  callbacks?: AcpRuntimeCallbacks
  auxiliaryUsage?: Readonly<{
    projectIdForSession: (sessionId: string) => Promise<string | undefined>
    record: (
      input: import('../session-persistence/auxiliary-turn-usage').SessionAuxiliaryTurnUsageRecord
    ) => Promise<unknown>
  }>
  permissionGrantStore?: ConversationPermissionGrantStore
  permissionGrantRegistry?: PermissionGrantRegistry
  permissionGrantContext?: Readonly<{ projectId: string; sessionId: string }>
  // Replaces only physical process creation. Backend identity and initialization material still come
  // from resolveBackend when it is available.
  spawnAgent?: () => ChildProcessWithoutNullStreams
  // Resolves the active agent backend (framework + spawn inputs) at connect time so a framework or
  // provider switch takes effect on reconnect.
  resolveBackend?: (context: {
    forcedSkillIds: string[]
    skillWhitelist?: string[]
    systemPromptAppends: string[]
    grantedLocalRoots?: readonly Pick<GrantedLocalRoot, 'path' | 'access'>[]
  }) => Promise<ResolvedAgentBackend> | ResolvedAgentBackend
  artifacts?: AcpRuntimeArtifactOptions
  runtimeSessions?: RuntimeSessionOwner
  uploads?: AcpRuntimeUploadOptions
  // Resolves a granted local root and its current access level (backed by the GrantedLocalRoot
  // table), enabling the linked-folder file-reference adapter. Absent ⇒ linked-folder references
  // stay unavailable.
  authorizedDirectories?: Pick<AuthorizedDirectoryNotices, 'initialize' | 'prepareNotice'>
  grantedRoots?: {
    list?: () => Promise<readonly Pick<GrantedLocalRoot, 'path' | 'access'>[]>
    resolveRoot: (rootId: string) => Promise<Pick<GrantedLocalRoot, 'path' | 'access'> | undefined>
  }
  notebook?: AcpRuntimeNotebookOptions
  wslSetupSessions?: Readonly<{
    authorizeToken(token: unknown): boolean
    bind(token: string, sessionId: string): Promise<void>
    isBound(sessionId: string): Promise<boolean>
  }>
  memory?: {
    isEnabled?(): Promise<boolean>
    recallForPrompt(
      requestText: string,
      context: { projectId: string }
    ): Promise<string | undefined>
  }
  skillImport?: AcpRuntimeSkillImportOptions
  skills?: AcpTurnSkillHooks
  plan?: AcpRuntimePlanOptions
  permissionWait?: {
    sessions: SessionRuntimeContextCommands &
      Pick<SessionCatalog, 'containsMessageOnActiveBranch' | 'loadSessionForContinuation'> &
      Partial<Pick<SessionCatalog, 'sessionProjectId'> & SessionMutation>
    onSessionUpdated?: import('./permission-wait-owner').PublishPermissionWaitSession
    onContinuationSessionUpdated?: import('./permission-wait-owner').PublishPermissionWaitSession
  }
  sideChat?: Readonly<{
    sendMessage: (
      routingId: string,
      request: SideChatSendMessageRequest
    ) => Promise<SideChatSendMessageResult>
  }>
  literature?: Readonly<{
    elements?: import('../literature/pdf-structure/agent-reader').PdfElementTools
    isEnabled: (appSessionId: string, projectId: string) => Promise<boolean>
    resolveAttachmentVersion?: (versionId: string) => Promise<
      | Readonly<{
          path: string
          filename: string
          contentType: string
        }>
      | undefined
    >
    readDocument: (request: {
      projectId: string
      sessionId: string
      promptMessageId: string
      input: LiteratureReadDocumentRequest
    }) => Promise<unknown>
  }>
  literatureLibrary?: Readonly<{
    acquirePdf?: (request: {
      candidate: LiteratureLibraryDiscovery
      pdfUrl?: string
      signal?: AbortSignal
      projectId: string
      sessionId: string
    }) => Promise<import('../literature/agent-pdf-acquisition').AgentPdfAcquisitionResult>
    resolveSaveReferences?: (
      references: readonly string[],
      signal?: AbortSignal
    ) => Promise<readonly LiteratureLibraryDiscovery[]>
    searchLibrary: (request: {
      projectId: string
      query?: string
      scope?: LiteratureLibraryScope
      collectionId?: string
      itemIds?: readonly string[]
      offset?: number
      limit?: number
    }) => Promise<LiteratureLibrarySearchResult>
    readAbstract: (request: {
      projectId: string
      itemId: string
      scope?: LiteratureLibraryScope
      collectionId?: string
    }) => Promise<LiteratureLibraryReadAbstractResult | undefined>
    readPdf: (request: {
      projectId: string
      itemId: string
      attachmentId?: string
      query: string
      scope?: LiteratureLibraryScope
      collectionId?: string
    }) => Promise<LiteratureLibraryReadPdfResult | undefined>
    readCandidateFile?: (request: {
      projectId: string
      sessionId: string
      workspaceCwd: string
      filename: string
      signal?: AbortSignal
    }) => Promise<string>
    formatReferences?: (request: {
      projectId: string
      itemIds: readonly string[]
      styleId: import('@aipoch/literature-citations/contracts').LiteratureCitationStyle
      locale: import('@aipoch/literature-citations/contracts').LiteratureCitationLocale
    }) => Promise<LiteratureLibraryFormatReferencesResult>
    formatCitationDocument?: (request: {
      projectId: string
      sessionId: string
      workspaceCwd: string
      filename: string
      styleId: import('@aipoch/literature-citations/contracts').LiteratureCitationStyle
      locale: import('@aipoch/literature-citations/contracts').LiteratureCitationLocale
    }) => Promise<
      LiteratureLibraryFormatDocumentResult & {
        contentBase64: string
        literature: ArtifactLiteratureRequest
      }
    >
    prepareLatexBundle?: (request: {
      projectId: string
      sessionId: string
      workspaceCwd: string
      filename: string
    }) => Promise<
      LiteratureLibraryPrepareLatexResult & {
        contentBase64: string
        literature: ArtifactLiteratureRequest
      }
    >
    saveToInbox: (request: {
      projectId: string
      sessionId: string
      candidates: readonly LiteratureLibraryDiscovery[]
      signal?: AbortSignal
    }) => Promise<LiteratureLibrarySaveResult>
  }>
  sideChatRelays?: Readonly<{
    claim: (parentSessionId: string) =>
      | Readonly<{
          historyPreamble: string
          commit: (promptMessageId?: string) => void | Promise<void>
          restore: () => void
        }>
      | undefined
  }>
  sessionCapabilityPolicy?: SessionCapabilityPolicy
  // The agent backend to drive. Defaults to Claude Code; selecting another (opencode) swaps only the
  // framework-coupled behavior (spawn, session meta, permission-mode mapping) via AgentFramework.
  framework?: AgentFramework
  // Local http host for app-owned session MCP servers, used for frameworks that reject stdio MCP.
  // Absent ⇒ those frameworks run without the corresponding app tooling.
  mcpHttpHost?: AgentMcpHttpHost
  // Bounds inactivity while reconnecting or resuming. Target-session provider events renew the
  // resume deadline; the fast attached-session path is never timed. Injectable timers keep tests
  // deterministic.
  resumeTimeoutMs?: number
  cancelTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  // Per-session cumulative inlined-image budget in base64 bytes. Defaults to MAX_SESSION_INLINE_IMAGE_BYTES;
  // injectable so tests can drive the degrade-to-file path with small fixtures.
  inlineImageBudgetBytes?: number
  imageInputCompatibility?: Pick<ImageInputCompatibilityPort, 'isAvailable' | 'prepare'>
  hasReplayableImageHistory?: (projectId: string, sessionId: string) => Promise<boolean>
  contextUsageTracker?: ContextUsageTracker
  // Injectable only for the authenticated OpenCode loopback usage snapshots; production uses fetch.
  opencodeUsageFetch?: typeof fetch
  // Resolves the identity-inject text for a specialist UUID at session-creation time.
  // The main process reads the latest Profile from SpecialistService; the runtime never caches it.
  // Returns undefined when the specialist is not found, disabled, or its Profile is corrupt —
  // the caller should have validated before calling createSession.
  resolveSpecialistIdentity?: (
    specialistId: string,
    framework: string
  ) => Promise<{ append: string; prefix: string } | undefined>
  // Re-resolves capabilities from the latest Specialist profile and installed catalog. This is
  // intentionally separate from Main Agent enablement: a Main-disabled installed Skill remains
  // eligible for a Specialist.
  resolveSpecialistSkills?: (specialistId: string) => Promise<EffectiveSpecialistSkills>
  // Resolves the project's Agent Context (a system prompt append) at session setup time. The ACP
  // projectId carries the Project id. Returns undefined when absent or on lookup failure.
  resolveProjectAgentContext?: (projectId: string) => Promise<string | undefined>
  // Reads the Session authority's current Compute execution targets at each Turn. The ids are used
  // only to decide whether the fixed execution directive applies; host inventory stays in the
  // runtime host.compute discovery seam.
  resolveComputeExecutionTargetIds?: (sessionId: string) => readonly string[]
}

export type AcpRuntimeArtifactOptions = {
  // Config root: where the app-owned claude config dir lives (never relocated).
  configRoot: string
  // Data root: where artifacts/notebooks/runtime live (user-relocatable).
  dataRoot: string
  projectId: string
  mcpEntryPath: string
  mcpCommand?: string
  repository?: ArtifactRepository
  runRegistry?: ArtifactRunRegistry
  getRpcConnection?: () => Promise<NotebookRpcConnection>
  issueRpcCapability?: (binding: ArtifactRpcCapabilityBinding) => string
  revokeRpcCapability?: (token: string) => Promise<void> | void
  // When present, the caller already owns the execution Artifact turn. Runtime only provisions the
  // MCP transport against this exact handoff and never opens a competing root turn.
  currentRunFile?: string
  provenance?: Pick<
    import('../artifacts/provenance-repository').ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<
      Pick<
        import('../artifacts/provenance-repository').ArtifactProvenanceRepository,
        | 'recordLiteraturePdfRead'
        | 'recordLiteratureAbstractRead'
        | 'recordLiteratureSearch'
        | 'withSessionMutation'
      >
    >
  managedFileVersions?: Pick<
    import('../managed-file-versions/service').ManagedFileVersionService,
    'openLatest' | 'openVersion' | 'openUnpublishedVersion'
  >
}

export type AcpRuntimeUploadOptions = {
  repository: UploadRepository
}

export type AcpRuntimeNotebookOptions = {
  authorizeRuntimeBindingAdmission?: AuthorizeNotebookRuntimeBindingAdmission
  canOwnRuntimeBindingDecision?: CanOwnNotebookRuntimeBindingDecision
  projectId: string
  mcpEntryPath: string
  mcpCommand?: string
  memoryTools?: boolean
  isMemoryEnabled?: () => Promise<boolean>
  getShellRuntimeBinding?: () => ShellRuntimeBinding | Promise<ShellRuntimeBinding>
  getRpcConnection?: (binding: {
    sessionId: string
    projectId: string
    memoryTools: boolean
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string, capabilityTokens: readonly string[]) => void
  registerSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => void
  authorizeExecution?: (authorization: {
    sessionId: string
    toolCallId: string
    promptMessageId: string
    method: NotebookExecutionRpcMethod
    rawInput?: unknown
  }) => string | undefined
  setArtifactTurnBinding?: (
    sessionId: string,
    binding: {
      ownerExecutionId: string
      projectId: string
      provenanceContext: import('../../shared/notebook').NotebookRunProvenanceContext
    }
  ) => void
  clearArtifactTurnBinding?: (sessionId: string, ownerExecutionId: string) => void | Promise<void>
  prepareTurnInputs?: (request: {
    projectId: string
    appSessionId: string
    promptMessageId: string
    uploads: UploadedAttachment[]
    references: FileReference[]
  }) => Promise<{ inputs: readonly NotebookPromptInput[]; commit: () => void }>
  registerTurnInputs?: (request: {
    projectId: string
    appSessionId: string
    promptMessageId: string
    uploads: UploadedAttachment[]
    references: FileReference[]
    materializeOnly?: boolean
  }) => Promise<readonly NotebookPromptInput[] | void>
  peekHandoffContext?: (sessionId: string) => NotebookHandoffContext | undefined
}

export type AcpRuntimeSkillImportOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  // Read when building each agent session so a settings-triggered reconnect can add/remove the MCP
  // without constructing a new application service or keeping stale prompt guidance.
  isEnabled?: () => Promise<boolean>
  getRpcConnection: (binding: { sessionId: string }) => Promise<SkillImportRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string, capabilityTokens: readonly string[]) => void
  authorizeReferencedUploads?: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
}

export type AcpRuntimePlanOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection: (binding: {
    sessionId: string
    projectId: string
    replaceExisting: false
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  sessions: SessionRuntimeContextCommands &
    SessionMutation &
    Pick<SessionCatalog, 'containsMessageOnActiveBranch' | 'loadSessionForContinuation'>
  onApprovalRequested?: PlanServiceDependencies['onApprovalRequested']
  onApprovalSettled?: PlanServiceDependencies['onApprovalSettled']
}
