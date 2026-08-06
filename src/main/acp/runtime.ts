import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection, PromptResponse } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
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
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import { type SessionPermissionProfileState } from '../../shared/permission-profiles'
import { type AgentFrameworkId } from '../../shared/settings'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import {
  claudeCodeFramework,
  type AgentFramework,
  type AgentModelChangeTarget,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { ConversationPermissionGrantStore } from './permission-broker'
import { AcpPermissionContext, HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
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
import { ContextUsageTracker } from './context-usage-tracker'
import { AcpContextUsagePolicy } from './context-usage-policy'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import type { UploadRepository } from '../uploads/repository'
import { DEFAULT_UPLOAD_PROJECT_NAME, type UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, FileReference } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import {
  ReviewerSessionOwner,
  type ReviewerSessionDisposition,
  type ReviewerSessionRequest,
  type ReviewerSessionResult
} from './reviewer-session-owner'
import {
  AcpSessionCapabilityOwner,
  CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY
} from './session-capability-owner'
import { ArtifactTurnOwner, type ArtifactTurnHandle } from './artifact-turn-owner'
import { AcpPromptContentOwner } from './prompt-content-owner'
import {
  AcpSessionInteractionOwner,
  type AcpPromptSessionInteractionScope
} from './session-interaction-owner'
import {
  AcpSessionRegistry,
  type AcpPrimarySessionIdentityReservation,
  type AcpPrimarySessionIdentityReservationResult
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
import { AcpSessionUpdateProjector } from './session-update-projector'
import { AcpConnectionLifecycleWorkflow } from './connection-lifecycle-workflow'
import { AcpConnectionCloseWorkflow, type CloseState } from './connection-close-workflow'
import { AcpModelChangeWorkflow } from './model-change-workflow'
import { AcpProviderSessionCreator } from './provider-session-creator'
import { AcpProviderSessionAdopter } from './provider-session-adopter'
import { AcpProviderSessionResumer } from './provider-session-resumer'
import { AcpSessionReplacementWorkflow } from './session-replacement-workflow'
import { AcpSessionDeletionWorkflow } from './session-deletion-workflow'
import { AcpPromptPreparationOwner } from './prompt-preparation-owner'
import { AcpPromptTurnWorkflow, type AcpPromptTurnPlanContext } from './prompt-turn-workflow'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
import { AcpProviderPromptExecutor } from './provider-prompt-executor'
import { AcpPromptOutcomeFinalizer } from './prompt-outcome-finalizer'
import { AcpTurnSkillOwner, type AcpTurnSkillHooks } from './turn-skill-owner'
import { createProductionPlanService } from '../session-plan/production-plan-service'
import { SessionPlanInteractionOwner } from '../session-plan/session-plan-interaction-owner'
import { SESSION_PLAN_SYSTEM_PROMPT_APPEND } from '../session-plan/guidance'
import type { PlanResponseResult, PlanService } from '../session-plan/plan-service'
import type {
  ActivePlanProjection,
  GeneratePlanContent,
  PlanResponseCommand
} from '../../shared/session-plan/contract'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { SessionPlanStepStatus } from '../../shared/session-persistence'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'

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
  plan?: AcpRuntimePlanOptions
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
  >
}
// An end_turn is final from the runtime's perspective, so promised work must be a tool call in the
// current turn or an explicit request for user input rather than text that implies later execution.
const TURN_CONTINUITY_SYSTEM_PROMPT_APPEND = [
  '<open_science_turn_continuity_instructions>',
  'Do not describe a tool-backed action as future work and then end the turn. If you say you will download, install, run, edit, analyze, or otherwise perform an action that needs a tool, issue the corresponding tool call in this same turn.',
  'If a required tool cannot be used or its operation fails, do not promise another attempt. Clearly state that the turn has stopped, what prevented progress, and what the user can do next.',
  '</open_science_turn_continuity_instructions>'
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

// ACP Session facade. Connection publication and physical teardown live behind their epoch owner;
// Runtime retains protocol startup, Session/Permission/Notebook cleanup, and status/event projection.
class AcpRuntime {
  private readonly snapshotOwner: AcpRuntimeSnapshotOwner
  private readonly contextUsageTracker: ContextUsageTracker
  private readonly contextUsagePolicy: AcpContextUsagePolicy
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
  private readonly sessionUpdateProjector: AcpSessionUpdateProjector
  private readonly providerPromptExecutor: AcpProviderPromptExecutor
  // Injectable lifecycle timers (defaults to real setTimeout/clearTimeout).
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly artifactRepository: ArtifactRepository | undefined
  private readonly artifactRunRegistry: ArtifactRunRegistry | undefined
  private readonly artifactTurns: ArtifactTurnOwner | undefined
  private readonly planInteractions = new SessionPlanInteractionOwner()
  private readonly planService: PlanService | undefined
  private readonly planSessions: AcpRuntimePlanOptions['sessions'] | undefined
  private readonly promptContentOwner: AcpPromptContentOwner
  private readonly promptPreparation: AcpPromptPreparationOwner
  private readonly contextCompactionWorkflow: AcpContextCompactionWorkflow
  private readonly promptTurnWorkflow: AcpPromptTurnWorkflow
  private readonly connectionClose: AcpConnectionCloseWorkflow
  private readonly connectionLifecycle: AcpConnectionLifecycleWorkflow
  private readonly modelChanges: AcpModelChangeWorkflow
  private readonly providerSessionCreator: AcpProviderSessionCreator
  private readonly providerSessionAdopter: AcpProviderSessionAdopter
  private readonly providerSessionResumer: AcpProviderSessionResumer
  private readonly sessionReplacement: AcpSessionReplacementWorkflow
  private readonly sessionDeletion: AcpSessionDeletionWorkflow

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
    this.providerPromptExecutor = new AcpProviderPromptExecutor({
      backendGeneration: this.backendGeneration,
      opencodeUsageFetch: options.opencodeUsageFetch
    })
    this.sessionConfigurator = new AcpSessionConfigurator({
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      diagnosticContext: (backend) => this.diagnosticContext(backend.framework.id)
    })
    this.contextUsageTracker = options.contextUsageTracker ?? new ContextUsageTracker()
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.sessionInteractions = new AcpSessionInteractionOwner({
      cancelTimeoutMs: options.cancelTimeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
    this.artifactOptions = options.artifacts
    this.sessionCapabilities = new AcpSessionCapabilityOwner({
      artifacts: options.artifacts,
      notebook: options.notebook,
      skillImport: options.skillImport,
      plan: options.plan,
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
    this.planSessions = options.plan?.sessions
    this.planService =
      options.plan && this.artifactTurns && options.artifacts?.provenance?.resolveVersionContent
        ? createProductionPlanService({
            interactions: this.planInteractions,
            artifactTurns: this.artifactTurns,
            provenance: {
              resolveVersionContent: (request) =>
                options.artifacts!.provenance!.resolveVersionContent!(request)
            },
            sessions: options.plan.sessions
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
    this.promptPreparation = new AcpPromptPreparationOwner({
      promptContent: this.promptContentOwner,
      presentation: new AcpSessionPresentationPolicy(),
      contextUsage: this.contextUsageTracker,
      selectBridgeSkills: async (text, catalog, signal) =>
        (await this.connectionResources.selectBridgeSkills(text, catalog, signal)) ?? [],
      authorizeReferencedUploads: options.skillImport?.authorizeReferencedUploads,
      ...(options.notebook
        ? {
            notebook: {
              peekHandoffContext: options.notebook.peekHandoffContext,
              registerTurnInputs: options.notebook.registerTurnInputs
            }
          }
        : {}),
      emitState: () => this.emitState()
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
    this.contextUsagePolicy = new AcpContextUsagePolicy({
      backend: () => this.backend,
      appliedModel: (sessionId) =>
        this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().appliedModel,
      systemPromptAppends: () => this.getSystemPromptAppends(),
      tooling: () => this.currentCapabilityAvailability()
    })
    this.sessionUpdateProjector = new AcpSessionUpdateProjector({
      registry: this.sessionRegistry,
      contextUsage: this.contextUsageTracker,
      contextPolicy: this.contextUsagePolicy,
      hasActiveSession: (sessionId) => this.activeSessionFor(sessionId) !== undefined,
      currentFramework: () => this.framework.id,
      reconnectPending: () => this.pendingProviderReconnect,
      mcpServerNamesFor: (sessionId) => this.sessionCapabilities.mcpServerNamesFor(sessionId),
      nextEventId: () => this.nextEventId(),
      emitState: () => this.emitState(),
      pushEvent: (event) => this.pushEvent(event),
      reportToolFailure: (effect) =>
        log.warn('tool call failed', {
          tool: effect.tool,
          toolCallId: effect.toolCallId,
          sessionId: effect.sessionId,
          reason: effect.reason
        })
    })
    this.permissionContext = new AcpPermissionContext({
      emitPermissionRequest: (request) => {
        this.pushEvent({
          kind: 'permission',
          level: 'warning',
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          title: 'Permission requested',
          text: request.title,
          raw: request
        })
        this.callbacks.onPermissionRequest?.(request)
        this.emitState()
      },
      routing: {
        resolveAppSessionId: (sessionId) => this.sessionRegistry.resolveAppSessionId(sessionId),
        sessionSnapshot: (sessionId) => {
          const snapshot = this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot()
          return snapshot
            ? {
                cwd: snapshot.cwd,
                frameworkId: snapshot.frameworkId,
                permissionProfile: snapshot.permissionProfile
              }
            : undefined
        },
        hasActivePrimarySession: (sessionId) => this.activeSessionFor(sessionId) !== undefined,
        capturePrompt: (sessionId) => {
          const scope = this.currentPromptInteraction(sessionId)
          return scope
            ? {
                sequence: scope.sequence,
                isCancellationAccepted: () => this.sessionInteractions.isCancellationAccepted(scope)
              }
            : undefined
        },
        currentInteractionSequence: (sessionId) =>
          this.sessionInteractions.current(sessionId)?.sequence,
        mcpServerNamesFor: (sessionId) => this.sessionCapabilities.mcpServerNamesFor(sessionId),
        reviewerContextFor: (sessionId) => this.reviewerSessions.contextFor(sessionId),
        resolveReviewerPermission: (request) => this.reviewerSessions.resolvePermission(request),
        currentFramework: () => this.framework,
        resolveProjectId: (sessionId) => this.resolveSessionProjectName(sessionId)
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
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      clearPermissionCorrelations: (sessionId) =>
        this.permissionContext.clearCorrelationsForSession(sessionId),
      currentSessionSetup: () => ({
        framework: this.framework,
        sessionOptions: this.backend.session.options
      }),
      currentStartupGeneration: () => this.sessionRegistry.startupGeneration,
      ensureConnected: (cwd) => this.ensureConnected(cwd),
      isPrimarySessionIdClaimed: (sessionId) => this.sessionRegistry.isIdentityClaimed(sessionId),
      onActiveSessionReleased: () => this.generationActivityChanged(),
      registerBridgeSession: (sessionId) =>
        this.connectionResources.registerBridgeReviewerSession(sessionId),
      removeStartupBlocker: (token) => this.generationActivity.releaseStartup(token),
      unregisterBridgeSession: (sessionId) =>
        this.connectionResources.unregisterBridgeReviewerSession(sessionId)
    })
    this.contextCompactionWorkflow = new AcpContextCompactionWorkflow({
      sessions: {
        activeSession: (sessionId) => this.activeSessionFor(sessionId),
        currentFramework: () => this.framework
      },
      interactions: this.sessionInteractions,
      context: this.contextUsageTracker,
      promptContent: this.promptContentOwner,
      contextEstimateInput: (sessionId) => this.contextUsagePolicy.resolve(sessionId).estimateInput,
      selectedContextWindow: (sessionId) =>
        this.contextUsagePolicy.resolve(sessionId).selectedWindow,
      routeHiddenNotification: (notification, sessionId) =>
        this.sessionUpdateProjector.route(notification, {
          appSessionId: sessionId,
          visible: false,
          emitState: () => {
            try {
              this.emitState()
            } catch (error) {
              safeLogError('compaction state callback failed', errorLogFields(error))
            }
          }
        }),
      pushEvent: (event) => this.pushEvent(event),
      emitState: () => this.emitState(),
      errorMessage
    })
    this.promptTurnWorkflow = new AcpPromptTurnWorkflow({
      registry: this.sessionRegistry,
      interactions: this.sessionInteractions,
      skills: this.turnSkills,
      preparation: this.promptPreparation,
      executor: this.providerPromptExecutor,
      contextUsage: this.contextUsageTracker,
      providerReconnectPending: () => this.pendingProviderReconnect,
      finalizer: new AcpPromptOutcomeFinalizer(),
      permission: this.permissionContext,
      environment: {
        backend: () => this.backend,
        tooling: () => this.currentCapabilityAvailability(),
        bridgeSkillsAvailable: () => this.connectionResources.bridgeSkillsAvailable,
        skillImportEnabled: () => this.sessionCapabilities.isSkillImportEnabled(),
        contextEstimateInput: (sessionId) =>
          this.contextUsagePolicy.resolve(sessionId).estimateInput,
        selectedContextWindow: (sessionId) =>
          this.contextUsagePolicy.resolve(sessionId).selectedWindow,
        emitSkillActivities: (sessionId, turn, inputs, status) =>
          this.emitCodexSkillInputActivities(sessionId, turn, inputs, status),
        onSkillImportAttachmentEligible: this.callbacks.onSkillImportAttachmentEligible,
        onProviderPromptAccepted: this.callbacks.onProviderPromptAccepted,
        routeNotification: (notification, sessionId) =>
          this.sessionUpdateProjector.route(notification, { appSessionId: sessionId }),
        diagnosticContext: () => this.diagnosticContext(),
        pushUserMessage: ({ sessionId, promptMessageId, text }) =>
          this.pushEvent({
            kind: 'message',
            level: 'info',
            sessionId,
            ...(promptMessageId ? { promptMessageId } : {}),
            role: 'user',
            text
          })
      },
      artifacts: {
        open: (sessionId, provenance) => this.activateArtifactRun(sessionId, provenance),
        promptMessageIdFor: (sessionId) => this.artifactTurns?.promptMessageIdFor(sessionId),
        publish: (sessionId, artifact, onPublished) =>
          this.emitArtifactRunEvent(sessionId, artifact, onPublished),
        dispose: (artifact) => this.clearArtifactRun(artifact)
      },
      planLifecycle: {
        beforeStop: (sessionId, interaction, response) =>
          this.checkPromptPlanCompletion(sessionId, interaction, response),
        beforeRelease: (sessionId, interaction) =>
          this.releasePromptPlanBinding(sessionId, interaction),
        afterRelease: (sessionId) => this.publishTerminalPlanProjection(sessionId)
      },
      finalization: {
        errorMessage,
        errorKind: acpErrorKind,
        pushEvent: (event) => this.pushEvent(event),
        onPromptEnded: (sessionId, turnToken) =>
          this.callbacks.onPromptEnded?.(sessionId, turnToken),
        generationActivityChanged: () => this.generationActivityChanged(),
        autoCompact: (sessionId, session, interaction) =>
          this.contextCompactionWorkflow.compactAutomatic({ sessionId, session, interaction })
      },
      currentCwd: () => this.snapshotOwner.cwd,
      resolveProjectName: (sessionId) => this.resolveSessionProjectName(sessionId),
      preflightPlan: (request) => this.preflightPromptPlan(request),
      admitPlan: (request, interaction, plan) => this.admitPromptPlan(request, interaction, plan),
      disconnectForReload: () => this.disconnect(false),
      resumeAfterReload: (request) => this.resumeSession(request),
      recordAdmittedPrompt: (request) => this.handoffContinuity.recordAdmittedPrompt(request),
      onPromptStarted: (sessionId, turnToken, promptAttemptId) =>
        this.callbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId),
      emitState: () => this.emitState()
    })
    const closeState: CloseState = {
      invalidatePendingSessionStartups: () => this.invalidatePendingSessionStartups(),
      disposePermissionContext: () => this.permissionContext.dispose(),
      clearReviewerState: () => this.reviewerSessions.clear(),
      clearPlanInteractions: () =>
        this.planInteractions.clearAll('The Session Plan interaction was disconnected.'),
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
      backendGeneration: this.backendGeneration,
      connectionResources: this.connectionResources,
      registry: this.sessionRegistry,
      configurator: this.sessionConfigurator,
      contextUsage: this.contextUsageTracker,
      currentStatus: () => this.snapshotOwner.status,
      providerReconnectPending: () => this.pendingProviderReconnect,
      isGenerationBusy: () => this.generationActivity.blockers().retirement,
      contextEstimateInput: (sessionId) => this.contextUsagePolicy.resolve(sessionId).estimateInput,
      emitState: () => this.emitState(),
      // Model-change fallback already owns its drain. Calling the close workflow here would ask the
      // same drain to await itself, so arm the authoritative transition directly.
      requestReconnect: () => this.connectionTransitions.requestProviderReconnect(),
      recoverFailedReconnect: () => this.connectionClose.recoverFailedDeferredDisconnect(),
      reportReconnectFailure: (error) =>
        safeLogError('model-change reconnect failed', errorLogFields(error)),
      diagnosticContext: () => this.diagnosticContext()
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
    this.sessionReplacement = new AcpSessionReplacementWorkflow({
      defaultCwd: options.defaultCwd,
      defaultProjectName: options.artifacts?.projectName || DEFAULT_UPLOAD_PROJECT_NAME,
      currentCwd: () => this.snapshotOwner.cwd,
      currentFrameworkId: () => this.framework.id,
      ensureConnected: (cwd) => this.ensureConnected(cwd),
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      registry: this.sessionRegistry,
      reserveIdentity: (sessionId, publishedAppSessionId) =>
        this.reservePrimarySessionIds(undefined, [sessionId], publishedAppSessionId),
      adopter: this.providerSessionAdopter,
      permission: this.permissionContext,
      promptContent: this.promptContentOwner,
      contextUsage: this.contextUsageTracker,
      interactions: this.sessionInteractions,
      resolveSpecialistIdentity: options.resolveSpecialistIdentity,
      registerSessionSpecialist: options.notebook?.registerSessionSpecialist
    })
    this.sessionDeletion = new AcpSessionDeletionWorkflow({
      registry: this.sessionRegistry,
      withOperation: (work) => this.withOperationLease(work),
      currentConnection: () => this.connection,
      supportsSessionDelete: () => this.connectionResources.capabilities.delete,
      supportsSessionClose: () => this.connectionResources.capabilities.close,
      permission: this.permissionContext,
      interactions: this.sessionInteractions,
      capabilities: this.sessionCapabilities,
      promptContent: this.promptContentOwner,
      handoff: this.handoffContinuity,
      contextUsage: this.contextUsageTracker,
      projector: this.sessionUpdateProjector,
      pushEvent: (event) => this.pushEvent(event),
      emitState: () => this.emitState(),
      getSnapshot: () => this.getSnapshot()
    })
    this.providerSessionResumer = new AcpProviderSessionResumer({
      defaultCwd: options.defaultCwd,
      defaultProjectName: options.artifacts?.projectName || DEFAULT_UPLOAD_PROJECT_NAME,
      currentCwd: () => this.snapshotOwner.cwd,
      currentConnection: () => this.connection,
      ensureConnected: (cwd) => this.ensureConnected(cwd),
      assertCurrentConnection: (connection) => this.assertCurrentConnectedConnection(connection),
      disconnectTimedOutConnection: async () => {
        await this.disconnect(false)
      },
      resumeCapabilityAdvertised: () => this.connectionResources.capabilities.resume,
      currentBackend: () => this.backend,
      registry: this.sessionRegistry,
      reserveIdentity: (sessionId) => this.reservePrimarySessionIds(undefined, [sessionId]),
      capabilities: this.sessionCapabilities,
      configurator: this.sessionConfigurator,
      adopter: this.providerSessionAdopter,
      resolveSpecialistSkills: options.resolveSpecialistSkills,
      updateCwd: (cwd) => this.snapshotOwner.updateCwd(cwd),
      pushEvent: (event) => this.pushEvent(event),
      emitState: () => this.emitState(),
      resumeTimeoutMs: options.resumeTimeoutMs ?? 30_000,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      diagnosticContext: () => this.diagnosticContext()
    })
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

  async callSessionPlan(input: {
    projectId: string
    sessionId: string
    operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus'
    input?: unknown
  }): Promise<unknown> {
    const service = this.planService
    if (!service) throw new Error('Session Plan capability is not configured.')
    if (input.operation === 'generate') {
      const interactionId = this.artifactTurns?.promptMessageIdFor(input.sessionId)
      if (!interactionId) throw new Error('No active interaction can generate a Session Plan.')
      this.planInteractions.reserveApproval(input.sessionId, interactionId)
      let result: Awaited<ReturnType<PlanService['generate']>>
      try {
        result = await service.generate({
          projectId: input.projectId,
          sessionId: input.sessionId,
          interactionId,
          content: input.input as GeneratePlanContent
        })
      } catch (error) {
        this.planInteractions.releaseApprovalReservation(input.sessionId, interactionId)
        const current = await service.getProjection(input.projectId, input.sessionId)
        if (current) this.publishPlanProjection(input.sessionId, current)
        throw error
      }
      let approval: Promise<unknown>
      try {
        approval = this.planInteractions.parkReservedApproval(input.sessionId, interactionId)
      } catch (error) {
        this.planInteractions.release(input.sessionId, result.projection.artifactVersionId)
        throw error
      }
      this.publishPlanProjection(input.sessionId, result.projection)
      return approval
    }
    const projection = await service.getProjection(input.projectId, input.sessionId, {
      interactionIsLive: this.sessionInteractions.current(input.sessionId) !== undefined
    })
    if (!projection) throw new Error('The Session has no active Plan.')
    await this.assertPlanVisibleToDurableBranch(input.projectId, input.sessionId, projection)
    const identity = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      artifactVersionId: projection.artifactVersionId,
      expectedRevision: projection.revision
    }
    if (input.operation === 'approve' || input.operation === 'reject') {
      const interactionIsLive = this.sessionInteractions.current(input.sessionId) !== undefined
      const decision = input.operation === 'approve' ? 'approved' : 'rejected'
      const executionBinding = this.planInteractions.executionBindingFor(input.sessionId)
      const result = await service.respond({
        ...identity,
        decision,
        interactionIsLive
      })
      if (decision === 'approved') {
        this.bindPlanExecutionToCurrentInteraction(
          input.sessionId,
          result.projection.artifactVersionId
        )
      } else {
        if (executionBinding) {
          this.planInteractions.releaseExecution(
            input.sessionId,
            executionBinding.interactionSequence
          )
        }
      }
      this.planInteractions.resolveApproval(input.sessionId, result)
      this.publishPlanProjection(input.sessionId, result.projection)
      return result
    }
    const update = input.input as {
      title: string
      status: SessionPlanStepStatus
      notes?: string
      expectedArtifactVersionId?: string
    }
    if (projection.approval !== 'approved') {
      throw new PlanCommandError(
        'plan-not-approved',
        'The Plan is still pending. Interpret the user Message, then call generate_plan with decision:"approved" or decision:"rejected" before updating steps.'
      )
    }
    const interaction = this.sessionInteractions.current(input.sessionId)
    const binding = this.planInteractions.executionBindingFor(input.sessionId)
    if (!binding) {
      throw new PlanCommandError(
        'continuation-required',
        'Continuing this Plan requires an explicit user continuation.'
      )
    }
    if (!interaction || binding.interactionSequence !== interaction.sequence) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is not authorized to execute the active Plan.'
      )
    }
    if (
      binding.artifactVersionId !== projection.artifactVersionId ||
      (update.expectedArtifactVersionId !== undefined &&
        update.expectedArtifactVersionId !== binding.artifactVersionId)
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'This interaction is bound to a different Plan Artifact Version.'
      )
    }
    const result = await service.updateStepStatus({
      ...identity,
      artifactVersionId: update.expectedArtifactVersionId ?? identity.artifactVersionId,
      title: update.title,
      status: update.status,
      ...(update.notes ? { notes: update.notes } : {})
    })
    this.publishPlanProjection(input.sessionId, result.projection)
    return result
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): Promise<ActivePlanProjection | null> {
    return (
      this.planService?.getProjection(projectId, sessionId, {
        interactionIsLive: this.sessionInteractions.current(sessionId) !== undefined
      }) ?? Promise.resolve(null)
    )
  }

  async respondSessionPlan(input: PlanResponseCommand): Promise<PlanResponseResult> {
    if (!this.planService) throw new Error('Session Plan capability is not configured.')
    if (
      input.decision === undefined &&
      !this.planInteractions.approvalInteractionIdFor(input.sessionId)
    ) {
      throw new Error('The paused Session Plan interaction is no longer available.')
    }
    const interactionIsLive =
      this.planInteractions.approvalInteractionIdFor(input.sessionId) !== undefined
    const projection = await this.planService.getProjection(input.projectId, input.sessionId, {
      interactionIsLive
    })
    if (!projection) throw new Error('The Session has no active Plan.')
    await this.assertPlanVisibleToDurableBranch(input.projectId, input.sessionId, projection)
    const result = await this.planService.respond({ ...input, interactionIsLive })
    if ('projection' in result) {
      if (interactionIsLive && result.projection.approval === 'approved') {
        this.bindPlanExecutionToCurrentInteraction(
          input.sessionId,
          result.projection.artifactVersionId
        )
      }
      if (interactionIsLive) this.planInteractions.resolveApproval(input.sessionId, result)
      this.publishPlanProjection(input.sessionId, result.projection)
      return result
    }
    if (
      this.planInteractions.approvalInteractionIdFor(input.sessionId) !==
      result.routeToInteractionId
    ) {
      throw new Error('The paused Session Plan interaction is no longer available.')
    }
    try {
      this.pushEvent({
        id: `session-user-message-${result.message.id}`,
        timestamp: result.message.createdAt,
        kind: 'message',
        level: 'info',
        sessionId: input.sessionId,
        promptMessageId: result.message.responseToMessageId,
        messageId: result.message.id,
        role: 'user',
        text: result.message.content
      })
    } catch (error) {
      safeLogError('Routed user Message projection callback failed', errorLogFields(error))
    }
    this.planInteractions.resolveApproval(input.sessionId, result)
    return result
  }

  private publishPlanProjection(
    sessionId: string,
    projection: import('../../shared/session-plan/contract').ActivePlanProjection
  ): void {
    try {
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
      safeLogError('Session Plan projection callback failed', errorLogFields(error))
    }
  }

  private async publishTerminalPlanProjection(sessionId: string): Promise<void> {
    if (!this.planService) return
    try {
      const projection = await this.planService.getProjection(
        this.resolveSessionProjectName(sessionId),
        sessionId,
        { interactionIsLive: false }
      )
      if (projection) this.publishPlanProjection(sessionId, projection)
    } catch (error) {
      safeLogError('Session Plan terminal projection failed', errorLogFields(error))
    }
  }

  private bindPlanExecutionToCurrentInteraction(
    sessionId: string,
    artifactVersionId: string
  ): void {
    const interaction = this.sessionInteractions.current(sessionId)
    if (!interaction || interaction.kind !== 'prompt') return
    this.planInteractions.bindExecution({
      sessionId,
      interactionSequence: interaction.sequence,
      artifactVersionId
    })
  }

  private async assertPlanVisibleToDurableBranch(
    projectId: string,
    sessionId: string,
    projection: ActivePlanProjection
  ): Promise<void> {
    const origin = projection.originatingPromptMessageId
    if (
      !origin ||
      !this.planSessions ||
      !(await this.planSessions.containsMessageOnActiveBranch(projectId, sessionId, origin))
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The active Session Plan does not belong to the durable active Message Branch.'
      )
    }
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
    return this.withOperationLease(() => this.providerSessionResumer.resume(request))
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
      requestPermission: (params) => this.permissionContext.handleProviderRequest(params),
      observeSessionUpdate: (notification) =>
        this.permissionContext.observeProviderUpdate(notification),
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

  private preflightPromptPlan(
    request: AcpPromptRequest
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> {
    if (
      request.planContinuation &&
      request.planContinuation.projectId !== this.resolveSessionProjectName(request.sessionId)
    ) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The Plan continuation belongs to a different Project.'
      )
    }
    if (request.planContinuation && !this.planService) {
      throw new Error('Session Plan capability is not configured.')
    }
    const continuation = request.planContinuation
    if (continuation?.pendingAction === undefined && continuation) {
      return this.planService!.authorizeContinuation({
        projectId: continuation.projectId,
        sessionId: request.sessionId,
        artifactVersionId: continuation.artifactVersionId,
        expectedRevision: continuation.expectedRevision
      }).then(async (authorized) => {
        await this.assertPlanVisibleToDurableBranch(
          continuation.projectId,
          request.sessionId,
          authorized
        )
        return Object.freeze({ authorized })
      })
    }
    if (!continuation) return Object.freeze({})
    return this.planService!.getProjection(continuation.projectId, request.sessionId, {
      interactionIsLive: false
    }).then(async (protectedPending) => {
      if (!protectedPending) {
        throw new PlanCommandError('no-active-plan', 'The Session has no active Plan.')
      }
      if (protectedPending.artifactVersionId !== continuation.artifactVersionId) {
        throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
      }
      if (protectedPending.revision !== continuation.expectedRevision) {
        throw new PlanCommandError('revision-conflict', 'The Plan revision is stale.')
      }
      if (protectedPending.approval !== 'pending') {
        throw new PlanCommandError('approval-already-decided', 'Plan approval is irreversible.')
      }
      await this.assertPlanVisibleToDurableBranch(
        continuation.projectId,
        request.sessionId,
        protectedPending
      )
      return Object.freeze({ protectedPending })
    })
  }

  private admitPromptPlan(
    request: AcpPromptRequest,
    interaction: AcpPromptSessionInteractionScope,
    plan: AcpPromptTurnPlanContext
  ): AcpPromptTurnPlanContext | Promise<AcpPromptTurnPlanContext> {
    let { authorized, protectedPending } = plan
    const continuation = request.planContinuation
    const decision = continuation?.pendingAction
    const committed = (): AcpPromptTurnPlanContext => {
      if (authorized) {
        this.planInteractions.bindExecution({
          sessionId: request.sessionId,
          interactionSequence: interaction.sequence,
          artifactVersionId: authorized.artifactVersionId
        })
      }
      return Object.freeze({
        ...(authorized ? { authorized } : {}),
        ...(protectedPending ? { protectedPending } : {})
      })
    }
    if (continuation && (decision === 'approve' || decision === 'reject')) {
      const executionBinding = this.planInteractions.executionBindingFor(request.sessionId)
      return this.planService!.respond({
        projectId: continuation.projectId,
        sessionId: request.sessionId,
        artifactVersionId: continuation.artifactVersionId,
        expectedRevision: continuation.expectedRevision,
        decision: decision === 'approve' ? 'approved' : 'rejected',
        interactionIsLive: true
      }).then((result) => {
        if (decision === 'approve') authorized = result.projection
        else {
          protectedPending = result.projection
          if (executionBinding) {
            this.planInteractions.releaseExecution(
              request.sessionId,
              executionBinding.interactionSequence
            )
          }
        }
        this.planInteractions.resolveApproval(request.sessionId, result)
        this.publishPlanProjection(request.sessionId, result.projection)
        return committed()
      })
    }
    return committed()
  }

  private async checkPromptPlanCompletion(
    sessionId: string,
    interaction: AcpPromptSessionInteractionScope,
    response: PromptResponse
  ): Promise<void> {
    const binding = this.planInteractions.executionBindingFor(sessionId)
    if (
      response.stopReason !== 'end_turn' ||
      !this.planService ||
      binding?.interactionSequence !== interaction.sequence
    ) {
      return
    }
    const completion = await this.planService.checkTurnCompletion({
      projectId: this.resolveSessionProjectName(sessionId),
      sessionId
    })
    if (!completion.allow) {
      throw new Error(
        `The active Session Plan is not complete (${completion.lifecycle ?? 'incomplete'}).`
      )
    }
  }

  private releasePromptPlanBinding(
    sessionId: string,
    interaction: AcpPromptSessionInteractionScope
  ): void {
    this.planInteractions.releaseExecution(sessionId, interaction.sequence)
    if (interaction.promptMessageId) {
      this.rejectPlanApprovalForInteraction(
        sessionId,
        interaction.promptMessageId,
        'The Session Plan interaction ended before approval.'
      )
    }
  }

  private rejectPlanApprovalForInteraction(
    sessionId: string,
    interactionId: string,
    reason: string
  ): void {
    this.planInteractions.releaseApprovalReservation(sessionId, interactionId)
    if (this.planInteractions.approvalInteractionIdFor(sessionId) !== interactionId) return
    this.planInteractions.rejectApproval(sessionId, reason)
  }

  // Sends one prompt turn to the targeted session and streams updates until stop.
  async sendPrompt(request: AcpPromptRequest, promptAttemptId?: string): Promise<PromptResponse> {
    return this.withOperationLease(() =>
      withDataRootWrite(() =>
        this.promptTurnWorkflow.run(request, {
          kind: 'user',
          ...(promptAttemptId === undefined ? {} : { promptAttemptId })
        })
      )
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
      withDataRootWrite(() =>
        this.promptTurnWorkflow.run(request, {
          kind: 'app-continuation',
          ...(promptAttemptId === undefined ? {} : { promptAttemptId })
        })
      )
    )
  }

  // Requests cancellation without clearing in-flight state before the agent stops.
  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    const connection = this.connection
    const activeSession = this.activeSessionFor(request.sessionId)
    const planInteractionId =
      this.currentPromptInteraction(request.sessionId)?.promptMessageId ??
      this.planInteractions.approvalInteractionIdFor(request.sessionId)

    if (connection && activeSession) {
      await this.sessionInteractions.cancelPrompt({
        sessionId: request.sessionId,
        notify: () =>
          connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: activeSession.sessionId
          }),
        onAccepted: () => {
          if (planInteractionId) {
            this.rejectPlanApprovalForInteraction(
              request.sessionId,
              planInteractionId,
              'The Session Plan interaction was cancelled.'
            )
          }
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
    this.planInteractions.clearSession(
      request.sessionId,
      'The Session Plan interaction was deleted.'
    )
    return this.sessionDeletion.delete(request.sessionId)
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

  // Lazily initializes the process connection before session creation.
  private async ensureConnected(cwd: string): Promise<ClientConnection> {
    return this.connectionLifecycle.ensureConnected(cwd)
  }

  private observeClaudeSdkMessage(params: Record<string, unknown>): void {
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
      ...(this.skillImportToolingAvailable() ? [SKILL_IMPORT_SYSTEM_PROMPT_APPEND] : []),
      ...(this.planService ? [SESSION_PLAN_SYSTEM_PROMPT_APPEND] : [])
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

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectName(sessionId: string): string {
    return (
      this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectName ??
      this.artifactOptions?.projectName ??
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
    artifactRun: ArtifactTurnHandle | undefined,
    onPublished?: () => void
  ): Promise<void> {
    if (!artifactRun || !this.artifactTurns) return
    const publication = await this.artifactTurns.finalize(artifactRun)
    if (!publication) return

    this.pushEvent(
      {
        kind: 'artifact',
        level: 'info',
        sessionId,
        title: 'Generated files',
        runId: publication.runId,
        promptMessageId: publication.promptMessageId,
        artifactSessionId: publication.artifactStorageSessionId,
        artifactClaimId: publication.artifactClaimId,
        artifacts: publication.artifacts
      },
      onPublished
    )
  }

  private cancelPermissionFlowForSession(sessionId: string): void {
    this.permissionContext.cancelForSession(sessionId)
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
    event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>,
    onAppended?: () => void
  ): void {
    const currentPromptMessageId = event.sessionId
      ? this.currentPromptInteraction(event.sessionId)?.promptMessageId
      : undefined
    const scopedEvent =
      currentPromptMessageId && !event.promptMessageId
        ? { ...event, promptMessageId: currentPromptMessageId }
        : event
    const runtimeEvent = this.snapshotOwner.appendEvent(scopedEvent)
    onAppended?.()
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
    return this.withOperationLease(() => this.reviewerSessions.create(request))
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
export type { ReviewerSessionDisposition } from './reviewer-session-owner'
