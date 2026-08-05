import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpContextUsage,
  AcpTurnTokenUsage,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import {
  ACP_MODEL_TURN_COUNT_META_KEY,
  ACP_TURN_TOKEN_USAGE_META_KEY,
  toAcpTurnTokenUsage
} from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import {
  DEFAULT_PERMISSION_PROFILE,
  normalizePermissionProfile,
  type SessionPermissionProfileState
} from '../../shared/permission-profiles'
import { type AgentFrameworkId } from '../../shared/settings'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import {
  claudeCodeFramework,
  getAgentFramework,
  type AgentFramework,
  type AgentModelChangeTarget,
  type ResolvedAgentBackend
} from '../agent-framework'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import { extractProviderToolName } from './runtime-events'
import { toCodexTurnTokenUsage } from './codex-turn-usage'
import { fetchOpenCodeUsageSnapshot, sumOpenCodeTurnUsage } from './opencode-turn-usage'
import { matchSessionModelOption, resolveSessionEffortOption } from './session-config'
import { describePromptError, isProviderPromptError } from './prompt-error'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { ConversationPermissionGrantStore } from './permission-broker'
import { isMcpToolName } from './permission-policy'
import { AcpPermissionContext, HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import { applyCurrentModeUpdate } from './permission-profile-controller'
import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { NOTEBOOK_SYSTEM_PROMPT_APPEND, type NotebookRpcConnection } from '../notebook/mcp-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import {
  SKILL_IMPORT_SYSTEM_PROMPT_APPEND,
  type SkillImportRpcConnection
} from '../skills/mcp-server'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { withDataRootWrite } from '../storage/migration-state'
import { opencodeStorageDir } from '../agent-framework/opencode'
import {
  ContextUsageTracker,
  type ContextUsageTurnHandle,
  type SessionEstimateInput
} from './context-usage-tracker'
import { contextUsageMcpSections } from './context-usage-static-context'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import type { UploadRepository } from '../uploads/repository'
import { DEFAULT_UPLOAD_PROJECT_NAME, type UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, FileReference } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import { isMediaOverflowError } from '../../shared/media-overflow'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import { resolveFileTextBudget } from '../../shared/history-preamble'
import {
  ReviewerSessionOwner,
  type ReviewerSessionDisposition,
  type ReviewerSessionRequest,
  type ReviewerSessionResult
} from './reviewer-session-owner'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
  type SessionCapabilityProvision
} from './session-capability-owner'
import { ArtifactTurnOwner, type ArtifactTurnHandle } from './artifact-turn-owner'
import { AcpPromptContentOwner } from './prompt-content-owner'
import {
  AcpSessionInteractionOwner,
  type AcpPromptSessionInteractionScope
} from './session-interaction-owner'
import type { AcpSessionAggregateAttachInput } from './session-aggregate'
import {
  AcpSessionRegistry,
  type AcpPrimarySessionIdentityReservation,
  type AcpPrimarySessionIdentityReservationResult,
  type AcpSessionDeletion,
  type AcpSessionRegistryEntry
} from './session-registry'
import {
  AcpConnectionResourceOwner,
  type AcpConnectionResourceAttempt
} from './connection-resource-owner'
import {
  AcpAgentConnectionAdapter,
  type AcpAgentConnectionCandidate,
  type AcpAgentConnectionHooks
} from './agent-connection-adapter'
import { AcpConnectionTransitionOwner } from './connection-transition-owner'
import { AcpGenerationActivityOwner } from './generation-activity-owner'
import { AcpHandoffContinuityOwner } from './handoff-continuity-owner'
import {
  AcpBackendGenerationOwner,
  type AcpBackendGenerationView
} from './backend-generation-owner'
import { AcpSessionConfigurator } from './session-configurator'
import { AcpSessionUpdateProjector, type AcpSessionUpdateEffect } from './session-update-projector'
import { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'
import { AcpConnectionCloseWorkflow, type CloseState } from './connection-close-workflow'
import { AcpModelChangeWorkflow } from './model-change-workflow'
import { AcpProviderSessionCreator } from './provider-session-creator'
import { AcpProviderSessionAdopter } from './provider-session-adopter'
import {
  AcpTurnSkillOwner,
  type AcpTurnSkillHooks,
  type TurnSkillHandle,
  type TurnSkillOutcome
} from './turn-skill-owner'

export type AcpRuntimeCallbacks = {
  onStateChanged?: (state: AcpStateSnapshot) => void
  onEvent?: (event: AcpRuntimeEvent) => void
  onPermissionRequest?: (request: AcpPermissionRequest) => void
  onPromptStarted?: (sessionId: string, turnToken: string, promptAttemptId?: string) => void
  // Fires after the provider prompt yields its first update/terminal response. Reaching this point
  // proves startup did not reject before the provider accepted the request.
  onProviderPromptAccepted?: (sessionId: string, promptAttemptId?: string) => void
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
  permissionGrantStore?: ConversationPermissionGrantStore
  permissionGrantRegistry?: PermissionGrantRegistry
  spawnAgent?: () => ChildProcessWithoutNullStreams
  // Resolves the active agent backend (framework + spawn inputs) at connect time so a framework or
  // provider switch takes effect on reconnect. Ignored when an explicit spawnAgent is provided (tests
  // inject that directly).
  resolveBackend?: (context: {
    forcedSkillIds: string[]
    systemPromptAppends: string[]
  }) => Promise<ResolvedAgentBackend> | ResolvedAgentBackend
  artifacts?: AcpRuntimeArtifactOptions
  uploads?: AcpRuntimeUploadOptions
  notebook?: AcpRuntimeNotebookOptions
  skillImport?: AcpRuntimeSkillImportOptions
  skills?: AcpTurnSkillHooks
  // The agent backend to drive. Defaults to Claude Code; selecting another (opencode) swaps only the
  // framework-coupled behavior (spawn, session meta, permission-mode mapping) via AgentFramework.
  framework?: AgentFramework
  // Local http host for app-owned session MCP servers, used for frameworks that reject stdio MCP.
  // Absent ⇒ those frameworks run without the corresponding app tooling.
  mcpHttpHost?: AgentMcpHttpHost
  // Bounds the network-bound reconnect+resume so Resume always resolves; the fast attached-session
  // path is never timed. Injectable timer mirrors the approval broker so tests stay deterministic.
  resumeTimeoutMs?: number
  cancelTimeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  // Per-session cumulative inlined-image budget in base64 bytes. Defaults to MAX_SESSION_INLINE_IMAGE_BYTES;
  // injectable so tests can drive the degrade-to-file path with small fixtures.
  inlineImageBudgetBytes?: number
  contextUsageTracker?: ContextUsageTracker
  // Injectable only for the authenticated OpenCode loopback usage snapshots; production uses fetch.
  opencodeUsageFetch?: typeof fetch
  // Resolves the identity-inject text for a specialist UUID at session-creation time.
  // The main process reads the latest Profile from ProfileService; the runtime never caches it.
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
}

type AcpRuntimeArtifactOptions = {
  // Config root: where the app-owned claude config dir lives (never relocated).
  configRoot: string
  // Data root: where artifacts/notebooks/runtime live (user-relocatable).
  dataRoot: string
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  repository?: ArtifactRepository
  runRegistry?: ArtifactRunRegistry
  getRpcConnection?: () => Promise<NotebookRpcConnection>
  issueRpcCapability?: (binding: ArtifactRpcCapabilityBinding) => string
  revokeRpcCapability?: (token: string) => Promise<void> | void
  provenance?: Pick<
    import('../artifacts/provenance-repository').ArtifactProvenanceRepository,
    'listRunVersions' | 'writeAppGeneratedVersion'
  > &
    Partial<
      Pick<
        import('../artifacts/provenance-repository').ArtifactProvenanceRepository,
        'resolveVersionContent'
      >
    >
}

type AcpRuntimeUploadOptions = {
  repository: UploadRepository
}

type AcpRuntimeNotebookOptions = {
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection?: (binding: {
    sessionId: string
    projectId: string
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string) => void
  registerSessionSpecialist?: (sessionId: string, specialistId: string | undefined) => void
  setArtifactProvenanceContext?: (
    sessionId: string,
    context: import('../../shared/notebook').NotebookRunProvenanceContext | undefined
  ) => void
  registerTurnInputs?: (request: {
    projectId: string
    appSessionId: string
    promptMessageId: string
    uploads: UploadedAttachment[]
    references: FileReference[]
  }) => Promise<void>
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

type SessionAttachmentResponse = {
  sessionId: string
  modes?: SessionModeState | null
  configOptions?: unknown
  _meta?: unknown
}

type ClientContextSessionAttacher = {
  attachSession: (response: SessionAttachmentResponse) => ActiveSession
}

// Mirror claude-agent-acp's autonomous result lanes. Unknown future origins stay eligible so a
// newly introduced user lane does not silently lose the terminal SDK `num_turns` value.
const CLAUDE_AUTONOMOUS_RESULT_ORIGINS = new Set([
  'task-notification',
  'peer',
  'coordinator',
  'observer',
  'observer-activity'
])
// An end_turn is final from the runtime's perspective, so promised work must be a tool call in the
// current turn or an explicit request for user input rather than text that implies later execution.
const TURN_CONTINUITY_SYSTEM_PROMPT_APPEND = [
  '<open_science_turn_continuity_instructions>',
  'Do not describe a tool-backed action as future work and then end the turn. If you say you will download, install, run, edit, analyze, or otherwise perform an action that needs a tool, issue the corresponding tool call in this same turn.',
  'If a required tool cannot be used or its operation fails, do not promise another attempt. Clearly state that the turn has stopped, what prevented progress, and what the user can do next.',
  '</open_science_turn_continuity_instructions>'
].join('\n')
const buildNotebookHandoffPrompt = (context: NotebookHandoffContext): string =>
  [
    '<open_science_notebook_continuity>',
    'The application retained this live in-memory Notebook state while the Agent context was replaced. Treat it as continuity metadata, not as a request to inspect Notebook again.',
    JSON.stringify(context),
    '</open_science_notebook_continuity>'
  ].join('\n')
// Appends artifact tool guidance as system prompt metadata so user prompts stay untouched.
const ARTIFACT_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_artifact_instructions>',
  'When this turn creates or saves local user-facing files such as images, documents, reports, data exports, XML, SVG, HTML, CSV, PDF, or archives, you MUST save them through the MCP tool `write_artifact_file` from the `open-science-artifacts` server.',
  'Do not save generated user-facing files directly into the workspace or current directory unless the user explicitly asks to modify project files.',
  'Pass the filename, MIME type, and either inline content or a local source path to `write_artifact_file`; the app assigns the project, session, Artifact run, and final message location.',
  'If a Notebook, REPL, or shell execution produced the file, also pass `producerRunId` with the exact `runId` returned by the execution that created or last modified it. Omit `producerRunId` only when no Notebook execution produced the file; never use the Artifact run ID as the producer.',
  'Only claim a generated file is available after `write_artifact_file` succeeds. If it fails or is denied, state that the local file may exist but was not saved as an Artifact, and do not present it as downloadable.',
  'After using the tool, mention the generated filename rather than an absolute filesystem path. The app will display the generated file list below your message.',
  'Never write files inside a skill directory — loaded skills are read-only; route any file a skill generates through `write_artifact_file`.',
  '</open_science_artifact_instructions>'
].join('\n')

// Steers the agent away from reading large attached data files in their entirety, since a single big
// read (esp. under frameworks whose read/bash tools do not hard-cap output) can exceed the provider's
// request-size limit and break the conversation. Framework-neutral: Claude carries it in the system
// prompt preset, opencode as a prompt prefix.
const LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND = [
  '<open_science_large_file_instructions>',
  'Large attached data files (CSV, TSV, TXT, JSON, FASTA/FASTQ, VCF, and similar tabular or text data) are provided as a file reference plus a short preview, not as full inline content.',
  'Never read, cat, or print such a file in its entirety — a single large read can exceed the request-size limit and break the conversation.',
  'Inspect structure first (columns, row count, a few sample rows), then read only the specific line ranges, rows, or columns you need.',
  'To analyze, filter, or aggregate over a large file, load it in the notebook (e.g. pandas) and compute there instead of reading its contents into the conversation.',
  '</open_science_large_file_instructions>'
].join('\n')

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

// The ACP agent tags a provider-relayed failure with the upstream error type in `data.errorKind`
// (e.g. `request_too_large` for an HTTP 413). Read it so the overflow check can match the slug even
// when the message text comes in a wording the pattern does not cover. Total: any shape but a string
// kind collapses to undefined, and a hostile getter never escapes.
const acpErrorKind = (error: unknown): string | undefined => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind

    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

const log = createLogger('acp')

// Logs an error without ever throwing back into the caller. Used on failure paths where a throwing
// logger (or a hostile payload) must never mask the original error being handled/re-thrown.
const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

const UNRESUMABLE_SESSION_ERROR_KINDS = new Set([
  'session_not_found',
  'conversation_not_found',
  'session_missing',
  'conversation_missing',
  'session_resume_failed',
  'conversation_restore_failed'
])

const isUnresumableSessionErrorKind = (errorKind: unknown): boolean =>
  typeof errorKind === 'string' &&
  UNRESUMABLE_SESSION_ERROR_KINDS.has(
    errorKind
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  )

const isCodexProtocolSessionId = (sessionId: string): boolean =>
  /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)

const isOpenCodeProtocolSessionId = (sessionId: string): boolean => sessionId.startsWith('ses_')

// Legacy agents may expose only an English diagnostic. Keep this fallback deliberately narrow: a
// false positive silently resets agent-side context, while a false negative leaves the real error
// visible and can be fixed by teaching the backend to emit a machine-readable errorKind.
const describesUnresumableSession = (details: unknown): boolean => {
  if (typeof details !== 'string') return false
  if (
    /\b(?:auth|authentication|authorization|credential|provider|mcp|model|tool|server)\b/i.test(
      details
    )
  )
    return false

  const describesMissingSession =
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+(?:(?:was|is)\s+)?(?:not found|missing|unknown)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+does not exist\b/i.test(details) ||
    /\b(?:no|missing|unknown)\s+(?:saved\s+|previous\s+)?(?:session|conversation)\b/i.test(details)
  const describesFailedResume =
    /\b(?:failed|unable|cannot|can't|could not)\s+to\s+(?:resume|restore|reopen|reattach)\b.{0,80}\b(?:session|conversation)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:failed|was unable)\s+to\s+(?:resume|restore|reopen|reattach)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:could not|cannot|can't)\s+be\s+(?:resumed|restored|reopened|reattached)\b/i.test(
      details
    )

  return describesMissingSession || describesFailedResume
}

// Detects an agent-side resume failure that means the session cannot be reattached, so the thread
// should adopt a fresh agent session instead of dead-ending. A spec-compliant agent returns
// "Resource not found" (-32002) for a session id it no longer holds (e.g. after a provider switch);
// some agents instead return a generic "Internal error" (-32603) after an app restart replaced their
// process. Both mean resume is impossible here. Other failures (invalid params, transport errors)
// still propagate so genuinely fatal problems stay visible.
const isUnresumableSessionError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as {
    code?: number
    message?: string
    data?: { details?: unknown; errorKind?: unknown; service?: unknown }
  }
  const message = candidate.message ?? ''

  if (candidate.code === -32002 || /resource not found|session not found/i.test(message))
    return true

  if (candidate.code !== -32603) return false

  // opencode reports a lost session as an Internal error tagged with the failing service
  // (`{ service: 'session' }`) and a descriptive message suffix, rather than the bare message or the
  // details string the fallbacks below expect. This marker is machine-readable and language-
  // independent, so a session-service failure is authoritative — adopt a fresh session regardless of
  // the suffix. A non-session service (provider, mcp, …) still propagates as a genuine failure.
  if (candidate.data?.service === 'session') return true

  if (!/^internal error\.?$/i.test(message.trim())) return false

  // A structured reason is authoritative and language-independent. Unknown reasons propagate even when
  // their detail happens to look session-related, preventing provider/MCP errors from being swallowed.
  if (candidate.data?.errorKind !== undefined) {
    return isUnresumableSessionErrorKind(candidate.data.errorKind)
  }

  // Detail-free Internal errors keep the existing fallback because some agents discard the cause.
  return (
    candidate.data?.details === undefined || describesUnresumableSession(candidate.data.details)
  )
}

