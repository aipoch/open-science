import type { ActiveSession } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import { MAX_ACP_RUNTIME_EVENTS } from '../../shared/acp'
import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  ElicitationResponse,
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpRuntimeEvent,
  AcpRuntimeState,
  AcpSetPermissionProfileRequest,
  AcpSessionAgentTarget,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../shared/acp'
import type { AcpHandoffFailure } from '../../shared/acp'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { AgentFrameworkId } from '../../shared/settings'
import type { MessageAttribution } from '../../shared/session-persistence'
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import { ConversationPermissionGrantStore, type AppPermissionRequest } from './permission-broker'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import type { AgentUserChoiceRequest, AgentUserChoiceResult } from '../../shared/elicitation'
import type { AgentModelChangeTarget } from '../agent-framework'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import {
  DelegateMessageParkedError,
  DelegateMessagePreAcceptanceError,
  type DelegateMessageAcceptanceEvidence
} from '../delegation/execution-port'
import type { ShutdownStepOutcome } from '../lifecycle-shutdown'
import { projectPermissionRequest } from './runtime-publication-owner'

const QUIT_PREPARATION_TIMEOUT_MS = 4_000

const isOwnershipScopedControlEvent = (event: AcpRuntimeEvent): boolean =>
  event.kind === 'compaction' || event.recoverable === 'context-overflow'

const hasArtifactProvenance = (event: AcpRuntimeEvent): boolean =>
  Boolean(event.runId && event.promptMessageId && event.artifactClaimId)

type RuntimeFactory = (
  callbacks: AcpRuntimeCallbacks,
  permissionGrantStore: ConversationPermissionGrantStore,
  target?: AcpSessionAgentTarget
) => AcpRuntime

type AcpRuntimeCoordinatorTeardownCallbacks = {
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  onSessionDeleteStarted?: (sessionId: string) => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  // Runs after the runtime deletion attempt. `retained` is true after failure or when a concurrent
  // runtime adoption kept the logical Session alive.
  afterSessionDelete?: (sessionId: string, retained: boolean) => void
}

type PermissionGrantSnapshotProvider = () => AcpStateSnapshot['permissionGrants']

type PendingPromptStart = {
  id: string
  runtime: AcpRuntime
  cancelled: boolean
  globalCancellationGeneration: number
}

type ActivePromptRequest = {
  request: AcpPromptRequest
  runtime: AcpRuntime
  attemptId: string
  turnToken?: string
  acceptance?: PromptAcceptance
}

type PromptAcceptance = {
  resolve: () => void
  reject: (error: unknown) => void
  settled: boolean
}

const observePromptAcceptance = (onAccepted: () => void): PromptAcceptance => {
  const acceptance: PromptAcceptance = {
    resolve: () => undefined,
    reject: () => undefined,
    settled: false
  }
  acceptance.resolve = () => {
    if (acceptance.settled) return
    acceptance.settled = true
    onAccepted()
  }
  acceptance.reject = () => {
    acceptance.settled = true
  }
  return acceptance
}

type PendingSessionDrain = {
  runtime: AcpRuntime
  promise: Promise<void>
  resolve: () => void
}

type PendingResumeReconciliation = {
  runtime: AcpRuntime
  response: AcpCreateSessionResponse
  specialistId: string | undefined
}

type RootAdmissionLease = {
  release: () => void
}

type PromptAdmissionGuard = <Result>(
  sessionId: string,
  dispatch: () => Promise<Result>
) => Promise<Result>

// Keeps each framework generation in its own AcpRuntime. Framework changes preserve active turns, then
// retire their runtime so every later turn resumes through the newly selected framework.
class AcpRuntimeCoordinator {
  private readonly runtimes = new Set<AcpRuntime>()
  private readonly retiredRuntimes = new Set<AcpRuntime>()
  private readonly sessionRuntimes = new Map<string, AcpRuntime>()
  private readonly sessionConnectionStatuses = new Map<string, AcpStateSnapshot['status']>()
  private readonly permissionRuntimes = new Map<string, AcpRuntime>()
  private readonly reviewerRuntimes = new WeakMap<ActiveSession, AcpRuntime>()
  private readonly runtimeIds = new WeakMap<AcpRuntime, string>()
  private readonly runtimeTargetKeys = new WeakMap<AcpRuntime, string>()
  private readonly runtimeTargets = new WeakMap<AcpRuntime, AcpSessionAgentTarget>()
  private readonly targetedRuntimes = new Map<string, AcpRuntime>()
  private readonly publishedRuntimeEventIds = new WeakMap<AcpRuntime, Set<string>>()
  private readonly applicationEvents: AcpRuntimeEvent[] = []
  private readonly durableQuitDetachedSessionIds = new Set<string>()
  private readonly permissionGrantStore = new ConversationPermissionGrantStore()
  // Runtime events are persisted on Message nodes. A process-local sequence alone restarts at one
  // after every app launch and can collide with a historical Session's event ids.
  private readonly eventNamespace = randomUUID()
  private runtimeSequence = 0
  private snapshotRevision = 0
  private initializationGeneration = 0
  private globalCancellationGeneration = 0
  private delegatedWorkRevision = 0
  private promptAttemptSequence = 0
  private readonly pendingPromptStarts = new Map<string, PendingPromptStart[]>()
  private readonly activePromptRequests = new Map<string, ActivePromptRequest>()
  private readonly activePromptCounts = new Map<string, number>()
  private readonly interactionReleaseWaiters = new Map<string, Set<() => void>>()
  private readonly rootAdmissionTails = new Map<string, Promise<void>>()
  private readonly activeRootAdmissions = new Map<string, RootAdmissionLease>()
  private promptAdmissionGuard?: (sessionId: string) => Promise<void>
  private promptDispatchAdmissionGuard?: PromptAdmissionGuard
  private sessionResumeObserver?: (
    request: AcpResumeSessionRequest,
    response: AcpCreateSessionResponse
  ) => Promise<void>
  private promptAdmissionClosedForQuit = false
  private providerShutdownStartedForQuit = false
  private readonly pendingSessionAdoptions = new Map<string, AcpRuntime>()
  private readonly pendingResumeReconciliations = new Map<string, PendingResumeReconciliation>()
  private readonly pendingSessionDrains = new Map<string, PendingSessionDrain>()
  // The latest user-originated prompt is retained only long enough to construct an app-owned
  // continuation for an approved handoff. The continuation keeps its provenance context but never
  // republishes this text as a new user message.
  private readonly latestPromptRequests = new Map<string, AcpPromptRequest>()
  private activeRuntime: AcpRuntime | undefined
  private lastRuntime: AcpRuntime | undefined

  constructor(
    private readonly createRuntime: RuntimeFactory,
    private readonly callbacks: AcpRuntimeCallbacks = {},
    private readonly defaultCwd = '',
    private readonly initializationBarrier?: Promise<unknown>,
    private readonly onDisconnected?: () => void,
    private readonly onSessionUnavailable?: (sessionId: string) => void,
    private readonly teardownCallbacks: AcpRuntimeCoordinatorTeardownCallbacks = {},
    private readonly permissionGrantSnapshot?: PermissionGrantSnapshotProvider,
    private readonly delegatedWork?: RootDelegatedWorkControl
  ) {
    this.activeRuntime = this.addRuntime()
    this.lastRuntime = this.activeRuntime
    this.delegatedWork?.subscribe((event) => {
      this.delegatedWorkRevision += 1
      if (event.kind === 'permission-requested') {
        this.callbacks.onPermissionRequest?.(projectPermissionRequest(event.request))
      }
      this.emitState()
    })
  }

  getState(): AcpRuntimeState {
    this.snapshotRevision += 1
    return this.projectState(
      Array.from(this.runtimes, (runtime) => ({ runtime, state: runtime.getState() }))
    )
  }

