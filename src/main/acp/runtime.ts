import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  CreateElicitationResponse,
  PromptResponse
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpCancelPromptRequest,
  type AcpCompactSessionRequest,
  type AcpConnectRequest,
  type AcpCreateSessionRequest,
  type AcpCreateSessionResponse,
  type AcpRuntimeEvent,
  type AcpRuntimeEventInput,
  type AcpDeleteSessionRequest,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpPermissionSettlementState,
  type ElicitationResponse,
  type AcpPromptRequest,
  type AcpSteerFollowUpRequest,
  type AcpSteerFollowUpResult,
  type AcpResumeSessionRequest,
  type AcpRevokePermissionGrantRequest,
  type AcpRuntimeState,
  type AcpSetPermissionProfileRequest,
  type AcpStateSnapshot,
  type AcpStateUpdate
} from '../../shared/acp'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { isCodexSubscriptionProviderId, type AgentFrameworkId } from '../../shared/settings'
import {
  sanitizeSessionReferences,
  type MessageAttribution
} from '../../shared/session-persistence'
import {
  sanitizeAgentUserChoiceRequest,
  type AgentUserChoiceRequest,
  type AgentUserChoiceResult,
  type ElicitationField,
  type PendingElicitationRequest
} from '../../shared/elicitation'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { SideChatSendMessageRequest, SideChatSendMessageResult } from '../../shared/side-chat'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import {
  type AgentFramework,
  type AgentModelChangeTarget,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import type { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { buildSessionReferencePrompt } from './session-reference-prompt'
import { ConversationPermissionGrantStore, type AppPermissionRequest } from './permission-broker'
import { HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import type { AcpPermissionContext } from './permission-context'
import { AgentMcpHttpHost } from './mcp-http-host'
import type { AcpSessionCapabilityOwner, SessionCapabilityPolicy } from './session-capability-owner'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import type { NotebookExecutionRpcMethod, NotebookPromptInput } from '../../shared/notebook'
import type { SkillImportRpcConnection } from '../skills/mcp-server'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { withDataRootWrite } from '../storage/migration-state'
import { opencodeStorageDir } from '../agent-framework/opencode'
import type { UploadRepository } from '../uploads/repository'
import {
  LITERATURE_MCP_SERVER_NAME,
  type LiteratureReadDocumentRequest
} from '../literature/mcp-server'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, FileReference } from '../../shared/artifacts'
import type {
  AppGeneratedArtifactProducer,
  ArtifactRpcCapabilityBinding
} from '../../shared/artifact-provenance'
import { resolveFileTextBudget, type HistoryReplayDescriptor } from '../../shared/history-preamble'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import type { AcpAppContinuationOwner } from './app-continuation-owner'
import type { ContextUsageTracker } from './context-usage-tracker'
import type { ImageInputCompatibilityOwner } from './image-input-compatibility-owner'
import type { AcpElicitationOwner } from './elicitation-owner'
import type {
  ReviewerSessionOwner,
  ReviewerSessionDisposition,
  ReviewerSessionRequest,
  ReviewerSessionResult
} from './reviewer-session-owner'
import type { ArtifactTurnOwner } from './artifact-turn-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import {
  AcpNativeFollowUpWorkflow,
  finalizeNativeFollowUpPreparedContent,
  type NativeFollowUpPreparedContent
} from './native-follow-up-workflow'
import type { AcpSessionRegistry } from './session-registry'
import type {
  AcpConnectionResourceOwner,
  AcpConnectionResourceAttempt
} from './connection-resource-owner'
import {
  AcpAgentConnectionAdapter,
  type AcpAgentConnectionCandidate,
  type AcpAgentConnectionHooks
} from './agent-connection-adapter'
import type { AcpConnectionTransitionOwner } from './connection-transition-owner'
import type { AcpGenerationActivityOwner } from './generation-activity-owner'
import type { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import type {
  AcpBackendGenerationOwner,
  AcpBackendGenerationView
} from './backend-generation-owner'
import type { AcpSessionConfigurator } from './session-configurator'
import type { AcpSessionUpdateProjector } from './session-update-projector'
import type { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'
import type { AcpConnectionCloseWorkflow } from './connection-close-workflow'
import type { AcpModelChangeWorkflow } from './model-change-workflow'
import type { AcpProviderSessionCreator } from './provider-session-creator'
import type { AcpProviderSessionResumer } from './provider-session-resumer'
import type { AcpSessionReplacementWorkflow } from './session-replacement-workflow'
import type { AcpSessionDeletionWorkflow } from './session-deletion-workflow'
import type { AcpPromptContentOwner } from './prompt-content-owner'
import type { AcpPromptTurnWorkflow } from './prompt-turn-workflow'
import type { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import type { AcpProviderPromptExecutor } from './provider-prompt-executor'
import {
  codeBuddySkillRuntimeRoot,
  followUpPromptText,
  type AcpTurnSkillHooks,
  type AcpTurnSkillOwner
} from './turn-skill-owner'
import type { PlanResponseResult, PlanServiceDependencies } from '../session-plan/plan-service'
import { SessionPlanContinuationOwner } from './session-plan-continuation-owner'
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { AcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimePublicationOwner } from './runtime-publication-owner'
import type { AcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpSessionEnvironmentPolicy } from './session-environment-policy'
import { composeAcpRuntimeLifecycleOwners } from './runtime-lifecycle-composition'
import { composeAcpRuntimeProviderSessionOwners } from './runtime-provider-session-composition'
import { composeAcpRuntimePromptOwners } from './runtime-prompt-composition'
import {
  composeAcpRuntimePlanWorkflow,
  type AcpRuntimePlanWorkflow,
  type AcpSessionPlanCall
} from './runtime-plan-composition'

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

type AcpRuntimeOptions = {
  appVersion: string
  defaultCwd: string
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
    systemPromptAppends: string[]
  }) => Promise<ResolvedAgentBackend> | ResolvedAgentBackend
  artifacts?: AcpRuntimeArtifactOptions
  uploads?: AcpRuntimeUploadOptions
  // Resolves a granted local root and its current access level (backed by the GrantedLocalRoot
  // table), enabling the linked-folder file-reference adapter. Absent ⇒ linked-folder references
  // stay unavailable.
  grantedRoots?: {
    resolveRoot: (rootId: string) => Promise<Pick<GrantedLocalRoot, 'path' | 'access'> | undefined>
  }
  notebook?: AcpRuntimeNotebookOptions
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
    sessions: Pick<
      SessionPersistenceCoordinator,
      | 'readSessionRuntimeContext'
      | 'patchSessionRuntimeContext'
      | 'containsMessageOnActiveBranch'
      | 'loadSessionForContinuation'
    > &
      Partial<
        Pick<SessionPersistenceCoordinator, 'appendUserMessageToInteraction' | 'sessionProjectId'>
      >
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
    isEnabled: (appSessionId: string, projectId: string) => Promise<boolean>
    readDocument: (request: {
      projectId: string
      sessionId: string
      promptMessageId: string
      input: LiteratureReadDocumentRequest
    }) => Promise<unknown>
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
  imageInputCompatibility?: Pick<ImageInputCompatibilityOwner, 'isAvailable' | 'prepare'>
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

type AcpRuntimeArtifactOptions = {
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
  >
  managedFileVersions?: Pick<
    import('../managed-file-versions/service').ManagedFileVersionService,
    'openLatest' | 'openVersion' | 'openUnpublishedVersion'
  >
}

type AcpRuntimeUploadOptions = {
  repository: UploadRepository
}

type AcpRuntimeNotebookOptions = {
  projectId: string
  mcpEntryPath: string
  mcpCommand?: string
  memoryTools?: boolean
  getRpcConnection?: (binding: {
    sessionId: string
    projectId: string
    memoryTools: boolean
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string) => void
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
  clearArtifactTurnBinding?: (sessionId: string, ownerExecutionId: string) => void
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

type AcpRuntimeSkillImportOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  // Read when building each agent session so a settings-triggered reconnect can add/remove the MCP
  // without constructing a new application service or keeping stale prompt guidance.
  isEnabled?: () => Promise<boolean>
  getRpcConnection: (binding: { sessionId: string }) => Promise<SkillImportRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string) => void
  authorizeReferencedUploads?: (
    projectId: string,
    sessionId: string,
    paths: string[]
  ) => Promise<() => void>
}

type AcpRuntimePlanOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection: (binding: {
    sessionId: string
    projectId: string
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  sessions: Pick<
    SessionPersistenceCoordinator,
    | 'readSessionRuntimeContext'
    | 'patchSessionRuntimeContext'
    | 'appendUserMessageToInteraction'
    | 'containsMessageOnActiveBranch'
    | 'loadSessionForContinuation'
  >
  onApprovalRequested?: PlanServiceDependencies['onApprovalRequested']
  onApprovalSettled?: PlanServiceDependencies['onApprovalSettled']
}
// Converts unknown thrown values into user-visible error text. Total AND always returns a string: a
// hostile message getter or a throwing String() coercion (e.g. a Proxy-wrapped Error) must not escape,
// and a non-string message (object/bigint/Symbol/undefined) must be coerced — this text flows into the
// state snapshot and event payloads that get structured-cloned to the renderer, where a raw Symbol or
// throwing value would break the broadcast.
const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const log = createLogger('acp')
const literatureLog = createLogger('literature-reading-context')

const PERMISSION_DENIED_CONTINUATION_TEXT =
  'The user explicitly denied this operation. You do not have authorization to perform it. ' +
  'Do not retry or approximate the denied operation with a different command, tool, or route, ' +
  'and do not request permission for it again in this turn. Continue only with independent work ' +
  'that is already permitted. If the denied operation is required, explain the boundary and wait ' +
  'for the user to explicitly change their decision in a new message.'

const PERMISSION_CANCELLED_CONTINUATION_TEXT =
  'The pending permission interaction was cancelled without granting authorization. Do not ' +
  'execute or retry the parked tool call unless the user explicitly approves it later. Continue ' +
  'only with independent work that is already permitted, or explain what cannot be completed.'

const PLAN_CONTINUATION_CLAIM_MAX_ATTEMPTS = 3
const PLAN_CONTINUATION_CLAIM_RETRY_BASE_DELAY_MS = 25
const AGENT_STDERR_REPORT_WINDOW_MS = 1000
const MAX_RAW_AGENT_STDERR_SAMPLE_BYTES = 4096
const CODEX_TRANSPORT_SIGNAL_SAMPLE_CHARACTERS = 512
// Support-only opt-in. Raw agent stderr can contain research data, local paths, and tool output.
const RAW_AGENT_STDERR_ENV = 'OPEN_SCIENCE_AGENT_STDERR'

// Preserve the renderer's existing suppression for the two exact informational diagnostics Codex
// emits during successful turns. Evaluate each adapter-delivered stderr block independently, as the
// pre-aggregation event path did; any additional content makes the whole window actionable.
const isNonActionableCodexStderr = (text: string): boolean => {
  const withoutSkillBudgetNotice = text.replace(
    /Warning:\s*Skill descriptions were shortened to fit the 2% skills context budget\.\s*Codex can still see every skill, but some descriptions are shorter\.\s*Disable unused skills or plugins to leave more room for the rest\.\s*/gi,
    ''
  )
  const withoutTransportFallback = withoutSkillBudgetNotice.replace(
    /Warning:\s*Falling\s*back\s*from\s*WebSockets\s*to\s*HTTPS\s*transport\.\s*request\s*timed\s*out\s*/gi,
    ''
  )

  return withoutTransportFallback.trim().length === 0
}

const hasCodexWebSocketFallback = (text: string): boolean =>
  /Warning:\s*Falling\s*back\s*from\s*WebSockets\s*to\s*HTTPS\s*transport\.\s*request\s*timed\s*out\s*/i.test(
    text
  )

const utf8PrefixWithinBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  // Do not retain half of a UTF-16 surrogate pair at the byte boundary.
  if (low > 0 && value.charCodeAt(low - 1) >= 0xd800 && value.charCodeAt(low - 1) <= 0xdbff) {
    low -= 1
  }
  return value.slice(0, low)
}

type AgentStderrWindow = {
  process: ChildProcessWithoutNullStreams
  framework: AgentFrameworkId
  epoch: number
  startedAt: number
  chunkCount: number
  byteCount: number
  rawSample: string
  rawSampleBytes: number
  rawSampleTruncated: boolean
  sessionId?: string
  interactionSequence?: number
  sessionAttributionConsistent: boolean
  nonActionableCodexOnly: boolean
  codexTransportSignalSample: string
  codexWebSocketFallbackObserved: boolean
  eventEligible: boolean
  timer: ReturnType<typeof setTimeout>
}

type PlanContinuationClaimRetry = {
  commandId: string
  failedAttempts: number
  timer?: ReturnType<typeof setTimeout>
}

// Logs an error without ever throwing back into the caller. Used on failure paths where a throwing
// logger (or a hostile payload) must never mask the original error being handled/re-thrown.
const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

// ACP Session facade. Connection publication and physical teardown live behind their epoch owner;
// Runtime retains protocol startup, Session/Permission/Notebook cleanup, and status/event projection.
class AcpRuntime {
  private readonly snapshotOwner: AcpRuntimeSnapshotOwner
  private readonly connectionAdapter: AcpAgentConnectionAdapter
  private readonly connectionResources: AcpConnectionResourceOwner
  private readonly connectionTransitions: AcpConnectionTransitionOwner
  private readonly generationActivity: AcpGenerationActivityOwner
  // Stable app identities, provider aliases, publication order, selection, and startup/delete
  // arbitration share one owner. The runtime retains only protocol/resource orchestration.
  private readonly sessionRegistry: AcpSessionRegistry
  // App-owned MCP construction, routing aliases, and bearer lease ownership are kept behind one
  // explicit role policy. Connection/process lifetime remains with the connection resource owner.
  private readonly sessionInteractions: AcpSessionInteractionOwner
  private readonly elicitationOwner: AcpElicitationOwner
  private readonly appContinuations: AcpAppContinuationOwner
  private readonly userChoiceProvenanceContexts = new Map<
    string,
    Readonly<{
      sessionId: string
      provenanceContext?: NonNullable<AcpPromptRequest['provenanceContext']>
      memoryEnabled?: boolean
      referencedSessions?: AcpPromptRequest['referencedSessions']
    }>
  >()
  private readonly durableContinuationContext: AcpRuntimeSessionOwners['durableContinuationContext']
  private readonly permissionWaitOwner: AcpRuntimeSessionOwners['permissionWaitOwner']
  private readonly planContinuationOwner: SessionPlanContinuationOwner | undefined
  private durablePermissionContinuations?: Map<
    string,
    { projectId: string; requestId: string; cancellationRequested?: boolean }
  >
  private durablePlanContinuations?: Map<string, { projectId: string; commandId: string }>
  private readonly planContinuationClaimRetries = new Map<string, PlanContinuationClaimRetry>()
  private readonly agentStderrWindows = new Map<ChildProcessWithoutNullStreams, AgentStderrWindow>()
  private restoredContinuationContextResetSessionIds?: Set<string>
  // Ephemeral Reviewer identity, isolation, permission, and resource state lives behind one owner.
  private readonly reviewerSessions: ReviewerSessionOwner
  private readonly turnSkills: AcpTurnSkillOwner
  private readonly handoffContinuity: AcpHandoffContinuityOwner
  private readonly permissionContext: AcpPermissionContext
  private readonly clientInteractions: AcpRuntimeSessionOwners['clientInteractions']
  private readonly publication: AcpRuntimePublicationOwner
  private readonly sessionEnvironment: AcpSessionEnvironmentPolicy
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly backendGeneration: AcpBackendGenerationOwner
  private readonly sessionConfigurator: AcpSessionConfigurator
  private readonly sessionCapabilities: AcpSessionCapabilityOwner
  private readonly sessionUpdateProjector: AcpSessionUpdateProjector
  private readonly providerPromptExecutor: AcpProviderPromptExecutor
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly artifactTurns: ArtifactTurnOwner | undefined
  private readonly sessionPlanWorkflow: AcpRuntimePlanWorkflow
  private readonly contextCompactionWorkflow: AcpContextCompactionWorkflow
  private readonly promptTurnWorkflow: AcpPromptTurnWorkflow
  private readonly promptContent: AcpPromptContentOwner
  private readonly nativeFollowUp: AcpNativeFollowUpWorkflow
  private readonly connectionClose: AcpConnectionCloseWorkflow
  private readonly connectionLifecycle: AcpConnectionLifecycleWorkflow
  private readonly modelChanges: AcpModelChangeWorkflow
  private readonly providerSessionCreator: AcpProviderSessionCreator
  private readonly providerSessionResumer: AcpProviderSessionResumer
  private readonly sessionReplacement: AcpSessionReplacementWorkflow
  private readonly sessionDeletion: AcpSessionDeletionWorkflow
  private readonly permissionProfileChanges = new Map<
    string,
    { revision: number; tail: Promise<void> }
  >()

  // Wires runtime dependencies and forwards permission prompts into the event stream.
  constructor(
    private readonly options: AcpRuntimeOptions,
    base: AcpRuntimeBaseOwners,
    session: AcpRuntimeSessionOwners
  ) {
    this.spawnAgent = options.spawnAgent
    this.artifactOptions = options.artifacts
    this.snapshotOwner = base.snapshotOwner
    this.connectionAdapter = base.connectionAdapter
    this.connectionResources = base.connectionResources
    this.backendGeneration = base.backendGeneration
    this.providerPromptExecutor = base.providerPromptExecutor
    this.sessionInteractions = base.sessionInteractions
    this.artifactTurns = base.artifactTurns
    this.handoffContinuity = base.handoffContinuity
    this.generationActivity = base.generationActivity
    this.connectionTransitions = base.connectionTransitions
    this.turnSkills = base.turnSkills
    this.sessionConfigurator = base.sessionConfigurator
    this.sessionCapabilities = base.sessionCapabilities
    this.sessionRegistry = session.sessionRegistry
    this.sessionEnvironment = session.sessionEnvironment
    this.publication = session.publication
    this.permissionContext = session.permissionContext
    this.clientInteractions = session.clientInteractions
    this.elicitationOwner = session.elicitationOwner
    this.durableContinuationContext = session.durableContinuationContext
    this.permissionWaitOwner = session.permissionWaitOwner
    this.planContinuationOwner = options.plan
      ? new SessionPlanContinuationOwner(options.plan.sessions)
      : undefined
    this.appContinuations = session.appContinuations
    this.reviewerSessions = session.reviewerSessions
    this.sessionUpdateProjector = session.sessionUpdateProjector
    this.sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(options, base, session, {
      continuations: this.planContinuationOwner
    })
    const prompt = composeAcpRuntimePromptOwners(options, base, session, {
      plan: this.sessionPlanWorkflow.prompt,
      reload: {
        disconnect: () => this.disconnect(false),
        resume: (request) => this.resumeSession(request)
      },
      onPromptEnded: (sessionId, turnToken) => this.nativeFollowUp.releaseTurn(sessionId, turnToken)
    })
    this.contextCompactionWorkflow = prompt.contextCompactionWorkflow
    this.promptTurnWorkflow = prompt.promptTurnWorkflow
    this.promptContent = base.promptContentOwner
    this.nativeFollowUp = new AcpNativeFollowUpWorkflow({
      connection: () => this.connection,
      capabilities: () => this.connectionResources.capabilities,
      frameworkId: () => this.framework.id,
      openCodeUsageApi: () => this.backendGeneration.openCodeUsageApi(),
      activeProviderSessionId: (sessionId) => this.activeSessionFor(sessionId)?.sessionId,
      hasLivePrompt: (sessionId) => this.sessionInteractions.current(sessionId)?.kind === 'prompt',
      hasPendingPermission: (sessionId) => this.permissionContext.hasPendingForSession(sessionId),
      livePrompt: (sessionId) => {
        const current = this.sessionInteractions.current(sessionId)
        return current?.kind === 'prompt'
          ? {
              turnToken: current.turnToken,
              signal: current.signal,
              ...(current.promptMessageId ? { promptMessageId: current.promptMessageId } : {})
            }
          : undefined
      },
      sessionCwd: (sessionId) => this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd,
      prepareFollowUp: (request) => this.prepareNativeFollowUpContent(request),
      ...(this.options.notebook?.registerTurnInputs
        ? { registerTurnInputs: this.options.notebook.registerTurnInputs }
        : {}),
      publishUserMessage: ({ sessionId, messageId, text, uploads, parts }) =>
        this.publication.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId,
          messageId,
          role: 'user',
          text,
          ...(uploads && uploads.length > 0 ? { uploads: [...uploads] } : {}),
          ...(parts && parts.length > 0 ? { parts: [...parts] } : {})
        })
    })
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: (request) => this.connect(request),
      disconnect: (emitClosedStatus) => this.disconnect(emitClosedStatus),
      clearPromptResources: () => this.nativeFollowUp.clear(),
      openAgentConnection: (attempt, onFrameworkResolved) =>
        this.openAgentConnection(attempt, onFrameworkResolved)
    })
    this.modelChanges = lifecycle.modelChanges
    this.connectionClose = lifecycle.connectionClose
    this.connectionLifecycle = lifecycle.connectionLifecycle
    const providerSessions = composeAcpRuntimeProviderSessionOwners(
      options,
      base,
      session,
      lifecycle,
      {
        clearUserChoiceProvenanceForSession: (sessionId) =>
          this.clearUserChoiceProvenanceForSession(sessionId),
        releasePromptResourcesForSession: (sessionId) =>
          this.nativeFollowUp.releaseSession(sessionId)
      }
    )
    this.providerSessionCreator = providerSessions.providerSessionCreator
    this.providerSessionResumer = providerSessions.providerSessionResumer
    this.sessionReplacement = providerSessions.sessionReplacement
    this.sessionDeletion = providerSessions.sessionDeletion
  }

  private get backend(): AcpBackendGenerationView {
    return this.backendGeneration.current
  }

  private get framework(): AgentFramework {
    return this.backend.framework
  }

  private get connection(): ClientConnection | undefined {
    return this.connectionResources.connection
  }

  private get reconnectBarrier(): Promise<void> | undefined {
    return this.connectionTransitions.barrier
  }

  private get connectionGeneration(): number {
    return this.connectionResources.epoch
  }

  private activeSessionFor(appSessionId: string): ActiveSession | undefined {
    return this.sessionRegistry.lookup(appSessionId)?.attachment?.session
  }

  private activeSessionEntries(): Array<readonly [string, ActiveSession]> {
    return this.sessionRegistry
      .entries(true)
      .flatMap(({ appSessionId, attachment }) =>
        attachment ? [[appSessionId, attachment.session] as const] : []
      )
  }

  private activeSessionIds(): string[] {
    return this.activeSessionEntries().map(([appSessionId]) => appSessionId)
  }

  // Boundary-safe context for session-creation and process-spawn diagnostics. Keep this list explicit:
  // workspace paths, request/provider payloads, model research content, and credentials do not belong
  // in these lifecycle records.
  private diagnosticContext(
    framework: AgentFramework['id'] = this.framework.id,
    generation = this.connectionGeneration
  ): { framework: AgentFramework['id']; generation: number; status: AcpStateSnapshot['status'] } {
    return { framework, generation, status: this.snapshotOwner.status }
  }

  // Returns an immutable renderer-facing view of connection and session state.
  getSnapshot(): AcpStateSnapshot {
    return this.publication.getSnapshot()
  }

  getState(): AcpRuntimeState {
    return this.publication.getState()
  }

  captureBackend(): AcpBackendGenerationView {
    return this.backend
  }

  beginProviderTurnObservation(input: {
    providerSessionId: string
    cwd: string
  }): ReturnType<AcpProviderPromptExecutor['beginObservation']> {
    return this.providerPromptExecutor.beginObservation({
      ...input,
      frameworkId: this.framework.id
    })
  }

  captureSessionModel(
    sessionId: string
  ): Readonly<{ backend: AcpBackendGenerationView; appliedModel?: string }> | undefined {
    const record = this.sessionRegistry.lookup(sessionId)
    if (!record?.attachment) return undefined
    const aggregate = record.aggregate.snapshot()
    return Object.freeze({
      backend: this.backend,
      ...(aggregate.appliedModel ? { appliedModel: aggregate.appliedModel } : {})
    })
  }

  callSessionPlan(input: AcpSessionPlanCall): Promise<unknown> {
    return this.sessionPlanWorkflow.call(input)
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): Promise<ActivePlanProjection | null> {
    return this.sessionPlanWorkflow.projection(projectId, sessionId)
  }

  async respondSessionPlan(input: PlanResponseCommand): Promise<PlanResponseResult> {
    const result = await this.sessionPlanWorkflow.respond(input)
    const continuationProjection =
      'projection' in result ? result.projection : result.continuationProjection
    if (continuationProjection?.continuationState === 'queued') {
      this.scheduleQueuedPlanContinuation(input.projectId, input.sessionId)
    }
    return result
  }

  // Lists sessions with an in-flight prompt, for the pre-migration active-session warning.
  getActivePromptSessions(): { projectId: string; sessionId: string }[] {
    return this.getInFlightSessionIds().map((sessionId) => ({
      projectId: this.resolveSessionProjectId(sessionId),
      sessionId
    }))
  }

  // A permission-blocked prompt whose authority reached durable storage is quiescent for app quit:
  // teardown loses only the dead provider RPC, while the card remains actionable after restart.
  getQuitBlockingPromptSessions(): { projectId: string; sessionId: string }[] {
    return this.getInFlightSessionIds()
      .filter((sessionId) => !this.permissionContext.hasDurablePendingForSession(sessionId))
      .map((sessionId) => ({
        projectId: this.resolveSessionProjectId(sessionId),
        sessionId
      }))
  }

  hasLiveSession(projectId: string, sessionId: string): boolean {
    return (
      this.activeSessionFor(sessionId) !== undefined &&
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectId === projectId
    )
  }

  isSessionMemoryEnabled(sessionId: string): boolean {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().memoryEnabled ?? false
  }

  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    const aggregate = this.sessionRegistry.lookup(sessionId)?.aggregate
    if (!aggregate) throw new Error(`ACP session not found: ${sessionId}`)
    aggregate.setMemoryEnabled(enabled)
    this.emitState()
  }

  liveSessionProjectId(sessionId: string): string | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectId
  }

  isSessionReferenceAllowed(sessionId: string, referencedSessionId: string): boolean {
    return this.sessionInteractions.isSessionReferenceAllowed(sessionId, referencedSessionId)
  }

  // Handoff adapters select their framework without reaching into session ownership maps. The
  // framework recorded here is the one that provisioned this logical session, including after a
  // coordinator generation rotation.
  isSessionUsingFramework(sessionId: string, frameworkId: AgentFrameworkId): boolean {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId === frameworkId
  }

  prepareClaudeCodeHandoffReplay(input: ClaudeCodeReplayInput): void {
    this.handoffContinuity.stageClaudeReplay(input)
  }

  discardClaudeCodeHandoffReplay(sessionId: string): void {
    this.handoffContinuity.discardClaudeReplay(sessionId)
  }

  createClaudeCodeContinuationRequest(input: {
    sessionId: string
    switchReadBack: ApprovedSwitchReadBack
  }): AcpPromptRequest {
    return this.handoffContinuity.createClaudeContinuation(input)
  }

  reportApprovedHandoffFailure(sessionId: string): void {
    this.pushEvent({
      kind: 'error',
      level: 'error',
      sessionId,
      title: 'Specialist handoff failed',
      text: 'The approved specialist could not continue the current task.'
    })
  }

  private getInFlightSessionIds(): string[] {
    const interactions = this.sessionInteractions.snapshot()
    return Array.from(
      new Set([
        ...interactions.filter(({ kind }) => kind === 'prompt').map(({ sessionId }) => sessionId),
        ...interactions
          .filter(({ kind }) => kind === 'compaction')
          .map(({ sessionId }) => sessionId),
        ...this.appContinuations.sessionIds()
      ])
    )
  }

  // Accepts a model selection without interrupting a live generation. The picker may keep changing
  // while work is active; one pending slot deliberately makes the latest selection win. New runtime
  // operations wait on the barrier, while the operation that was already admitted finishes against
  // the old model.
  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    return this.modelChanges.apply(target)
  }

  // Live-applies a reasoning-effort change to every open session when the generation is idle. A
  // prompt or background activity keeps its admitted model/effort immutable; returning false lets
  // the settings workflow defer the new persisted effort through its reconnect path. The same
  // fallback covers frameworks that carry effort only in baked spawn config and genuine live-update
  // failures. On success the generation view tracks the new level, so sessions created later in this
  // process inherit it; the persisted setting covers the next respawn.
  async applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    if (!this.modelChanges.barrier && this.generationActivity.blocksLiveEffortChange()) return false
    return this.modelChanges.applyReasoningEffort(effort)
  }

  // Starts a fresh agent process connection and initializes protocol capabilities.
  async connect(request: AcpConnectRequest = {}): Promise<AcpStateSnapshot> {
    return this.withOperationLease(() => this.connectionLifecycle.connect(request))
  }

  // Creates a protocol session, injects artifact tooling, and uses the returned id as the app session id.
  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(() => this.providerSessionCreator.create(request))
  }

  // Reattaches a persisted protocol session after an app restart so later prompts can stream.
  async resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(async () => {
      this.restoredContinuationContextResetSessionIds?.delete(request.sessionId)
      const resumed = await this.providerSessionResumer.resume(request)
      if (resumed.contextReset) {
        const contextResetSessionIds =
          this.restoredContinuationContextResetSessionIds ?? new Set<string>()
        this.restoredContinuationContextResetSessionIds = contextResetSessionIds
        contextResetSessionIds.add(request.sessionId)
      }
      this.scheduleQueuedPlanContinuation(
        this.sessionEnvironment.projectId(request.sessionId),
        request.sessionId
      )
      return resumed
    })
  }

  async enableLiteratureContext(sessionId: string): Promise<void> {
    if (!this.options.literature) return
    this.sessionCapabilities.enableLiterature(sessionId)
    if (
      this.sessionCapabilities.mcpServerNamesFor(sessionId).includes(LITERATURE_MCP_SERVER_NAME)
    ) {
      return
    }
    const snapshot = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
    if (!snapshot || !this.activeSessionFor(sessionId)) {
      literatureLog.info('Literature MCP mount deferred until provider Session creation', {
        sessionId
      })
      return
    }
    if (this.sessionInteractions.current(sessionId)) {
      throw new Error('Cannot prepare Literature tools while the Agent is running.')
    }
    try {
      await this.withOperationLease(() =>
        this.providerSessionResumer.reconfigure({
          sessionId,
          cwd: snapshot.cwd ?? this.options.defaultCwd,
          projectId: snapshot.projectId,
          memoryEnabled: snapshot.memoryEnabled,
          ...(snapshot.permissionProfile?.selectedProfile
            ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
            : {})
        })
      )
      literatureLog.info('Literature MCP mounted with compatible provider resume', {
        sessionId,
        framework: this.framework.id,
        replayedHistory: false
      })
    } catch (error) {
      this.sessionCapabilities.rollbackLiteratureEnable(sessionId)
      literatureLog.warn('Literature MCP mount failed', {
        sessionId,
        ...errorLogFields(error)
      })
      throw error
    }
  }

  async disableLiteratureContext(sessionId: string): Promise<void> {
    if (!this.options.literature || !this.sessionCapabilities.disableLiterature(sessionId)) return
    if (
      !this.sessionCapabilities.mcpServerNamesFor(sessionId).includes(LITERATURE_MCP_SERVER_NAME)
    ) {
      return
    }
    const snapshot = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
    if (!snapshot || !this.activeSessionFor(sessionId)) return
    if (this.sessionInteractions.current(sessionId)) {
      literatureLog.info('Literature MCP unmount deferred until the Agent is idle', { sessionId })
      return
    }
    try {
      await this.withOperationLease(() =>
        this.providerSessionResumer.reconfigure({
          sessionId,
          cwd: snapshot.cwd ?? this.options.defaultCwd,
          projectId: snapshot.projectId,
          memoryEnabled: snapshot.memoryEnabled,
          ...(snapshot.permissionProfile?.selectedProfile
            ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
            : {})
        })
      )
      literatureLog.info('Literature MCP disabled with compatible provider resume', {
        sessionId,
        framework: this.framework.id,
        replayedHistory: false
      })
    } catch (error) {
      literatureLog.warn('Literature MCP disable failed; message context remains authoritative', {
        sessionId,
        ...errorLogFields(error)
      })
      throw error
    }
  }

  // Forcibly drops the agent-side context for a session whose accumulated history can no longer be sent
  // — chiefly when inlined media pushed the request past the provider's size limit and the backend's own
  // compaction fails with `media_unstrippable`. Disposes the current agent session and adopts a brand-new
  // one under the SAME app id, resetting the per-session inline-image budget so a replayed text-only
  // transcript starts clean. Returns contextReset so the caller replays a bounded transcript into the
  // next prompt (the app-level equivalent of compaction, which — unlike the backend's — drops all media).
  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(() => this.sessionReplacement.reset(request))
  }

  // Hot-switches the specialist bound to a live session. Updates the per-session skills and identity
  // maps so the next prompt reflects the new specialist. For Claude (identity baked into session
  // _meta at creation) the agent session is replaced via a context reset so the new identity append
  // takes effect immediately; Codex/OpenCode carry identity as a per-turn prefix (updated in the map)
  // and need no reset. Returns `contextReset` so the renderer knows to replay conversation history
  // into the next prompt (only true for Claude, whose fresh session starts with no provider context).
  async switchSpecialist(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    return this.withOperationLease(() =>
      this.sessionReplacement.switchSpecialist(sessionId, specialistId)
    )
  }

  // The completion-gate adapter uses this public runtime fact to claim only the framework it owns.
  // A session keeps its original framework while a different active backend is prepared elsewhere.
  getSessionFramework(sessionId: string): AgentFrameworkId | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId
  }

  // Invokes the framework's own context compaction command on the attached agent session. The
  // command is an internal control turn: fresh usage updates are retained, while its command
  // echo/status output is not projected into the user's conversation.
  async compactSession(request: AcpCompactSessionRequest): Promise<PromptResponse> {
    return this.withOperationLease(() => this.contextCompactionWorkflow.compact(request))
  }

  // Serializes changes per Session and coalesces queued requests so only the latest selection can
  // commit or release a pending provider request. The operation lease covers time spent in the queue.
  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    return this.withOperationLease(() => this.enqueuePermissionProfileChange(request))
  }

  private enqueuePermissionProfileChange(
    request: AcpSetPermissionProfileRequest
  ): Promise<AcpStateSnapshot> {
    const state = this.permissionProfileChanges.get(request.sessionId) ?? {
      revision: 0,
      tail: Promise.resolve()
    }
    const revision = ++state.revision
    const operation = state.tail.then(() =>
      this.setPermissionProfileOperation(request, state, revision)
    )
    state.tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.permissionProfileChanges.set(request.sessionId, state)
    void state.tail.then(() => {
      if (
        this.permissionProfileChanges.get(request.sessionId) === state &&
        state.revision === revision
      ) {
        this.permissionProfileChanges.delete(request.sessionId)
      }
    })

    return operation
  }

  private async setPermissionProfileOperation(
    request: AcpSetPermissionProfileRequest,
    state: { revision: number },
    revision: number
  ): Promise<AcpStateSnapshot> {
    if (state.revision !== revision) return this.getSnapshot()

    const session = this.activeSessionFor(request.sessionId)

    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    if (this.sessionInteractions.current(request.sessionId)?.kind === 'compaction') {
      throw new Error('Permission profile cannot be changed while the Agent is compacting.')
    }

    const connection = this.connection
    if (!connection) throw new Error('ACP connection is not available.')
    const backend = this.backend
    const aggregate = this.sessionRegistry.lookup(request.sessionId)?.aggregate
    const previousPermissionProfile = aggregate?.snapshot().permissionProfile
    const requestedPermissionProfile = backend.framework.mapPermissionProfile(
      request.profile,
      session.modes
    ).state
    const isCurrent = (): boolean =>
      state.revision === revision &&
      this.connection === connection &&
      this.activeSessionFor(request.sessionId) === session

    // Make the requested posture authoritative before the provider mode request can yield. A
    // downgrade from Full must affect broker decisions immediately, even while setMode is in flight.
    this.permissionContext.beginPermissionProfileTransition(
      request.sessionId,
      requestedPermissionProfile,
      isCurrent
    )

    let permissionProfile
    try {
      permissionProfile = await this.sessionConfigurator.configurePermissionProfile(
        {
          backend,
          connection,
          session,
          permissionProfile: request.profile
        },
        true
      )
    } catch (error) {
      if (previousPermissionProfile && isCurrent()) {
        this.permissionContext.setLivePermissionProfile(
          request.sessionId,
          {
            ...previousPermissionProfile,
            availableModeIds: [...previousPermissionProfile.availableModeIds]
          },
          isCurrent
        )
      }
      throw error
    }
    if (state.revision !== revision) return this.getSnapshot()
    if (this.activeSessionFor(request.sessionId) !== session) {
      throw new Error('ACP session startup was superseded.')
    }
    this.assertCurrentConnectedConnection(connection)
    await this.permissionContext.applyPermissionProfile(
      request.sessionId,
      permissionProfile,
      () => state.revision === revision
    )
    if (state.revision !== revision) return this.getSnapshot()
    if (this.activeSessionFor(request.sessionId) !== session) {
      throw new Error('ACP session startup was superseded.')
    }
    this.assertCurrentConnectedConnection(connection)
    this.sessionRegistry
      .lookup(request.sessionId)
      ?.aggregate.setPermissionProfile(structuredClone(permissionProfile))
    this.permissionContext.setLivePermissionProfile(request.sessionId, permissionProfile)
    this.emitState()

    return this.getSnapshot()
  }

  // Revokes an app-owned session grant so the next matching tool call prompts again.
  async revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpStateSnapshot> {
    await this.permissionContext.revokeGrant(request.sessionId, request.categoryKey)
    this.emitState()

    return this.getSnapshot()
  }

  // Tears down every local session route and closes the underlying agent process.
  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    this.clearAllPlanContinuationClaimRetries()
    try {
      return await this.connectionClose.disconnect(emitClosedStatus)
    } finally {
      this.clearAllPlanContinuationClaimRetries()
    }
  }

  // Synchronously terminates the agent child for app shutdown. Electron's `will-quit` cannot await, so
  // this does only the synchronous work of signalling the child to exit — an agent left running after
  // the app is gone would be an orphaned process still holding its network connection open. The OS
  // reclaims the remaining connection/session state as the process exits.
  shutdown(): void {
    this.clearAllPlanContinuationClaimRetries()
    this.connectionClose.shutdown()
  }

  // Awaitable quit/relaunch teardown. Latches shuttingDown FIRST so a connect that is mid-spawn when
  // quit lands self-aborts and kills its freshly-spawned child (see the lifecycle workflow). Unlike shutdown(),
  // this can be awaited, so a caller that follows it with app.exit(0) is guaranteed no orphaned agent
  // remains — assigned, connecting, or mid-spawn. Returns { reaped } so the caller can tell a clean
  // teardown from a degraded one (taskkill fallback left grandchildren) before committing to app.exit.
  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.clearAllPlanContinuationClaimRetries()
    try {
      return await this.connectionClose.shutdownForQuit()
    } finally {
      this.clearAllPlanContinuationClaimRetries()
    }
  }

  // Teardown for the pre-update-install gate. Reaps the current agent tree (so the NSIS installer can
  // delete files the agent held) but, unlike shutdownForQuit, does NOT latch shuttingDown: a refused
  // install (degraded or timed-out teardown) must leave the runtime able to lazily reconnect. Crucially
  // it does not rely on a latch to catch a connect racing inside provider spawn either — this teardown
  // can itself be abandoned by its caller (runBounded) once the budget elapses, and a latch set here
  // would then never clear, wedging every future connect. Instead disconnect() bumps the connection
  // generation, and the lifecycle workflow reaps any freshly-spawned child whose generation is now stale,
  // independent of shuttingDown. Awaiting the in-flight connect here only sharpens the returned reaped
  // signal (so a degraded reap makes the caller refuse the install); if that await is abandoned on
  // timeout the caller refuses on !completed and the stale-generation self-reap still collects the child.
  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.clearAllPlanContinuationClaimRetries()
    try {
      return await this.connectionClose.shutdownForUpdateGate()
    } finally {
      this.clearAllPlanContinuationClaimRetries()
    }
  }

  // Retires this framework generation without interrupting active turns or background workflows. The
  // coordinator stops routing new work here immediately; teardown waits for every prompt and lease.
  async requestRetirement(): Promise<void> {
    await this.connectionClose.requestRetirement()
  }

  // Applies an active-provider change without interrupting the user. The agent bakes its provider env in
  // at spawn, so a new provider needs a reconnect — but if a prompt is running we defer the reconnect
  // until the session goes idle. Because every provider shares one config dir, the reconnect resumes the
  // conversation on the new provider with full context. Called when the active provider changes.
  async requestProviderReconnect(): Promise<void> {
    await this.connectionClose.requestProviderReconnect()
  }

  // Holds this generation across a multi-step background workflow, including gaps with no live session.
  async withActivity<T>(
    _options: AcpRuntimeActivityOptions,
    work: (runtime: AcpRuntimeActivity) => Promise<T>
  ): Promise<T> {
    return this.generationActivity.withActivity(() => work(this))
  }

  private withOperationLease<T>(work: () => Promise<T>): Promise<T> {
    const barrier = this.modelChanges.barrier ?? this.reconnectBarrier
    if (barrier) {
      return barrier.then(() => this.withOperationLease(work))
    }
    return this.generationActivity.withOperation(work)
  }

  private openAgentConnection(
    identity: AcpConnectionResourceAttempt,
    onFrameworkResolved: (framework: AgentFramework['id']) => void
  ): Promise<AcpAgentConnectionCandidate> {
    const hooks: AcpAgentConnectionHooks = {
      createElicitation: (params) => this.clientInteractions.createElicitation(params),
      requestPermission: (params) => this.clientInteractions.requestPermission(params),
      observeSessionUpdate: (notification) => {
        this.providerSessionResumer.observeProgress(notification.sessionId)
        this.permissionContext.observeProviderUpdate(notification)
      },
      observeClaudeSdkMessage: (params) => this.observeClaudeSdkMessage(params),
      filesystem: {
        resolveSessionCwd: (sessionId) => this.resolveSessionCwd(sessionId),
        protectedReadRoots: () => this.protectedReadRoots()
      },
      onBackendResolved: (framework) => {
        onFrameworkResolved(framework)
        if (!this.spawnAgent) {
          // Keep spawn configuration and provider identifiers out of diagnostics.
          log.info('agent backend resolved', this.diagnosticContext(framework))
        }
      },
      onProcessSpawned: (framework) => {
        if (!this.spawnAgent) log.info('agent process spawned', this.diagnosticContext(framework))
      },
      onBackendPublished: (backend) => {
        this.sessionUpdateProjector.beginGeneration(
          backend.adapter.codexHome ? join(backend.adapter.codexHome, 'skills') : undefined
        )
      },
      onProcessTreeReaped: (reaped) => {
        this.connectionClose.recordProcessTreeReaped(reaped)
      },
      markProcessExitExpected: (process) => this.connectionClose.markExpected(process),
      onProcessStderr: (text, context) => this.handleAgentProcessStderr(text, context),
      onProcessError: (error, context) => this.handleAgentProcessError(error, context),
      onProcessExit: (code, signal, context) => this.handleAgentProcessExit(code, signal, context),
      onConnectionClosed: () => this.connectionClose.handleUnexpectedClose(),
      reportCleanupFailure: (stage, error, framework, epoch) => {
        if (stage === 'bridge-lease') {
          safeLogError('responses bridge lease release failed', errorLogFields(error))
          return
        }
        if (stage === 'anthropic-bridge-lease') {
          safeLogError('Anthropic bridge lease release failed', errorLogFields(error))
          return
        }
        if (stage === 'provider-transport-lease') {
          safeLogError('provider transport lease release failed', errorLogFields(error))
          return
        }
        safeLogError(`unattached ACP ${stage} cleanup failed`, {
          ...diagnosticErrorFields(error),
          ...this.diagnosticContext(framework, epoch)
        })
      },
      reportProcessTreeError: (message, error) => log.error(message, error)
    }

    return this.connectionAdapter.open(
      {
        epoch: identity.epoch,
        resolveBackend: async () => {
          const backend: ResolvedAgentBackend | undefined = this.options.resolveBackend
            ? await this.options.resolveBackend({
                forcedSkillIds: [...this.turnSkills.backendPreparation().forcedSkillIds],
                systemPromptAppends: [
                  ...(await this.sessionEnvironment.backendSystemPromptAppends())
                ]
              })
            : this.spawnAgent
              ? { framework: this.framework, executablePath: '', env: {} }
              : undefined
          if (!backend) throw new Error('ACP agent spawn configuration is not available.')
          return backend
        },
        prepareBackend: (backend) => this.backendGeneration.prepare(identity, backend),
        isCurrent: () => identity.epoch === this.connectionGeneration,
        isShuttingDown: () => this.connectionResources.isShuttingDown,
        ...(this.spawnAgent ? { spawnAgent: this.spawnAgent } : {})
      },
      hooks
    )
  }

  // Side-band follow-up into the live prompt. Does not open a second prompt interaction.
  async steerFollowUp(request: AcpSteerFollowUpRequest): Promise<AcpSteerFollowUpResult> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.nativeFollowUp.steerFollowUp(request))
    )
  }

  async steerSideChatAdvisory(
    request: AcpSteerFollowUpRequest
  ): ReturnType<AcpNativeFollowUpWorkflow['steerSideChatAdvisory']> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.nativeFollowUp.steerSideChatAdvisory(request))
    )
  }

  private async prepareNativeFollowUpContent(
    request: AcpSteerFollowUpRequest
  ): Promise<NativeFollowUpPreparedContent> {
    const referencedSessions = sanitizeSessionReferences(request.parts)
    this.sessionInteractions.authorizeSessionReferences(
      request.sessionId,
      referencedSessions.map((reference) => reference.sessionId)
    )
    const livePrompt = this.sessionInteractions.current(request.sessionId)
    const presented = await this.turnSkills.presentFollowUp({
      frameworkId: this.framework.id,
      text: request.text,
      selectedSkillIds: request.forcedSkillIds ?? [],
      role: this.sessionEnvironment.role(),
      specialistId: this.sessionRegistry.lookup(request.sessionId)?.aggregate.snapshot()
        .specialistId,
      codexHome: this.backendGeneration.current.adapter.codexHome,
      ...(this.framework.id === 'codebuddy'
        ? {
            codebuddy: {
              root: codeBuddySkillRuntimeRoot(this.backendGeneration.current.session.options),
              selectorAvailable: this.connectionResources.bridgeSkillsAvailable,
              selectSkills: async (text, catalog, signal, observeUsage) =>
                (await this.connectionResources.selectBridgeSkills(
                  text,
                  catalog,
                  signal,
                  observeUsage
                )) ?? [],
              ...(livePrompt?.kind === 'prompt' ? { signal: livePrompt.signal } : {})
            }
          }
        : {})
    })
    const supportsImageInput = this.backendGeneration.current.context.supportsImageInput
    const imageCompatibility = this.options.imageInputCompatibility
    const prepared = await this.promptContent.prepare({
      appSessionId: request.sessionId,
      projectId: this.liveSessionProjectId(request.sessionId) ?? '',
      connectionGeneration: this.connectionGeneration,
      text: [buildSessionReferencePrompt(referencedSessions), followUpPromptText(presented)]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n'),
      historyImages: [],
      historyUploads: [],
      currentUploads: request.attachments ?? [],
      references: request.referencedArtifacts ?? [],
      codexSkillInputs: presented.codexSkillInputs,
      skillImportEnabled: false,
      imageCompatibilityRelay: supportsImageInput === false && imageCompatibility !== undefined,
      fileTextBudget: resolveFileTextBudget(this.backendGeneration.current.context.window)
    })
    return finalizeNativeFollowUpPreparedContent({
      content: prepared.content,
      ...(prepared.turnInputs ? { turnInputs: prepared.turnInputs } : {}),
      projectId: this.liveSessionProjectId(request.sessionId) ?? '',
      sessionId: request.sessionId,
      ...(livePrompt?.kind === 'prompt' && livePrompt.promptMessageId
        ? { livePromptMessageId: livePrompt.promptMessageId }
        : {}),
      supportsImageInput,
      ...(prepared.imageSources ? { imageSources: prepared.imageSources } : {}),
      historyImageCount: prepared.historyImageCount,
      ...(livePrompt?.kind === 'prompt' ? { signal: livePrompt.signal } : {}),
      ...(imageCompatibility ? { imageCompatibility } : {}),
      close: prepared.close
    })
  }

  // Sends one prompt turn to the targeted session and streams updates until stop.
  async sendPrompt(
    request: AcpPromptRequest,
    promptAttemptId?: string,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<PromptResponse> {
    if (
      request.referencedArtifacts?.some(
        (reference) =>
          'pdfReadingPosition' in reference && reference.pdfReadingPosition !== undefined
      )
    ) {
      await this.enableLiteratureContext(request.sessionId)
    }
    return this.withOperationLease(() =>
      this.runPromptTurn(
        request,
        {
          kind: 'user',
          ...(promptAttemptId === undefined ? {} : { promptAttemptId })
        },
        onPromptAdmitted
      )
    )
  }

  async sendApplicationPrompt(
    request: AcpPromptRequest,
    attribution: MessageAttribution,
    promptAttemptId?: string
  ): Promise<PromptResponse> {
    return this.withOperationLease(() =>
      this.runPromptTurn(request, {
        kind: 'application',
        attribution,
        ...(promptAttemptId === undefined ? {} : { promptAttemptId })
      })
    )
  }

  // App-owned continuations participate in the same prompt ownership, cancellation, provenance, and
  // accounting lifecycle as user turns. Their synthesized control text is provider input, however,
  // and must never be projected into the transcript as a second user-authored message.
  async sendAppContinuation(
    request: AcpPromptRequest,
    promptAttemptId?: string
  ): Promise<PromptResponse> {
    // A parked continuation itself blocks reconnect. Enter the generation directly so it can finish
    // before that barrier is released instead of waiting on the barrier it intentionally holds.
    return this.generationActivity.withOperation(() =>
      this.runPromptTurn(request, {
        kind: 'app-continuation',
        ...(promptAttemptId === undefined ? {} : { promptAttemptId })
      })
    )
  }

  private runPromptTurn(
    request: AcpPromptRequest,
    intent:
      | Readonly<{ kind: 'user'; promptAttemptId?: string }>
      | Readonly<{
          kind: 'application'
          attribution: MessageAttribution
          promptAttemptId?: string
        }>
      | Readonly<{ kind: 'app-continuation'; promptAttemptId?: string }>,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<PromptResponse> {
    return withDataRootWrite(async () => {
      let response: PromptResponse | undefined
      try {
        response = await this.promptTurnWorkflow.run(request, intent, onPromptAdmitted)
        return response
      } finally {
        this.schedulePendingAppContinuation(request.sessionId, response?.stopReason)
      }
    })
  }

  // Requests cancellation without clearing in-flight state before the agent stops.
  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    const connection = this.connection
    const activeSession = this.activeSessionFor(request.sessionId)
    const cancelPlanInteraction = this.sessionPlanWorkflow.capturePromptCancellation(
      request.sessionId
    )
    const interactionInFlight = this.sessionInteractions.current(request.sessionId) !== undefined
    const durablePermission = this.durablePermissionContinuations?.get(request.sessionId)
    if (durablePermission) durablePermission.cancellationRequested = true
    const continuationWasPending = this.appContinuations.get(request.sessionId) !== undefined
    const cancelledContinuation = this.appContinuations.delete(request.sessionId)

    if (continuationWasPending && cancelledContinuation && !interactionInFlight) {
      await this.settleCancelledDurablePermissionContinuation(request.sessionId)
      this.emitState()
      return this.getSnapshot()
    }

    if (!interactionInFlight && !durablePermission) {
      try {
        const permissionRequestId = await this.permissionWaitOwner.cancelPendingSession(
          request.sessionId
        )
        if (permissionRequestId) {
          this.restoredContinuationContextResetSessionIds?.delete(request.sessionId)
          this.permissionContext.clearRestoredDecision(request.sessionId)
          this.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId: request.sessionId,
            permissionRequestId,
            title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
            text: 'cancelled'
          })
          this.emitState()
          return this.getSnapshot()
        }
      } catch (error) {
        this.pushEvent({
          kind: 'system',
          level: 'error',
          sessionId: request.sessionId,
          title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
          text: errorMessage(error)
        })
        this.emitState()
        return this.getSnapshot()
      }
    }

    let cancellationAccepted = false
    if (connection && activeSession) {
      await this.sessionInteractions.cancelPrompt({
        sessionId: request.sessionId,
        notify: () =>
          connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: activeSession.sessionId
          }),
        onAccepted: () => {
          cancellationAccepted = true
          cancelPlanInteraction()
          this.cancelPermissionFlowForSession(request.sessionId)
          this.pushEvent({
            kind: 'system',
            level: 'warning',
            sessionId: request.sessionId,
            title: 'Prompt cancellation requested'
          })
          this.emitState()
        },
        onTimeout: () => {
          this.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId: request.sessionId,
            title: 'Prompt cancellation timed out',
            text: 'The agent did not stop, so its process was stopped and will restart on the next prompt.'
          })
          void this.disconnect()
        }
      })
    }
    if (cancellationAccepted) {
      await this.settleCancelledDurablePermissionContinuation(request.sessionId)
      this.emitState()
    }

    return this.getSnapshot()
  }

  // Closes the agent-side session when supported, then removes local routing state.
  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    this.clearPlanContinuationClaimRetry(request.sessionId)
    this.sessionPlanWorkflow.sessionDeleted(request.sessionId)
    try {
      return await this.sessionDeletion.delete(request.sessionId)
    } finally {
      this.clearPlanContinuationClaimRetry(request.sessionId)
    }
  }

  // Resolves or cancels one pending permission request from the renderer.
  async respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot> {
    const permissionRequest = this.permissionContext
      .getPendingRequests()
      .find((request) => request.requestId === response.requestId)
    if (!permissionRequest && response.restored) {
      return this.respondToRestoredPermission(response)
    }
    const selectedOption = permissionRequest?.options.find(
      (option) => option.optionId === response.optionId
    )
    const interaction = permissionRequest
      ? this.sessionInteractions.current(permissionRequest.sessionId)
      : undefined
    const promptInteraction = interaction?.kind === 'prompt' ? interaction : undefined
    const continueAfterProviderCancellation = Boolean(
      permissionRequest &&
      promptInteraction &&
      this.getSessionFramework(permissionRequest.sessionId) === 'claude-code' &&
      !response.cancelled &&
      selectedOption?.kind.toLowerCase().startsWith('reject_')
    )
    if (permissionRequest && promptInteraction && continueAfterProviderCancellation) {
      const referencedSessions = this.handoffContinuity.copyReferencedSessions(
        permissionRequest.sessionId
      )
      this.appContinuations.set(permissionRequest.sessionId, {
        condition: 'provider-cancelled',
        request: {
          sessionId: permissionRequest.sessionId,
          text: PERMISSION_DENIED_CONTINUATION_TEXT,
          ...(promptInteraction.memoryEnabled !== undefined
            ? { memoryEnabled: promptInteraction.memoryEnabled }
            : {}),
          suppressUserMessage: true,
          ...(promptInteraction.promptMessageId
            ? { provenanceContext: { promptMessageId: promptInteraction.promptMessageId } }
            : {}),
          ...(referencedSessions?.length ? { referencedSessions } : {})
        }
      })
    }

    try {
      const handled = await this.permissionContext.respondToPermission(
        response,
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      if (!handled && permissionRequest && continueAfterProviderCancellation) {
        this.appContinuations.delete(permissionRequest.sessionId)
      }
      this.pushEvent({
        kind: 'permission',
        level: handled ? 'info' : 'warning',
        permissionRequestId: response.requestId,
        title: handled ? 'Permission response sent' : 'Permission request not found',
        text: response.cancelled ? 'cancelled' : response.optionId
      })
    } catch (error) {
      if (permissionRequest && continueAfterProviderCancellation) {
        this.appContinuations.delete(permissionRequest.sessionId)
      }
      this.pushEvent({
        kind: 'permission',
        level: 'error',
        permissionRequestId: response.requestId,
        title: 'Permission approval could not be saved',
        text: error instanceof Error ? error.message : 'The tool call was cancelled.'
      })
      this.emitState()
      throw error
    }
    this.emitState()

    return this.getSnapshot()
  }

  private async respondToRestoredPermission(
    response: AcpPermissionResponse
  ): Promise<AcpStateSnapshot> {
    const restored = response.restored!
    const activeSession = this.activeSessionFor(restored.sessionId)
    if (!activeSession) throw new Error(`ACP session not found: ${restored.sessionId}`)
    const projectId = this.sessionEnvironment.projectId(restored.sessionId)
    const decision = await this.permissionWaitOwner.resolveRestored(
      response,
      projectId,
      restored.sessionId
    )
    const continuation = await this.durableContinuationContext.prepare({
      projectId,
      sessionId: restored.sessionId,
      promptMessageId: decision.permission.originatingPromptMessageId,
      ...(this.restoredContinuationContextResetSessionIds?.has(restored.sessionId)
        ? {
            replay: {
              descriptor: this.durableContinuationHistoryReplayDescriptor(),
              supportsImageInput: await this.supportsDurableContinuationImages()
            }
          }
        : {})
    })
    const durablePermissionContinuations =
      this.durablePermissionContinuations ??
      new Map<string, { projectId: string; requestId: string; cancellationRequested?: boolean }>()
    this.durablePermissionContinuations = durablePermissionContinuations
    if (durablePermissionContinuations.has(restored.sessionId)) {
      throw new Error('The restored permission request is already being continued.')
    }
    durablePermissionContinuations.set(restored.sessionId, {
      projectId,
      requestId: response.requestId
    })
    let continuationBegan = false
    try {
      // Persist the consumed/non-replayable marker before starting provider work. A process loss or
      // grant failure must never leave a reusable approval without consuming its authority first.
      await this.permissionWaitOwner.beginContinuation(
        projectId,
        restored.sessionId,
        response.requestId
      )
      continuationBegan = true
      await this.permissionContext.prepareRestoredDecision(
        decision.permission,
        decision.option,
        projectId
      )
    } catch (error) {
      this.permissionContext.clearRestoredDecision(restored.sessionId)
      if (continuationBegan) {
        try {
          await this.permissionWaitOwner.rearmContinuation(
            projectId,
            restored.sessionId,
            response.requestId
          )
          this.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId: restored.sessionId,
            permissionRequestId: response.requestId,
            title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
          })
        } catch (rearmError) {
          this.pushEvent({
            kind: 'permission',
            level: 'error',
            sessionId: restored.sessionId,
            permissionRequestId: response.requestId,
            title: ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
            text: errorMessage(rearmError)
          })
        }
        this.emitState()
      }
      durablePermissionContinuations.delete(restored.sessionId)
      throw error
    }

    const scope = decision.option?.scope
    const text = response.cancelled
      ? PERMISSION_CANCELLED_CONTINUATION_TEXT
      : decision.denied
        ? PERMISSION_DENIED_CONTINUATION_TEXT
        : `The user approved the pending tool permission${scope ? ` for ${scope}` : ''}. Retry only ` +
          'the exact parked tool call and continue the current task. Do not broaden or reinterpret the approval.'
    this.appContinuations.set(restored.sessionId, {
      condition: 'always',
      request: {
        sessionId: restored.sessionId,
        text,
        memoryEnabled: continuation.memoryEnabled,
        suppressUserMessage: true,
        provenanceContext: continuation.provenanceContext,
        ...(continuation.referencedSessions?.length
          ? { referencedSessions: continuation.referencedSessions }
          : {}),
        ...(continuation.historyReplay?.historyPreamble
          ? { historyPreamble: continuation.historyReplay.historyPreamble }
          : {}),
        ...(continuation.historyReplay?.historyAttachments.length
          ? { historyAttachments: continuation.historyReplay.historyAttachments }
          : {}),
        ...(continuation.historyReplay?.historyImages.length
          ? { historyImages: continuation.historyReplay.historyImages }
          : {})
      }
    })
    this.schedulePendingAppContinuation(restored.sessionId)
    const settlementState = response.cancelled
      ? 'cancelled'
      : decision.denied
        ? 'rejected'
        : 'resolved'
    this.options.callbacks?.onPermissionSettled?.(response.requestId, settlementState)
    if (settlementState !== 'resolved') {
      this.pushEvent({
        kind: 'tool',
        level: 'info',
        sessionId: restored.sessionId,
        promptMessageId: decision.permission.originatingPromptMessageId,
        toolCallId: decision.permission.request.toolCallId,
        title: decision.permission.request.title,
        providerToolName:
          decision.permission.request.providerToolName ?? decision.permission.request.mcpIdentity,
        rawInput: decision.permission.request.rawInput,
        status: settlementState === 'rejected' ? 'completed' : 'in_progress',
        toolDisposition: settlementState === 'rejected' ? 'declined' : 'permission-closed'
      })
    }
    this.pushEvent({
      kind: 'permission',
      level: 'info',
      sessionId: restored.sessionId,
      permissionRequestId: response.requestId,
      promptMessageId: decision.permission.originatingPromptMessageId,
      title: 'Restored permission response accepted',
      text: response.cancelled ? 'cancelled' : response.optionId
    })
    this.emitState()
    return this.getSnapshot()
  }

  async respondToElicitation(response: ElicitationResponse): Promise<AcpStateSnapshot> {
    if (response.request && response.request.requestId !== response.requestId) {
      throw new Error('Restored structured input request id does not match the response')
    }
    let restoredContinuation:
      | Awaited<
          ReturnType<AcpRuntimeSessionOwners['durableContinuationContext']['prepareElicitation']>
        >
      | undefined
    if (
      !this.elicitationOwner
        .getPendingRequests()
        .some((request) => request.requestId === response.requestId) &&
      response.request
    ) {
      if (!this.activeSessionFor(response.request.sessionId)) {
        throw new Error(`ACP session not found: ${response.request.sessionId}`)
      }
      restoredContinuation = await this.durableContinuationContext.prepareElicitation({
        projectId: this.sessionEnvironment.projectId(response.request.sessionId),
        sessionId: response.request.sessionId,
        requestId: response.request.requestId,
        toolCallId: response.request.toolCallId,
        action: response.action,
        answers: response.answers,
        replacePreviousAnswer: response.replacePreviousAnswer,
        ...(this.restoredContinuationContextResetSessionIds?.has(response.request.sessionId)
          ? {
              replay: {
                descriptor: this.durableContinuationHistoryReplayDescriptor(),
                supportsImageInput: await this.supportsDurableContinuationImages()
              }
            }
          : {})
      })
      if (!this.elicitationOwner.restoreDetached(restoredContinuation.request)) {
        throw new Error('Invalid restored structured input request')
      }
    }

    const livePromptContext = this.userChoiceProvenanceContexts.get(response.requestId)
    const resolution = this.elicitationOwner.respond(response)
    this.userChoiceProvenanceContexts.delete(response.requestId)
    if (resolution.detached) {
      const continuation = this.userChoiceContinuation(
        resolution.request,
        resolution.response,
        restoredContinuation?.historyReplay,
        restoredContinuation?.provenanceContext ?? livePromptContext?.provenanceContext,
        restoredContinuation?.memoryEnabled ?? livePromptContext?.memoryEnabled,
        restoredContinuation?.referencedSessions ?? livePromptContext?.referencedSessions
      )
      if (continuation) {
        this.appContinuations.set(resolution.request.sessionId, {
          request: continuation,
          condition: 'always'
        })
        this.schedulePendingAppContinuation(resolution.request.sessionId)
      }
      this.restoredContinuationContextResetSessionIds?.delete(resolution.request.sessionId)
    }
    return this.getSnapshot()
  }

  async requestUserInput(input: AgentUserChoiceRequest): Promise<AgentUserChoiceResult> {
    const request = sanitizeAgentUserChoiceRequest(input)
    if (!request) throw new Error('Invalid user choice request.')
    if (!this.activeSessionFor(request.sessionId)) return { action: 'cancelled' }

    const pendingChoice = this.elicitationOwner
      .getPendingRequests()
      .find(
        (pending) =>
          pending.sessionId === request.sessionId && pending.durable?.kind === 'agent-user-choice'
      )
    if (pendingChoice) {
      const firstQuestionIndex = pendingChoice.fields.filter((field) =>
        /^question_\d+$/u.test(field.id)
      ).length
      const fields: ElicitationField[] = request.questions.flatMap((question, offset) => {
        const questionIndex = firstQuestionIndex + offset
        return [
          {
            id: `question_${questionIndex}`,
            label: question.header ?? `Question ${questionIndex + 1}`,
            description: question.question,
            kind: 'single-select' as const,
            options: question.options.map((option) => ({
              value: option.label,
              label: option.label,
              ...(option.description ? { description: option.description } : {})
            }))
          },
          {
            id: `question_${questionIndex}_custom`,
            label: 'Other',
            description: 'Type your own answer instead of choosing an option above (optional).',
            kind: 'text' as const
          }
        ]
      })
      const appended = this.elicitationOwner.appendDetached(pendingChoice.requestId, fields)
      if (!appended) return { action: 'cancelled' }
      return { action: 'pending' }
    }

    const requestId = randomUUID()
    const promptInteraction = this.sessionInteractions.current(request.sessionId)
    const properties = Object.fromEntries(
      request.questions.flatMap((question, questionIndex) => [
        [
          `question_${questionIndex}`,
          {
            type: 'string',
            ...(question.header ? { title: question.header } : {}),
            description: question.question,
            oneOf: question.options.map((option) => ({
              const: option.label,
              title: option.label,
              ...(option.description ? { description: option.description } : {})
            }))
          }
        ],
        [
          `question_${questionIndex}_custom`,
          {
            type: 'string',
            title: 'Other',
            description: 'Type your own answer instead of choosing an option above (optional).'
          }
        ]
      ])
    )
    const pending = this.elicitationOwner.requestDetached(
      {
        mode: 'form',
        sessionId: request.sessionId,
        toolCallId: `ask-user-question-${randomUUID()}`,
        message: request.questions[0].question,
        requestedSchema: {
          type: 'object',
          properties
        }
      },
      { sessionId: request.sessionId },
      {
        kind: 'agent-user-choice',
        requestId,
        ...(promptInteraction?.kind === 'prompt' && promptInteraction.promptMessageId
          ? { promptMessageId: promptInteraction.promptMessageId }
          : {}),
        ...(promptInteraction?.kind === 'prompt' && promptInteraction.provenanceContext
          ? { provenanceContext: promptInteraction.provenanceContext }
          : {})
      }
    )

    if (!pending) return { action: 'cancelled' }
    const referencedSessions = this.handoffContinuity.copyReferencedSessions(request.sessionId)
    if (
      promptInteraction?.kind === 'prompt' &&
      (promptInteraction.provenanceContext ||
        promptInteraction.memoryEnabled !== undefined ||
        referencedSessions?.length)
    ) {
      this.userChoiceProvenanceContexts.set(requestId, {
        sessionId: request.sessionId,
        ...(promptInteraction.provenanceContext
          ? { provenanceContext: promptInteraction.provenanceContext }
          : {}),
        ...(promptInteraction.memoryEnabled !== undefined
          ? { memoryEnabled: promptInteraction.memoryEnabled }
          : {}),
        ...(referencedSessions?.length ? { referencedSessions } : {})
      })
    }
    return { action: 'pending' }
  }

  private userChoiceContinuation(
    request: PendingElicitationRequest,
    response: CreateElicitationResponse,
    historyReplay?: ElicitationResponse['historyReplay'],
    provenanceContext?: AcpPromptRequest['provenanceContext'],
    memoryEnabled?: boolean,
    referencedSessions?: AcpPromptRequest['referencedSessions']
  ): AcpPromptRequest | undefined {
    if (response.action === 'cancel') return undefined
    const content =
      response.action === 'accept'
        ? (response.content as Record<string, unknown> | undefined)
        : undefined
    const answeredQuestions = request.fields.flatMap((field) => {
      if (!/^question_\d+$/u.test(field.id)) return []
      const customAnswer = content?.[`${field.id}_custom`]
      const selectedAnswer = content?.[field.id]
      const answer =
        typeof customAnswer === 'string' && customAnswer.trim()
          ? customAnswer.trim()
          : typeof selectedAnswer === 'string' && selectedAnswer.trim()
            ? selectedAnswer.trim()
            : Array.isArray(selectedAnswer) &&
                selectedAnswer.every((value): value is string => typeof value === 'string')
              ? selectedAnswer.join(', ')
              : undefined
      return answer
        ? [
            {
              question:
                field.description ??
                (request.fields.length === 1 ? request.message : (field.label ?? request.message)),
              answer
            }
          ]
        : []
    })
    const text = (() => {
      if (response.action === 'decline' || answeredQuestions.length === 0) {
        return `The user skipped the pending question: ${request.message}\nChoose the best reasonable option and continue the current task without asking the same question again.`
      }
      if (answeredQuestions.length === 1) {
        const [{ question, answer }] = answeredQuestions
        return `The user answered the pending question: ${question}\nAnswer: ${answer}\nContinue the current task using this answer without asking the same question again.`
      }
      const answers = answeredQuestions
        .map(({ question, answer }, index) => `${index + 1}. ${question}\nAnswer: ${answer}`)
        .join('\n\n')
      return `The user answered the pending questions:\n${answers}\nContinue the current task using these answers without asking the same questions again.`
    })()
    const continuationProvenance =
      provenanceContext ??
      (request.durable?.promptMessageId
        ? { promptMessageId: request.durable.promptMessageId }
        : undefined)
    return {
      sessionId: request.sessionId,
      text,
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      suppressUserMessage: true,
      ...(continuationProvenance ? { provenanceContext: continuationProvenance } : {}),
      ...(referencedSessions?.length ? { referencedSessions } : {}),
      ...(historyReplay?.historyPreamble ? { historyPreamble: historyReplay.historyPreamble } : {}),
      ...(historyReplay?.historyAttachments?.length
        ? { historyAttachments: historyReplay.historyAttachments }
        : {}),
      ...(historyReplay?.historyImages?.length
        ? { historyImages: historyReplay.historyImages }
        : {})
    }
  }

  private clearPlanContinuationClaimRetry(sessionId: string, commandId?: string): void {
    const retry = this.planContinuationClaimRetries.get(sessionId)
    if (!retry || (commandId && retry.commandId !== commandId)) return
    if (retry.timer) clearTimeout(retry.timer)
    this.planContinuationClaimRetries.delete(sessionId)
  }

  private clearAllPlanContinuationClaimRetries(): void {
    for (const sessionId of this.planContinuationClaimRetries.keys()) {
      this.clearPlanContinuationClaimRetry(sessionId)
    }
  }

  private retryPlanContinuationClaim(
    projectId: string,
    sessionId: string,
    commandId: string
  ): void {
    const current = this.planContinuationClaimRetries.get(sessionId)
    if (current && current.commandId !== commandId) {
      this.clearPlanContinuationClaimRetry(sessionId)
    }
    const failedAttempts = current?.commandId === commandId ? current.failedAttempts + 1 : 1
    const retry: PlanContinuationClaimRetry = { commandId, failedAttempts }
    this.planContinuationClaimRetries.set(sessionId, retry)
    if (failedAttempts >= PLAN_CONTINUATION_CLAIM_MAX_ATTEMPTS) {
      this.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId,
        title: 'Could not claim the Plan continuation',
        text: 'The Plan continuation remained safely queued after concurrent Session updates.'
      })
      this.emitState()
      return
    }
    const delay = PLAN_CONTINUATION_CLAIM_RETRY_BASE_DELAY_MS * 2 ** (failedAttempts - 1)
    retry.timer = setTimeout(() => {
      const pending = this.planContinuationClaimRetries.get(sessionId)
      if (pending !== retry) return
      retry.timer = undefined
      this.scheduleQueuedPlanContinuation(projectId, sessionId, commandId)
    }, delay)
  }

  private scheduleQueuedPlanContinuation(
    projectId: string,
    sessionId: string,
    expectedCommandId?: string
  ): void {
    queueMicrotask(() => {
      void this.queueDurablePlanContinuation(projectId, sessionId, expectedCommandId).catch(
        (error) => {
          this.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId,
            title: 'Could not prepare the Plan continuation',
            text: errorMessage(error)
          })
          this.emitState()
        }
      )
    })
  }

  private async queueDurablePlanContinuation(
    projectId: string,
    sessionId: string,
    expectedCommandId?: string
  ): Promise<void> {
    const owner = this.planContinuationOwner
    const sessions = this.options.plan?.sessions
    if (
      !owner ||
      !sessions ||
      !this.activeSessionFor(sessionId) ||
      this.durablePlanContinuations?.has(sessionId)
    ) {
      return
    }

    const observed = await sessions.readSessionRuntimeContext(projectId, sessionId)
    const plan = observed.plan
    const command = plan?.continuation
    const claimRetry = this.planContinuationClaimRetries.get(sessionId)
    if (expectedCommandId && command?.commandId !== expectedCommandId) {
      this.clearPlanContinuationClaimRetry(sessionId, expectedCommandId)
      return
    }
    if (claimRetry && claimRetry.commandId !== command?.commandId) {
      this.clearPlanContinuationClaimRetry(sessionId)
    } else if (
      claimRetry?.timer ||
      claimRetry?.failedAttempts === PLAN_CONTINUATION_CLAIM_MAX_ATTEMPTS
    ) {
      return
    }
    if (
      !plan ||
      command?.state !== 'queued' ||
      (command.kind === 'approved-plan' && plan.approval !== 'approved') ||
      (command.kind === 'rejected-plan' && plan.approval !== 'rejected') ||
      (command.kind === 'review-feedback' &&
        (plan.approval !== 'pending' ||
          plan.reviewFeedbackMessageId !== command.originatingPromptMessageId))
    ) {
      if (command) this.clearPlanContinuationClaimRetry(sessionId, command.commandId)
      return
    }

    const continuation = await this.durableContinuationContext.prepare({
      projectId,
      sessionId,
      promptMessageId: command.originatingPromptMessageId,
      ...(this.restoredContinuationContextResetSessionIds?.has(sessionId)
        ? {
            replay: {
              descriptor: this.durableContinuationHistoryReplayDescriptor(),
              supportsImageInput: await this.supportsDurableContinuationImages()
            }
          }
        : {})
    })
    const reviewFeedback =
      command.kind === 'review-feedback'
        ? (await sessions.loadSessionForContinuation(projectId, sessionId)).messages.find(
            (message) =>
              message.id === command.originatingPromptMessageId &&
              message.role === 'user' &&
              message.status === 'complete'
          )
        : undefined
    if (command.kind === 'review-feedback' && !reviewFeedback) {
      throw new Error('The durable Plan review feedback Message is unavailable.')
    }
    const durablePlanContinuations =
      this.durablePlanContinuations ?? new Map<string, { projectId: string; commandId: string }>()
    this.durablePlanContinuations = durablePlanContinuations
    durablePlanContinuations.set(sessionId, { projectId, commandId: command.commandId })
    const rejected = command.kind === 'rejected-plan'
    const reviewed = command.kind === 'review-feedback'
    const request: AcpPromptRequest = {
      sessionId,
      text: reviewed
        ? 'The user provided review feedback for the pending Session Plan. Interpret the ' +
          'feedback, then call generate_plan with decision:"approved", decision:"rejected", ' +
          'or a revised Plan as appropriate. Do not treat the feedback text itself as a decision.\n\n' +
          `Review feedback:\n${reviewFeedback?.content}`
        : rejected
          ? 'The user rejected the pending Session Plan. Acknowledge that decision and do not ' +
            `execute that rejected Plan Artifact Version (artifact_version_id=${plan.artifactVersionId}). ` +
            "Await or follow the user's next request without reviving the rejected Plan."
          : 'The user approved the pending Session Plan. Continue execution of exactly that ' +
            `approved Plan Artifact Version (artifact_version_id=${plan.artifactVersionId}). ` +
            'Do not regenerate, broaden, or reinterpret the approved Plan.',
      memoryEnabled: continuation.memoryEnabled,
      suppressUserMessage: true,
      provenanceContext: continuation.provenanceContext,
      ...(continuation.referencedSessions?.length
        ? { referencedSessions: continuation.referencedSessions }
        : {}),
      planContinuation: {
        projectId,
        artifactVersionId: plan.artifactVersionId,
        expectedRevision: observed.revision,
        ...(rejected ? { settledAction: 'rejected' as const } : {}),
        ...(reviewed ? { pendingAction: 'review' as const } : {})
      },
      ...(continuation.historyReplay?.historyPreamble
        ? { historyPreamble: continuation.historyReplay.historyPreamble }
        : {}),
      ...(continuation.historyReplay?.historyAttachments.length
        ? { historyAttachments: continuation.historyReplay.historyAttachments }
        : {}),
      ...(continuation.historyReplay?.historyImages.length
        ? { historyImages: continuation.historyReplay.historyImages }
        : {})
    }
    this.appContinuations.set(sessionId, {
      condition: 'always',
      request,
      beforeSend: async () => {
        if (!(await owner.begin(projectId, sessionId, command.commandId))) {
          durablePlanContinuations.delete(sessionId)
          const latest = await sessions.readSessionRuntimeContext(projectId, sessionId)
          if (
            latest.plan?.continuation?.commandId === command.commandId &&
            latest.plan.continuation.state === 'queued'
          ) {
            this.retryPlanContinuationClaim(projectId, sessionId, command.commandId)
          } else {
            this.clearPlanContinuationClaimRetry(sessionId, command.commandId)
          }
          return undefined
        }
        this.clearPlanContinuationClaimRetry(sessionId, command.commandId)
        let dispatchReady = false
        try {
          const claimed = await sessions.readSessionRuntimeContext(projectId, sessionId)
          const claimedPlan = claimed.plan
          if (
            !claimedPlan ||
            claimedPlan.artifactVersionId !== plan.artifactVersionId ||
            claimedPlan.continuation?.commandId !== command.commandId ||
            claimedPlan.continuation.state !== 'continuing' ||
            claimedPlan.continuation.kind !== command.kind ||
            (command.kind === 'approved-plan' && claimedPlan.approval !== 'approved') ||
            (command.kind === 'rejected-plan' && claimedPlan.approval !== 'rejected') ||
            (command.kind === 'review-feedback' &&
              (claimedPlan.approval !== 'pending' ||
                claimedPlan.reviewFeedbackMessageId !== command.originatingPromptMessageId))
          ) {
            throw new Error('The Plan continuation changed before dispatch.')
          }
          dispatchReady = true
          return {
            ...request,
            planContinuation: {
              projectId,
              artifactVersionId: claimedPlan.artifactVersionId,
              expectedRevision: claimed.revision,
              ...(command.kind === 'rejected-plan' ? { settledAction: 'rejected' as const } : {}),
              ...(command.kind === 'review-feedback' ? { pendingAction: 'review' as const } : {})
            }
          }
        } finally {
          if (!dispatchReady) {
            durablePlanContinuations.delete(sessionId)
            await owner.rearmUndispatched(projectId, sessionId, command.commandId)
          }
        }
      }
    })
    this.schedulePendingAppContinuation(sessionId)
  }

  private schedulePendingAppContinuation(sessionId: string, stopReason?: string): void {
    const pending = this.appContinuations.get(sessionId)
    if (!pending) return
    if (pending.condition === 'provider-cancelled' && stopReason !== 'cancelled') {
      this.appContinuations.delete(sessionId)
      this.emitState()
      return
    }
    queueMicrotask(() => {
      void this.flushPendingAppContinuation(sessionId)
    })
  }

  private async flushPendingAppContinuation(sessionId: string): Promise<void> {
    const pending = this.appContinuations.get(sessionId)
    if (!pending || this.sessionInteractions.current(sessionId)) return
    const continuation = this.appContinuations.takeAndActivate(sessionId)
    if (!continuation) return
    let completed = false
    let cancelled = false
    try {
      const request = continuation.beforeSend
        ? await continuation.beforeSend()
        : continuation.request
      if (!request) return
      const response = await this.sendAppContinuation(request)
      cancelled = response.stopReason === 'cancelled'
      completed = !this.durablePlanContinuations?.has(sessionId) || !cancelled
    } catch (error) {
      this.pushEvent({
        kind: 'error',
        level: 'error',
        sessionId,
        ...(continuation.request.provenanceContext ?? {}),
        title: 'Could not continue the Agent task',
        text: errorMessage(error)
      })
      this.emitState()
    } finally {
      const durablePermission = this.durablePermissionContinuations?.get(sessionId)
      const durablePlan = this.durablePlanContinuations?.get(sessionId)
      this.permissionContext.clearRestoredDecision(sessionId)
      if (durablePermission?.cancellationRequested) {
        await this.settleCancelledDurablePermissionContinuation(sessionId)
      } else if (completed && durablePermission) {
        this.restoredContinuationContextResetSessionIds?.delete(sessionId)
        try {
          const cleared = await this.permissionWaitOwner.clearAfterContinuation(
            durablePermission.projectId,
            sessionId,
            durablePermission.requestId
          )
          if (cleared) {
            this.pushEvent({
              kind: 'permission',
              level: 'info',
              sessionId,
              permissionRequestId: durablePermission.requestId,
              title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
              text: 'completed'
            })
          }
        } catch (error) {
          this.pushEvent({
            kind: 'permission',
            level: 'error',
            sessionId,
            permissionRequestId: durablePermission.requestId,
            title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
            text: errorMessage(error)
          })
        } finally {
          this.durablePermissionContinuations?.delete(sessionId)
        }
      } else if (durablePermission) {
        try {
          // A retry is safe only after durable authority returns from consumed to pending. If this
          // write fails, retain `continuing` as a fail-closed tombstone and do not expose the card.
          await this.permissionWaitOwner.rearmContinuation(
            durablePermission.projectId,
            sessionId,
            durablePermission.requestId
          )
          this.pushEvent({
            kind: 'permission',
            level: 'info',
            sessionId,
            permissionRequestId: durablePermission.requestId,
            title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
          })
        } catch (error) {
          this.pushEvent({
            kind: 'permission',
            level: 'error',
            sessionId,
            permissionRequestId: durablePermission.requestId,
            title: ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
            text: errorMessage(error)
          })
        } finally {
          this.durablePermissionContinuations?.delete(sessionId)
        }
      }
      if (cancelled && durablePlan && this.planContinuationOwner) {
        try {
          await this.planContinuationOwner.interrupt(
            durablePlan.projectId,
            sessionId,
            durablePlan.commandId
          )
        } catch (error) {
          this.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId,
            title: 'Could not mark the Plan continuation as interrupted',
            text: errorMessage(error)
          })
        }
      } else if (completed && durablePlan && this.planContinuationOwner) {
        try {
          await this.clearSettledPlanContinuation(sessionId, durablePlan)
        } catch (error) {
          this.pushEvent({
            kind: 'error',
            level: 'error',
            sessionId,
            title: 'Could not settle the Plan continuation',
            text: errorMessage(error)
          })
        }
      }
      if (durablePlan) await this.publishCurrentPlanProjection(durablePlan.projectId, sessionId)
      if (durablePlan) this.durablePlanContinuations?.delete(sessionId)
      this.appContinuations.complete(sessionId)
      this.emitState()
    }
  }

  private async clearSettledPlanContinuation(
    sessionId: string,
    durablePlan: Readonly<{ projectId: string; commandId: string }>
  ): Promise<void> {
    const owner = this.planContinuationOwner
    const sessions = this.options.plan?.sessions
    if (!owner || !sessions) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await owner.clear(durablePlan.projectId, sessionId, durablePlan.commandId)) return
      const current = await sessions.readSessionRuntimeContext(durablePlan.projectId, sessionId)
      const continuation = current.plan?.continuation
      if (!continuation) return
      if (continuation.commandId !== durablePlan.commandId || continuation.state !== 'continuing') {
        throw new Error('The Plan continuation changed before settlement.')
      }
    }
    throw new Error('The Plan continuation could not be settled after concurrent updates.')
  }

  private async publishCurrentPlanProjection(projectId: string, sessionId: string): Promise<void> {
    try {
      const projection = await this.sessionPlanWorkflow.projection(projectId, sessionId)
      if (!projection) return
      this.pushEvent({
        id: `session-plan-${projection.artifactVersionId}-${projection.revision}`,
        timestamp: Date.now(),
        kind: 'plan',
        level: 'info',
        sessionId,
        title: 'Session Plan updated',
        planProjection: projection
      })
    } catch (error) {
      safeLogError('Session Plan continuation projection failed', errorLogFields(error))
    }
  }

  // App-owned privileged actions (such as Specialist handoff) share the provider permission card
  // and broker lifecycle. The caller supplies only a redacted renderer payload; this runtime owns
  // request parking, cancellation, and response validation.
  async requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
    signal?: AbortSignal
  }): Promise<boolean> {
    return this.permissionContext.requestAppApproval(input)
  }

  async requestAppPermission(input: AppPermissionRequest): Promise<string | undefined> {
    return this.permissionContext.requestAppPermission(input)
  }

  // Lazily initializes the process connection before session creation.
  private async ensureConnected(cwd: string): Promise<ClientConnection> {
    return this.connectionLifecycle.ensureConnected(cwd)
  }

  private observeClaudeSdkMessage(params: Record<string, unknown>): void {
    if (typeof params.sessionId === 'string') {
      this.providerSessionResumer.observeProgress(params.sessionId)
    }
    this.providerPromptExecutor.observeProviderMessage(params)
  }

  // Looks up the workspace root bound to a session for filesystem operations.
  private resolveSessionCwd(sessionId: string): string {
    const sessionCwd = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().cwd

    if (!this.activeSessionFor(sessionId) || !sessionCwd) {
      throw new Error(`Unknown ACP session: ${sessionId}`)
    }

    return sessionCwd
  }

  // App-owned directories the agent's Read tool must never read: framework config dirs hold
  // materialized skills plus provider/auth configuration whose contents must not be surfaced.
  private protectedReadRoots(): string[] {
    if (!this.artifactOptions) return []

    const root = this.artifactOptions.configRoot

    return [
      getAppClaudeConfigDir(root),
      opencodeStorageDir(root),
      codexStorageDir(root),
      codexSubscriptionStorageDir(root)
    ]
  }

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectId(sessionId: string): string {
    return this.sessionEnvironment.projectId(sessionId)
  }

  // Writes an inline file into the in-flight turn's pending artifact run so it attaches to the resulting
  // message and surfaces to the renderer like any generated artifact. Used by app-side connector tools
  // (e.g. molecule preview). Throws when no assistant turn is active (e.g. a user-run notebook cell).
  async writeArtifactForCurrentRun(
    sessionId: string,
    input: {
      filename: string
      content: string
      mimeType?: string
      producer?: AppGeneratedArtifactProducer
    }
  ): Promise<ArtifactFile> {
    if (!this.artifactTurns) {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    const execution = this.sessionInteractions.current(sessionId)
    if (!execution || execution.kind !== 'prompt') {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    const artifact = this.artifactTurns.handleForExecution(execution.turnToken)
    if (this.artifactTurns.snapshot(artifact).phase !== 'open') {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    return this.artifactTurns.write(artifact, input)
  }

  private cancelPermissionFlowForSession(sessionId: string): void {
    this.permissionContext.cancelForSession(sessionId)
    this.clearUserChoiceProvenanceForSession(sessionId)
    this.elicitationOwner.cancelForSession(sessionId)
    this.appContinuations.delete(sessionId)
  }

  private clearUserChoiceProvenanceForSession(sessionId: string): void {
    const provenanceContexts = this.userChoiceProvenanceContexts
    if (!provenanceContexts) return
    for (const [requestId, provenance] of provenanceContexts) {
      if (provenance.sessionId === sessionId) {
        provenanceContexts.delete(requestId)
      }
    }
  }

  private async settleCancelledDurablePermissionContinuation(sessionId: string): Promise<void> {
    const durablePermission = this.durablePermissionContinuations?.get(sessionId)
    if (!durablePermission) return
    try {
      await this.permissionWaitOwner.cancelContinuation(
        durablePermission.projectId,
        sessionId,
        durablePermission.requestId
      )
    } catch (error) {
      this.pushEvent({
        kind: 'permission',
        level: 'error',
        sessionId,
        permissionRequestId: durablePermission.requestId,
        title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
        text: errorMessage(error)
      })
      return
    }
    if (this.durablePermissionContinuations?.get(sessionId) !== durablePermission) return
    this.durablePermissionContinuations.delete(sessionId)
    this.restoredContinuationContextResetSessionIds?.delete(sessionId)
    this.permissionContext.clearRestoredDecision(sessionId)
    this.pushEvent({
      kind: 'permission',
      level: 'info',
      sessionId,
      permissionRequestId: durablePermission.requestId,
      title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
      text: 'cancelled'
    })
  }

  private durableContinuationHistoryReplayDescriptor(): HistoryReplayDescriptor {
    const backend = this.backendGeneration.current
    const target =
      backend.framework.id === 'opencode'
        ? 'opencode'
        : backend.framework.id === 'codebuddy'
          ? 'codebuddy'
          : backend.framework.id === 'codex'
            ? backend.modelRoute === 'codex-bridge'
              ? 'codex-bridge'
              : 'codex-response'
            : 'claude-code'
    return {
      target,
      ...(backend.context.window ? { contextWindow: backend.context.window } : {})
    }
  }

  private async supportsDurableContinuationImages(): Promise<boolean> {
    return (
      this.backendGeneration.current.context.supportsImageInput ||
      (await this.options.imageInputCompatibility?.isAvailable()) === true
    )
  }

  private processEventDisposition(
    process: ChildProcessWithoutNullStreams,
    epoch: number
  ): ReturnType<AcpConnectionResourceOwner['processEventDisposition']> {
    if (this.connectionClose.isExpected(process)) return 'expected'
    return this.connectionResources.processEventDisposition(process, epoch)
  }

  // Projects adapter-bound process diagnostics while retaining epoch classification and event state.
  private handleAgentProcessStderr(
    text: string,
    context: Parameters<AcpAgentConnectionHooks['onProcessStderr']>[1]
  ): void {
    if (!text) return

    const disposition = this.processEventDisposition(context.process, context.epoch)
    const inFlight = disposition === 'current' ? this.getInFlightSessionIds() : []
    const sessionId = inFlight.length === 1 ? inFlight[0] : undefined
    const interactionSequence = sessionId
      ? this.sessionInteractions.current(sessionId)?.sequence
      : undefined
    const existing = this.agentStderrWindows.get(context.process)
    if (existing) {
      existing.chunkCount += 1
      existing.byteCount += Buffer.byteLength(text, 'utf8')
      existing.eventEligible &&= disposition === 'current'
      existing.nonActionableCodexOnly &&=
        context.framework === 'codex' && isNonActionableCodexStderr(text)
      if (
        existing.sessionId !== sessionId ||
        existing.interactionSequence !== interactionSequence
      ) {
        existing.sessionId = undefined
        existing.interactionSequence = undefined
        existing.sessionAttributionConsistent = false
      }
      this.appendAgentStderrSample(existing, text)
      this.observeCodexTransportSignal(existing, text)
      return
    }

    const timer = setTimeout(
      () => this.flushAgentProcessStderr(context.process),
      AGENT_STDERR_REPORT_WINDOW_MS
    )
    timer.unref?.()
    const window: AgentStderrWindow = {
      process: context.process,
      framework: context.framework,
      epoch: context.epoch,
      startedAt: Date.now(),
      chunkCount: 1,
      byteCount: Buffer.byteLength(text, 'utf8'),
      rawSample: '',
      rawSampleBytes: 0,
      rawSampleTruncated: false,
      sessionId,
      interactionSequence,
      sessionAttributionConsistent: true,
      nonActionableCodexOnly: context.framework === 'codex' && isNonActionableCodexStderr(text),
      codexTransportSignalSample: '',
      codexWebSocketFallbackObserved: false,
      eventEligible: disposition === 'current',
      timer
    }
    this.appendAgentStderrSample(window, text)
    this.observeCodexTransportSignal(window, text)
    this.agentStderrWindows.set(context.process, window)
  }

  // Codex diagnostics can cross Node stderr chunk boundaries. Retain only a short ephemeral suffix
  // for this exact operational signal; it is never logged or persisted as user-visible output.
  private observeCodexTransportSignal(window: AgentStderrWindow, text: string): void {
    if (window.framework !== 'codex' || window.codexWebSocketFallbackObserved) return
    window.codexTransportSignalSample = `${window.codexTransportSignalSample}${text}`.slice(
      -CODEX_TRANSPORT_SIGNAL_SAMPLE_CHARACTERS
    )
    if (!hasCodexWebSocketFallback(window.codexTransportSignalSample)) return
    window.codexWebSocketFallbackObserved = true
    window.nonActionableCodexOnly = isNonActionableCodexStderr(window.codexTransportSignalSample)
    if (
      !window.eventEligible ||
      this.processEventDisposition(window.process, window.epoch) !== 'current' ||
      this.backend.providerId === undefined ||
      !isCodexSubscriptionProviderId(this.backend.providerId)
    ) {
      return
    }
    try {
      this.options.callbacks?.onCodexWebSocketFallback?.()
    } catch (error) {
      safeLogError('Codex WebSocket fallback observation failed', errorLogFields(error))
    }
  }

  private includeRawAgentStderr(): boolean {
    return process.env[RAW_AGENT_STDERR_ENV]?.trim().toLowerCase() === 'raw'
  }

  private appendAgentStderrSample(window: AgentStderrWindow, text: string): void {
    if (!this.includeRawAgentStderr()) return
    let available = MAX_RAW_AGENT_STDERR_SAMPLE_BYTES - window.rawSampleBytes
    if (available <= 0) {
      window.rawSampleTruncated = true
      return
    }
    if (window.rawSample) {
      window.rawSample += '\n'
      window.rawSampleBytes += 1
      available -= 1
    }
    const prefix = utf8PrefixWithinBytes(text, available)
    window.rawSample += prefix
    window.rawSampleBytes += Buffer.byteLength(prefix, 'utf8')
    if (prefix.length < text.length) window.rawSampleTruncated = true
  }

  private flushAgentProcessStderr(process: ChildProcessWithoutNullStreams): void {
    const window = this.agentStderrWindows.get(process)
    if (!window) return
    this.agentStderrWindows.delete(process)
    clearTimeout(window.timer)

    const windowMs = Math.max(1, Date.now() - window.startedAt)
    const includeRaw = this.includeRawAgentStderr() && window.rawSample.length > 0
    const chunkLabel = window.chunkCount === 1 ? 'chunk' : 'chunks'
    const summary = `Agent process stderr: ${window.chunkCount} ${chunkLabel}, ${window.byteCount} bytes; ${includeRaw ? 'bounded raw sample follows' : 'raw output omitted'}.`
    const rawSuffix = window.rawSampleTruncated ? '\n…[truncated]' : ''
    log.warn('agent stderr summary', {
      errorCategory: 'process-stderr',
      framework: window.framework,
      status: this.snapshotOwner.status,
      sessionCount: this.activeSessionIds().length,
      chunkCount: window.chunkCount,
      byteCount: window.byteCount,
      windowMs,
      chunksPerSecond: Number(((window.chunkCount * 1000) / windowMs).toFixed(1)),
      ...(includeRaw
        ? { rawSample: window.rawSample, rawSampleTruncated: window.rawSampleTruncated }
        : {})
    })

    if (
      !window.eventEligible ||
      this.processEventDisposition(window.process, window.epoch) !== 'current'
    ) {
      return
    }
    if (window.nonActionableCodexOnly) return

    const inFlight = this.getInFlightSessionIds()
    const currentSessionId = inFlight.length === 1 ? inFlight[0] : undefined
    const currentInteractionSequence = currentSessionId
      ? this.sessionInteractions.current(currentSessionId)?.sequence
      : undefined
    const sessionId =
      window.sessionAttributionConsistent &&
      window.sessionId === currentSessionId &&
      window.interactionSequence === currentInteractionSequence
        ? window.sessionId
        : undefined
    this.pushEvent({
      kind: 'system',
      level: 'warning',
      sessionId,
      title: 'agent',
      text: includeRaw ? `${summary}\n${window.rawSample}${rawSuffix}` : summary
    })
  }

  private handleAgentProcessError(
    error: unknown,
    context: Parameters<AcpAgentConnectionHooks['onProcessError']>[1]
  ): void {
    log.error('agent process error event', {
      ...diagnosticErrorFields(error),
      ...this.diagnosticContext(context.framework, context.epoch)
    })

    if (this.processEventDisposition(context.process, context.epoch) !== 'current') return

    this.snapshotOwner.updateError(errorMessage(error))
    this.pushEvent({
      kind: 'error',
      level: 'error',
      title: 'Agent process error',
      text: this.snapshotOwner.error
    })
    this.setStatus('error')
  }

  private handleAgentProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    context: Parameters<AcpAgentConnectionHooks['onProcessExit']>[2]
  ): void {
    this.flushAgentProcessStderr(context.process)
    const processDisposition = this.processEventDisposition(context.process, context.epoch)
    log.info('agent process exit', {
      code,
      signal,
      framework: context.framework,
      status: this.snapshotOwner.status,
      expected: processDisposition === 'expected',
      sessionCount: this.activeSessionIds().length,
      pid: context.pid
    })

    if (processDisposition !== 'current') return

    if (this.snapshotOwner.status === 'connected' || this.snapshotOwner.status === 'connecting') {
      this.pushEvent({
        kind: 'system',
        level: code === 0 ? 'info' : 'warning',
        title: 'Agent process exited',
        text: signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
      })
    }
  }

  // Updates connection status and broadcasts the new snapshot.
  private setStatus(status: AcpStateSnapshot['status']): void {
    this.snapshotOwner.transitionStatus(status)
    this.emitState()
  }

  // Adds a bounded event entry and notifies all renderer listeners.
  private pushEvent(event: AcpRuntimeEventInput, onAppended?: () => void): void {
    this.publication.pushEvent(event, onAppended)
  }

  // Broadcasts the latest runtime snapshot if a listener is registered.
  private emitState(): void {
    this.publication.emitState()
  }

  // Creates an ephemeral reviewer ACP session using the existing agent connection. The reviewer
  // session is isolated from primary session registry state, does not
  // appear in the snapshot, and callers are responsible for disposing it. This allows background
  // review to run in parallel with the main session without affecting the main state machine.
  async buildReviewerSession(request: ReviewerSessionRequest): Promise<ReviewerSessionResult> {
    return this.withOperationLease(() =>
      this.reviewerSessions.create(request, {
        ensureConnected: (cwd) => this.ensureConnected(cwd)
      })
    )
  }

  private assertCurrentConnectedConnection(connection: ClientConnection): void {
    if (this.connection !== connection || this.snapshotOwner.status !== 'connected') {
      throw new Error('ACP session startup was superseded.')
    }
  }

  // Disposes an ephemeral reviewer session and unregisters it from the auto-approve set. Safe to call
  // even if the session was never registered (e.g. it failed before start). Returns the gate rejection
  // count plus whether a bridged reviewer request actually hit its trusted session scope. The reads and
  // clears are atomic here so callers need no capture-before-dispose ordering.
  disposeReviewerSession(
    session: import('@agentclientprotocol/sdk').ActiveSession
  ): ReviewerSessionDisposition {
    return this.reviewerSessions.dispose(session)
  }
}

export { AcpRuntime }
export type { AcpRuntimeOptions }
export type { ReviewerSessionDisposition } from './reviewer-session-owner'
