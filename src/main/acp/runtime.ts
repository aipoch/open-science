import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, ClientConnection, PromptResponse } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

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
import { type AgentFrameworkId } from '../../shared/settings'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import {
  type AgentFramework,
  type AgentModelChangeTarget,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import type { AcpRuntimeSnapshotOwner } from './runtime-snapshot-owner'
import { ConversationPermissionGrantStore } from './permission-broker'
import { HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import type { AcpPermissionContext } from './permission-context'
import { AgentMcpHttpHost } from './mcp-http-host'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import type { NotebookRpcConnection } from '../notebook/mcp-server'
import type { NotebookHandoffContext } from '../notebook/runtime-service'
import type { SkillImportRpcConnection } from '../skills/mcp-server'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { withDataRootWrite } from '../storage/migration-state'
import { opencodeStorageDir } from '../agent-framework/opencode'
import type { UploadRepository } from '../uploads/repository'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ArtifactFile, FileReference } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import type { ContextUsageTracker } from './context-usage-tracker'
import type {
  ReviewerSessionOwner,
  ReviewerSessionDisposition,
  ReviewerSessionRequest,
  ReviewerSessionResult
} from './reviewer-session-owner'
import type { ArtifactTurnOwner } from './artifact-turn-owner'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
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
import type { AcpPromptTurnWorkflow } from './prompt-turn-workflow'
import type { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import type { AcpProviderPromptExecutor } from './provider-prompt-executor'
import type { AcpTurnSkillHooks, AcpTurnSkillOwner } from './turn-skill-owner'
import type { PlanResponseResult } from '../session-plan/plan-service'
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
  // Ephemeral Reviewer identity, isolation, permission, and resource state lives behind one owner.
  private readonly reviewerSessions: ReviewerSessionOwner
  private readonly turnSkills: AcpTurnSkillOwner
  private readonly handoffContinuity: AcpHandoffContinuityOwner
  private readonly permissionContext: AcpPermissionContext
  private readonly publication: AcpRuntimePublicationOwner
  private readonly sessionEnvironment: AcpSessionEnvironmentPolicy
  private readonly spawnAgent: (() => ChildProcessWithoutNullStreams) | undefined
  private readonly backendGeneration: AcpBackendGenerationOwner
  private readonly sessionConfigurator: AcpSessionConfigurator
  private readonly sessionUpdateProjector: AcpSessionUpdateProjector
  private readonly providerPromptExecutor: AcpProviderPromptExecutor
  private readonly artifactOptions: AcpRuntimeArtifactOptions | undefined
  private readonly artifactTurns: ArtifactTurnOwner | undefined
  private readonly sessionPlanWorkflow: AcpRuntimePlanWorkflow
  private readonly contextCompactionWorkflow: AcpContextCompactionWorkflow
  private readonly promptTurnWorkflow: AcpPromptTurnWorkflow
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
    this.sessionRegistry = session.sessionRegistry
    this.sessionEnvironment = session.sessionEnvironment
    this.publication = session.publication
    this.permissionContext = session.permissionContext
    this.reviewerSessions = session.reviewerSessions
    this.sessionUpdateProjector = session.sessionUpdateProjector
    this.sessionPlanWorkflow = composeAcpRuntimePlanWorkflow(options, base, session)
    const prompt = composeAcpRuntimePromptOwners(options, base, session, {
      plan: this.sessionPlanWorkflow.prompt,
      reload: {
        disconnect: () => this.disconnect(false),
        resume: (request) => this.resumeSession(request)
      }
    })
    this.contextCompactionWorkflow = prompt.contextCompactionWorkflow
    this.promptTurnWorkflow = prompt.promptTurnWorkflow
    const lifecycle = composeAcpRuntimeLifecycleOwners(options, base, session, {
      connect: (request) => this.connect(request),
      disconnect: (emitClosedStatus) => this.disconnect(emitClosedStatus),
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
      lifecycle
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

  callSessionPlan(input: AcpSessionPlanCall): Promise<unknown> {
    return this.sessionPlanWorkflow.call(input)
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): Promise<ActivePlanProjection | null> {
    return this.sessionPlanWorkflow.projection(projectId, sessionId)
  }

  respondSessionPlan(input: PlanResponseCommand): Promise<PlanResponseResult> {
    return this.sessionPlanWorkflow.respond(input)
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

  liveSessionProjectId(sessionId: string): string | undefined {
    return this.sessionRegistry.lookup(sessionId)?.aggregate.snapshot().projectName
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
                systemPromptAppends: [
                  ...(await this.sessionEnvironment.backendSystemPromptAppends())
                ]
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
    const cancelPlanInteraction = this.sessionPlanWorkflow.capturePromptCancellation(
      request.sessionId
    )

    if (connection && activeSession) {
      await this.sessionInteractions.cancelPrompt({
        sessionId: request.sessionId,
        notify: () =>
          connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: activeSession.sessionId
          }),
        onAccepted: () => {
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

    return this.getSnapshot()
  }

  // Closes the agent-side session when supported, then removes local routing state.
  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    this.sessionPlanWorkflow.sessionDeleted(request.sessionId)
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

  // Resolves the artifact/notebook storage project for a session, defaulting to the runtime constant.
  private resolveSessionProjectName(sessionId: string): string {
    return this.sessionEnvironment.projectName(sessionId)
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