  getSnapshot(): AcpStateSnapshot {
    this.snapshotRevision += 1
    const snapshots = Array.from(this.runtimes, (runtime) => ({
      runtime,
      snapshot: runtime.getSnapshot()
    }))
    const state = this.projectState(
      snapshots.map(({ runtime, snapshot }) => ({ runtime, state: snapshot }))
    )
    const events = [
      ...snapshots.flatMap(({ runtime, snapshot }) =>
        snapshot.events
          .filter((event) => this.shouldPublishEvent(runtime, event))
          .map((event) => ({
            ...event,
            id: this.eventId(runtime, event.id)
          }))
      ),
      ...this.applicationEvents
    ]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_ACP_RUNTIME_EVENTS)
    return { ...state, events }
  }

  private projectState(
    states: Array<{ runtime: AcpRuntime; state: AcpRuntimeState }>
  ): AcpRuntimeState {
    const primaryRuntime = this.activeRuntime ?? this.lastRuntime
    const primary = states.find(({ runtime }) => runtime === primaryRuntime)?.state
    const sessionIds = Array.from(
      new Set(states.flatMap(({ runtime, state }) => this.visibleSessionIds(runtime, state)))
    )
    const sessionResumeRequiredIds = Array.from(
      new Set(
        states.flatMap(({ runtime, state }) =>
          this.retiredRuntimes.has(runtime)
            ? this.visibleSessionIds(runtime, state).filter(
                (sessionId) => this.sessionRuntimes.get(sessionId) === runtime
              )
            : []
        )
      )
    )
    // A retired generation may keep draining after the same logical session was resumed by a fresh
    // runtime. Only its current owner may publish interaction state to the renderer.
    const ownedSessionIds = (select: (state: AcpRuntimeState) => readonly string[]): string[] =>
      Array.from(
        new Set(
          states.flatMap(({ runtime, state }) =>
            select(state).filter((sessionId) => this.sessionRuntimes.get(sessionId) === runtime)
          )
        )
      )
    const promptInFlightSessionIds = ownedSessionIds(
      (snapshot) => snapshot.promptInFlightSessionIds
    )
    const agentPromptInFlightSessionIds = ownedSessionIds(
      (snapshot) => snapshot.agentPromptInFlightSessionIds ?? []
    )
    const contextUsageBySession = Object.fromEntries(
      states.flatMap(({ runtime, state }) =>
        // A framework selection takes effect immediately even when the prior generation must finish
        // an active turn. Keep its conversation visible for routing, but stop publishing its context.
        this.retiredRuntimes.has(runtime)
          ? []
          : this.visibleSessionIds(runtime, state).flatMap((sessionId) => {
              // A runtime may still hold a stale measurement after the same logical session was adopted
              // by the next generation. Only the current owner may publish its context.
              if (this.sessionRuntimes.get(sessionId) !== runtime) return []
              const contextUsage = state.contextUsageBySession[sessionId]
              return contextUsage ? [[sessionId, contextUsage] as const] : []
            })
      )
    )
    const nativeContextCompactionSessionIds = states.flatMap(({ runtime, state }) =>
      this.retiredRuntimes.has(runtime)
        ? []
        : (state.nativeContextCompactionSessionIds ?? []).filter(
            (sessionId) =>
              this.sessionRuntimes.get(sessionId) === runtime && sessionIds.includes(sessionId)
          )
    )

    return {
      revision: this.snapshotRevision,
      status: primary?.status ?? 'idle',
      sessionConnectionStatuses: Object.fromEntries(this.sessionConnectionStatuses),
      cwd: primary?.cwd ?? this.defaultCwd,
      ...(primary?.sessionId && sessionIds.includes(primary.sessionId)
        ? { sessionId: primary.sessionId }
        : {}),
      sessionIds,
      sessionResumeRequiredIds,
      ...(primary?.error ? { error: primary.error } : {}),
      pendingPermissions: [
        ...states.flatMap(({ state }) => state.pendingPermissions),
        ...(this.delegatedWork?.pendingPermissions() ?? [])
      ].map(projectPermissionRequest),
      pendingElicitations: states.flatMap(({ state }) => state.pendingElicitations ?? []),
      permissionProfiles: Object.assign({}, ...states.map(({ state }) => state.permissionProfiles)),
      permissionGrants: this.permissionGrantSnapshot?.() ?? this.permissionGrantStore.snapshot(),
      contextUsageBySession,
      delegatedWorkRevision: this.delegatedWorkRevision,
      delegatedWorkUnavailableBySession: this.delegatedWork?.unavailableReasons?.() ?? {},
      nativeContextCompactionSessionIds,
      promptInFlight: promptInFlightSessionIds.length > 0,
      agentPromptInFlightSessionIds,
      promptInFlightSessionIds
    }
  }

  private emitState(): void {
    const onStateChanged = this.callbacks.onStateChanged
    if (!onStateChanged) return
    onStateChanged(this.callbacks.onEvent ? this.getState() : this.getSnapshot())
  }

  // Renderer aggregation intentionally hides idle sessions from retired generations. Destructive
  // lifecycle operations need the coordinator's complete ownership set instead.
  getOwnedSessionIds(): string[] {
    return Array.from(this.sessionRuntimes.keys())
  }

  captureSessionBackend(sessionId: string): ReturnType<AcpRuntime['captureBackend']> | undefined {
    return this.findRuntimeForSession(sessionId)?.captureBackend()
  }

  captureSessionModel(sessionId: string): ReturnType<AcpRuntime['captureSessionModel']> {
    return this.findRuntimeForSession(sessionId)?.captureSessionModel(sessionId)
  }

  callSessionPlan(input: Parameters<AcpRuntime['callSessionPlan']>[0]): Promise<unknown> {
    return this.runtimeForSession(input.sessionId).callSessionPlan(input)
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): ReturnType<AcpRuntime['getSessionPlanProjection']> {
    return this.runtimeForSession(sessionId).getSessionPlanProjection(projectId, sessionId)
  }

  respondSessionPlan(
    input: Parameters<AcpRuntime['respondSessionPlan']>[0]
  ): ReturnType<AcpRuntime['respondSessionPlan']> {
    return this.runtimeForSession(input.sessionId).respondSessionPlan(input)
  }

  getActivePromptSessions(): { projectId: string; sessionId: string }[] {
    return Array.from(this.runtimes).flatMap((runtime) => runtime.getActivePromptSessions())
  }

  getQuitBlockingPromptSessions(): { projectId: string; sessionId: string }[] {
    return Array.from(this.runtimes).flatMap((runtime) => runtime.getQuitBlockingPromptSessions())
  }

  hasLiveSession(projectId: string, sessionId: string): boolean {
    const runtime = this.sessionRuntimes.get(sessionId)
    return runtime?.hasLiveSession(projectId, sessionId) ?? false
  }

  isSessionMemoryEnabled(sessionId: string): boolean {
    return this.findRuntimeForSession(sessionId)?.isSessionMemoryEnabled(sessionId) ?? false
  }

  liveSessionProjectId(sessionId: string): string | undefined {
    return this.sessionRuntimes.get(sessionId)?.liveSessionProjectId(sessionId)
  }

  async enableLiteratureContext(sessionId: string): Promise<void> {
    await this.waitForSessionInteractionRelease(sessionId)
    const runtime = this.sessionRuntimes.get(sessionId)
    if (!runtime) return
    await runtime.enableLiteratureContext(sessionId)
  }

  async disableLiteratureContext(sessionId: string): Promise<void> {
    await this.waitForSessionInteractionRelease(sessionId)
    const runtime = this.sessionRuntimes.get(sessionId)
    if (!runtime) return
    await runtime.disableLiteratureContext(sessionId)
  }

  isSessionReferenceAllowed(sessionId: string, referencedSessionId: string): boolean {
    return (
      this.sessionRuntimes
        .get(sessionId)
        ?.isSessionReferenceAllowed(sessionId, referencedSessionId) ?? false
    )
  }

  getSessionFramework(sessionId: string): AgentFrameworkId | undefined {
    return this.findRuntimeForSession(sessionId)?.getSessionFramework(sessionId)
  }

  async connect(request: AcpConnectRequest = {}): Promise<AcpRuntimeState> {
    await this.waitForInitialization()
    const runtime = this.getActiveRuntime()
    await runtime.connect(request)
    return this.getState()
  }

  async disconnect(emitClosedStatus = true): Promise<AcpRuntimeState> {
    // User teardown intent invalidates held approvals synchronously. Runtime shutdown may take time or
    // reject after partial cleanup, but a dialog that was already open must not remain actionable.
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    const runtimes = Array.from(this.runtimes)
    const [delegatedResult, ...results] = await Promise.allSettled([
      this.delegatedWork?.stopAll() ?? Promise.resolve(),
      ...runtimes.map((runtime) => runtime.disconnect(emitClosedStatus))
    ])
    const failure =
      results.find((result): result is PromiseRejectedResult => result.status === 'rejected') ??
      (delegatedResult.status === 'rejected' ? delegatedResult : undefined)
    if (failure) {
      // A multi-runtime teardown can partially succeed. Release only the runtimes that are definitely
      // gone; failed runtimes retain their session and permission-routing ownership for retry.
      // A rejection can still happen after a runtime cleared some/all sessions, so reconcile those
      // actual disappearances too without releasing the failed runtime itself.
      results.forEach((result, index) => {
        const runtime = runtimes[index]
        if (result.status === 'fulfilled') this.releaseRuntimeOwnership(runtime)
        else this.releaseMissingRuntimeSessions(runtime, runtime.getSnapshot())
      })
      this.emitState()
      throw failure.reason
    }
    this.clearRuntimeOwnership()
    this.onDisconnected?.()
    return this.getState()
  }

  shutdown(): void {
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    void this.delegatedWork?.shutdown().catch(() => undefined)
    for (const runtime of this.runtimes) runtime.shutdown()
    this.clearRuntimeOwnership()
    this.onDisconnected?.()
  }

  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.providerShutdownStartedForQuit = true
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    return this.shutdownAll(
      (runtime) => runtime.shutdownForQuit(),
      () => this.delegatedWork?.shutdown()
    )
  }

  // Gives active agents a bounded chance to return their terminal stop response before process-tree
  // teardown. Those responses carry the final usage available from Claude Code/OpenCode/managed Codex;
  // an unresponsive agent cannot hold app quit indefinitely.
  async prepareForQuit(
    timeoutMs = QUIT_PREPARATION_TIMEOUT_MS
  ): Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>> {
    this.promptAdmissionClosedForQuit = true
    const activePromptSessionIds = new Set(
      this.getActivePromptSessions().map(({ sessionId }) => sessionId)
    )
    const quitBlockingSessionIds = new Set(
      this.getQuitBlockingPromptSessions().map(({ sessionId }) => sessionId)
    )
    const durablePermissionWaitSessionIds = new Set(
      [...activePromptSessionIds].filter((sessionId) => !quitBlockingSessionIds.has(sessionId))
    )
    for (const sessionId of durablePermissionWaitSessionIds) {
      this.durableQuitDetachedSessionIds.add(sessionId)
    }
    const sessionIds = Array.from(
      new Set([
        ...this.activePromptRequests.keys(),
        ...this.pendingPromptStarts.keys(),
        ...this.getSnapshot().promptInFlightSessionIds
      ])
    ).filter((sessionId) => !durablePermissionWaitSessionIds.has(sessionId))
    if (sessionIds.length === 0 && !this.delegatedWork) return 'completed'

    const cancelAndDrain = async (): Promise<void> => {
      const delegatedStop = this.delegatedWork?.stopAll() ?? Promise.resolve()
      await Promise.allSettled(
        sessionIds.map((sessionId) => this.cancelPrompt({ sessionId }).then(() => undefined))
      )
      await delegatedStop
      await Promise.all(
        sessionIds.map((sessionId) => this.waitForSessionInteractionRelease(sessionId))
      )
    }

    return new Promise<'completed' | 'timeout' | 'failed'>((resolve) => {
      let settled = false
      const finish = (outcome: 'completed' | 'timeout' | 'failed'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs))
      void cancelAndDrain().then(
        () => finish('completed'),
        () => finish('failed')
      )
    })
  }

  // Quit may be cancelled when renderer persistence cannot prove its final snapshot durable. Reopen
  // only the admission state owned by prepareForQuit; completed prompt cancellation remains completed.
  abortQuitPreparation(): void {
    if (this.providerShutdownStartedForQuit) return
    this.promptAdmissionClosedForQuit = false
    this.durableQuitDetachedSessionIds.clear()
  }

  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    return this.shutdownAll(
      (runtime) => runtime.shutdownForUpdateGate(),
      () => this.delegatedWork?.stopAll()
    )
  }

  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    await this.waitForInitialization()
    const runtime = this.runtimeForTarget(request.agentTarget)
    let response: AcpCreateSessionResponse
    try {
      response = await runtime.createSession(request)
    } catch (error) {
      await this.retireUnusedTargetedRuntime(runtime)
      throw error
    }
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  async resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    await this.waitForInitialization()
    const owner = this.findRuntimeForSession(request.sessionId)
    const pendingReconciliation = this.pendingResumeReconciliations.get(request.sessionId)
    if (
      pendingReconciliation &&
      pendingReconciliation.runtime === owner &&
      request.specialistBindingPending === true &&
      request.specialistId === pendingReconciliation.specialistId
    ) {
      await this.sessionResumeObserver?.(request, pendingReconciliation.response)
      if (this.pendingResumeReconciliations.get(request.sessionId) === pendingReconciliation) {
        this.pendingResumeReconciliations.delete(request.sessionId)
      }
      await this.delegatedWork?.wakeMessages?.(pendingReconciliation.response.sessionId)
      return pendingReconciliation.response
    }
    if (pendingReconciliation) this.pendingResumeReconciliations.delete(request.sessionId)
    const targetedRuntime = request.agentTarget
      ? this.runtimeForTarget(request.agentTarget)
      : undefined
    const runtime =
      targetedRuntime ??
      (owner && !this.retiredRuntimes.has(owner) ? owner : this.getActiveRuntime())
    const transfersOwnership = runtime !== owner

    // Keep the prior owner authoritative until adoption finishes. The renderer does not create the
    // incoming optimistic run until this promise resolves, so terminal events emitted while the old
    // generation drains can still settle its own Runtime Segment without touching the next one.
    if (transfersOwnership) this.pendingSessionAdoptions.set(request.sessionId, runtime)

    let response: AcpCreateSessionResponse
    try {
      response = await runtime.resumeSession(request)
    } catch (error) {
      if (transfersOwnership && this.pendingSessionAdoptions.get(request.sessionId) === runtime) {
        this.pendingSessionAdoptions.delete(request.sessionId)
      }
      await this.retireUnusedTargetedRuntime(runtime)
      throw error
    }

    if (transfersOwnership && owner) {
      // The incoming provider can attach before the draining generation emits its terminal event.
      // Keep the old owner authoritative until its active turn clears so stop/error settles the old
      // Runtime Segment before the renderer is allowed to append a turn for the adopted runtime.
      await this.waitForSessionDrain(owner, request.sessionId)
    }

    if (
      transfersOwnership &&
      (this.pendingSessionAdoptions.get(request.sessionId) !== runtime ||
        !this.runtimes.has(runtime) ||
        this.retiredRuntimes.has(runtime))
    ) {
      if (this.pendingSessionAdoptions.get(request.sessionId) === runtime) {
        this.pendingSessionAdoptions.delete(request.sessionId)
      }
      throw new Error('ACP session adoption was superseded before ownership could commit')
    }

    if (transfersOwnership && this.pendingSessionAdoptions.get(request.sessionId) === runtime) {
      this.pendingSessionAdoptions.delete(request.sessionId)
    }

    if (
      response.sessionId !== request.sessionId &&
      this.sessionRuntimes.get(request.sessionId) === owner
    ) {
      this.sessionRuntimes.delete(request.sessionId)
      this.sessionConnectionStatuses.delete(request.sessionId)
    }
    this.sessionRuntimes.set(response.sessionId, runtime)
    // The incoming runtime's attached snapshot is deliberately ignored while adoption is pending.
    // Commit its current connection status together with ownership so a stale status from the
    // draining owner cannot classify later prompt failures as disconnects.
    this.sessionConnectionStatuses.set(response.sessionId, runtime.getSnapshot().status)
    this.lastRuntime = runtime
    if (transfersOwnership) await this.retireUnusedTargetedRuntime(owner)
    if (transfersOwnership) this.emitState()
    try {
      await this.sessionResumeObserver?.(request, response)
    } catch (error) {
      if (request.specialistBindingPending === true) {
        this.pendingResumeReconciliations.set(request.sessionId, {
          runtime,
          response,
          specialistId: request.specialistId
        })
      }
      throw error
    }
    await this.delegatedWork?.wakeMessages?.(response.sessionId)
    return response
  }

  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    await this.waitForInitialization()
    const runtime = this.runtimeForSession(request.sessionId)
    const response = await runtime.resetSessionContext(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  async waitForPromptOwnershipRelease(sessionId: string): Promise<void> {
    const runtime = this.runtimeForSession(sessionId)
    await this.waitForSessionDrain(runtime, sessionId)
  }

  prepareClaudeCodeHandoffReplay(input: ClaudeCodeReplayInput): void {
    this.runtimeForSession(input.sessionId).prepareClaudeCodeHandoffReplay(input)
  }

  discardClaudeCodeHandoffReplay(sessionId: string): void {
    this.runtimeForSession(sessionId).discardClaudeCodeHandoffReplay(sessionId)
  }

  async createClaudeCodeContinuationRequest(input: {
    sessionId: string
    switchReadBack: ApprovedSwitchReadBack
  }): Promise<AcpPromptRequest> {
    return this.runtimeForSession(input.sessionId).createClaudeCodeContinuationRequest(input)
  }

  reportApprovedHandoffFailure(sessionId: string): void {
    this.runtimeForSession(sessionId).reportApprovedHandoffFailure(sessionId)
    this.emitState()
  }

  // Hot-switches the specialist on a live session. Delegates to the owning runtime so a framework
  // generation switch cannot strand a binding on a retired runtime.
  async switchSpecialist(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    await this.waitForInitialization()
    const runtime = this.runtimeForSession(sessionId)
    return runtime.switchSpecialist(sessionId, specialistId)
  }

  isSessionUsingFramework(sessionId: string, frameworkId: AgentFrameworkId): boolean {
    return this.getSessionFramework(sessionId) === frameworkId
  }

  async waitForPromptRelease(sessionId: string): Promise<void> {
    await this.waitForPromptOwnershipRelease(sessionId)
  }

  async continueApprovedHandoff(sessionId: string, text: string): Promise<void> {
    const prior = this.latestPromptRequests.get(sessionId)
    if (!prior)
      throw new Error('Cannot continue an approved handoff without its originating prompt.')
    await this.sendAppContinuation({
      sessionId,
      text,
      ...(prior.provenanceContext ? { provenanceContext: prior.provenanceContext } : {})
    })
  }

  getLatestUserPrompt(sessionId: string, promptMessageId: string): AcpPromptRequest | undefined {
    const prompt = this.latestPromptRequests.get(sessionId)
    return prompt?.provenanceContext?.promptMessageId === promptMessageId ? prompt : undefined
  }

  // Captures the app-owned original user request while its provider prompt still owns this session.
  // The framework adapter calls this before requesting cancellation, so the continuation can retain
  // the same text, attachments, and provenance without fabricating another user action.
  capturePromptForHandoff(
    sessionId: string
  ): { prompt: AcpPromptRequest; originatingTurnToken: string } | undefined {
    const active = this.activePromptRequests.get(sessionId)
    if (!active?.turnToken) return undefined
    return { prompt: active.request, originatingTurnToken: active.turnToken }
  }

  // Publishes only sanitized lifecycle metadata. The captured completion and original prompt remain
  // in the app-owned failure store and never cross the renderer/event boundary.
  publishHandoffFailure(
    failure: Omit<AcpHandoffFailure, 'retryable'> & { sessionId: string }
  ): void {
    const target = failure.targetName ?? 'Main Agent'
    const event: AcpRuntimeEvent = {
      id: `app-handoff-${randomUUID()}`,
      timestamp: Date.now(),
      kind: 'error',
      level: 'error',
      sessionId: failure.sessionId,
      title: 'Specialist handoff failed',
      text: `Switching to ${target} failed. The approved handoff is retained and can be retried.`,
      status: 'failed',
      handoffFailure: {
        targetName: failure.targetName,
        generation: failure.generation,
        failedPhase: failure.failedPhase,
        retryable: true
      }
    }
    this.applicationEvents.push(event)
    if (this.applicationEvents.length > MAX_ACP_RUNTIME_EVENTS) {
      this.applicationEvents.splice(0, this.applicationEvents.length - MAX_ACP_RUNTIME_EVENTS)
    }
    this.callbacks.onEvent?.(event)
    this.emitState()
  }

  async compactSession(request: AcpCompactSessionRequest): Promise<AcpRuntimeState> {
    this.assertPromptAdmissionOpen()
    await this.waitForInitialization()
    this.assertPromptAdmissionOpen()
    await this.runtimeForSession(request.sessionId).compactSession(request)
    return this.getState()
  }

  setPromptAdmissionGuard(guard: (sessionId: string) => Promise<void>): void {
    this.promptAdmissionGuard = guard
  }

  setPromptDispatchAdmissionGuard(guard: PromptAdmissionGuard): void {
    this.promptDispatchAdmissionGuard = guard
  }

  setSessionResumeObserver(
    observer: (
      request: AcpResumeSessionRequest,
      response: AcpCreateSessionResponse
    ) => Promise<void>
  ): void {
    this.sessionResumeObserver = observer
  }

  sendPrompt(request: AcpPromptRequest): ReturnType<AcpRuntime['sendPrompt']> {
    return this.sendObservedPrompt(request)
  }

  // Interactive prompt dispatch is an admission RPC, while the authoritative turn lifecycle is
  // streamed through runtime state/events. Settle once the application runtime owns the prompt;
  // blocking providers and human approval waits may produce no provider update before their own
  // domain lifecycle completes and must not retain a Web request until then.
  startPrompt(request: AcpPromptRequest): Promise<void> {
    let settled = false
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const accepted = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    const settleAdmitted = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const settleRejected = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const settleAfterRuntimeDispatch = (prompt: ReturnType<AcpRuntime['sendPrompt']>): void => {
      // A runtime can return an immediately rejected Promise through several async wrappers when
      // it cannot accept the prompt. Let that microtask chain drain before acknowledging local
      // ownership. Once accepted, later model, tool, or human-input waits remain authoritative
      // through state/events.
      void prompt.then(settleAdmitted, settleRejected)
      setImmediate(settleAdmitted)
    }

    void this.sendObservedPrompt(request, undefined, settleAfterRuntimeDispatch).then(
      settleAdmitted,
      settleRejected
    )
    return accepted
  }

  sendApplicationPrompt(
    request: AcpPromptRequest,
    attribution: MessageAttribution
  ): ReturnType<AcpRuntime['sendApplicationPrompt']> {
    return this.linearizeRootAdmission(request.sessionId, () =>
      this.dispatchPrompt(
        request,
        undefined,
        'sendApplicationPrompt',
        undefined,
        false,
        attribution
      )
    )
  }

  sendPromptObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): ReturnType<AcpRuntime['sendPrompt']> {
    return this.sendObservedPrompt(
      request,
      observePromptAcceptance(onProviderPromptAccepted),
      undefined,
      onPromptAdmitted
    )
  }

  private sendObservedPrompt(
    request: AcpPromptRequest,
    acceptance?: PromptAcceptance,
    onApplicationPromptAdmitted?: (prompt: ReturnType<AcpRuntime['sendPrompt']>) => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): ReturnType<AcpRuntime['sendPrompt']> {
    if (this.promptAdmissionClosedForQuit) return this.rejectPromptForQuit()
    const dispatch = (): ReturnType<AcpRuntime['sendPrompt']> =>
      this.linearizeRootAdmission(request.sessionId, () =>
        this.dispatchPrompt(
          request,
          acceptance,
          'sendPrompt',
          undefined,
          true,
          undefined,
          onApplicationPromptAdmitted,
          onPromptAdmitted
        ).finally(() => this.delegatedWork?.wakeMessages?.(request.sessionId))
      )
    const admission = this.promptAdmissionGuard?.(request.sessionId)
    return admission ? admission.then(dispatch) : dispatch()
  }

  sendAppContinuation(request: AcpPromptRequest): ReturnType<AcpRuntime['sendAppContinuation']> {
    return this.linearizeRootAdmission(request.sessionId, () =>
      this.dispatchPrompt(request, undefined, 'sendAppContinuation')
    )
  }

  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void
  ): ReturnType<AcpRuntime['sendAppContinuation']> {
    return this.linearizeRootAdmission(request.sessionId, () =>
      this.dispatchPrompt(
        request,
        observePromptAcceptance(onProviderPromptAccepted),
        'sendAppContinuation'
      )
    )
  }

  private linearizeRootAdmission<Result>(
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.rootAdmissionTails.get(sessionId)
    let resolveGate!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    let released = false
    const lease: RootAdmissionLease = {
      release: () => {
        if (released) return
        released = true
        if (this.activeRootAdmissions.get(sessionId) === lease) {
          this.activeRootAdmissions.delete(sessionId)
        }
        resolveGate()
      }
    }
    const run = (): Promise<Result> => {
      this.activeRootAdmissions.set(sessionId, lease)
      let result: Promise<Result>
      try {
        result = operation()
      } catch (error) {
        result = Promise.reject(error)
      }
      void result.then(lease.release, lease.release)
      return result
    }
    const ready = previous?.catch(() => undefined)
    const result = ready ? ready.then(run) : run()
    const tail = ready ? ready.then(() => gate) : gate
    this.rootAdmissionTails.set(sessionId, tail)
    void tail
      .finally(() => {
        if (this.rootAdmissionTails.get(sessionId) === tail) {
          this.rootAdmissionTails.delete(sessionId)
        }
      })
      .catch(() => undefined)
    return result
  }

  // Starts an app-owned continuation and reports the strongest acceptance evidence available.
  // Validation rejection is proven pre-accept; a provider-call rejection remains conservatively unknown.
  startContinuation(request: AcpPromptRequest): Promise<void> {
    return this.startContinuationWhen(request, async () => undefined).then(() => undefined)
  }

  startContinuationWhen(
    request: AcpPromptRequest,
    validate: () => Promise<void>
  ): Promise<DelegateMessageAcceptanceEvidence> {
    return this.startContinuationWhenWithDispatchAdmission(request, validate, false)
  }

  startContinuationWhenDispatchAdmitted(
    request: AcpPromptRequest,
    validate: () => Promise<void>
  ): Promise<DelegateMessageAcceptanceEvidence> {
    // The caller owns final deletion admission for the whole validation/resume/acceptance lifecycle.
    // Bypass only the nested dispatch guard; root-session admission remains linearized below.
    return this.startContinuationWhenWithDispatchAdmission(request, validate, true)
  }

  private startContinuationWhenWithDispatchAdmission(
    request: AcpPromptRequest,
    validate: () => Promise<void>,
    dispatchAdmitted: boolean
  ): Promise<DelegateMessageAcceptanceEvidence> {
    let resolve!: (evidence: DelegateMessageAcceptanceEvidence) => void
    let reject!: (error: unknown) => void
    const accepted = new Promise<DelegateMessageAcceptanceEvidence>(
      (promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
      }
    )
    const acceptance: PromptAcceptance = {
      resolve: () => undefined,
      reject: () => undefined,
      settled: false
    }
    acceptance.resolve = () => {
      if (acceptance.settled) return
      acceptance.settled = true
      resolve('provider_prompt_accepted')
    }
    acceptance.reject = (error) => {
      if (acceptance.settled) return
      acceptance.settled = true
      reject(error)
    }

    void this.linearizeRootAdmission(request.sessionId, async () => {
      try {
        await validate()
      } catch (error) {
        if (error instanceof DelegateMessageParkedError) throw error
        throw new DelegateMessagePreAcceptanceError(
          error instanceof Error ? error.message : String(error),
          error
        )
      }
      await (dispatchAdmitted
        ? this.dispatchAdmittedPrompt(request, acceptance, 'sendAppContinuation')
        : this.dispatchPrompt(request, acceptance, 'sendAppContinuation'))
      if (!acceptance.settled) {
        acceptance.settled = true
        resolve('provider_prompt_completed')
      }
    }).catch((error) => acceptance.reject(error))
    return accepted
  }

  private dispatchPrompt(
    request: AcpPromptRequest,
    acceptance: PromptAcceptance | undefined,
    operation: 'sendPrompt' | 'sendAppContinuation' | 'sendApplicationPrompt',
    pinnedRuntime?: AcpRuntime,
    retainAsLatestUserPrompt = operation === 'sendPrompt',
    attribution?: MessageAttribution,
    onApplicationPromptAdmitted?: (prompt: ReturnType<AcpRuntime['sendPrompt']>) => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): ReturnType<AcpRuntime['sendPrompt']> {
    let dispatchStarted = false
    const dispatch = (): ReturnType<AcpRuntime['sendPrompt']> => {
      dispatchStarted = true
      return this.dispatchAdmittedPrompt(
        request,
        acceptance,
        operation,
        pinnedRuntime,
        retainAsLatestUserPrompt,
        attribution,
        onApplicationPromptAdmitted,
        onPromptAdmitted
      )
    }
    if (!this.promptDispatchAdmissionGuard) return dispatch()
    return this.promptDispatchAdmissionGuard(request.sessionId, dispatch).catch((error) => {
      if (dispatchStarted || error instanceof DelegateMessagePreAcceptanceError) throw error
      throw new DelegateMessagePreAcceptanceError(
        error instanceof Error ? error.message : String(error),
        error
      )
    })
  }

  private dispatchAdmittedPrompt(
    request: AcpPromptRequest,
    acceptance: PromptAcceptance | undefined,
    operation: 'sendPrompt' | 'sendAppContinuation' | 'sendApplicationPrompt',
    pinnedRuntime?: AcpRuntime,
    retainAsLatestUserPrompt = operation === 'sendPrompt',
    attribution?: MessageAttribution,
    onApplicationPromptAdmitted?: (prompt: ReturnType<AcpRuntime['sendPrompt']>) => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): ReturnType<AcpRuntime['sendPrompt']> {
    if (this.promptAdmissionClosedForQuit) return this.rejectPromptForQuit()
    const owner = pinnedRuntime ?? this.findRuntimeForSession(request.sessionId)
    if (!pinnedRuntime && owner && this.retiredRuntimes.has(owner)) {
      return Promise.reject(new Error('ACP session must resume before sending a prompt'))
    }

    const runtime = owner ?? this.getActiveRuntime()
    const attempt: PendingPromptStart = {
      id: `prompt-attempt-${++this.promptAttemptSequence}`,
      runtime,
      cancelled: false,
      globalCancellationGeneration: this.globalCancellationGeneration
    }
    const pending = this.pendingPromptStarts.get(request.sessionId) ?? []
    pending.push(attempt)
    this.pendingPromptStarts.set(request.sessionId, pending)
    // Legacy callers may omit graph provenance. Give the originating task one stable identity before
    // its first runtime run so an app-owned continuation reuses that identity instead of receiving a
    // second per-run fallback from AcpRuntime.activateArtifactRun().
    const taskRequest: AcpPromptRequest = request.provenanceContext
      ? request
      : {
          ...request,
          provenanceContext: { promptMessageId: `prompt-${randomUUID()}` }
        }
    const activePrompt: ActivePromptRequest = {
      request: taskRequest,
      runtime,
      attemptId: attempt.id,
      acceptance
    }
    this.activePromptRequests.set(request.sessionId, activePrompt)
    if (retainAsLatestUserPrompt) this.latestPromptRequests.set(request.sessionId, taskRequest)
    const originatingPromptId = taskRequest.provenanceContext?.promptMessageId
    let settlementLeaseId: string | undefined
    const endRootTurn = async (clean: boolean): Promise<void> => {
      if (!originatingPromptId) return
      await this.delegatedWork
        ?.rootTurnEnded?.({
          sessionId: request.sessionId,
          originatingPromptId,
          clean,
          ...(settlementLeaseId ? { leaseId: settlementLeaseId } : {})
        })
        .catch(() => undefined)
    }
    const settlementStart = originatingPromptId
      ? this.delegatedWork
          ?.rootTurnStarted?.({
            sessionId: request.sessionId,
            originatingPromptId
          })
          .catch(() => undefined)
      : undefined
    const admitPrompt = onPromptAdmitted
      ? async (): Promise<AcpPromptRequest['provenanceContext']> => {
          const provenanceContext = await onPromptAdmitted()
          if (provenanceContext) taskRequest.provenanceContext = provenanceContext
          return provenanceContext
        }
      : undefined
    const prompt = Promise.resolve(settlementStart).then((leaseId) => {
      settlementLeaseId = leaseId
      if (
        attempt.globalCancellationGeneration !== this.globalCancellationGeneration ||
        attempt.cancelled ||
        this.activePromptRequests.get(request.sessionId) !== activePrompt
      ) {
        throw new DelegateMessagePreAcceptanceError(
          'ACP prompt start was superseded before provider dispatch'
        )
      }
      if (operation === 'sendApplicationPrompt') {
        return runtime.sendApplicationPrompt(taskRequest, attribution!, attempt.id)
      }
      if (operation === 'sendPrompt') {
        return admitPrompt
          ? runtime.sendPrompt(taskRequest, attempt.id, admitPrompt)
          : runtime.sendPrompt(taskRequest, attempt.id)
      }
      return runtime.sendAppContinuation(taskRequest, attempt.id)
    })
    onApplicationPromptAdmitted?.(prompt)
    return prompt
      .then(async (response) => {
        await endRootTurn(response?.stopReason !== 'cancelled')
        return response
      })
      .catch(async (error: unknown) => {
        await endRootTurn(false)
        if (
          operation === 'sendPrompt' &&
          this.promptAdmissionClosedForQuit &&
          this.providerShutdownStartedForQuit &&
          this.durableQuitDetachedSessionIds.has(request.sessionId)
        ) {
          return { stopReason: 'cancelled' as const }
        }
        throw error
      })
      .finally(() => {
        this.durableQuitDetachedSessionIds.delete(request.sessionId)
        this.removePendingPromptStart(request.sessionId, attempt)
        if (this.activePromptRequests.get(request.sessionId) === activePrompt) {
          this.activePromptRequests.delete(request.sessionId)
        }
      })
  }

  async steerFollowUp(request: AcpSteerFollowUpRequest): Promise<AcpSteerFollowUpResult> {
    this.assertPromptAdmissionOpen()
    await this.waitForInitialization()
    this.assertPromptAdmissionOpen()
    await this.promptAdmissionGuard?.(request.sessionId)
    this.assertPromptAdmissionOpen()
    const dispatch = (): Promise<AcpSteerFollowUpResult> =>
      this.runtimeForSession(request.sessionId).steerFollowUp(request)
    return this.promptDispatchAdmissionGuard
      ? this.promptDispatchAdmissionGuard(request.sessionId, dispatch)
      : dispatch()
  }

  async steerSideChatAdvisory(
    request: AcpSteerFollowUpRequest
  ): ReturnType<AcpRuntime['steerSideChatAdvisory']> {
    this.assertPromptAdmissionOpen()
    await this.waitForInitialization()
    this.assertPromptAdmissionOpen()
    const dispatch = (): ReturnType<AcpRuntime['steerSideChatAdvisory']> =>
      this.runtimeForSession(request.sessionId).steerSideChatAdvisory(request)
    return this.promptDispatchAdmissionGuard
      ? this.promptDispatchAdmissionGuard(request.sessionId, dispatch)
      : dispatch()
  }

  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpRuntimeState> {
    if (request.scope === 'subagents') {
      await this.delegatedWork?.stopActiveBranch?.(request.sessionId)
      return this.getState()
    }
    const initiatingTurnMessageId = this.activePromptRequests.get(request.sessionId)?.request
      .provenanceContext?.promptMessageId
    const cancelledAdmission = this.activeRootAdmissions.get(request.sessionId)
    // Production delegated-work establishes its admission fence synchronously before this call
    // returns a Promise. Keep the pinned child stops in flight so a cleanup failure cannot prevent
    // the root Attempt from being invalidated and cancelled.
    const delegatedCancellation = initiatingTurnMessageId
      ? (this.delegatedWork?.cancelTurn?.(request.sessionId, initiatingTurnMessageId) ??
        Promise.resolve())
      : Promise.resolve()
    this.invalidateSessionTurn(request.sessionId)
    const [rootCancellation, childCancellation] = await Promise.allSettled([
      Promise.resolve().then(() => this.runtimeForSession(request.sessionId).cancelPrompt(request)),
      delegatedCancellation
    ])
    cancelledAdmission?.release()
    if (rootCancellation.status === 'rejected') throw rootCancellation.reason
    if (childCancellation.status === 'rejected') throw childCancellation.reason
    return this.getState()
  }

  async stopPromptForHandoff(sessionId: string): Promise<void> {
    // Supersede the old turn exactly like user cancellation, but do not emit the user-generation
    // cancellation callback: that callback marks the approved handoff itself cancelled.
    const cancelledAdmission = this.activeRootAdmissions.get(sessionId)
    this.invalidateSessionTurn(sessionId, false)
    await this.runtimeForSession(sessionId).cancelPrompt({ sessionId })
    cancelledAdmission?.release()
  }

  // Resolves only when the coordinator no longer owns either a pending prompt start or an attached
  // runtime interaction for this app session. This is the explicit ownership-release acknowledgement
  // used by specialist handoff; a cancel request returning is deliberately not sufficient.
  async waitForSessionInteractionRelease(sessionId: string): Promise<void> {
    if (!this.hasSessionInteraction(sessionId)) return
    await new Promise<void>((resolve) => {
      const waiters = this.interactionReleaseWaiters.get(sessionId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.interactionReleaseWaiters.set(sessionId, waiters)
      this.notifyInteractionRelease(sessionId)
    })
  }

  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpRuntimeState> {
    this.invalidateSessionTurn(request.sessionId)
    this.teardownCallbacks.onSessionDeleteStarted?.(request.sessionId)
    this.activePromptRequests.delete(request.sessionId)
    this.pendingResumeReconciliations.delete(request.sessionId)
    const runtime = this.runtimeForSession(request.sessionId)
    const ownedBeforeDelete = this.sessionRuntimes.get(request.sessionId) === runtime
    try {
      await this.delegatedWork?.deleteSession(request.sessionId)
      await this.teardownCallbacks.beforeSessionDelete?.(request.sessionId)
      await runtime.deleteSession(request)
    } catch (error) {
      this.teardownCallbacks.afterSessionDelete?.(request.sessionId, true)
      throw error
    }
    const ownerAfterDelete = this.sessionRuntimes.get(request.sessionId)
    const retained = ownerAfterDelete !== undefined && ownerAfterDelete !== runtime
    // Attached deletes emit a runtime state change, whose reconciliation already notifies exactly once.
    // Detached cleanup deliberately emits no state, so complete its session-scoped teardown here. A
    // concurrent resume may have transferred the same app session to a new generation while the old
    // agent delete was in flight; preserve that new owner and its connection status in full.
    if (ownerAfterDelete === runtime || (!ownerAfterDelete && !ownedBeforeDelete)) {
      this.sessionRuntimes.delete(request.sessionId)
      this.sessionConnectionStatuses.delete(request.sessionId)
      this.latestPromptRequests.delete(request.sessionId)
      this.clearApplicationSessionEvents(request.sessionId)
      this.onSessionUnavailable?.(request.sessionId)
    }
    this.teardownCallbacks.afterSessionDelete?.(request.sessionId, retained)
    await this.retireUnusedTargetedRuntime(runtime)
    return this.getState()
  }

  async respondToPermission(response: AcpPermissionResponse): Promise<AcpRuntimeState> {
    if (this.delegatedWork && (await this.delegatedWork.respondToPermission(response))) {
      return this.getState()
    }
    const runtime =
      this.permissionRuntimes.get(response.requestId) ??
      Array.from(this.runtimes).find((candidate) =>
        candidate
          .getSnapshot()
          .pendingPermissions.some((request) => request.requestId === response.requestId)
      ) ??
      (response.restored ? this.sessionRuntimes.get(response.restored.sessionId) : undefined) ??
      this.getActiveRuntime()
    try {
      await runtime.respondToPermission(response)
    } finally {
      this.permissionRuntimes.delete(response.requestId)
    }
    return this.getState()
  }

  async respondToElicitation(response: ElicitationResponse): Promise<AcpRuntimeState> {
    const runtime =
      Array.from(this.runtimes).find((candidate) =>
        candidate
          .getSnapshot()
          .pendingElicitations?.some((request) => request.requestId === response.requestId)
      ) ??
      (response.request ? this.findRuntimeForSession(response.request.sessionId) : undefined) ??
      this.getActiveRuntime()
    await runtime.respondToElicitation(response)
    return this.getState()
  }

  async requestUserInput(input: AgentUserChoiceRequest): Promise<AgentUserChoiceResult> {
    return this.runtimeForSession(input.sessionId).requestUserInput(input)
  }

  // Keeps an app-owned approval on the runtime that owns the conversation, so the existing ACP
  // broker/card can be used across framework generations without a parallel responder path.
  async requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
    signal?: AbortSignal
  }): Promise<boolean> {
    return this.runtimeForSession(input.sessionId).requestAppApproval(input)
  }

  async requestAppPermission(input: AppPermissionRequest): Promise<string | undefined> {
    return this.runtimeForSession(input.sessionId).requestAppPermission(input)
  }

  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpRuntimeState> {
    await this.runtimeForSession(request.sessionId).setPermissionProfile(request)
    await this.delegatedWork?.setPermissionProfile(request.sessionId, request.profile)
    return this.getState()
  }

  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    this.runtimeForSession(sessionId).setMemoryEnabled(sessionId, enabled)
  }

  async revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpRuntimeState> {
    await this.runtimeForSession(request.sessionId).revokePermissionGrant(request)
    return this.getState()
  }

  notifyPermissionGrantsChanged(): void {
    this.emitState()
  }

  // A framework change takes effect for every future turn and workflow. The old generations stay alive
  // until their active prompts and workflow leases finish; idle sessions resume on demand. Managed
  // runtime removal can scope this invalidation to the removed framework while still rotating the
  // default generation whose selected backend changed.
  async requestAgentFrameworkSwitch(frameworkId?: AgentFrameworkId): Promise<void> {
    if (!frameworkId) {
      await this.retireRuntimeGenerations(this.runtimes)
      return
    }

    const affected = new Set(this.runtimeGenerationsForFramework(frameworkId))
    if (this.activeRuntime) affected.add(this.activeRuntime)
    await this.retireRuntimeGenerations(affected)
  }

  // Provider edits reconnect the default generation only when it uses the affected default, plus every
  // live targeted generation pinned to that provider. Retiring generations stay on their old settings
  // while active workflows drain.
  async requestProviderReconnect(
    providerIds?: readonly string[],
    includeDefault = true
  ): Promise<void> {
    const affected = new Set<AcpRuntime>()
    if (includeDefault) affected.add(this.getActiveRuntime())
    if (providerIds) {
      for (const runtime of this.runtimes) {
        if (
          !this.retiredRuntimes.has(runtime) &&
          providerIds.includes(this.runtimeTargets.get(runtime)?.providerId ?? '')
        ) {
          affected.add(runtime)
        }
      }
    }
    await Promise.all(Array.from(affected, (runtime) => runtime.requestProviderReconnect()))
  }

  async requestSkillsReload(): Promise<void> {
    // Skills and connector tools are captured by every runtime generation, including generations
    // pinned to an explicit Session target.
    await this.retireRuntimeGenerations(this.runtimes)
  }

  async requestProjectAgentContextReload(): Promise<void> {
    // Project Agent Context is captured during Session setup. Retire every generation so its idle
    // Sessions resume with the current Project value before their next prompt.
    await this.retireRuntimeGenerations(this.runtimes)
  }

  async requestSkillsReloadForFramework(frameworkId: AgentFrameworkId): Promise<void> {
    // A framework-scoped derived asset must not rotate an unrelated backend generation. An empty
    // generation has no session holding stale assets; its first Session will provision from the
    // current source of truth without an explicit reload.
    await this.retireRuntimeGenerations(this.runtimeGenerationsForFramework(frameworkId))
  }

  async applyReasoningEffortChange(effort: ResolvedReasoningEffort): Promise<boolean> {
    // The settings layer resolved this value against the currently selected model. Retiring
    // generations stay pinned to their own provider/model and therefore must not receive a value
    // resolved for a different model profile.
    return this.getActiveRuntime().applyReasoningEffortChange(effort)
  }

  async applyModelChange(target: AgentModelChangeTarget): Promise<boolean> {
    return this.getActiveRuntime().applyModelChange(target)
  }

  writeArtifactForCurrentRun(
    sessionId: string,
    input: Parameters<AcpRuntime['writeArtifactForCurrentRun']>[1]
  ): ReturnType<AcpRuntime['writeArtifactForCurrentRun']> {
    return this.runtimeForSession(sessionId).writeArtifactForCurrentRun(sessionId, input)
  }

  async withActivity<T>(
    options: AcpRuntimeActivityOptions,
    work: (runtime: AcpRuntimeActivity) => Promise<T>
  ): Promise<T> {
    this.assertPromptAdmissionOpen()
    const runtime = this.runtimeForTarget(options.session?.agentTarget)
    const scopedRuntime = this.createScopedActivityRuntime(runtime, options)

    return runtime.withActivity(options, () => {
      this.assertPromptAdmissionOpen()
      return work(scopedRuntime)
    })
  }

  async buildReviewerSession(
    request: Parameters<AcpRuntime['buildReviewerSession']>[0]
  ): ReturnType<AcpRuntime['buildReviewerSession']> {
    return this.buildReviewerSessionOnRuntime(this.getActiveRuntime(), request)
  }

  disposeReviewerSession(session: ActiveSession): ReturnType<AcpRuntime['disposeReviewerSession']> {
    const runtime = this.reviewerRuntimes.get(session) ?? this.getActiveRuntime()
    this.reviewerRuntimes.delete(session)
    return runtime.disposeReviewerSession(session)
  }

  private createScopedActivityRuntime(
    runtime: AcpRuntime,
    options: AcpRuntimeActivityOptions
  ): AcpRuntimeActivity {
    let resumeInFlight: Promise<boolean> | undefined

    const ensureActivitySession = async (sessionId: string): Promise<boolean> => {
      const session = options.session
      if (!session || session.sessionId !== sessionId) return false
      if (runtime.getSnapshot().sessionIds.includes(sessionId)) return false

      if (!resumeInFlight) {
        const resumeRequest: AcpResumeSessionRequest = {
          sessionId: session.sessionId,
          cwd: session.cwd,
          ...(session.projectId ? { projectId: session.projectId } : {}),
          ...(session.permissionProfile ? { permissionProfile: session.permissionProfile } : {}),
          memoryEnabled: session.memoryEnabled !== false,
          ...(session.previousFrameworkId
            ? { previousFrameworkId: session.previousFrameworkId }
            : {}),
          ...(session.previousBackendId ? { previousBackendId: session.previousBackendId } : {}),
          ...(session.specialistId ? { specialistId: session.specialistId } : {}),
          ...(session.specialistBindingPending === true ? { specialistBindingPending: true } : {}),
          ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
          ...(session.providerContinuityToken
            ? { providerContinuityToken: session.providerContinuityToken }
            : {}),
          ...(session.agentTarget ? { agentTarget: session.agentTarget } : {})
        }
        resumeInFlight = runtime.resumeSession(resumeRequest).then(async (response) => {
          this.sessionRuntimes.set(response.sessionId, runtime)
          this.lastRuntime = runtime
          await this.sessionResumeObserver?.(resumeRequest, response)
          return Boolean(response.contextReset)
        })
      }

      return resumeInFlight
    }

    return {
      captureBackend: () => runtime.captureBackend(),
      beginProviderTurnObservation: (input) => runtime.beginProviderTurnObservation(input),
      buildReviewerSession: (request) => this.buildReviewerSessionOnRuntime(runtime, request),
      disposeReviewerSession: (session) => {
        this.reviewerRuntimes.delete(session)
        return runtime.disposeReviewerSession(session)
      },
      sendPrompt: async (request) => {
        this.assertPromptAdmissionOpen()
        const contextReset = await ensureActivitySession(request.sessionId)
        await this.promptAdmissionGuard?.(request.sessionId)
        const historyPreamble = options.session?.historyPreamble
        return this.dispatchPrompt(
          contextReset
            ? {
                ...request,
                contextReset: true,
                ...(historyPreamble && !request.historyPreamble ? { historyPreamble } : {})
              }
            : request,
          undefined,
          'sendPrompt',
          runtime,
          false
        )
      },
      sendApplicationPrompt: (request, attribution) =>
        this.linearizeRootAdmission(request.sessionId, async () => {
          this.assertPromptAdmissionOpen()
          const contextReset = await ensureActivitySession(request.sessionId)
          await this.promptAdmissionGuard?.(request.sessionId)
          const historyPreamble = options.session?.historyPreamble
          return this.dispatchPrompt(
            contextReset
              ? {
                  ...request,
                  contextReset: true,
                  ...(historyPreamble && !request.historyPreamble ? { historyPreamble } : {})
                }
              : request,
            undefined,
            'sendApplicationPrompt',
            runtime,
            false,
            attribution
          )
        })
    }
  }

  private async buildReviewerSessionOnRuntime(
    runtime: AcpRuntime,
    request: Parameters<AcpRuntime['buildReviewerSession']>[0]
  ): ReturnType<AcpRuntime['buildReviewerSession']> {
    this.assertPromptAdmissionOpen()
    const built = await runtime.buildReviewerSession(request)
    if (this.promptAdmissionClosedForQuit) {
      try {
        runtime.disposeReviewerSession(built.session)
      } finally {
        this.assertPromptAdmissionOpen()
      }
    }
    this.reviewerRuntimes.set(built.session, runtime)
    return built
  }

  private async waitForInitialization(): Promise<void> {
    const generation = this.initializationGeneration
    await this.initializationBarrier
    if (generation !== this.initializationGeneration) {
      throw new Error('ACP initialization request was superseded.')
    }
  }

  private supersedeInitializationRequests(): void {
    this.initializationGeneration += 1
  }

  private assertPromptAdmissionOpen(): void {
    if (this.promptAdmissionClosedForQuit) {
      throw new Error('ACP prompt admission is closed because the app is quitting.')
    }
  }

  private rejectPromptForQuit(): Promise<never> {
    return Promise.reject(new Error('ACP prompt admission is closed because the app is quitting.'))
  }

  private invalidateSessionTurn(sessionId: string, notifyCancellation = true): void {
    for (const attempt of this.pendingPromptStarts.get(sessionId) ?? []) attempt.cancelled = true
    this.pendingPromptStarts.delete(sessionId)
    const activePrompt = this.activePromptRequests.get(sessionId)
    if (activePrompt && activePrompt.turnToken === undefined) {
      this.activePromptRequests.delete(sessionId)
    }
    this.notifyInteractionRelease(sessionId)
    if (notifyCancellation) this.teardownCallbacks.onSessionCancellationRequested?.(sessionId)
  }

  private invalidateAllSessionTurns(): void {
    this.globalCancellationGeneration += 1
    this.teardownCallbacks.onAllSessionsCancellationRequested?.()
  }

  private takePendingPromptStart(
    sessionId: string,
    runtime: AcpRuntime,
    attemptId: string | undefined
  ): PendingPromptStart | undefined {
    if (!attemptId) return undefined
    const pending = this.pendingPromptStarts.get(sessionId)
    if (!pending) return undefined
    const index = pending.findIndex(
      (attempt) => attempt.runtime === runtime && attempt.id === attemptId
    )
    if (index < 0) return undefined
    const [attempt] = pending.splice(index, 1)
    if (pending.length === 0) this.pendingPromptStarts.delete(sessionId)
    return attempt
  }

  private removePendingPromptStart(sessionId: string, attempt: PendingPromptStart): void {
    const pending = this.pendingPromptStarts.get(sessionId)
    if (!pending) return
    const index = pending.indexOf(attempt)
    if (index >= 0) pending.splice(index, 1)
    if (pending.length === 0) this.pendingPromptStarts.delete(sessionId)
    this.notifyInteractionRelease(sessionId)
  }

  private hasSessionInteraction(sessionId: string): boolean {
    return (
      this.pendingPromptStarts.has(sessionId) || (this.activePromptCounts.get(sessionId) ?? 0) > 0
    )
  }

  private notifyInteractionRelease(sessionId: string): void {
    if (this.hasSessionInteraction(sessionId)) return
    const waiters = this.interactionReleaseWaiters.get(sessionId)
    if (!waiters) return
    this.interactionReleaseWaiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }

  private getActiveRuntime(): AcpRuntime {
    if (!this.activeRuntime) this.activeRuntime = this.addRuntime()
    this.lastRuntime = this.activeRuntime
    return this.activeRuntime
  }

  private runtimeForSession(sessionId: string): AcpRuntime {
    return this.findRuntimeForSession(sessionId) ?? this.getActiveRuntime()
  }

  private findRuntimeForSession(sessionId: string): AcpRuntime | undefined {
    const owned = this.sessionRuntimes.get(sessionId)
    if (owned) return owned

    const discovered = Array.from(this.runtimes).find((runtime) =>
      runtime.getSnapshot().sessionIds.includes(sessionId)
    )
    if (discovered) {
      this.sessionRuntimes.set(sessionId, discovered)
      return discovered
    }

    return undefined
  }

  private runtimeForTarget(target: AcpSessionAgentTarget | undefined): AcpRuntime {
    if (!target) return this.getActiveRuntime()
    const key = JSON.stringify([
      target.frameworkId,
      target.providerId,
      target.model ?? null,
      target.reasoningEffort
    ])
    const existing = this.targetedRuntimes.get(key)
    if (existing && this.runtimes.has(existing) && !this.retiredRuntimes.has(existing)) {
      return existing
    }
    const runtime = this.addRuntime(target)
    this.runtimeTargetKeys.set(runtime, key)
    this.targetedRuntimes.set(key, runtime)
    return runtime
  }

  private addRuntime(target?: AcpSessionAgentTarget): AcpRuntime {
    const runtime = this.createRuntime(
      {
        onStateChanged: (snapshot) => this.handleRuntimeState(runtime, snapshot),
        ...(this.callbacks.onEvent
          ? {
              onEvent: (event: AcpRuntimeEvent) => {
                if (!this.shouldPublishEvent(runtime, event)) return
                this.callbacks.onEvent?.({ ...event, id: this.eventId(runtime, event.id) })
              }
            }
          : {}),
        onPermissionRequest: (request) => {
          this.permissionRuntimes.set(request.requestId, runtime)
          this.callbacks.onPermissionRequest?.(projectPermissionRequest(request))
        },
        onPermissionSettled: (requestId, state) => {
          this.callbacks.onPermissionSettled?.(requestId, state)
        },
        onPromptStarted: (sessionId, turnToken, promptAttemptId) => {
          const attempt = this.takePendingPromptStart(sessionId, runtime, promptAttemptId)
          this.activePromptCounts.set(sessionId, (this.activePromptCounts.get(sessionId) ?? 0) + 1)
          if (
            attempt &&
            !attempt.cancelled &&
            attempt.globalCancellationGeneration === this.globalCancellationGeneration
          ) {
            this.teardownCallbacks.onSessionTurnStarted?.(sessionId, turnToken)
          }
          const activePrompt = this.activePromptRequests.get(sessionId)
          if (activePrompt && activePrompt.attemptId === promptAttemptId) {
            activePrompt.turnToken = turnToken
          }
          this.callbacks.onPromptStarted?.(sessionId, turnToken)
        },
        onProviderPromptAccepted: (sessionId, promptAttemptId) => {
          const activePrompt = this.activePromptRequests.get(sessionId)
          if (activePrompt && activePrompt.attemptId === promptAttemptId) {
            activePrompt.acceptance?.resolve()
          }
          this.callbacks.onProviderPromptAccepted?.(sessionId, promptAttemptId)
        },
        onCodexWebSocketFallback: () => {
          this.callbacks.onCodexWebSocketFallback?.()
        },
        onPromptEnded: (sessionId, turnToken) => {
          const remaining = (this.activePromptCounts.get(sessionId) ?? 1) - 1
          if (remaining > 0) this.activePromptCounts.set(sessionId, remaining)
          else this.activePromptCounts.delete(sessionId)
          this.activeRootAdmissions.get(sessionId)?.release()
          this.notifyInteractionRelease(sessionId)
          this.teardownCallbacks.onSessionTurnEnded?.(sessionId, turnToken)
          this.callbacks.onPromptEnded?.(sessionId, turnToken)
        },
        onSkillImportAttachmentEligible: (sessionId, turnToken, attachmentUri) => {
          this.teardownCallbacks.onSkillImportAttachmentEligible?.(
            sessionId,
            turnToken,
            attachmentUri
          )
          this.callbacks.onSkillImportAttachmentEligible?.(sessionId, turnToken, attachmentUri)
        },
        onRetired: () => this.handleRuntimeRetired(runtime)
      },
      this.permissionGrantStore,
      target
    )
    this.runtimeSequence += 1
    this.runtimeIds.set(runtime, `runtime-${this.runtimeSequence}-${this.eventNamespace}`)
    if (target) this.runtimeTargets.set(runtime, target)
    this.runtimes.add(runtime)
    return runtime
  }

  private async retireUnusedTargetedRuntime(runtime: AcpRuntime | undefined): Promise<void> {
    if (
      !runtime ||
      !this.runtimeTargets.has(runtime) ||
      this.retiredRuntimes.has(runtime) ||
      Array.from(this.sessionRuntimes.values()).includes(runtime)
    ) {
      return
    }
    this.retiredRuntimes.add(runtime)
    await runtime.requestRetirement()
  }

  private runtimeGenerationsForFramework(frameworkId: AgentFrameworkId): AcpRuntime[] {
    return Array.from(this.runtimes).filter(
      (runtime) =>
        !this.retiredRuntimes.has(runtime) &&
        (this.runtimeTargets.get(runtime)?.frameworkId === frameworkId ||
          runtime
            .getSnapshot()
            .sessionIds.some((sessionId) =>
              runtime.isSessionUsingFramework(sessionId, frameworkId)
            ))
    )
  }

  private async retireRuntimeGenerations(runtimes: Iterable<AcpRuntime>): Promise<void> {
    const retiring = [...new Set(runtimes)].filter(
      (runtime) => this.runtimes.has(runtime) && !this.retiredRuntimes.has(runtime)
    )
    if (retiring.length === 0) return

    for (const runtime of retiring) this.retiredRuntimes.add(runtime)
    if (this.activeRuntime && retiring.includes(this.activeRuntime)) this.rotateActiveRuntime()
    this.emitState()
    await Promise.all(retiring.map((runtime) => runtime.requestRetirement()))
  }

  private handleRuntimeState(runtime: AcpRuntime, state: AcpStateUpdate): void {
    if (state.events) {
      const retainedEventIds = new Set(state.events.map((event) => event.id))
      const publishedEventIds = this.publishedRuntimeEventIds.get(runtime)
      if (publishedEventIds) {
        for (const eventId of publishedEventIds) {
          if (!retainedEventIds.has(eventId)) publishedEventIds.delete(eventId)
        }
      }
    }

    const attached = this.releaseMissingRuntimeSessions(runtime, state)
    for (const sessionId of attached) {
      // resumeSession owns the handoff commit. AcpRuntime emits its attached snapshot just before the
      // resume promise resolves; treating that intermediate state as ownership would again suppress
      // terminal events from the draining generation during the adoption window.
      if (this.pendingSessionAdoptions.get(sessionId) === runtime) continue

      const owner = this.sessionRuntimes.get(sessionId)
      // A late state emission from a retiring runtime must not steal back a session already adopted by
      // the current generation.
      if (
        !owner ||
        owner === runtime ||
        (this.retiredRuntimes.has(owner) && !this.retiredRuntimes.has(runtime))
      ) {
        this.sessionRuntimes.set(sessionId, runtime)
        this.sessionConnectionStatuses.set(sessionId, state.status)
      }
    }
    this.emitState()
    this.resolveSessionDrain(runtime, state)
  }

  private releaseMissingRuntimeSessions(runtime: AcpRuntime, state: AcpRuntimeState): Set<string> {
    const attached = new Set(state.sessionIds)
    for (const [sessionId, owner] of this.sessionRuntimes) {
      if (owner !== runtime || attached.has(sessionId)) continue

      this.sessionRuntimes.delete(sessionId)
      this.pendingResumeReconciliations.delete(sessionId)
      if (state.status === 'closed' || state.status === 'error') {
        this.sessionConnectionStatuses.set(sessionId, state.status)
      } else {
        this.sessionConnectionStatuses.delete(sessionId)
      }
      this.clearApplicationSessionEvents(sessionId)
      this.onSessionUnavailable?.(sessionId)
    }
    return attached
  }

  private handleRuntimeRetired(runtime: AcpRuntime): void {
    this.releaseRuntimeOwnership(runtime)
    this.emitState()
  }

  private releaseRuntimeOwnership(runtime: AcpRuntime): void {
    const targetKey = this.runtimeTargetKeys.get(runtime)
    if (targetKey && this.targetedRuntimes.get(targetKey) === runtime) {
      this.targetedRuntimes.delete(targetKey)
    }
    const retiredStatus = runtime.getSnapshot().status
    this.runtimes.delete(runtime)
    this.retiredRuntimes.delete(runtime)
    for (const [sessionId, owner] of this.sessionRuntimes) {
      if (owner !== runtime) continue
      this.sessionRuntimes.delete(sessionId)
      if (retiredStatus === 'closed' || retiredStatus === 'error') {
        this.sessionConnectionStatuses.set(sessionId, retiredStatus)
      } else {
        this.sessionConnectionStatuses.delete(sessionId)
      }
      this.clearApplicationSessionEvents(sessionId)
      this.onSessionUnavailable?.(sessionId)
    }
    for (const [sessionId, incoming] of this.pendingSessionAdoptions) {
      if (incoming === runtime) this.pendingSessionAdoptions.delete(sessionId)
    }
    for (const [sessionId, pending] of this.pendingResumeReconciliations) {
      if (pending.runtime === runtime) this.pendingResumeReconciliations.delete(sessionId)
    }
    for (const [sessionId, pending] of this.pendingSessionDrains) {
      if (pending.runtime !== runtime) continue
      this.pendingSessionDrains.delete(sessionId)
      pending.resolve()
    }
    for (const [requestId, owner] of this.permissionRuntimes) {
      if (owner === runtime) this.permissionRuntimes.delete(requestId)
    }
    if (this.activeRuntime === runtime) this.activeRuntime = undefined
    if (this.lastRuntime === runtime) {
      // Partial teardown keeps rejected runtimes for retry. If the runtime that did stop was also the
      // snapshot primary, retain one survivor as lastRuntime so the coordinator does not publish idle
      // while a live generation still owns sessions or permissions. Do not make a retired survivor the
      // active target for new work; getActiveRuntime may create the selected framework generation later.
      this.lastRuntime = this.activeRuntime ?? Array.from(this.runtimes).at(-1)
    }
  }

  private visibleSessionIds(runtime: AcpRuntime, snapshot: AcpRuntimeState): string[] {
    if (!this.retiredRuntimes.has(runtime)) return snapshot.sessionIds

    // Keep a retiring session visible only while its current turn still needs routing. Once idle it
    // deliberately disappears from coordinator aggregation; the next client turn uses resumeSession,
    // which re-discovers and adopts it under the selected framework.
    const active = new Set([
      ...snapshot.promptInFlightSessionIds,
      ...snapshot.pendingPermissions.map((request) => request.sessionId),
      ...(snapshot.pendingElicitations ?? []).map((request) => request.sessionId)
    ])
    return snapshot.sessionIds.filter((sessionId) => active.has(sessionId))
  }

  private waitForSessionDrain(runtime: AcpRuntime, sessionId: string): Promise<void> {
    if (!runtime.getSnapshot().promptInFlightSessionIds.includes(sessionId)) {
      return Promise.resolve()
    }

    const existing = this.pendingSessionDrains.get(sessionId)
    if (existing?.runtime === runtime) return existing.promise
    if (existing) existing.resolve()

    let resolve!: () => void
    const promise = new Promise<void>((promiseResolve) => {
      resolve = promiseResolve
    })
    this.pendingSessionDrains.set(sessionId, { runtime, promise, resolve })
    return promise
  }

  private resolveSessionDrain(runtime: AcpRuntime, snapshot: AcpRuntimeState): void {
    const inFlight = new Set(snapshot.promptInFlightSessionIds)
    for (const [sessionId, pending] of this.pendingSessionDrains) {
      if (pending.runtime !== runtime || inFlight.has(sessionId)) continue
      this.pendingSessionDrains.delete(sessionId)
      pending.resolve()
    }
  }

  private shouldPublishEvent(runtime: AcpRuntime, event: AcpRuntimeEvent): boolean {
    const owner = event.sessionId ? this.sessionRuntimes.get(event.sessionId) : undefined
    const belongsToPreviousOwner = owner !== undefined && owner !== runtime
    const publishedEventIds = this.publishedRuntimeEventIds.get(runtime)
    if (publishedEventIds?.has(event.id)) {
      // Chat/tool/stop events admitted during the drain stay visible long enough for the renderer to
      // consume them. Control events must not survive ownership transfer, because a remounted hook has
      // no durable dedup state and would execute the old recovery lifecycle again.
      if (belongsToPreviousOwner && isOwnershipScopedControlEvent(event)) return false
      if (belongsToPreviousOwner && event.kind === 'artifact') return hasArtifactProvenance(event)
      return true
    }

    const shouldPublish =
      !event.sessionId ||
      owner === undefined ||
      owner === runtime ||
      (event.kind === 'artifact' && hasArtifactProvenance(event))

    if (shouldPublish) {
      const remembered = publishedEventIds ?? new Set<string>()
      remembered.add(event.id)
      while (remembered.size > MAX_ACP_RUNTIME_EVENTS) {
        const oldest = remembered.values().next()
        if (oldest.done) break
        remembered.delete(oldest.value)
      }
      if (!publishedEventIds) this.publishedRuntimeEventIds.set(runtime, remembered)
    }

    // Every session-scoped event belongs to the runtime generation that emitted it. Once a fresh
    // generation adopts the same logical session, late tool/message/stop events from the draining
    // generation must not mutate the new Runtime Segment. Artifact claims are the exception above:
    // providers may publish them after stop, and their explicit run/prompt ids finalize the prior turn.
    // Events already admitted while this runtime owned the session remain visible in later snapshots
    // until the runtime's bounded event window drops them, so an ownership broadcast cannot erase a
    // terminal event before the renderer consumes it. Preserve events while ownership is unknown so
    // discovery and pre-adoption behavior stay intact.
    return shouldPublish
  }

  private eventId(runtime: AcpRuntime, eventId: string): string {
    return `${this.runtimeIds.get(runtime) ?? 'runtime'}:${eventId}`
  }

  private rotateActiveRuntime(): void {
    if (this.activeRuntime) this.lastRuntime = this.activeRuntime
    this.activeRuntime = undefined
  }

  private async shutdownAll(
    shutdown: (runtime: AcpRuntime) => Promise<{ reaped: boolean }>,
    stopDelegatedWork: () => Promise<void> | undefined
  ): Promise<{ reaped: boolean }> {
    const runtimes = Array.from(this.runtimes)
    const [delegatedOutcome, ...outcomes] = await Promise.allSettled([
      stopDelegatedWork() ?? Promise.resolve(),
      ...runtimes.map(shutdown)
    ])
    const failure =
      outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected') ??
      (delegatedOutcome.status === 'rejected' ? delegatedOutcome : undefined)
    if (failure) {
      // Awaitable shutdown paths suppress each runtime's closed-state event. Account for partial
      // success here so only runtimes that really stopped release their routing ownership.
      // Rejected teardowns may nevertheless have cleared their session maps before the failing step.
      outcomes.forEach((outcome, index) => {
        const runtime = runtimes[index]
        if (outcome.status === 'fulfilled') this.releaseRuntimeOwnership(runtime)
        else this.releaseMissingRuntimeSessions(runtime, runtime.getSnapshot())
      })
      this.emitState()
      throw failure.reason
    }
    this.clearRuntimeOwnership()
    this.onDisconnected?.()
    return {
      reaped: outcomes.every((outcome) => outcome.status === 'fulfilled' && outcome.value.reaped)
    }
  }

  private clearRuntimeOwnership(): void {
    this.runtimes.clear()
    this.retiredRuntimes.clear()
    this.targetedRuntimes.clear()
    this.sessionRuntimes.clear()
    this.pendingSessionAdoptions.clear()
    this.pendingResumeReconciliations.clear()
    for (const pending of this.pendingSessionDrains.values()) pending.resolve()
    this.pendingSessionDrains.clear()
    this.sessionConnectionStatuses.clear()
    this.permissionRuntimes.clear()
    this.pendingPromptStarts.clear()
    this.latestPromptRequests.clear()
    this.activePromptRequests.clear()
    this.applicationEvents.length = 0
    this.latestPromptRequests.clear()
    this.activeRuntime = undefined
    this.lastRuntime = undefined
  }

  private clearApplicationSessionEvents(sessionId: string): void {
    for (let index = this.applicationEvents.length - 1; index >= 0; index -= 1) {
      if (this.applicationEvents[index].sessionId === sessionId) {
        this.applicationEvents.splice(index, 1)
      }
    }
  }
}

export { AcpRuntimeCoordinator }