// ACP Session facade. Connection publication and physical teardown live behind their epoch owner;
// Runtime retains protocol startup, Session/Permission/Notebook cleanup, and status/event projection.
class AcpRuntime {
  private readonly snapshotOwner: AcpRuntimeSnapshotOwner
  private readonly contextUsageTracker: ContextUsageTracker
  private readonly connectionAdapter = new AcpAgentConnectionAdapter()
  private readonly connectionResources: AcpConnectionResourceOwner
  private readonly connectionTransitions: AcpConnectionTransitionOwner
  private readonly generationActivity: AcpGenerationActivityOwner
  // Stable app identities, provider aliases, publication order, selection, and startup/delete
  // arbitration share one owner. The runtime retains only protocol/resource orchestration.
  private readonly sessionRegistry: AcpSessionRegistry
  // App-owned MCP construction, routing aliases, and bearer lease ownership are kept behind one
  // explicit role policy. Connection/process lifetime remains with the connection resource owner.
  private readonly sessionCapabilities: AcpSessionCapabilityOwner
  private readonly sessionInteractions: AcpSessionInteractionOwner
  // Ephemeral Reviewer identity, isolation, permission, and resource state lives behind one owner.
  private readonly reviewerSessions: ReviewerSessionOwner
  private readonly turnSkills: AcpTurnSkillOwner
  private readonly handoffContinuity = new AcpHandoffContinuityOwner()
  private readonly permissionContext: AcpPermissionContext
  private readonly callbacks: AcpRuntimeCallbacks
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly backendGeneration: AcpBackendGenerationOwner
  private readonly sessionConfigurator: AcpSessionConfigurator
  private readonly sessionUpdateProjector = new AcpSessionUpdateProjector()
  // Bounded resume network timeout + injectable timers (defaults to real setTimeout/clearTimeout).
  private readonly resumeTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly notebookOptions: AcpRuntimeNotebookOptions | undefined
  private readonly skillImportOptions: AcpRuntimeSkillImportOptions | undefined
  private readonly artifactRepository: ArtifactRepository | undefined
  private readonly artifactRunRegistry: ArtifactRunRegistry | undefined
  private readonly artifactTurns: ArtifactTurnOwner | undefined
  private readonly promptContentOwner: AcpPromptContentOwner
  private readonly connectionClose: AcpConnectionCloseWorkflow
  private readonly connectionLifecycle: AcpConnectionLifecycleWorkflow
  private readonly modelChanges: AcpModelChangeWorkflow
  private readonly providerSessionCreator: AcpProviderSessionCreator
  private readonly providerSessionAdopter: AcpProviderSessionAdopter

  // Wires runtime dependencies and forwards permission prompts into the event stream.
  constructor(private readonly options: AcpRuntimeOptions) {
    this.snapshotOwner = new AcpRuntimeSnapshotOwner(resolve(options.defaultCwd))
    this.callbacks = options.callbacks ?? {}
    this.connectionResources = new AcpConnectionResourceOwner({
      closeMcpHost: async () => {
        await options.mcpHttpHost?.close()
      }
    })
    this.generationActivity = new AcpGenerationActivityOwner({
      activityChanged: () => this.generationActivityChanged(),
      hasActivePrompts: () => this.sessionInteractions.snapshot().length > 0,
      hasActiveReviewerSessions: () => this.reviewerSessions.hasActiveSessions()
    })
    this.connectionTransitions = new AcpConnectionTransitionOwner({
      blockers: () => this.generationActivity.blockers(),
      connectionGeneration: () => this.connectionGeneration,
      disconnect: (emitClosedStatus) => this.disconnect(emitClosedStatus),
      onRetired: () => this.callbacks.onRetired?.(),
      publishIdle: () => this.setStatus('idle'),
      recoverFailedDeferredDisconnect: () => this.connectionClose.recoverFailedDeferredDisconnect(),
      reportFailure: (message, error) => safeLogError(message, errorLogFields(error))
    })
    this.turnSkills = new AcpTurnSkillOwner({
      resolveSpecialistSkills: options.resolveSpecialistSkills,
      skills: options.skills,
      requestSkillsReload: () => this.connectionTransitions.requestSkillsReload()
    })
    this.spawnAgent = options.spawnAgent
    this.backendGeneration = new AcpBackendGenerationOwner(options.framework ?? claudeCodeFramework)
    this.sessionConfigurator = new AcpSessionConfigurator({
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      diagnosticContext: (backend) => this.diagnosticContext(backend.framework.id)
    })
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000
    this.contextUsageTracker = options.contextUsageTracker ?? new ContextUsageTracker()
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.sessionInteractions = new AcpSessionInteractionOwner({
      cancelTimeoutMs: options.cancelTimeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
    this.artifactOptions = options.artifacts
    this.notebookOptions = options.notebook
    this.skillImportOptions = options.skillImport
    this.sessionCapabilities = new AcpSessionCapabilityOwner({
      artifacts: options.artifacts,
      notebook: options.notebook,
      skillImport: options.skillImport,
      mcpHttpHost: options.mcpHttpHost
    })
    this.artifactRepository = options.artifacts
      ? (options.artifacts.repository ?? new ArtifactRepository(options.artifacts.dataRoot))
      : undefined
    this.artifactRunRegistry = options.artifacts
      ? (options.artifacts.runRegistry ?? new ArtifactRunRegistry())
      : undefined
    this.artifactTurns =
      options.artifacts && this.artifactRepository && this.artifactRunRegistry
        ? new ArtifactTurnOwner({
            dataRoot: options.artifacts.dataRoot,
            repository: this.artifactRepository,
            runRegistry: this.artifactRunRegistry,
            issueRpcCapability: options.artifacts.issueRpcCapability,
            revokeRpcCapability: options.artifacts.revokeRpcCapability,
            provenance: options.artifacts.provenance,
            ...(options.notebook
              ? {
                  notebook: {
                    setArtifactProvenanceContext: options.notebook.setArtifactProvenanceContext
                  }
                }
              : {})
          })
        : undefined
    const uploadRepository = options.uploads?.repository
    const fileReferenceResolver = createManagedFileReferenceResolver({
      uploads: uploadRepository,
      artifacts: this.artifactRepository,
      artifactVersions: options.artifacts?.provenance
    })
    this.promptContentOwner = new AcpPromptContentOwner({
      uploadRepository,
      fileReferenceResolver,
      inlineImageBudgetBytes: options.inlineImageBudgetBytes
    })
    this.sessionRegistry = new AcpSessionRegistry({
      addStartupBlocker: (token) => this.generationActivity.acquireStartup(token),
      foreignIdentityCollision: (sessionIds) => {
        const pendingReviewerCollision = sessionIds.find((sessionId) =>
          this.reviewerSessions.hasPendingSessionId(sessionId)
        )
        if (pendingReviewerCollision) {
          return new Error(
            `Primary session id collision with pending reviewer: ${pendingReviewerCollision}`
          )
        }
        const activeReviewerCollision = sessionIds.find((sessionId) =>
          this.reviewerSessions.hasActiveSessionId(sessionId)
        )
        return activeReviewerCollision
          ? new Error(`Primary session id collision with reviewer: ${activeReviewerCollision}`)
          : undefined
      },
      removeStartupBlocker: (token) => this.generationActivity.releaseStartup(token)
    })
    this.permissionContext = new AcpPermissionContext({
      emitPermissionRequest: (request) => {
        // Relabel to the app-facing id when this session was adopted onto a replaced agent.
        const sessionId = this.sessionRegistry.resolveAppSessionId(request.sessionId)
        const routed = sessionId === request.sessionId ? request : { ...request, sessionId }

        this.pushEvent({
          kind: 'permission',
          level: 'warning',
          sessionId: routed.sessionId,
          toolCallId: routed.toolCallId,
          title: 'Permission requested',
          text: routed.title,
          raw: routed
        })
        this.callbacks.onPermissionRequest?.(routed)
        this.emitState()
      },
      conversationGrants: options.permissionGrantStore,
      permissionGrantRegistry: options.permissionGrantRegistry,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onOpenCodeWaitTimeout: ({ sessionId, toolCallId, waitMs }) => {
        log.warn('OpenCode permission context wait timed out', { sessionId, toolCallId, waitMs })
      }
    })
    this.reviewerSessions = new ReviewerSessionOwner({
      addStartupBlocker: (token) => this.generationActivity.acquireStartup(token),
      clearPermissionCorrelations: (sessionId) =>
        this.permissionContext.clearCorrelationsForSession(sessionId),
      currentStartupGeneration: () => this.sessionRegistry.startupGeneration,
      isPrimarySessionIdClaimed: (sessionId) => this.sessionRegistry.isIdentityClaimed(sessionId),
      onActiveSessionReleased: () => this.generationActivityChanged(),
      registerBridgeSession: (sessionId) =>
        this.connectionResources.registerBridgeReviewerSession(sessionId),
      removeStartupBlocker: (token) => this.generationActivity.releaseStartup(token),
      unregisterBridgeSession: (sessionId) =>
        this.connectionResources.unregisterBridgeReviewerSession(sessionId)
    })
    const closeState: CloseState = {
      invalidatePendingSessionStartups: () => this.invalidatePendingSessionStartups(),
      disposePermissionContext: () => this.permissionContext.dispose(),
      clearReviewerState: () => this.reviewerSessions.clear(),
      settleActivePrompts: () => this.sessionInteractions.settleActivePrompts(),
      supersedeInteractions: () => this.sessionInteractions.supersedeAll(),
      clearContextUsage: () => this.contextUsageTracker.clear(),
      clearAppliedSessionModels: () => this.clearAppliedSessionModels(),
      activeSessionIds: () => this.activeSessionIds(),
      disposeSessionCapabilities: (sessionIds) => this.sessionCapabilities.dispose(sessionIds),
      disposeActiveSessions: (recordFailure) => {
        for (const session of this.activeSessions()) {
          try {
            session.dispose()
          } catch (error) {
            recordFailure('primary-session', error)
          }
        }
      },
      detachSessionConnections: (clearPermissionProfile) => {
        for (const entry of this.sessionRegistry.entries()) {
          if (entry.attachment) this.sessionRegistry.detach(entry.attachment, 'connection')
          else entry.aggregate.detachConnection()
          if (clearPermissionProfile) entry.aggregate.setPermissionProfile(undefined)
        }
      },
      clearPromptContent: () => this.promptContentOwner.clear(),
      clearHandoffContinuity: () => this.handoffContinuity.clearGeneration(),
      clearSessionProjection: () => this.sessionUpdateProjector.clearGeneration(),
      disposeSessionProjection: () => this.sessionUpdateProjector.dispose(),
      clearHttpRoutes: () => this.sessionCapabilities.clearHttpRoutes(),
      selectSession: () => this.sessionRegistry.select(undefined),
      publishInterruptedPromptFailures: (prompts) => {
        for (const { scope, terminal } of prompts as ReturnType<
          AcpSessionInteractionOwner['settleActivePrompts']
        >) {
          try {
            this.pushEvent({
              kind: 'error',
              level: 'error',
              providerError: false,
              sessionId: scope.sessionId,
              ...(scope.promptMessageId ? { promptMessageId: scope.promptMessageId } : {}),
              timestamp: terminal.timestamp,
              title: ACP_PROMPT_FAILED_EVENT_TITLE,
              text: 'ACP connection closed'
            })
          } catch (error) {
            safeLogError('connection-close prompt event failed', errorLogFields(error))
          }
        }
      },
      setStatus: (status) => this.setStatus(status),
      transitionStatus: (status) => this.snapshotOwner.transitionStatus(status),
      emitState: () => this.emitState(),
      hasContextUsage: () => this.contextUsageTracker.hasUsage()
    }
    this.modelChanges = new AcpModelChangeWorkflow({
      canApply: (target) => this.canApplyModelChange(target),
      matchesCurrent: (target) => this.modelChangeMatchesCurrent(target),
      isGenerationBusy: () => this.generationActivity.blockers().retirement,
      applyTarget: (target) => this.applyModelTarget(target),
      // Model-change fallback already owns its drain. Calling the close workflow here would ask the
      // same drain to await itself, so arm the authoritative transition directly.
      requestReconnect: () => this.connectionTransitions.requestProviderReconnect(),
      recoverFailedReconnect: () => this.connectionClose.recoverFailedDeferredDisconnect(),
      reportReconnectFailure: (error) =>
        safeLogError('model-change reconnect failed', errorLogFields(error))
    })
    this.connectionClose = new AcpConnectionCloseWorkflow({
      currentGeneration: () => this.connectionGeneration,
      currentStatus: () => this.snapshotOwner.status,
      getSnapshot: () => this.getSnapshot(),
      disconnectCurrent: (emitClosedStatus, generation) =>
        this.disconnectCurrent(emitClosedStatus, generation),
      transitions: this.connectionTransitions,
      resources: this.connectionResources,
      backendGeneration: this.backendGeneration,
      modelChanges: this.modelChanges,
      state: closeState,
      reportFailure: (message, error) => safeLogError(message, errorLogFields(error))
    })
    this.connectionLifecycle = new AcpConnectionLifecycleWorkflow({
      appVersion: options.appVersion,
      defaultCwd: options.defaultCwd,
      currentConnection: () => this.connection,
      currentStatus: () => this.snapshotOwner.status,
      currentGeneration: () => this.connectionGeneration,
      currentFramework: () => this.framework.id,
      reconnectBarrier: () => this.reconnectBarrier,
      connect: (request) => this.connect(request),
      getSnapshot: () => this.getSnapshot(),
      connectResources: this.connectionResources,
      invalidatePendingSessionStartups: () => this.invalidatePendingSessionStartups(),
      disconnectCurrent: (emitClosedStatus, generation) =>
        this.disconnectCurrent(emitClosedStatus, generation),
      updateCwd: (cwd) => this.snapshotOwner.updateCwd(cwd),
      updateError: (error) => this.snapshotOwner.updateError(error),
      setStatus: (status) => this.setStatus(status),
      pushEvent: (event) => this.pushEvent(event),
      transitionStatus: (status) => this.snapshotOwner.transitionStatus(status),
      emitState: () => this.emitState(),
      diagnosticContext: (framework, generation) => this.diagnosticContext(framework, generation),
      openCandidate: (attempt, onFrameworkResolved) =>
        this.openAgentConnection(attempt, onFrameworkResolved)
    })
    this.providerSessionCreator = new AcpProviderSessionCreator({
      defaultCwd: options.defaultCwd,
      defaultProjectName: options.artifacts?.projectName || DEFAULT_UPLOAD_PROJECT_NAME,
      currentCwd: () => this.snapshotOwner.cwd,
      ensureConnected: (cwd) => this.ensureConnected(cwd),
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      currentBackend: () => this.backend,
      registry: this.sessionRegistry,
      reserveIdentity: (sessionId, startupGeneration) =>
        this.reservePrimarySessionIds(undefined, [sessionId], undefined, startupGeneration),
      capabilities: this.sessionCapabilities,
      configurator: this.sessionConfigurator,
      resolveSpecialistIdentity: options.resolveSpecialistIdentity,
      resolveSpecialistSkills: options.resolveSpecialistSkills,
      registerSessionSpecialist: options.notebook?.registerSessionSpecialist,
      updateCwd: (cwd) => this.snapshotOwner.updateCwd(cwd),
      pushEvent: (event) => this.pushEvent(event),
      emitState: () => this.emitState(),
      diagnosticContext: () => this.diagnosticContext()
    })
    this.providerSessionAdopter = new AcpProviderSessionAdopter({
      currentBackend: () => this.backend,
      registry: this.sessionRegistry,
      reserveIdentity: (reservation, sessionIds) =>
        this.reservePrimarySessionIds(reservation, sessionIds),
      capabilities: this.sessionCapabilities,
      configurator: this.sessionConfigurator,
      resolveSpecialistIdentity: options.resolveSpecialistIdentity,
      resolveSpecialistSkills: options.resolveSpecialistSkills,
      peekClaudeReplay: (sessionId) => this.handoffContinuity.peekClaudeReplay(sessionId),
      commitClaudeReplay: (sessionId) => this.handoffContinuity.commitClaudeReplay(sessionId),
      updateCwd: (cwd) => this.snapshotOwner.updateCwd(cwd),
      emitState: () => this.emitState(),
      diagnosticContext: () => this.diagnosticContext()
    })
  }

  private get backend(): AcpBackendGenerationView {
    return this.backendGeneration.current
  }

  private get framework(): AgentFramework {
    return this.backend.framework
  }

  private get backendId(): string | undefined {
    return this.backend.backendId
  }

  private get connection(): ClientConnection | undefined {
    return this.connectionResources.connection
  }

  private get pendingProviderReconnect(): boolean {
    return this.connectionTransitions.providerReconnectPending
  }

  private get reconnectBarrier(): Promise<void> | undefined {
    return this.connectionTransitions.barrier
  }

  private generationActivityChanged(): void {
    this.connectionTransitions.activityChanged()
    this.modelChanges.activityChanged()
  }

  private get connectionGeneration(): number {
    return this.connectionResources.epoch
  }

  private get supportsSessionClose(): boolean {
    return this.connectionResources.capabilities.close
  }

  private get supportsSessionDelete(): boolean {
    return this.connectionResources.capabilities.delete
  }

  private get supportsSessionResume(): boolean {
    return this.connectionResources.capabilities.resume
  }

  private attachSessionAggregate(
    reservation: AcpPrimarySessionIdentityReservation,
    appSessionId: string,
    input: AcpSessionAggregateAttachInput
  ): AcpSessionRegistryEntry {
    return this.sessionRegistry.publish(reservation, appSessionId, input)
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

  private activeSessions(): ActiveSession[] {
    return this.activeSessionEntries().map(([, session]) => session)
  }

  private clearAppliedSessionModels(): void {
    this.sessionRegistry.clearAppliedModels()
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
    const sessionIds = this.activeSessionIds()
    const promptInFlightSessionIds = this.getInFlightSessionIds()
    const permissionProfiles: Record<string, SessionPermissionProfileState> = {}
    for (const { appSessionId: sessionId, aggregate } of this.sessionRegistry.entries()) {
      const profile = aggregate.snapshot().permissionProfile
      // getSnapshot() is an immutable projection even though the legacy shared shape is mutable.
      if (profile) permissionProfiles[sessionId] = profile as SessionPermissionProfileState
    }

    return this.snapshotOwner.snapshot({
      sessionId: this.sessionRegistry.currentSessionId,
      sessionIds,
      pendingPermissions: this.permissionContext.getPendingRequests(),
      permissionProfiles,
      permissionGrants: Object.fromEntries(
        sessionIds.map((sessionId) => [sessionId, this.permissionContext.listGrants(sessionId)])
      ),
      contextUsageBySession: this.contextUsageTracker.usageSnapshot(),
      nativeContextCompactionSessionIds:
        this.framework.contextCompaction.kind === 'native-command' ? sessionIds : [],
      promptInFlight: promptInFlightSessionIds.length > 0,
      promptInFlightSessionIds
    })
  }

  // Lists sessions with an in-flight prompt, for the pre-migration active-session warning.
  getActivePromptSessions(): { projectName: string; sessionId: string }[] {
    return this.getInFlightSessionIds().map((sessionId) => ({
      projectName: this.resolveSessionProjectName(sessionId),
      sessionId
    }))
  }

  hasLiveSession(projectId: string, sessionId: string): boolean {
    return (
      this.activeSessionFor(sessionId) !== undefined &&
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectName === projectId
    )
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
    return [
      ...interactions.filter(({ kind }) => kind === 'prompt'),
      ...interactions.filter(({ kind }) => kind === 'compaction')
    ].map(({ sessionId }) => sessionId)
  }

  private hasSessionInteractionInFlight(sessionId: string): boolean {
    return this.sessionInteractions.current(sessionId) !== undefined
  }

  private currentPromptInteraction(
    sessionId: string
  ): AcpPromptSessionInteractionScope | undefined {
    const interaction = this.sessionInteractions.current(sessionId)
    return interaction?.kind === 'prompt' ? interaction : undefined
  }

  // Run ids of turns currently in flight, from live in-memory state (not the persisted current-run
  // handoff, which survives a crash). The artifact orphan scan uses this to exclude files a running
  // turn is still writing, while a crashed run — absent here — correctly surfaces as orphaned.
  getActiveArtifactRunIds(): string[] {
    return this.artifactTurns?.activeRunIds() ?? []
  }

  // Accepts a model selection without interrupting a live generation. The picker may keep changing
  // while work is active; one pending slot deliberately makes the latest selection win. New runtime
  // operations wait on the barrier, while the operation that was already admitted finishes against
  // the old model.
  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    return this.modelChanges.apply(target)
  }

  private canApplyModelChange(target: AgentModelChangeTarget): boolean {
    const backendCompatible =
      this.backendId === target.backendId ||
      (this.framework.id === 'claude-code' &&
        target.route === 'claude-anthropic' &&
        target.anthropicBridgeTargetId !== undefined &&
        this.connectionResources.anthropicBridgeAvailable) ||
      (target.providerTransportTargetId !== undefined &&
        this.connectionResources.providerTransportAvailable)
    return (
      !this.connectionResources.isShuttingDown &&
      !this.pendingProviderReconnect &&
      this.snapshotOwner.status === 'connected' &&
      this.connection !== undefined &&
      this.activeSessionEntries().length > 0 &&
      this.framework.id === target.frameworkId &&
      backendCompatible &&
      this.backend.modelRoute === target.route
    )
  }

  private modelChangeMatchesCurrent(target: AgentModelChangeTarget): boolean {
    return (
      this.backendId === target.backendId &&
      this.backend.context.model === target.model &&
      this.backend.session.model === target.sessionModel &&
      this.backend.context.supportsImageInput === target.supportsImageInput &&
      (this.backend.session.effort ?? 'default') === target.reasoningEffort
    )
  }

  private async applyModelTarget(target: AgentModelChangeTarget): Promise<boolean> {
    const connection = this.connection
    if (!connection) return false
    if (
      this.framework.id === 'codex' &&
      target.route !== 'codex-bridge' &&
      this.backendId !== target.backendId &&
      this.backend.session.model === target.sessionModel
    ) {
      // Native Codex catalogs capability metadata by model slug. Two providers may reuse one slug
      // for models with different image, context, or effort capabilities, which the live session
      // cannot distinguish. Reconnect so the newly selected provider owns a fresh catalog entry.
      return false
    }
    if (
      this.backend.context.supportsImageInput &&
      !target.supportsImageInput &&
      (target.route === 'claude-anthropic' || target.route === 'codex-bridge')
    ) {
      // Claude retains opaque SDK history, while the Codex bridge keeps an image-capable transport
      // model. Neither can prove that images from earlier turns will be removed for a text-only
      // upstream model, so reuse the reconnect/resume path that already filters image history.
      return false
    }

    try {
      if (target.providerTransportTargetId) {
        if (
          !this.connectionResources.setProviderTransportTarget(target.providerTransportTargetId)
        ) {
          return false
        }
      }
      if (target.anthropicBridgeTargetId) {
        if (!this.connectionResources.setAnthropicBridgeTarget(target.anthropicBridgeTargetId)) {
          return false
        }
      }
      if (target.bridge) {
        const bridgeUpdated = this.connectionResources.setBridgeModelTarget({
          ...target.bridge,
          ...(target.reasoningEffort === 'default'
            ? { reasoningEffort: undefined }
            : { reasoningEffort: target.reasoningEffort })
        })
        if (!bridgeUpdated) return false
      }

      const results = new Map<
        string,
        { appliedModel: string; configOptions: SessionConfigOption[] | null | undefined }
      >()

      for (const [appSessionId, session] of this.activeSessionEntries()) {
        const priorOptions =
          (this.sessionRegistry.lookup(appSessionId)?.aggregate.snapshot().configOptions as
            readonly SessionConfigOption[] | undefined) ??
          (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
            .newSessionResponse?.configOptions
        let configOptions: SessionConfigOption[] | null | undefined = priorOptions
          ? structuredClone([...priorOptions])
          : priorOptions
        let appliedModel = target.sessionModel

        // The Chat-to-Responses bridge keeps the ACP transport model fixed; only its upstream target
        // changes. Other routes switch the session's advertised model option in place.
        if (target.route !== 'codex-bridge') {
          const selection = matchSessionModelOption(configOptions, target.sessionModel)
          if (!selection) return false
          appliedModel = selection.value

          if (!selection.alreadyCurrent) {
            this.assertCurrentConnectedConnection(connection)
            const response = (await connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: session.sessionId,
                configId: selection.configId,
                value: selection.value
              }
            )) as { configOptions?: SessionConfigOption[] | null }
            configOptions = response?.configOptions ?? configOptions
          }

          const shouldApplyEffort =
            this.framework.supportsLiveEffortChange &&
            (target.reasoningEffort !== 'default' || this.backend.session.effort !== undefined)
          if (shouldApplyEffort) {
            const effortSelection = resolveSessionEffortOption(
              configOptions,
              target.reasoningEffort
            )
            if (!effortSelection) return false
            const response = (await connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: session.sessionId,
                configId: effortSelection.configId,
                value: effortSelection.value
              }
            )) as { configOptions?: SessionConfigOption[] | null }
            configOptions = response?.configOptions ?? configOptions
          }
        }

        results.set(appSessionId, { appliedModel, configOptions })
      }

      this.assertCurrentConnectedConnection(connection)
      this.backendGeneration.updateModel(target)
      for (const [appSessionId, result] of results) {
        this.sessionRegistry
          .lookup(appSessionId)
          ?.aggregate.updateModel(result.appliedModel, result.configOptions, target.backendId)
      }
      this.contextUsageTracker.clear()
      for (const appSessionId of results.keys()) this.ensureContextUsageTracking(appSessionId)
      this.emitState()
      log.info('session model change applied', this.diagnosticContext())
      return true
    } catch (error) {
      log.warn('live session model change failed', {
        ...diagnosticErrorFields(error),
        ...this.diagnosticContext()
      })
      return false
    }
  }

  // Live-applies a reasoning-effort change to every open session — the ACP equivalent of a model
  // switch, no respawn. Returns false when the active framework only carries effort in its baked
  // spawn config (opencode advertises no thought_level option), or when applying to a session
  // genuinely failed — the caller then falls back to the provider-switch reconnect rather than
  // leaving the UI showing a level the agent never received. All sessions are attempted even after
  // a failure, so the set never straddles two levels longer than the reconnect takes. Sessions that
  // simply advertise no effort option are skipped (a reconnect could not give their model one
  // either). On success the generation view tracks the new level, so sessions created later in
  // this process inherit it; the persisted setting covers the next respawn.
  async applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    const modelChangeBarrier = this.modelChanges.barrier
    if (modelChangeBarrier) {
      await modelChangeBarrier
      return this.applyReasoningEffortChange(effort)
    }

    // A provider/model switch may be waiting for an in-flight turn to finish. The incoming effort was
    // resolved against that newly selected model, while this connection still owns the old one. Let
    // the persisted setting reach the fresh backend after reconnect instead of leaking it here.
    if (this.pendingProviderReconnect) return false

    const backend = this.backendGeneration.updateReasoningEffort(effort)
    this.connectionResources.setBridgeReasoningEffort(backend.session.effort)
    const connection = this.connection
    if (!connection) return backend.framework.supportsLiveEffortChange

    const facts = await this.sessionConfigurator.applyLiveEffort({
      backend,
      connection,
      effort,
      sessions: this.activeSessionEntries().map(([appSessionId, session]) => ({
        session,
        configOptions:
          (this.sessionRegistry.lookup(appSessionId)?.aggregate.snapshot().configOptions as
            readonly SessionConfigOption[] | undefined) ??
          (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
            .newSessionResponse?.configOptions,
        assertCurrent: () => {
          if (this.activeSessionFor(appSessionId) !== session) {
            throw new Error('ACP session startup was superseded.')
          }
        }
      }))
    })
    return !facts.reconnectRequired
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
    return this.withOperationLease(() => this.resumeSessionOperation(request))
  }

  private async resumeSessionOperation(
    request: AcpResumeSessionRequest
  ): Promise<AcpCreateSessionResponse> {
    const sessionCwd = resolve(request.cwd || this.snapshotOwner.cwd || this.options.defaultCwd)
    const projectName = this.normalizeProjectName(request.projectName)

    // If the runtime already attached this session, only refresh routing metadata.
    const attachedSession = this.activeSessionFor(request.sessionId)

    if (attachedSession) {
      const aggregate = this.sessionRegistry.lookup(request.sessionId)?.aggregate
      if (!aggregate) throw new Error(`ACP session is not registered: ${request.sessionId}`)
      if (request.specialistId) {
        aggregate.setSpecialistId(request.specialistId)
      }
      const connection = this.connection
      if (!connection) throw new Error('ACP connection is not available.')
      const permissionProfile = await this.sessionConfigurator.configurePermissionProfile({
        backend: this.backend,
        connection,
        session: attachedSession,
        permissionProfile: normalizePermissionProfile(
          request.permissionProfile ??
            aggregate.snapshot().permissionProfile?.selectedProfile ??
            DEFAULT_PERMISSION_PROFILE
        )
      })
      if (this.activeSessionFor(request.sessionId) !== attachedSession) {
        throw new Error('ACP session startup was superseded.')
      }
      this.assertCurrentConnectedConnection(connection)
      aggregate.setPermissionProfile(structuredClone(permissionProfile))
      this.sessionRegistry.select(request.sessionId)
      this.snapshotOwner.updateCwd(sessionCwd)
      aggregate.updateLocation(sessionCwd, projectName)
      this.emitState()

      return {
        sessionId: request.sessionId,
        cwd: sessionCwd,
        frameworkId: this.framework.id,
        ...(this.backendId ? { backendId: this.backendId } : {})
      }
    }

    // The reconnect + session/resume handshake spawns a fresh agent and is network-bound, so it is
    // wrapped in a bounded timeout that tears down the half-open connection if the agent stalls.
    return this.resumeSessionWithTimeout(request, sessionCwd, projectName)
  }

  // Forcibly drops the agent-side context for a session whose accumulated history can no longer be sent
  // — chiefly when inlined media pushed the request past the provider's size limit and the backend's own
  // compaction fails with `media_unstrippable`. Disposes the current agent session and adopts a brand-new
  // one under the SAME app id, resetting the per-session inline-image budget so a replayed text-only
  // transcript starts clean. Returns contextReset so the caller replays a bounded transcript into the
  // next prompt (the app-level equivalent of compaction, which — unlike the backend's — drops all media).
  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    return this.withOperationLease(() => this.resetSessionContextOperation(request))
  }

  private async resetSessionContextOperation(
    request: AcpResumeSessionRequest
  ): Promise<AcpCreateSessionResponse> {
    const sessionCwd = resolve(request.cwd || this.snapshotOwner.cwd || this.options.defaultCwd)
    const projectName = this.normalizeProjectName(request.projectName)
    const publishedSession = this.activeSessionFor(request.sessionId)
    const publishedAppSessionId = publishedSession ? request.sessionId : undefined
    const reservationResult = this.reservePrimarySessionIds(
      undefined,
      [request.sessionId],
      publishedAppSessionId
    )
    if (reservationResult.collision) throw reservationResult.collision
    const reservation = reservationResult.reservation

    try {
      return await this.resetReservedSessionContextOperation(
        request,
        sessionCwd,
        projectName,
        reservation,
        publishedSession
      )
    } finally {
      this.releasePrimarySessionIdentityReservation(reservation)
    }
  }

  private async resetReservedSessionContextOperation(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string,
    primaryIdentityReservation: AcpPrimarySessionIdentityReservation,
    publishedSession: ActiveSession | undefined
  ): Promise<AcpCreateSessionResponse> {
    const connection = await this.ensureConnected(sessionCwd)
    this.assertCurrentConnectedConnection(connection)
    const currentPublishedSession = this.activeSessionFor(request.sessionId)
    const crossedGeneration = this.renewPrimarySessionIdentityReservation(
      primaryIdentityReservation,
      currentPublishedSession === publishedSession && currentPublishedSession
        ? request.sessionId
        : undefined
    )
    const reconnectReplacedPublishedSession =
      publishedSession !== undefined && currentPublishedSession === undefined && crossedGeneration
    if (currentPublishedSession !== publishedSession && !reconnectReplacedPublishedSession) {
      throw new Error('ACP session startup was superseded.')
    }

    // Tear down the currently attached agent session (if any) before adopting a replacement, dropping
    // its reverse routing so late events from the old agent session can no longer target this app id.
    const attachedEntry = this.sessionRegistry.lookup(request.sessionId)
    const attached = attachedEntry?.attachment

    // A context reset replaces only the provider-side history; the app conversation continues under
    // the same id, so retain its visible/revocable grants while cancelling requests owned by the old
    // agent session. Provider tool context must not survive because a fresh agent may reuse call ids.
    this.cancelPermissionFlowForSession(request.sessionId)

    if (attached) {
      attached.session.dispose()
      this.sessionRegistry.detach(attached, 'provider')
    }

    // The fresh agent session holds no history, so the accumulated media is gone; start its budget clean.
    this.promptContentOwner.resetSession(request.sessionId)
    // A context reset creates a new agent-side conversation under the same app id. Do not carry the
    // previous context size into the fresh conversation before its first usage_update arrives.
    this.contextUsageTracker.deleteSession(request.sessionId)
    this.sessionRegistry.lookup(request.sessionId)?.aggregate.clearAppliedModel()

    // Release the failed interaction now. Its own `finally` may run only after async artifact cleanup;
    // the generation-guarded owner prevents that stale cleanup from clearing the recovery resend.
    this.sessionInteractions.supersedeCurrent(request.sessionId)

    return this.adoptFreshSession(
      connection,
      request,
      sessionCwd,
      projectName,
      primaryIdentityReservation
    )
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
    return this.withOperationLease(() => this.switchSpecialistOperation(sessionId, specialistId))
  }

  // The completion-gate adapter uses this public runtime fact to claim only the framework it owns.
  // A session keeps its original framework while a different active backend is prepared elsewhere.
  getSessionFramework(sessionId: string): AgentFrameworkId | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId
  }

  private async switchSpecialistOperation(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    if (this.hasSessionInteractionInFlight(sessionId)) {
      throw new Error('Cannot switch specialist while the Agent is running.')
    }

    // Skills map drives per-turn skill resolution for every framework.
    const { aggregate } = this.sessionRegistry.ensureAffinity(sessionId)
    aggregate.setSpecialistId(specialistId)

    // Per-turn identity prefix (Codex / OpenCode). Claude uses a session _meta append instead, which
    // adoptFreshSession re-bakes from sessionSpecialistIds during the context reset below.
    if (specialistId !== undefined && this.options.resolveSpecialistIdentity) {
      const identity = await this.options.resolveSpecialistIdentity(specialistId, this.framework.id)
      if (identity?.prefix) {
        aggregate.setSpecialistPrefix(identity.prefix)
      } else {
        aggregate.setSpecialistPrefix(undefined)
      }
    } else {
      aggregate.setSpecialistPrefix(undefined)
    }

    // Keep notebook routing metadata in sync so MCP calls carry the new specialist context.
    this.notebookOptions?.registerSessionSpecialist?.(sessionId, specialistId)

    // Claude bakes the specialist identity into the session _meta at session/new. A live identity
    // change therefore requires replacing the agent session so the new append takes effect. Only do
    // this when a session is actually attached; an unattached session will pick up the new binding
    // (now recorded in the maps above) when it is later created or resumed.
    const requiresContextReset =
      this.framework.id === 'claude-code' && this.activeSessionFor(sessionId) !== undefined
    if (requiresContextReset) {
      const snapshot = aggregate.snapshot()
      await this.resetSessionContextOperation({
        sessionId,
        cwd: snapshot.cwd,
        projectName: snapshot.projectName,
        ...(snapshot.permissionProfile?.selectedProfile
          ? { permissionProfile: snapshot.permissionProfile.selectedProfile }
          : {})
      } as AcpResumeSessionRequest)
    }

    return { contextReset: requiresContextReset }
  }

  // Invokes the framework's own context compaction command on the attached agent session. The
  // command is an internal control turn: fresh usage updates are retained, while its command
  // echo/status output is not projected into the user's conversation.
  async compactSession(request: AcpCompactSessionRequest): Promise<PromptResponse> {
    return this.withOperationLease(() => this.compactSessionOperation(request))
  }

  private async compactSessionOperation(
    request: AcpCompactSessionRequest
  ): Promise<PromptResponse> {
    const session = this.activeSessionFor(request.sessionId)
    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    const currentInteraction = this.sessionInteractions.current(request.sessionId)
    if (currentInteraction?.kind === 'compaction') {
      throw new Error('Context compaction is already running for this session')
    }
    if (currentInteraction && request.reason !== 'overflow-recovery') {
      throw new Error('An ACP prompt is already running for this session')
    }

    // A recoverable overflow is emitted only after the provider prompt has already rejected; the old
    // turn may still be doing artifact cleanup, but it no longer owns the agent session. Transfer its
    // public lock to the control turn now so the retry can start immediately after compaction, while the
    // dedicated compaction lock below keeps unrelated sends blocked during `/compact` itself.
    if (request.reason === 'overflow-recovery' && currentInteraction) {
      this.sessionInteractions.supersede(currentInteraction)
    }

    const compactionInteraction = this.sessionInteractions.claim({
      sessionId: request.sessionId,
      kind: 'compaction'
    })
    this.emitState()

    try {
      return await this.performNativeContextCompaction(
        session,
        request.sessionId,
        request.reason ?? 'manual'
      )
    } finally {
      this.sessionInteractions.release(compactionInteraction)
      this.emitState()
    }
  }

  private shouldAutoCompactContext(sessionId: string): boolean {
    const strategy = this.framework.contextCompaction
    if (strategy.kind !== 'native-command' || strategy.triggerAtPercent === undefined) return false

    const usage = this.contextUsageTracker.usage(sessionId)
    if (!usage || usage.size === undefined || usage.size <= 0 || usage.used < 0) return false
    if (usage.breakdown?.status === 'preflight') return false

    return (usage.used / usage.size) * 100 >= strategy.triggerAtPercent
  }

  private async performNativeContextCompaction(
    session: ActiveSession,
    appSessionId: string,
    reason: NonNullable<AcpRuntimeEvent['compactionReason']>
  ): Promise<PromptResponse> {
    const strategy = this.framework.contextCompaction
    if (strategy.kind !== 'native-command') {
      throw new Error(`${this.framework.displayName} manages context compaction automatically.`)
    }
    const contextUsageCheckpoint = this.contextUsageTracker.checkpointSession(appSessionId)
    const restoreContextEstimate = (): void => {
      this.contextUsageTracker.restoreSession(appSessionId, contextUsageCheckpoint)
    }

    this.pushEvent({
      kind: 'compaction',
      compactionReason: reason,
      level: 'info',
      sessionId: appSessionId,
      status: 'in_progress',
      title: 'Compacting context'
    })

    try {
      let failureText: string | undefined
      const promptFailure = new Promise<never>((_, reject) => {
        session.prompt([{ type: 'text', text: strategy.command }]).catch(reject)
      })

      for (;;) {
        const message = await Promise.race([session.nextUpdate(), promptFailure])
        if (message.kind === 'stop') {
          if (message.response.stopReason === 'cancelled') {
            restoreContextEstimate()
            this.pushEvent({
              kind: 'compaction',
              compactionReason: reason,
              level: 'info',
              sessionId: appSessionId,
              status: 'cancelled',
              title: 'Context compaction cancelled'
            })
            return message.response
          }
          if (message.response.stopReason !== 'end_turn') {
            throw new Error(
              `Context compaction stopped before completion: ${message.response.stopReason}`
            )
          }
          if (failureText) throw new Error(failureText)

          // Some adapters do not emit usage_update for their compaction control turn. Invalidate only
          // the unchanged pre-compaction reading; a fresh update received during the turn is a new
          // object and remains available to the context meter and auto-compaction threshold.
          this.contextUsageTracker.resetAfterCompaction(
            appSessionId,
            this.contextUsageEstimateInput(appSessionId),
            contextUsageCheckpoint,
            this.selectedContextWindowFor(appSessionId)
          )
          this.promptContentOwner.resetSession(appSessionId)
          this.pushEvent({
            kind: 'compaction',
            compactionReason: reason,
            level: 'info',
            sessionId: appSessionId,
            status: 'completed',
            title: 'Context compacted'
          })
          return message.response
        }

        const update = message.notification.update
        if (
          !failureText &&
          strategy.failureTextPrefix &&
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text.trimStart().startsWith(strategy.failureTextPrefix)
        ) {
          failureText = update.content.text.trim()
        }
        this.handleSessionUpdate(message.notification, appSessionId, false)
      }
    } catch (error) {
      restoreContextEstimate()
      this.pushEvent({
        kind: 'compaction',
        compactionReason: reason,
        level: 'error',
        sessionId: appSessionId,
        status: 'failed',
        title: 'Context compaction failed',
        text: errorMessage(error)
      })
      throw error
    }
  }

  // Races the network-bound resume against a timeout so a stalled agent handshake cannot hang Resume
  // forever. On timeout the half-open connection is torn down so the next Resume reconnects cleanly.
  private async resumeSessionWithTimeout(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string
  ): Promise<AcpCreateSessionResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimer(() => {
        timedOut = true
        reject(new Error('ACP session resume timed out.'))
      }, this.resumeTimeoutMs)
    })

    try {
      return await Promise.race([
        this.resumeSessionNetwork(request, sessionCwd, projectName),
        timeout
      ])
    } catch (error) {
      if (timedOut) {
        await this.disconnect(false)
      }

      throw error
    } finally {
      if (timer !== undefined) {
        this.clearTimer(timer)
      }
    }
  }

  // Performs the connect + session/resume handshake for a session the runtime does not yet hold.
  private async resumeSessionNetwork(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string
  ): Promise<AcpCreateSessionResponse> {
    // request.sessionId is the known stable app identity. Reserve it synchronously, before connection
    // setup can await, then let the network path extend the same owner with the provider protocol id.
    const reservationResult = this.reservePrimarySessionIds(undefined, [request.sessionId])
    if (reservationResult.collision) throw reservationResult.collision
    const reservation = reservationResult.reservation

    try {
      return await this.resumeReservedSessionNetwork(request, sessionCwd, projectName, reservation)
    } finally {
      this.releasePrimarySessionIdentityReservation(reservation)
    }
  }

  private async resumeReservedSessionNetwork(
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string,
    primaryIdentityReservation: AcpPrimarySessionIdentityReservation
  ): Promise<AcpCreateSessionResponse> {
    const connection = await this.ensureConnected(sessionCwd)
    this.assertCurrentConnectedConnection(connection)
    this.renewPrimarySessionIdentityReservation(primaryIdentityReservation)
    // A session created under a different framework can never be resumed by the current agent — each
    // framework keeps its own session store, so the request is guaranteed to fail and only makes the
    // agent log a scary internal error. Skip straight to adopting a fresh session (context still
    // resets, so the caller replays the transcript) when we know it last ran under another framework.
    const priorAffinity = this.sessionRegistry.lookup(request.sessionId)?.aggregate.snapshot()
    const priorFramework = priorAffinity?.frameworkId ?? request.previousFrameworkId
    const priorBackend = priorAffinity?.backendId ?? request.previousBackendId

    if (
      (priorFramework && priorFramework !== this.framework.id) ||
      (priorBackend && this.backendId && priorBackend !== this.backendId)
    ) {
      log.info('skipping incompatible backend resume; adopting a fresh session', {
        sessionId: request.sessionId,
        fromFramework: priorFramework,
        toFramework: this.framework.id,
        fromBackend: priorBackend,
        toBackend: this.backendId
      })

      return this.adoptFreshSession(
        connection,
        request,
        sessionCwd,
        projectName,
        primaryIdentityReservation
      )
    }

    // A conversation adopted from another framework keeps its app-facing id. After restart the
    // in-memory agent-id mapping is gone, and Codex cannot parse non-UUID ids such as OpenCode's
    // `ses_...` form. The resume call is guaranteed to fail, so adopt a fresh Codex session directly
    // and let the caller replay the visible transcript under the stable app id.
    if (this.framework.id === 'codex' && !isCodexProtocolSessionId(request.sessionId)) {
      log.info('skipping invalid Codex session resume; adopting a fresh session', {
        sessionId: request.sessionId
      })
      return this.adoptFreshSession(
        connection,
        request,
        sessionCwd,
        projectName,
        primaryIdentityReservation
      )
    }

    // Persisted sessions created before framework provenance was recorded may restore without a
    // previousFrameworkId. OpenCode ids use the `ses_...` namespace, which Claude Code rejects before
    // it can return a resumable session-not-found result. Avoid the guaranteed failing request and
    // preserve the app-facing conversation by adopting a fresh Claude session for transcript replay.
    if (this.framework.id === 'claude-code' && isOpenCodeProtocolSessionId(request.sessionId)) {
      log.info('skipping OpenCode session id for Claude resume; adopting a fresh session', {
        sessionId: request.sessionId
      })
      return this.adoptFreshSession(
        connection,
        request,
        sessionCwd,
        projectName,
        primaryIdentityReservation
      )
    }

    // Resume is optional in ACP. A cross-framework session was handled above and can always be
    // adopted fresh; same-framework sessions require the advertised resume capability.
    if (!this.supportsSessionResume) {
      throw new Error('ACP agent does not support session resume.')
    }

    let capabilityProvision: SessionCapabilityProvision | undefined
    let session: ActiveSession | undefined
    try {
      // Resumed sessions already have stable ids, so the artifact session mirrors the runtime session
      // id.
      capabilityProvision = await this.sessionCapabilities.provision({
        stableAppSessionId: request.sessionId,
        framework: this.framework,
        nativeMcpEnabled: this.backend.adapter.nativeMcpEnabled,
        bridgeMcpAliasesEnabled: this.backend.adapter.bridgeMcpAliasesEnabled,
        policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
        sessionCwd,
        projectName
      })
      const { mcpServers } = capabilityProvision
      let resumeResponse
      try {
        resumeResponse = await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: request.sessionId,
          cwd: sessionCwd,
          mcpServers,
          ...this.buildSessionMetaArg(
            [],
            await this.resolveCurrentSpecialistSkills(
              request.sessionId,
              request.specialistId ?? priorAffinity?.specialistId
            )
          )
        })
      } catch (error) {
        if (!isUnresumableSessionError(error)) throw error

        // The failed resume crossed a network await. If teardown replaced this startup meanwhile,
        // release only its concrete bearer lease and stop: broad app-id cleanup or fresh adoption
        // could otherwise revoke or overwrite the same-id successor.
        try {
          this.assertPrimarySessionIdentityReservation(primaryIdentityReservation)
        } catch (supersededError) {
          capabilityProvision.release({ ownsStableIdentity: false })
          capabilityProvision = undefined
          throw supersededError
        }

        // The agent could not resume this session (an app restart spawned a fresh agent process that no
        // longer holds it — surfacing as -32002 not-found or a generic -32603 Internal error). Revoke
        // the token handed to that failed attempt before adopting a brand-new agent session under the
        // SAME app id; adoptFreshSession owns the replacement token's lifecycle.
        capabilityProvision.release({ ownsStableIdentity: true })
        capabilityProvision = undefined
        log.info('resumed session adopted after unrecoverable resume error', {
          sessionId: request.sessionId,
          ...errorLogFields(error)
        })

        return await this.adoptFreshSession(
          connection,
          request,
          sessionCwd,
          projectName,
          primaryIdentityReservation
        )
      }
      // The SDK exposes public helpers for new sessions only. The runtime keeps this adapter
      // narrow so resume can reuse the same update routing surface as newly-created sessions.
      session = (connection.agent as unknown as ClientContextSessionAttacher).attachSession({
        sessionId: request.sessionId,
        ...resumeResponse
      })

      const reservationResult = this.reservePrimarySessionIds(primaryIdentityReservation, [
        session.sessionId
      ])
      if (reservationResult.collision) {
        this.disposeSessionAfterFailure(session, 'primary collision session disposal failed')
        session = undefined
        throw reservationResult.collision
      }

      const backend = this.backend
      const configuration = await this.sessionConfigurator.configure({
        backend,
        connection,
        session,
        permissionProfile: normalizePermissionProfile(request.permissionProfile)
      })

      this.assertPrimarySessionIdentityReservation(primaryIdentityReservation)
      const { aggregate } = this.attachSessionAggregate(
        primaryIdentityReservation,
        request.sessionId,
        {
          session,
          cwd: sessionCwd,
          projectName,
          frameworkId: backend.framework.id,
          backendId: backend.backendId,
          permissionProfile: structuredClone(configuration.permissionProfile),
          appliedModel: configuration.appliedModel,
          configOptions: structuredClone(configuration.configOptions)
        }
      )
      if (request.specialistId) {
        aggregate.setSpecialistId(request.specialistId)
      }
      capabilityProvision.commit(request.sessionId)
      this.releasePrimarySessionIdentityReservation(primaryIdentityReservation)
      capabilityProvision = undefined
      this.snapshotOwner.updateCwd(sessionCwd)
      try {
        this.pushEvent({
          kind: 'system',
          level: 'info',
          sessionId: request.sessionId,
          title: 'Session resumed',
          text: sessionCwd
        })
      } catch (error) {
        safeLogError('session resumed event callback failed', {
          ...diagnosticErrorFields(error),
          sessionId: request.sessionId
        })
      }
      try {
        this.emitState()
      } catch (error) {
        safeLogError('session resumed state callback failed', {
          ...diagnosticErrorFields(error),
          sessionId: request.sessionId
        })
      }

      return {
        sessionId: request.sessionId,
        cwd: sessionCwd,
        frameworkId: this.framework.id,
        ...(this.backendId ? { backendId: this.backendId } : {})
      }
    } catch (error) {
      let startupError = error
      let ownsStableIdentity = true
      try {
        this.assertPrimarySessionIdentityReservation(primaryIdentityReservation)
      } catch (supersededError) {
        startupError = supersededError
        ownsStableIdentity = false
      }
      capabilityProvision?.release({ ownsStableIdentity })
      capabilityProvision = undefined
      if (session) {
        this.disposeSessionAfterFailure(session, 'resumed startup session disposal failed')
      }
      throw startupError
    }
  }

  // Builds a brand-new agent session under the SAME app id when a resume cannot reattach the original
  // (a cross-framework switch, or an unresumable restart). Earlier turns stay visible; only agent-side
  // context is gone, so contextReset is returned to let the caller replay a transcript into the next
  // prompt. Shared by the cross-framework skip and the unrecoverable-error fallback.
  private async adoptFreshSession(
    connection: ClientConnection,
    request: AcpResumeSessionRequest,
    sessionCwd: string,
    projectName: string,
    primaryIdentityReservation: AcpPrimarySessionIdentityReservation
  ): Promise<AcpCreateSessionResponse> {
    return this.providerSessionAdopter.adopt(request.sessionId, {
      connection,
      cwd: sessionCwd,
      projectName,
      identity: primaryIdentityReservation,
      permissionProfile: request.permissionProfile,
      specialistId: request.specialistId
    })
  }

  // Changes approval behavior only while the conversation is idle. Applying the ACP mode before the
  // next prompt guarantees Full access cannot show a first-tool permission race.
  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    return this.withOperationLease(() => this.setPermissionProfileOperation(request))
  }

  private async setPermissionProfileOperation(
    request: AcpSetPermissionProfileRequest
  ): Promise<AcpStateSnapshot> {
    const session = this.activeSessionFor(request.sessionId)

    if (!session) throw new Error(`ACP session not found: ${request.sessionId}`)
    if (this.hasSessionInteractionInFlight(request.sessionId)) {
      throw new Error('Permission profile cannot be changed while the Agent is running.')
    }
    if (this.permissionContext.hasPendingForSession(request.sessionId)) {
      throw new Error('Resolve the pending permission request before changing profiles.')
    }

    const connection = this.connection
    if (!connection) throw new Error('ACP connection is not available.')
    const permissionProfile = await this.sessionConfigurator.configurePermissionProfile({
      backend: this.backend,
      connection,
      session,
      permissionProfile: request.profile
    })
    if (this.activeSessionFor(request.sessionId) !== session) {
      throw new Error('ACP session startup was superseded.')
    }
    this.assertCurrentConnectedConnection(connection)
    this.sessionRegistry
      .lookup(request.sessionId)
      ?.aggregate.setPermissionProfile(structuredClone(permissionProfile))
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
    return this.connectionClose.disconnect(emitClosedStatus)
  }

  // Synchronously terminates the agent child for app shutdown. Electron's `will-quit` cannot await, so
  // this does only the synchronous work of signalling the child to exit — an agent left running after
  // the app is gone would be an orphaned process still holding its network connection open. The OS
  // reclaims the remaining connection/session state as the process exits.
  shutdown(): void {
    this.connectionClose.shutdown()
  }

  // Awaitable quit/relaunch teardown. Latches shuttingDown FIRST so a connect that is mid-spawn when
  // quit lands self-aborts and kills its freshly-spawned child (see the lifecycle workflow). Unlike shutdown(),
  // this can be awaited, so a caller that follows it with app.exit(0) is guaranteed no orphaned agent
  // remains — assigned, connecting, or mid-spawn. Returns { reaped } so the caller can tell a clean
  // teardown from a degraded one (taskkill fallback left grandchildren) before committing to app.exit.
  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    return this.connectionClose.shutdownForQuit()
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
    return this.connectionClose.shutdownForUpdateGate()
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

  private disconnectCurrent(
    emitClosedStatus = true,
    teardownGeneration = this.connectionGeneration
  ): Promise<AcpStateSnapshot> {
    return this.connectionClose.disconnectCurrent(emitClosedStatus, teardownGeneration)
  }

  private openAgentConnection(
    identity: AcpConnectionResourceAttempt,
    onFrameworkResolved: (framework: AgentFramework['id']) => void
  ): Promise<AcpAgentConnectionCandidate> {
    const hooks: AcpAgentConnectionHooks = {
      requestPermission: (params) => this.handlePermissionRequest(params),
      observeSessionUpdate: (notification) => this.observePermissionToolContext(notification),
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
          const backend: ResolvedAgentBackend | undefined = this.spawnAgent
            ? { framework: this.framework, executablePath: '', env: {} }
            : await this.options.resolveBackend?.({
                forcedSkillIds: [...this.turnSkills.backendPreparation().forcedSkillIds],
                systemPromptAppends: await this.getBackendSystemPromptAppends()
              })
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

  // Sends one prompt turn to the targeted session and streams updates until stop.
  async sendPrompt(request: AcpPromptRequest, promptAttemptId?: string): Promise<PromptResponse> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.sendPromptTurn(request, promptAttemptId, true))
    )
  }

  // App-owned continuations participate in the same prompt ownership, cancellation, provenance, and
  // accounting lifecycle as user turns. Their synthesized control text is provider input, however,
  // and must never be projected into the transcript as a second user-authored message.
  async sendAppContinuation(
    request: AcpPromptRequest,
    promptAttemptId?: string
  ): Promise<PromptResponse> {
    return this.withOperationLease(() =>
      withDataRootWrite(() => this.sendPromptTurn(request, promptAttemptId, false))
    )
  }

  private async sendPromptTurn(
    request: AcpPromptRequest,
    promptAttemptId: string | undefined,
    publishUserMessage: boolean
  ): Promise<PromptResponse> {
    let activeSession = this.activeSessionFor(request.sessionId)

    if (!activeSession) {
      throw new Error(`ACP session not found: ${request.sessionId}`)
    }

    if (this.hasSessionInteractionInFlight(request.sessionId)) {
      throw new Error('An ACP prompt is already running for this session')
    }

    // Reserve this attempt before Specialist/skill authorization can yield. A newer preflight may
    // supersede the reservation without publishing an in-flight turn, preserving the existing
    // last-admitted-preflight behavior while preventing a stale attempt from using a replaced session.
    let promptReservation = this.sessionInteractions.reservePrompt({
      sessionId: request.sessionId,
      kind: 'prompt',
      promptMessageId: request.provenanceContext?.promptMessageId,
      turnToken: request.continuation?.originatingTurnToken
    })

    let turnSkillHandle: TurnSkillHandle
    try {
      const authorization = this.turnSkills.authorize({
        specialistId: this.sessionRegistry.lookup(request.sessionId)?.aggregate.snapshot()
          .specialistId,
        selectedSkillIds: request.forcedSkillIds,
        signal: promptReservation.signal
      })
      turnSkillHandle = authorization instanceof Promise ? await authorization : authorization
    } catch (error) {
      this.sessionInteractions.release(promptReservation)
      throw error
    }
    const rejectedSkillOutcome =
      turnSkillHandle.reloadDecision.kind === 'reload' ? 'reload-restored' : 'failed'

    try {
      if (turnSkillHandle.reloadDecision.kind === 'reload') {
        if (this.hasSessionInteractionInFlight(request.sessionId)) {
          throw new Error('An ACP prompt is already running for this session')
        }

        const aggregateSnapshot = this.sessionRegistry
          .lookup(request.sessionId)
          ?.aggregate.snapshot()
        const sessionCwd = aggregateSnapshot?.cwd ?? this.snapshotOwner.cwd
        const projectName = this.resolveSessionProjectName(request.sessionId)
        const permissionProfile =
          aggregateSnapshot?.permissionProfile?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE
        await this.disconnect(false)
        const reloadResume = await this.resumeSession({
          sessionId: request.sessionId,
          cwd: sessionCwd,
          projectName,
          permissionProfile
        })
        if (reloadResume.contextReset) {
          request.historyPreamble = request.resumeFallback?.historyPreamble
          request.historyAttachments = request.resumeFallback?.historyAttachments
          request.historyImages = request.resumeFallback?.historyImages
          request.contextReset = true
        }

        const reloaded = this.activeSessionFor(request.sessionId)
        if (!reloaded) {
          throw new Error(`ACP session not found after force-load: ${request.sessionId}`)
        }
        activeSession = reloaded
        promptReservation = this.sessionInteractions.reservePrompt({
          sessionId: request.sessionId,
          kind: 'prompt',
          promptMessageId: request.provenanceContext?.promptMessageId,
          turnToken: request.continuation?.originatingTurnToken
        })
      }
    } catch (error) {
      turnSkillHandle.close('reload-restored')
      this.sessionInteractions.release(promptReservation)
      throw error
    }

    // Another prompt can claim this session while authorization preflight is awaiting. Activate only
    // the newest reservation so a delayed attempt cannot overwrite a newer turn's lifecycle state.
    if (this.hasSessionInteractionInFlight(request.sessionId)) {
      turnSkillHandle.close(rejectedSkillOutcome)
      this.sessionInteractions.release(promptReservation)
      throw new Error('An ACP prompt is already running for this session')
    }

    const refreshedActiveSession = this.activeSessionFor(request.sessionId)
    if (!refreshedActiveSession) {
      turnSkillHandle.close(rejectedSkillOutcome)
      this.sessionInteractions.release(promptReservation)
      throw new Error(`ACP session not found: ${request.sessionId}`)
    }
    activeSession = refreshedActiveSession

    let promptInteraction: AcpPromptSessionInteractionScope
    try {
      promptInteraction = this.sessionInteractions.activatePrompt(promptReservation)
      this.sessionRegistry.select(request.sessionId)
      this.handoffContinuity.recordAdmittedPrompt(request)
    } catch (error) {
      turnSkillHandle.close(rejectedSkillOutcome)
      this.sessionInteractions.release(promptReservation)
      throw error
    }
    const promptTurn = promptInteraction.sequence
    const skillImportTurnToken = promptInteraction.turnToken
    const promptEventIdentity = promptInteraction.promptMessageId
      ? { promptMessageId: promptInteraction.promptMessageId }
      : {}
    try {
      this.callbacks.onPromptStarted?.(request.sessionId, skillImportTurnToken, promptAttemptId)
    } catch (error) {
      safeLogError('prompt-start callback failed', errorLogFields(error))
    }
    this.emitState()
    log.info('prompt start', {
      sessionId: request.sessionId,
      textLength: request.text?.length ?? 0
    })
    let artifactRun: ArtifactTurnHandle | undefined
    let artifactEmitted = false
    let skillActivityInputs: Array<{ name: string; path: string }> = []
    let skillActivitiesStarted = false
    let skillActivitiesFinalized = false
    let revokeReferencedUploadGrant: (() => void) | undefined
    let contextUsageTurn: ContextUsageTurnHandle | undefined
    let turnSkillOutcome: TurnSkillOutcome = 'failed'
    let observedPromptStop:
      | {
          response: PromptResponse
          turnUsage?: AcpTurnTokenUsage
          modelTurnCount?: number
        }
      | undefined
    const publishObservedPromptStop = (): boolean => {
      if (!observedPromptStop) return false
      const terminal = this.sessionInteractions.settle(promptInteraction, {
        ...(observedPromptStop.turnUsage ? { turnUsage: observedPromptStop.turnUsage } : {}),
        ...(observedPromptStop.modelTurnCount === undefined
          ? {}
          : { modelTurnCount: observedPromptStop.modelTurnCount })
      })
      if (!terminal) return false
      this.pushEvent({
        kind: 'stop',
        level: 'info',
        sessionId: request.sessionId,
        ...promptEventIdentity,
        timestamp: terminal.timestamp,
        title: 'Prompt stopped',
        text: observedPromptStop.response.stopReason,
        turnUsage: terminal.turnUsage,
        raw: observedPromptStop.response
      })
      return true
    }

    try {
      // Create a fresh run context before prompting so MCP writes can be attributed to this turn.
      artifactRun = await this.activateArtifactRun(request.sessionId, request.provenanceContext)
      let userMessageEmitted = false
      const emitUserMessage = (): void => {
        if (
          !publishUserMessage ||
          request.continuation ||
          request.suppressUserMessage ||
          userMessageEmitted
        )
          return
        userMessageEmitted = true
        this.pushEvent({
          kind: 'message',
          level: 'info',
          sessionId: request.sessionId,
          ...promptEventIdentity,
          role: 'user',
          text: request.text
        })
      }
      const finishCancelledBeforePrompt = async (): Promise<PromptResponse> => {
        turnSkillOutcome = 'cancelled'
        const response: PromptResponse = { stopReason: 'cancelled' }
        observedPromptStop = { response }
        if (!this.sessionInteractions.captureTerminal(promptInteraction, 'cancelled')) {
          return response
        }
        emitUserMessage()
        await this.emitArtifactRunEvent(request.sessionId, artifactRun)
        artifactEmitted = true
        log.info('prompt stopped', {
          sessionId: request.sessionId,
          stopReason: response.stopReason
        })
        contextUsageTurn?.fail()
        publishObservedPromptStop()
        return response
      }
      if (
        (await this.sessionInteractions.cancellationCheckpoint(promptInteraction)) === 'cancelled'
      ) {
        return finishCancelledBeforePrompt()
      }

      const sessionSpecialistPrefix = this.sessionRegistry
        .lookup(request.sessionId)
        ?.aggregate.snapshot().specialistPrefix
      const promptRequestText = request.continuation
        ? this.buildSpecialistHandoffContinuationText(request)
        : request.text
      const skillPreparation = await turnSkillHandle.prepareProvider({
        frameworkId: this.framework.id,
        selectionText: request.text,
        promptText: promptRequestText,
        codex: {
          home: this.backend.adapter.codexHome,
          bridgeSkillsAvailable: this.connectionResources.bridgeSkillsAvailable,
          selectSkills: async (text, catalog, signal) =>
            (await this.connectionResources.selectBridgeSkills(text, catalog, signal)) ?? [],
          signal: promptInteraction.signal
        }
      })
      if (
        (await this.sessionInteractions.cancellationCheckpoint(promptInteraction)) === 'cancelled'
      ) {
        return finishCancelledBeforePrompt()
      }
      const { promptPrefix: frameworkPromptPrefix } = this.framework.buildSessionSetup({
        systemPromptAppends: this.backend.prompt.persistentSystemPrompt
          ? []
          : this.getSystemPromptAppends(),
        turnPromptReminders: skillPreparation.specialistSkillGuidance
          ? [skillPreparation.specialistSkillGuidance]
          : [],
        sessionOptions: this.backend.session.options
      })
      const promptPrefix =
        [sessionSpecialistPrefix, frameworkPromptPrefix]
          .filter((segment): segment is string => Boolean(segment))
          .join('\n\n') || undefined
      const codexSkillInputs = [...skillPreparation.codexSkillInputs]
      const notebookHandoff =
        request.contextReset || request.historyPreamble
          ? this.notebookOptions?.peekHandoffContext?.(request.sessionId)
          : undefined
      const promptText = [
        request.historyPreamble,
        notebookHandoff ? buildNotebookHandoffPrompt(notebookHandoff) : undefined,
        promptPrefix,
        skillPreparation.text
      ]
        .filter((segment): segment is string => Boolean(segment))
        .join('\n\n')
      revokeReferencedUploadGrant = await this.authorizeReferencedSkillUploads(
        request.sessionId,
        request.referencedArtifacts ?? []
      )
      const projectId = this.resolveSessionProjectName(request.sessionId)
      const preparedPrompt = await this.promptContentOwner.prepare({
        appSessionId: request.sessionId,
        projectId,
        text: promptText,
        historyImages: request.historyImages ?? [],
        historyUploads: request.historyAttachments ?? [],
        currentUploads: request.attachments ?? [],
        references: request.referencedArtifacts ?? [],
        codexSkillInputs,
        skillImportEnabled: this.sessionCapabilities.isSkillImportEnabled(),
        fileTextBudget: resolveFileTextBudget(this.backend.context.window),
        skillImportTurnToken,
        onSkillImportAttachmentEligible: this.callbacks.onSkillImportAttachmentEligible
          ? (attachmentUri) => {
              try {
                this.callbacks.onSkillImportAttachmentEligible?.(
                  request.sessionId,
                  skillImportTurnToken,
                  attachmentUri
                )
              } catch (error) {
                safeLogError('skill import attachment callback failed', errorLogFields(error))
              }
            }
          : undefined
      })
      if (this.notebookOptions?.registerTurnInputs && preparedPrompt.turnInputs) {
        await this.notebookOptions.registerTurnInputs({
          projectId,
          appSessionId: request.sessionId,
          promptMessageId:
            request.provenanceContext?.promptMessageId ??
            this.artifactTurns?.promptMessageIdFor(request.sessionId) ??
            `prompt-unbound-${request.sessionId}`,
          uploads: preparedPrompt.turnInputs.uploads,
          references: preparedPrompt.turnInputs.references
        })
      }
      const promptContent = preparedPrompt.content

      contextUsageTurn = this.contextUsageTracker.beginTurn(request.sessionId)
      await this.recordPromptContextEstimate(
        request.sessionId,
        promptContent,
        promptPrefix,
        codexSkillInputs
      )

      emitUserMessage()
      skillActivityInputs = codexSkillInputs
      if (skillActivityInputs.length > 0) {
        this.emitCodexSkillInputActivities(
          request.sessionId,
          promptTurn,
          skillActivityInputs,
          'in_progress'
        )
        skillActivitiesStarted = true
      }

      const promptSessionSnapshot = this.sessionRegistry
        .lookup(request.sessionId)
        ?.aggregate.snapshot()
      const promptFramework = promptSessionSnapshot?.frameworkId ?? this.framework.id
      const openCodeUsageApi = this.backendGeneration.openCodeUsageApi()
      const opencodeUsageBefore =
        promptFramework === 'opencode' && openCodeUsageApi
          ? await fetchOpenCodeUsageSnapshot(
              openCodeUsageApi,
              activeSession.sessionId,
              promptSessionSnapshot?.cwd ?? this.snapshotOwner.cwd,
              this.options.opencodeUsageFetch
            )
          : undefined
      if (
        (await this.sessionInteractions.cancellationCheckpoint(promptInteraction)) === 'cancelled'
      ) {
        return finishCancelledBeforePrompt()
      }

      // Start the prompt and race it against routed updates from the active session queue.
      if (request.historyPreamble) {
        log.info('session transcript replay dispatched', {
          sessionId: request.sessionId,
          historyTextLength: request.historyPreamble.length,
          historyAttachmentCount: request.historyAttachments?.length ?? 0,
          historyImageCount: request.historyImages?.length ?? 0,
          ...this.diagnosticContext()
        })
      }
      const promptFailure = new Promise<never>((_, reject) => {
        activeSession.prompt(promptContent).catch(reject)
      })
      let providerPromptAccepted = false

      for (;;) {
        const message = await Promise.race([activeSession.nextUpdate(), promptFailure])

        // A reset/replacement may supersede this provider turn while a queued update or terminal
        // response is still draining. Settle the abandoned promise, but never project its state or
        // terminal facts into the replacement interaction.
        if (this.sessionInteractions.current(request.sessionId) !== promptInteraction) {
          if (message.kind === 'stop') return message.response
          continue
        }

        if (!providerPromptAccepted) {
          providerPromptAccepted = true
          try {
            this.callbacks.onProviderPromptAccepted?.(request.sessionId, promptAttemptId)
          } catch (error) {
            safeLogError('provider-prompt-accepted callback failed', errorLogFields(error))
          }
        }

        if (skillActivitiesStarted && !skillActivitiesFinalized) {
          this.emitCodexSkillInputActivities(
            request.sessionId,
            promptTurn,
            skillActivityInputs,
            'completed'
          )
          skillActivitiesFinalized = true
        }

        if (message.kind === 'stop') {
          turnSkillOutcome = message.response.stopReason === 'cancelled' ? 'cancelled' : 'completed'
          const codexTurnCount = message.response._meta?.[ACP_MODEL_TURN_COUNT_META_KEY]
          const reportedTurnCount =
            promptFramework === 'codex' &&
            Number.isSafeInteger(codexTurnCount) &&
            (codexTurnCount as number) > 0
              ? (codexTurnCount as number)
              : undefined
          observedPromptStop = {
            response: message.response,
            turnUsage:
              promptFramework === 'codex'
                ? (toCodexTurnTokenUsage(message.response._meta?.[ACP_TURN_TOKEN_USAGE_META_KEY]) ??
                  toCodexTurnTokenUsage(message.response.usage))
                : toAcpTurnTokenUsage(message.response.usage),
            ...(reportedTurnCount === undefined ? {} : { modelTurnCount: reportedTurnCount })
          }
          // Freeze provider-terminal time before artifact work and provider-specific usage fetching.
          // The outcome remains authoritative through close/reset while usage facts are finalized.
          if (!this.sessionInteractions.captureTerminal(promptInteraction, 'stop')) {
            return message.response
          }
          this.recordCodexPromptResponseContextUsage(
            request.sessionId,
            message.response,
            promptTurn
          )
          if (contextUsageTurn.complete()) this.emitState()
          // Emit artifact metadata before stop so the renderer can attach files to the finished message.
          await this.emitArtifactRunEvent(request.sessionId, artifactRun)
          artifactEmitted = true
          log.info('prompt stopped', {
            sessionId: request.sessionId,
            stopReason: message.stopReason
          })
          const opencodeTurnUsage =
            promptFramework === 'opencode' && openCodeUsageApi
              ? sumOpenCodeTurnUsage(
                  opencodeUsageBefore,
                  await fetchOpenCodeUsageSnapshot(
                    openCodeUsageApi,
                    activeSession.sessionId,
                    this.sessionRegistry.lookup(request.sessionId)?.aggregate.snapshot().cwd ??
                      this.snapshotOwner.cwd,
                    this.options.opencodeUsageFetch
                  )
                )
              : undefined
          if (opencodeTurnUsage) observedPromptStop.turnUsage = opencodeTurnUsage
          publishObservedPromptStop()
          if (
            this.sessionInteractions.current(request.sessionId) === promptInteraction &&
            this.activeSessionFor(request.sessionId) === activeSession &&
            this.shouldAutoCompactContext(request.sessionId)
          ) {
            try {
              await this.performNativeContextCompaction(
                activeSession,
                request.sessionId,
                'automatic'
              )
            } catch (error) {
              log.warn('automatic context compaction failed', {
                sessionId: request.sessionId,
                ...errorLogFields(error)
              })
            }
          }
          return message.response
        }

        // Route the update under the app-facing id so a session adopted onto a new agent (after a
        // provider switch) still streams into the same conversation the renderer is watching. (No
        // per-update log line here: it fires once per streamed chunk and floods the console for no
        // signal — 'prompt start'/'prompt stopped' already bracket the turn.)
        this.handleSessionUpdate(message.notification, request.sessionId)
      }
    } catch (error) {
      if (observedPromptStop) {
        // Provider stop/cancellation already won the outcome race. App-side finalization failure,
        // reset, or connection teardown cannot rewrite it as a prompt failure.
        contextUsageTurn?.complete()
        if (publishObservedPromptStop()) {
          log.warn('prompt terminal finalization failed', {
            sessionId: request.sessionId,
            ...errorLogFields(error)
          })
        }
        throw error
      }
      if (this.sessionInteractions.current(request.sessionId) !== promptInteraction) {
        // Reset/replacement is silent. Unexpected connection teardown settles and publishes every
        // visible prompt in handleConnectionClosed before releasing its interaction scope.
        contextUsageTurn?.supersede()
        throw error
      }
      // A fresh provider failure captures its terminal outcome before rollback work can add latency.
      if (!this.sessionInteractions.captureTerminal(promptInteraction, 'error')) throw error
      contextUsageTurn?.fail()
      if (skillActivitiesStarted && !skillActivitiesFinalized) {
        this.emitCodexSkillInputActivities(
          request.sessionId,
          promptTurn,
          skillActivityInputs,
          'failed'
        )
        skillActivitiesFinalized = true
      }
      // errorLogFields keeps the RequestError message/code/data visible in the file log — a raw Error
      // nested in the payload serializes without its (non-enumerable) message, which once hid the
      // provider's real rejection reason from the log.
      log.error('prompt failed', { sessionId: request.sessionId, ...errorLogFields(error) })
      const text = describePromptError(error, { model: this.backend.session.model })
      // Tag a request-size overflow as recoverable so the renderer tries native compaction, falls back
      // to context replacement + text replay, and retries instead of dead-ending.
      // The structured errorKind slug is checked alongside the message text: providers relay the same
      // overflow in different wordings, and a slug-only match needs no message at all.
      const recoverable =
        isMediaOverflowError(text) ||
        isMediaOverflowError(errorMessage(error)) ||
        isMediaOverflowError(acpErrorKind(error))
          ? 'context-overflow'
          : undefined
      const terminal = this.sessionInteractions.settle(promptInteraction, {})
      if (!terminal) throw error
      this.pushEvent({
        kind: 'error',
        level: 'error',
        recoverable,
        // Tag a model-provider failure (upstream LLM/HTTP error the agent relayed) so the renderer
        // keeps the message but hides the "Report error" button — only ACP-layer exceptions are bugs
        // worth a GitHub issue. Determined structurally from the agent's signals, not the message text.
        providerError: isProviderPromptError(error),
        sessionId: request.sessionId,
        ...promptEventIdentity,
        timestamp: terminal.timestamp,
        title: ACP_PROMPT_FAILED_EVENT_TITLE,
        text
      })
      throw error
    } finally {
      revokeReferencedUploadGrant?.()
      // A turn that fails or is aborted never reaches the stop branch; still surface any files it
      // wrote so they are attached to a message instead of being orphaned in the pending directory.
      if (!artifactEmitted) {
        try {
          await this.emitArtifactRunEvent(request.sessionId, artifactRun)
        } catch (error) {
          log.error('artifact emit after prompt failure failed', {
            sessionId: request.sessionId,
            ...errorLogFields(error)
          })
        }
      }
      try {
        await this.clearArtifactRun(artifactRun)
      } catch (error) {
        this.pushEvent({
          kind: 'error',
          level: 'error',
          sessionId: request.sessionId,
          ...promptEventIdentity,
          title: 'Artifact cleanup failed',
          text: errorMessage(error)
        })
      }
      // ArtifactTurnOwner clears only the handle that still owns this Session. A superseded turn's
      // delayed finally therefore cannot erase the replacement turn's handoff or active-run state.
      const ownsInteraction =
        this.sessionInteractions.current(request.sessionId) === promptInteraction
      if (ownsInteraction) {
        this.permissionContext.clearCorrelationsForSession(request.sessionId)
      }
      contextUsageTurn?.supersede()
      this.sessionInteractions.release(promptInteraction)
      if (ownsInteraction) {
        try {
          this.callbacks.onPromptEnded?.(request.sessionId, skillImportTurnToken)
        } catch (error) {
          safeLogError('prompt-end callback failed', errorLogFields(error))
        }
      }
      // emitState invokes the renderer onStateChanged callback; guard it so a throw there cannot skip
      // transition arbitration and strand a barrier awaited by a later createSession.
      try {
        this.emitState()
      } catch (error) {
        safeLogError('emitState after prompt turn failed', errorLogFields(error))
      }
      turnSkillHandle.close(turnSkillOutcome)
      if (turnSkillHandle.reloadDecision.kind === 'continue') {
        this.generationActivityChanged()
      }
    }
  }

  // Requests cancellation without clearing in-flight state before the agent stops.
  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    const connection = this.connection
    const activeSession = this.activeSessionFor(request.sessionId)

    if (connection && activeSession) {
      await this.sessionInteractions.cancelPrompt({
        sessionId: request.sessionId,
        notify: () =>
          connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: activeSession.sessionId
          }),
        onAccepted: () => {
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

    return this.getSnapshot()
  }

  // Closes the agent-side session when supported, then removes local routing state.
  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    const deletion = this.sessionRegistry.beginDelete(request.sessionId)
    try {
      return await this.withOperationLease(() => this.deleteSessionOperation(request, deletion))
    } finally {
      deletion.finish()
    }
  }

  private async deleteSessionOperation(
    request: AcpDeleteSessionRequest,
    deletion: AcpSessionDeletion
  ): Promise<AcpStateSnapshot> {
    const target = this.sessionRegistry.lookup(request.sessionId)
    const session = target?.attachment?.session

    this.cancelPermissionFlowForSession(request.sessionId)

    if (session) {
      // Talk to the agent using its own session id: for an adopted session the underlying
      // agent id (session.sessionId) differs from the app-facing request.sessionId.
      if (this.connection && this.supportsSessionDelete) {
        await this.connection.agent.request(acp.methods.agent.session.delete, {
          sessionId: session.sessionId
        })
      } else if (this.connection && this.supportsSessionClose) {
        await this.connection.agent.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId
        })
      } else {
        await this.connection?.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: session.sessionId
        })
      }

      session.dispose()
      if (target?.attachment) this.sessionRegistry.detach(target.attachment, 'provider')
    }

    // App-session-keyed cleanup runs whether or not a live session is attached. A framework switch
    // A disconnect detaches the provider but deliberately keeps framework/backend affinity, so deleting
    // a session that was never re-adopted must remove its remaining Aggregate as well.
    this.permissionContext.clearSession(request.sessionId)
    this.sessionInteractions.supersedeCurrent(request.sessionId)
    // Drop this session's MCP routes, aliases, and bearer ownership (idempotent for detached deletes).
    this.sessionCapabilities.revokeSession(request.sessionId)
    const removal = deletion.finish(target)
    this.promptContentOwner.resetSession(request.sessionId)
    this.handoffContinuity.clearSession(request.sessionId)
    this.contextUsageTracker.deleteSession(request.sessionId)

    // Only announce a deletion and shift the current session when something was actually attached; a
    // detached cleanup (post-switch) must not emit a spurious event or move the current selection.
    if (removal.wasActive) {
      this.pushEvent({
        kind: 'system',
        level: 'info',
        sessionId: request.sessionId,
        title: 'Session deleted'
      })
      this.emitState()
    }

    return this.getSnapshot()
  }

  // Resolves or cancels one pending permission request from the renderer.
  async respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot> {
    try {
      const handled = await this.permissionContext.respondToPermission(
        response,
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      this.pushEvent({
        kind: 'permission',
        level: handled ? 'info' : 'warning',
        title: handled ? 'Permission response sent' : 'Permission request not found',
        text: response.cancelled ? 'cancelled' : response.optionId
      })
    } catch (error) {
      this.pushEvent({
        kind: 'permission',
        level: 'error',
        title: 'Permission approval could not be saved',
        text: error instanceof Error ? error.message : 'The tool call was cancelled.'
      })
      this.emitState()
      throw error
    }
    this.emitState()

    return this.getSnapshot()
  }

  // App-owned privileged actions (such as Specialist handoff) share the provider permission card
  // and broker lifecycle. The caller supplies only a redacted renderer payload; this runtime owns
  // request parking, cancellation, and response validation.
  async requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
  }): Promise<boolean> {
    return this.permissionContext.requestAppApproval(input)
  }

  // Native UserInput::Skill entries are consumed inside Codex and may not emit a filesystem read
  // lifecycle over ACP. Project the same compact activity explicitly so selected and auto-routed
  // Skills remain visible without sending their path or document to renderer state or persistence.
  private emitCodexSkillInputActivities(
    sessionId: string,
    promptTurn: number,
    inputs: ReadonlyArray<{ name: string }>,
    status: 'in_progress' | 'completed' | 'failed'
  ): void {
    for (const [index, { name }] of inputs.entries()) {
      this.pushEvent({
        kind: 'tool',
        level: status === 'failed' ? 'error' : 'info',
        sessionId,
        toolCallId: `open-science-skill-${promptTurn}-${index}`,
        providerToolName: 'skill',
        title: `Loaded skill: ${name}`,
        status
      })
    }
  }

  // Converts the user's explicit `@` selections into a turn-scoped capability for Skill import.
  // Generic managed-path validation happens before the grant; the importer retains the stricter
  // session-owner check for every path that was not selected in this turn.
  private async authorizeReferencedSkillUploads(
    sessionId: string,
    references: FileReference[]
  ): Promise<(() => void) | undefined> {
    if (!this.sessionCapabilities.isSkillImportEnabled()) return undefined

    const authorize = this.skillImportOptions?.authorizeReferencedUploads
    if (!authorize) return undefined

    const paths = references.flatMap((reference) => {
      if (reference.source !== 'upload') return []
      const normalizedName = reference.name.toLowerCase()
      return normalizedName.endsWith('.skill') || normalizedName.endsWith('.zip')
        ? [reference.path]
        : []
    })

    return authorize(this.resolveSessionProjectName(sessionId), sessionId, paths)
  }

  // Lazily initializes the process connection before session creation.
  private async ensureConnected(cwd: string): Promise<ClientConnection> {
    return this.connectionLifecycle.ensureConnected(cwd)
  }

  private observeClaudeSdkMessage(params: Record<string, unknown>): void {
    if (typeof params.sessionId !== 'string') return
    if (typeof params.message !== 'object' || params.message === null) return

    const message = params.message as Record<string, unknown>
    if (message.type !== 'result') return
    const origin =
      typeof message.origin === 'object' && message.origin !== null
        ? (message.origin as Record<string, unknown>).kind
        : undefined
    if (typeof origin === 'string' && CLAUDE_AUTONOMOUS_RESULT_ORIGINS.has(origin)) return
    if (!Number.isSafeInteger(message.num_turns) || (message.num_turns as number) <= 0) return

    const appSessionId = this.sessionRegistry.resolveAppSessionId(params.sessionId)
    const promptInteraction = this.currentPromptInteraction(appSessionId)
    if (!promptInteraction) return
    this.sessionInteractions.observeModelTurns(promptInteraction, message.num_turns as number)
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

  // Collects the system-prompt guidance appended to every session, plus app tooling
  // instructions when those services are wired. Skill privacy is enforced at the presentation layer;
  // agent prompts must not block native progressive loading of a selected SKILL.md.
  private notebookToolingAvailable(): boolean {
    return this.currentCapabilityAvailability().notebook
  }

  private skillImportToolingAvailable(): boolean {
    return this.currentCapabilityAvailability().skillImport
  }

  private artifactToolingAvailable(): boolean {
    return this.currentCapabilityAvailability().artifacts
  }

  private currentCapabilityAvailability(): ReturnType<
    AcpSessionCapabilityOwner['toolingAvailability']
  > {
    return this.sessionCapabilities.toolingAvailability({
      framework: this.framework,
      nativeMcpEnabled: this.backend.adapter.nativeMcpEnabled,
      bridgeMcpAliasesEnabled: this.backend.adapter.bridgeMcpAliasesEnabled,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
    })
  }

  private getAppSystemPromptAppends(): string[] {
    return [
      TURN_CONTINUITY_SYSTEM_PROMPT_APPEND,
      LARGE_DATA_FILE_SYSTEM_PROMPT_APPEND,
      ...(this.artifactToolingAvailable() ? [ARTIFACT_FILE_SYSTEM_PROMPT_APPEND] : []),
      ...(this.notebookToolingAvailable() ? [NOTEBOOK_SYSTEM_PROMPT_APPEND] : []),
      ...(this.skillImportToolingAvailable() ? [SKILL_IMPORT_SYSTEM_PROMPT_APPEND] : [])
    ]
  }

  private async getBackendSystemPromptAppends(): Promise<string[]> {
    await this.sessionCapabilities.refreshDynamicAvailability()
    return this.getAppSystemPromptAppends()
  }

  private getSystemPromptAppends(skillGuidance?: string): string[] {
    // Each append names MCP tools that only exist when that tooling is actually wired for this session;
    // omit it otherwise so the agent isn't told to use tools it wasn't given.
    return [
      ...this.getAppSystemPromptAppends(),
      ...this.backend.prompt.systemPromptAppends,
      ...(skillGuidance ? [skillGuidance] : [])
    ]
  }

  private async resolveCurrentSpecialistSkills(
    sessionId: string,
    specialistId = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().specialistId
  ): Promise<EffectiveSpecialistSkills | undefined> {
    if (!specialistId || !this.options.resolveSpecialistSkills) return undefined
    try {
      return await this.options.resolveSpecialistSkills(specialistId)
    } catch {
      return { kind: 'unavailable', reason: 'The bound specialist is unavailable.' }
    }
  }

  private buildSpecialistHandoffContinuationText(request: AcpPromptRequest): string {
    const continuation = request.continuation
    if (!continuation) return request.text

    const outcome =
      continuation.completion.kind === 'returned'
        ? this.serializeHandoffValue(continuation.completion.value)
        : continuation.completion.errorMessage
    const outcomeLabel = continuation.completion.kind === 'returned' ? 'result' : 'error'
    const target = continuation.targetName ?? 'Main Agent'
    return [
      `Continue the original user task as ${target}. Do not repeat work already shown before the handoff.`,
      `Original user request:\n${request.text}`,
      `Captured outer tool ${outcomeLabel}:\n${outcome}`
    ].join('\n\n')
  }

  private serializeHandoffValue(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  // Builds the ACP `_meta` argument for session/new and session/resume, delegating the framework-specific
  // shape to the active framework. Claude applies its settingSources restriction, resolved backend
  // options, and system-prompt appends; opencode returns no meta and uses a prompt prefix instead.
  // `extraAppends` lets createSession inject a one-off specialist identity without touching the
  // shared generation appends that apply to every session on this runtime generation.
  private buildSessionMetaArg(
    extraAppends: string[] = [],
    specialistSkills?: EffectiveSpecialistSkills
  ): { _meta?: Record<string, unknown> } {
    const skillWhitelist =
      specialistSkills?.kind === 'specialist'
        ? specialistSkills.frameworkNames
        : specialistSkills?.kind === 'unavailable'
          ? []
          : undefined
    const setup = this.framework.buildSessionSetup({
      systemPromptAppends: [...this.getSystemPromptAppends(), ...extraAppends],
      sessionOptions: this.backend.session.options,
      ...(skillWhitelist !== undefined ? { skillWhitelist } : {})
    })

    return setup.meta ? { _meta: setup.meta } : {}
  }

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectName(sessionId: string): string {
    return (
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectName ??
      this.artifactOptions?.projectName ??
      DEFAULT_UPLOAD_PROJECT_NAME
    )
  }

  // Normalizes a requested project name, falling back to the runtime default when absent.
  private normalizeProjectName(requestedProjectName: string | undefined): string {
    return (
      requestedProjectName?.trim() ||
      this.artifactOptions?.projectName ||
      DEFAULT_UPLOAD_PROJECT_NAME
    )
  }

  // Marks a new assistant turn as the active artifact run before the model can call the MCP tool.
  private async activateArtifactRun(
    sessionId: string,
    provenanceContext: AcpPromptRequest['provenanceContext']
  ): Promise<ArtifactTurnHandle | undefined> {
    if (!this.artifactTurns) return undefined

    return this.artifactTurns.open({
      appSessionId: sessionId,
      artifactStorageSessionId:
        this.sessionCapabilities.artifactRoutingIdFor(sessionId) ?? sessionId,
      projectId: this.resolveSessionProjectName(sessionId),
      agentName: this.framework.displayName,
      provenanceContext
    })
  }

  // Clears the handoff file after the prompt so late MCP writes cannot attach to a completed turn.
  private async clearArtifactRun(artifactRun: ArtifactTurnHandle | undefined): Promise<void> {
    if (artifactRun) await this.artifactTurns?.dispose(artifactRun)
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
    }
  ): Promise<ArtifactFile> {
    if (!this.artifactTurns) {
      throw new Error('No active assistant turn to attach a generated file to.')
    }
    return this.artifactTurns.writeForActiveTurn(sessionId, input)
  }

  // Publishes pending files as a claim event; the renderer later supplies the final message id.
  private async emitArtifactRunEvent(
    sessionId: string,
    artifactRun: ArtifactTurnHandle | undefined
  ): Promise<void> {
    if (!artifactRun || !this.artifactTurns) return
    const publication = await this.artifactTurns.finalize(artifactRun)
    if (!publication) return

    this.pushEvent({
      kind: 'artifact',
      level: 'info',
      sessionId,
      title: 'Generated files',
      runId: publication.runId,
      promptMessageId: publication.promptMessageId,
      artifactSessionId: publication.artifactStorageSessionId,
      artifactClaimId: publication.artifactClaimId,
      artifacts: publication.artifacts
    })
  }

  // Hands permission requests to the broker so the renderer can answer later. Any failure is logged with
  // its real message before it propagates: the ACP SDK collapses a thrown handler error into a bare
  // -32603 "Internal error" (real detail buried in `data.details`), so this is the only place the true
  // cause is captured in the app log. The error is rethrown unchanged to preserve protocol behavior.
  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    // Fork point: a WebFetch/server-side tool that never reaches this line means the "Internal error"
    // originated elsewhere. Info level so it's a visible audit line (one per prompt): if an MCP call
    // runs without this appearing, the agent never asked (e.g. an un-gated permission config). Log the
    // tool identity (name/kind) and whether it looks like MCP — never the title (a WebFetch title is the
    // full URL with query params, i.e. user data).
    const appSessionId = this.sessionRegistry.resolveAppSessionId(params.sessionId)
    const reviewerContext = this.reviewerSessions.contextFor(params.sessionId)
    const mcpServerNames =
      reviewerContext?.mcpServerNames ?? this.sessionCapabilities.mcpServerNamesFor(appSessionId)
    const promptInteraction = this.currentPromptInteraction(appSessionId)
    const promptTurn = promptInteraction?.sequence
    const aggregateSnapshot = this.sessionRegistry.lookup(appSessionId)?.aggregate.snapshot()
    const framework = reviewerContext?.frameworkId ?? aggregateSnapshot?.frameworkId
    const isPermissionContextCancelled = (): boolean =>
      framework === 'opencode' &&
      (promptTurn === undefined
        ? this.activeSessionFor(appSessionId) !== undefined
        : this.currentPromptInteraction(appSessionId)?.sequence !== promptTurn ||
          (promptInteraction !== undefined &&
            this.sessionInteractions.isCancellationAccepted(promptInteraction)))
    const restoreContext = {
      sessionId: appSessionId,
      framework,
      mcpServerNames,
      isCancelled: isPermissionContextCancelled
    }
    const normalizedParams = await this.permissionContext.restoreToolCall(params, restoreContext)
    if (
      !normalizedParams ||
      this.permissionContext.isPermissionRequestCancelled(
        params.toolCall.toolCallId,
        restoreContext
      )
    ) {
      return { outcome: { outcome: 'cancelled' } }
    }
    const toolName = extractProviderToolName(normalizedParams.toolCall)
    const isMcp =
      isMcpToolName(normalizedParams.toolCall?.title, mcpServerNames) ||
      isMcpToolName(toolName, mcpServerNames)
    log.info('permission request received', {
      tool:
        this.toolIdentityForDiagnostics(toolName, appSessionId) ?? normalizedParams.toolCall?.kind,
      isMcp,
      toolCallId: normalizedParams.toolCall?.toolCallId,
      sessionId: params.sessionId,
      optionCount: params.options?.length
    })

    try {
      // Background reviewer sessions run unattended and are intentionally absent from the primary
      // Session Aggregate collection.
      // Approve only their dedicated, scope-bounded MCP. Bash, filesystem, network, other MCP servers,
      // and unknown tools are rejected without involving the renderer.
      if (reviewerContext) {
        const response = this.reviewerSessions.resolvePermission(normalizedParams)
        if (response) return response
        throw new Error(`Unknown ACP reviewer session: ${params.sessionId}`)
      }

      if (!this.activeSessionFor(appSessionId)) {
        throw new Error(`Unknown ACP session: ${appSessionId}`)
      }

      const profileState = aggregateSnapshot?.permissionProfile
      const permissionFrameworkId = aggregateSnapshot?.frameworkId ?? this.framework.id
      const permissionFramework =
        permissionFrameworkId === this.framework.id
          ? this.framework
          : getAgentFramework(permissionFrameworkId)

      return await this.permissionContext.requestPermission(
        appSessionId === normalizedParams.sessionId
          ? normalizedParams
          : { ...normalizedParams, sessionId: appSessionId },
        {
          profile: profileState?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          // Source the framework from the per-session map, not the current generation view — an
          // overlapping reconnect can move it off Codex mid-request and leak the amendment options.
          frameworkId: permissionFrameworkId,
          shellDialect: permissionFramework.commandShellDialect,
          autoReviewStrategy: profileState?.autoReviewStrategy,
          cwd: aggregateSnapshot?.cwd,
          mcpServerNames,
          projectId: this.resolveSessionProjectName(appSessionId)
        }
      )
    } catch (error) {
      log.error('permission request failed', {
        message: errorMessage(error),
        tool:
          this.toolIdentityForDiagnostics(
            extractProviderToolName(normalizedParams.toolCall),
            appSessionId
          ) ?? normalizedParams.toolCall?.kind,
        toolCallId: params.toolCall?.toolCallId,
        sessionId: params.sessionId
      })
      throw error
    }
  }

  // Observes every ACP update before framework-specific consumers drain their ActiveSession queue.
  // Reviewer updates are consumed outside handleSessionUpdate, so this shared boundary is the only
  // place where a preceding tool_call can reliably enrich a later sparse permission request.
  private observePermissionToolContext(notification: SessionNotification): void {
    const sessionId = this.sessionRegistry.resolveAppSessionId(notification.sessionId)
    const reviewerContext = this.reviewerSessions.contextFor(notification.sessionId)
    const framework =
      reviewerContext?.frameworkId ??
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().frameworkId
    this.applySessionUpdateEffects(
      this.sessionUpdateProjector.project(notification, {
        kind: 'permission',
        appSessionId: sessionId,
        framework,
        mcpServerNames:
          reviewerContext?.mcpServerNames ?? this.sessionCapabilities.mcpServerNamesFor(sessionId)
      })
    )
  }

  private cancelPermissionFlowForSession(sessionId: string): void {
    this.permissionContext.cancelForSession(sessionId)
  }

  // App-managed codex-acp emits the exact per-request numerator during generation. Codex's pinned
  // adapter publishes uncached input and cached input as separate PromptResponse categories, so
  // recombine them for the context numerator when applying the final per-request correction.
  private recordCodexPromptResponseContextUsage(
    sessionId: string,
    response: PromptResponse,
    promptTurn: number
  ): void {
    if (
      this.framework.id !== 'codex' ||
      this.pendingProviderReconnect ||
      this.currentPromptInteraction(sessionId)?.sequence !== promptTurn
    ) {
      return
    }

    const usage = toCodexTurnTokenUsage(response.usage)
    if (!usage) return

    const used = usage.inputTokens + usage.cacheTokens
    if (this.contextUsageTracker.reconcileUsed(sessionId, used)) this.emitState()
  }

  private contextUsageSelectionFor(sessionId?: string): {
    model?: string
    contextWindow?: number
  } {
    const appliedModel = sessionId
      ? this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().appliedModel
      : undefined
    // OpenCode applies the requested provider model through the optional ACP model config. If the
    // option was absent or rejected, the agent kept its own default and the requested model is unsafe
    // for both tokenization and window sizing. Other frameworks configure their upstream model
    // through env or an app-owned bridge, independently of the ACP transport model.
    const selectedModelConfirmed = !(
      this.framework.id === 'opencode' &&
      this.backend.session.model &&
      !appliedModel
    )
    if (!selectedModelConfirmed) return {}

    const model = this.backend.context.model ?? appliedModel
    return {
      ...(model ? { model } : {}),
      ...(this.backend.context.window ? { contextWindow: this.backend.context.window } : {})
    }
  }

  private contextUsageEstimateInput(sessionId?: string): SessionEstimateInput {
    const { model } = this.contextUsageSelectionFor(sessionId)
    const sessionSetup = this.framework.buildSessionSetup({
      systemPromptAppends: this.backend.prompt.persistentSystemPrompt
        ? []
        : this.getSystemPromptAppends(),
      sessionOptions: this.backend.session.options
    })
    const persistentSystemPrompt =
      this.backend.prompt.persistentSystemPrompt ?? sessionSetup.persistentSystemPrompt
    const persistentSections = contextUsageMcpSections(this.framework.id, {
      artifacts: this.artifactToolingAvailable(),
      notebook: this.notebookToolingAvailable(),
      skillImport: this.skillImportToolingAvailable(),
      codexBridgeAliases: this.backend.adapter.bridgeMcpAliasesEnabled
    }).map(({ sectionId, text }) => ({ sectionId, category: 'mcp' as const, text }))

    return {
      frameworkId: this.framework.id,
      ...(model ? { model } : {}),
      ...(persistentSystemPrompt ? { persistentSystemPrompt: [persistentSystemPrompt] } : {}),
      ...(persistentSections.length > 0 ? { persistentSections } : {})
    }
  }

  private selectedContextWindowFor(sessionId: string): number | undefined {
    return this.contextUsageSelectionFor(sessionId).contextWindow
  }

  private ensureContextUsageTracking(sessionId: string): void {
    if (!this.activeSessionFor(sessionId)) return
    this.contextUsageTracker.beginSession(sessionId, this.contextUsageEstimateInput(sessionId))
  }

  private refreshEstimatedContextUsage(
    sessionId: string,
    status: NonNullable<AcpContextUsage['breakdown']>['status']
  ): boolean {
    const selectedSize = this.selectedContextWindowFor(sessionId)
    const size = selectedSize ?? this.contextUsageTracker.usage(sessionId)?.size
    return this.contextUsageTracker.refreshUsage(sessionId, status, size)
  }

  private async recordPromptContextEstimate(
    sessionId: string,
    promptContent: string | ContentBlock[],
    promptPrefix: string | undefined,
    codexSkillInputs: ReadonlyArray<{ name: string; path: string }>
  ): Promise<void> {
    this.ensureContextUsageTracking(sessionId)
    this.contextUsageTracker.commitPendingAssistantOutput(sessionId)
    this.contextUsageTracker.appendText(sessionId, 'system', promptPrefix ?? '')
    this.contextUsageTracker.appendPromptContent(sessionId, promptContent, promptPrefix)

    const promptSkillDocuments = (
      await Promise.all(
        codexSkillInputs.map(async ({ path }) => {
          try {
            return { path, text: await readFile(path, 'utf8') }
          } catch (error) {
            log.warn('context estimate could not read Codex Skill input', {
              sessionId,
              ...errorLogFields(error)
            })
            return undefined
          }
        })
      )
    ).filter((document): document is { path: string; text: string } => document !== undefined)
    this.contextUsageTracker.replacePromptSkillDocuments(sessionId, promptSkillDocuments)

    if (this.refreshEstimatedContextUsage(sessionId, 'preflight')) this.emitState()
  }

  // Normalizes low-level session notifications into runtime/workspace events.
  private handleSessionUpdate(
    notification: SessionNotification,
    appSessionId?: string,
    visible = true
  ): void {
    const sessionId = appSessionId ?? notification.sessionId
    this.applySessionUpdateEffects(
      this.sessionUpdateProjector.project(notification, {
        kind: 'runtime',
        appSessionId,
        eventId: this.nextEventId(),
        visible,
        reconnectPending: this.pendingProviderReconnect,
        mcpServerNames: this.sessionCapabilities.mcpServerNamesFor(sessionId)
      })
    )
  }

  private applySessionUpdateEffects(effects: readonly AcpSessionUpdateEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'permission-tool-correlation':
          this.permissionContext.observeToolCall(effect.notification, effect.context)
          break
        case 'context-observation':
          this.ensureContextUsageTracking(effect.sessionId)
          this.contextUsageTracker.observeSessionUpdate(
            effect.sessionId,
            effect.notification,
            effect.observation
          )
          break
        case 'current-mode': {
          const aggregate = this.sessionRegistry.lookup(effect.sessionId)?.aggregate
          const profileState = aggregate?.snapshot().permissionProfile
          if (profileState) {
            aggregate.setPermissionProfile(
              applyCurrentModeUpdate(
                profileState as SessionPermissionProfileState,
                effect.currentModeId
              )
            )
            this.emitState()
          }
          break
        }
        case 'provider-usage':
          this.contextUsageTracker.reconcileProviderUsage(
            effect.sessionId,
            effect.usage,
            this.selectedContextWindowFor(effect.sessionId)
          )
          this.emitState()
          break
        case 'context-refresh':
          if (
            this.contextUsageTracker.usage(effect.sessionId)?.breakdown?.status !== 'reconciled'
          ) {
            this.refreshEstimatedContextUsage(effect.sessionId, 'preflight')
          }
          break
        case 'tool-failure-diagnostic':
          log.warn('tool call failed', {
            tool: effect.tool,
            toolCallId: effect.toolCallId,
            sessionId: effect.sessionId,
            reason: effect.reason
          })
          break
        case 'visible-event':
          this.pushEvent(effect.event)
          break
      }
    }
  }

  private toolIdentityForDiagnostics(
    providerToolName: string | undefined,
    sessionId: string
  ): string | undefined {
    if (!providerToolName) return undefined

    return (
      resolveCanonicalMcpToolIdentity(
        providerToolName,
        this.sessionCapabilities.mcpServerNamesFor(sessionId)
      ) ?? providerToolName
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
    // Always capture agent stderr in the log — it's the primary clue when a turn stalls or the
    // agent misbehaves (auth loops, MCP connection failures, tool errors) in a packaged build.
    if (text) {
      log.warn('agent stderr', {
        text,
        framework: context.framework,
        status: this.snapshotOwner.status,
        sessionCount: this.activeSessionIds().length
      })
    }

    if (this.processEventDisposition(context.process, context.epoch) !== 'current' || !text) return

    // Attribute stderr to a session only when exactly one prompt is in flight — then it's
    // unambiguously that turn's. With zero or multiple concurrent prompts, omit the sessionId
    // rather than risk pinning it to the wrong conversation's waiting indicator.
    const inFlight = this.getInFlightSessionIds()
    this.pushEvent({
      kind: 'system',
      level: 'warning',
      sessionId: inFlight.length === 1 ? inFlight[0] : undefined,
      title: 'agent',
      text
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
  private pushEvent(
    event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>
  ): void {
    const currentPromptMessageId = event.sessionId
      ? this.currentPromptInteraction(event.sessionId)?.promptMessageId
      : undefined
    const scopedEvent =
      currentPromptMessageId && !event.promptMessageId
        ? { ...event, promptMessageId: currentPromptMessageId }
        : event
    const runtimeEvent = this.snapshotOwner.appendEvent(scopedEvent)
    this.callbacks.onEvent?.(runtimeEvent)
    this.emitState()
  }

  // Generates monotonically increasing event ids for this runtime instance.
  private nextEventId(): string {
    return this.snapshotOwner.nextEventId()
  }

  // Broadcasts the latest runtime snapshot if a listener is registered.
  private emitState(): void {
    this.callbacks.onStateChanged?.(this.getSnapshot())
  }

  // Creates an ephemeral reviewer ACP session using the existing agent connection. The reviewer
  // session is isolated from primary session registry state, does not
  // appear in the snapshot, and callers are responsible for disposing it. This allows background
  // review to run in parallel with the main session without affecting the main state machine.
  async buildReviewerSession(request: ReviewerSessionRequest): Promise<ReviewerSessionResult> {
    return this.withOperationLease(() =>
      this.reviewerSessions.create(request, async () => {
        const connection = await this.ensureConnected(request.cwd)
        this.assertCurrentConnectedConnection(connection)
        return {
          connection,
          framework: this.framework,
          sessionOptions: this.backend.session.options,
          startupGeneration: this.sessionRegistry.startupGeneration
        }
      })
    )
  }

  private invalidatePendingSessionStartups(): void {
    this.generationActivity.invalidateStartups()
    this.sessionRegistry.invalidatePending()
    this.reviewerSessions.invalidatePending()
  }

  private reservePrimarySessionIds(
    reservation: AcpPrimarySessionIdentityReservation | undefined,
    sessionIds: string[],
    publishedAppSessionId?: string,
    startupGeneration = this.sessionRegistry.startupGeneration
  ): AcpPrimarySessionIdentityReservationResult {
    return this.sessionRegistry.reserve({
      reservation,
      sessionIds,
      publishedAppSessionId,
      startupGeneration,
      mayRenewAfterConnectionSetup: Boolean(
        this.reconnectBarrier || !this.connection || this.snapshotOwner.status !== 'connected'
      ),
      blockStartup: !this.reconnectBarrier
    })
  }

  private renewPrimarySessionIdentityReservation(
    reservation: AcpPrimarySessionIdentityReservation,
    publishedAppSessionId?: string
  ): boolean {
    return reservation.renew(publishedAppSessionId)
  }

  private assertPrimarySessionIdentityReservation(
    reservation: AcpPrimarySessionIdentityReservation
  ): void {
    reservation.assertCurrent()
  }

  private assertCurrentConnectedConnection(connection: ClientConnection): void {
    if (this.connection !== connection || this.snapshotOwner.status !== 'connected') {
      throw new Error('ACP session startup was superseded.')
    }
  }

  private releasePrimarySessionIdentityReservation(
    reservation: AcpPrimarySessionIdentityReservation
  ): void {
    reservation.release()
  }

  private disposeSessionAfterFailure(session: ActiveSession, logMessage: string): void {
    try {
      session.dispose()
    } catch (cleanupError) {
      safeLogError(logMessage, {
        ...diagnosticErrorFields(cleanupError),
        sessionId: session.sessionId
      })
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
export type { ReviewerSessionDisposition } from './reviewer-session-owner'
