import type { ActiveSession } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpRuntimeEvent,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import type { AcpHandoffFailure } from '../../shared/acp'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { AgentFrameworkId } from '../../shared/settings'
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import { ConversationPermissionGrantStore } from './permission-broker'
import type { ApprovedSwitchReadBack, ClaudeCodeReplayInput } from '../agents/claude-code-handoff'
import type { ShutdownStepOutcome } from '../lifecycle-shutdown'
import type { AgentModelChangeTarget } from '../agent-framework'

const MAX_EVENTS = 500
const QUIT_PREPARATION_TIMEOUT_MS = 4_000

const isOwnershipScopedControlEvent = (event: AcpRuntimeEvent): boolean =>
  event.kind === 'compaction' || event.recoverable === 'context-overflow'

const hasArtifactProvenance = (event: AcpRuntimeEvent): boolean =>
  Boolean(event.runId && event.promptMessageId && event.artifactClaimId)

type RuntimeFactory = (
  callbacks: AcpRuntimeCallbacks,
  permissionGrantStore: ConversationPermissionGrantStore
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
  beforeSessionDelete?: (sessionId: string) => Promise<void>
}

type PermissionGrantSnapshotProvider = () => AcpStateSnapshot['permissionGrants']

type PendingPromptStart = {
  id: string
  runtime: AcpRuntime
  sessionCancellationGeneration: number
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
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  settled: boolean
}

type PendingSessionDrain = {
  runtime: AcpRuntime
  promise: Promise<void>
  resolve: () => void
}

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
  private readonly publishedRuntimeEventIds = new WeakMap<AcpRuntime, Set<string>>()
  private readonly applicationEvents: AcpRuntimeEvent[] = []
  private readonly permissionGrantStore = new ConversationPermissionGrantStore()
  // Runtime events are persisted on Message nodes. A process-local sequence alone restarts at one
  // after every app launch and can collide with a historical Session's event ids.
  private readonly eventNamespace = randomUUID()
  private runtimeSequence = 0
  private initializationGeneration = 0
  private globalCancellationGeneration = 0
  private promptAttemptSequence = 0
  private readonly sessionCancellationGenerations = new Map<string, number>()
  private readonly pendingPromptStarts = new Map<string, PendingPromptStart[]>()
  private readonly activePromptRequests = new Map<string, ActivePromptRequest>()
  private readonly activePromptCounts = new Map<string, number>()
  private readonly interactionReleaseWaiters = new Map<string, Set<() => void>>()
  private promptAdmissionGuard?: (sessionId: string) => Promise<void>
  private promptAdmissionClosedForQuit = false
  private readonly pendingSessionAdoptions = new Map<string, AcpRuntime>()
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
    private readonly permissionGrantSnapshot?: PermissionGrantSnapshotProvider
  ) {
    this.activeRuntime = this.addRuntime()
    this.lastRuntime = this.activeRuntime
  }

  getSnapshot(): AcpStateSnapshot {
    const snapshots = Array.from(this.runtimes, (runtime) => ({
      runtime,
      snapshot: runtime.getSnapshot()
    }))
    const primaryRuntime = this.activeRuntime ?? this.lastRuntime
    const primary = snapshots.find(({ runtime }) => runtime === primaryRuntime)?.snapshot
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
      .slice(-MAX_EVENTS)
    const sessionIds = Array.from(
      new Set(
        snapshots.flatMap(({ runtime, snapshot }) => this.visibleSessionIds(runtime, snapshot))
      )
    )
    // A retired generation may keep draining after the same logical session was resumed by a fresh
    // runtime. Only its current owner may publish interaction state to the renderer.
    const ownedSessionIds = (select: (snapshot: AcpStateSnapshot) => readonly string[]): string[] =>
      Array.from(
        new Set(
          snapshots.flatMap(({ runtime, snapshot }) =>
            select(snapshot).filter((sessionId) => this.sessionRuntimes.get(sessionId) === runtime)
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
      snapshots.flatMap(({ runtime, snapshot }) =>
        // A framework selection takes effect immediately even when the prior generation must finish
        // an active turn. Keep its conversation visible for routing, but stop publishing its context.
        this.retiredRuntimes.has(runtime)
          ? []
          : this.visibleSessionIds(runtime, snapshot).flatMap((sessionId) => {
              // A runtime may still hold a stale measurement after the same logical session was adopted
              // by the next generation. Only the current owner may publish its context.
              if (this.sessionRuntimes.get(sessionId) !== runtime) return []
              const contextUsage = snapshot.contextUsageBySession[sessionId]
              return contextUsage ? [[sessionId, contextUsage] as const] : []
            })
      )
    )
    const nativeContextCompactionSessionIds = snapshots.flatMap(({ runtime, snapshot }) =>
      this.retiredRuntimes.has(runtime)
        ? []
        : (snapshot.nativeContextCompactionSessionIds ?? []).filter(
            (sessionId) =>
              this.sessionRuntimes.get(sessionId) === runtime && sessionIds.includes(sessionId)
          )
    )

    return {
      status: primary?.status ?? 'idle',
      sessionConnectionStatuses: Object.fromEntries(this.sessionConnectionStatuses),
      cwd: primary?.cwd ?? this.defaultCwd,
      ...(primary?.sessionId && sessionIds.includes(primary.sessionId)
        ? { sessionId: primary.sessionId }
        : {}),
      sessionIds,
      ...(primary?.error ? { error: primary.error } : {}),
      events,
      pendingPermissions: snapshots.flatMap(({ snapshot }) => snapshot.pendingPermissions),
      permissionProfiles: Object.assign(
        {},
        ...snapshots.map(({ snapshot }) => snapshot.permissionProfiles)
      ),
      permissionGrants: this.permissionGrantSnapshot?.() ?? this.permissionGrantStore.snapshot(),
      contextUsageBySession,
      nativeContextCompactionSessionIds,
      promptInFlight: promptInFlightSessionIds.length > 0,
      agentPromptInFlightSessionIds,
      promptInFlightSessionIds
    }
  }

  callSessionPlan(input: Parameters<AcpRuntime['callSessionPlan']>[0]): Promise<unknown> {
    const runtime = this.sessionRuntimes.get(input.sessionId) ?? this.activeRuntime
    if (!runtime) return Promise.reject(new Error('No active runtime owns the Session Plan call.'))
    return runtime.callSessionPlan(input)
  }

  getSessionPlanProjection(
    projectId: string,
    sessionId: string
  ): ReturnType<AcpRuntime['getSessionPlanProjection']> {
    const runtime = this.sessionRuntimes.get(sessionId) ?? this.activeRuntime
    return runtime?.getSessionPlanProjection(projectId, sessionId) ?? Promise.resolve(null)
  }

  respondSessionPlan(
    input: Parameters<AcpRuntime['respondSessionPlan']>[0]
  ): ReturnType<AcpRuntime['respondSessionPlan']> {
    const runtime = this.sessionRuntimes.get(input.sessionId) ?? this.activeRuntime
    if (!runtime)
      return Promise.reject(new Error('No active runtime owns the Session Plan response.'))
    return runtime.respondSessionPlan(input)
  }

  getActivePromptSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.runtimes).flatMap((runtime) => runtime.getActivePromptSessions())
  }

  hasLiveSession(projectId: string, sessionId: string): boolean {
    const runtime = this.sessionRuntimes.get(sessionId)
    return runtime?.hasLiveSession(projectId, sessionId) ?? false
  }

  liveSessionProjectId(sessionId: string): string | undefined {
    return this.sessionRuntimes.get(sessionId)?.liveSessionProjectId(sessionId)
  }

  getSessionFramework(sessionId: string): AgentFrameworkId | undefined {
    return this.findRuntimeForSession(sessionId)?.getSessionFramework(sessionId)
  }

  getActiveArtifactRunIds(): string[] {
    return Array.from(this.runtimes).flatMap((runtime) => runtime.getActiveArtifactRunIds())
  }

  async connect(request: AcpConnectRequest = {}): Promise<AcpStateSnapshot> {
    await this.waitForInitialization()
    const runtime = this.getActiveRuntime()
    await runtime.connect(request)
    return this.getSnapshot()
  }

  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    // User teardown intent invalidates held approvals synchronously. Runtime shutdown may take time or
    // reject after partial cleanup, but a dialog that was already open must not remain actionable.
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    const runtimes = Array.from(this.runtimes)
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.disconnect(emitClosedStatus))
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
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
      this.callbacks.onStateChanged?.(this.getSnapshot())
      throw failure.reason
    }
    this.clearRuntimeOwnership()
    this.onDisconnected?.()
    return this.getSnapshot()
  }

  shutdown(): void {
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    for (const runtime of this.runtimes) runtime.shutdown()
    this.clearRuntimeOwnership()
    this.onDisconnected?.()
  }

  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    return this.shutdownAll((runtime) => runtime.shutdownForQuit())
  }

  // Gives active agents a bounded chance to return their terminal stop response before process-tree
  // teardown. Those responses carry the final usage available from Claude Code/OpenCode/managed Codex;
  // an unresponsive agent cannot hold app quit indefinitely.
  async prepareForQuit(
    timeoutMs = QUIT_PREPARATION_TIMEOUT_MS
  ): Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>> {
    this.promptAdmissionClosedForQuit = true
    const sessionIds = Array.from(
      new Set([
        ...this.activePromptRequests.keys(),
        ...this.pendingPromptStarts.keys(),
        ...this.getSnapshot().promptInFlightSessionIds
      ])
    )
    if (sessionIds.length === 0) return 'completed'

    const cancelAndDrain = async (): Promise<void> => {
      await Promise.allSettled(
        sessionIds.map((sessionId) => this.cancelPrompt({ sessionId }).then(() => undefined))
      )
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

  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.invalidateAllSessionTurns()
    this.supersedeInitializationRequests()
    return this.shutdownAll((runtime) => runtime.shutdownForUpdateGate())
  }

  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    await this.waitForInitialization()
    const runtime = this.getActiveRuntime()
    const response = await runtime.createSession(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  async resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    await this.waitForInitialization()
    const owner = this.findRuntimeForSession(request.sessionId)
    const runtime = owner && !this.retiredRuntimes.has(owner) ? owner : this.getActiveRuntime()
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
    if (transfersOwnership) this.callbacks.onStateChanged?.(this.getSnapshot())
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
    this.callbacks.onStateChanged?.(this.getSnapshot())
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
    if (this.applicationEvents.length > MAX_EVENTS) {
      this.applicationEvents.splice(0, this.applicationEvents.length - MAX_EVENTS)
    }
    this.callbacks.onEvent?.(event)
    this.callbacks.onStateChanged?.(this.getSnapshot())
  }

  async compactSession(request: AcpCompactSessionRequest): Promise<AcpStateSnapshot> {
    this.assertPromptAdmissionOpen()
    await this.waitForInitialization()
    this.assertPromptAdmissionOpen()
    await this.runtimeForSession(request.sessionId).compactSession(request)
    return this.getSnapshot()
  }

  setPromptAdmissionGuard(guard: (sessionId: string) => Promise<void>): void {
    this.promptAdmissionGuard = guard
  }

  sendPrompt(request: AcpPromptRequest): ReturnType<AcpRuntime['sendPrompt']> {
    if (this.promptAdmissionClosedForQuit) return this.rejectPromptForQuit()
    if (!this.promptAdmissionGuard) return this.dispatchPrompt(request, undefined, 'sendPrompt')
    return this.promptAdmissionGuard(request.sessionId).then(() =>
      this.dispatchPrompt(request, undefined, 'sendPrompt')
    )
  }

  sendAppContinuation(request: AcpPromptRequest): ReturnType<AcpRuntime['sendAppContinuation']> {
    return this.dispatchPrompt(request, undefined, 'sendAppContinuation')
  }

  // Starts an app-owned continuation and resolves only once the provider produces its first update.
  // A rejection before that point remains a handoff-start failure owned by CompletionGateCoordinator.
  startContinuation(request: AcpPromptRequest): Promise<void> {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const acceptance: PromptAcceptance = {
      promise: new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
      }),
      resolve: () => undefined,
      reject: () => undefined,
      settled: false
    }
    acceptance.resolve = () => {
      if (acceptance.settled) return
      acceptance.settled = true
      resolve()
    }
    acceptance.reject = (error) => {
      if (acceptance.settled) return
      acceptance.settled = true
      reject(error)
    }

    void this.dispatchPrompt(request, acceptance, 'sendAppContinuation').catch((error) =>
      acceptance.reject(error)
    )
    return acceptance.promise
  }

  private dispatchPrompt(
    request: AcpPromptRequest,
    acceptance: PromptAcceptance | undefined,
    operation: 'sendPrompt' | 'sendAppContinuation',
    pinnedRuntime?: AcpRuntime,
    retainAsLatestUserPrompt = operation === 'sendPrompt'
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
      sessionCancellationGeneration:
        this.sessionCancellationGenerations.get(request.sessionId) ?? 0,
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
    return runtime[operation](taskRequest, attempt.id).finally(() => {
      this.removePendingPromptStart(request.sessionId, attempt)
      if (this.activePromptRequests.get(request.sessionId) === activePrompt) {
        this.activePromptRequests.delete(request.sessionId)
      }
    })
  }

  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    this.invalidateSessionTurn(request.sessionId)
    await this.runtimeForSession(request.sessionId).cancelPrompt(request)
    return this.getSnapshot()
  }

  async stopPromptForHandoff(sessionId: string): Promise<void> {
    // Supersede the old turn exactly like user cancellation, but do not emit the user-generation
    // cancellation callback: that callback marks the approved handoff itself cancelled.
    this.invalidateSessionTurn(sessionId, false)
    await this.runtimeForSession(sessionId).cancelPrompt({ sessionId })
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

  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    this.invalidateSessionTurn(request.sessionId)
    this.activePromptRequests.delete(request.sessionId)
    const runtime = this.runtimeForSession(request.sessionId)
    const ownedBeforeDelete = this.sessionRuntimes.get(request.sessionId) === runtime
    await this.teardownCallbacks.beforeSessionDelete?.(request.sessionId)
    await runtime.deleteSession(request)
    const ownerAfterDelete = this.sessionRuntimes.get(request.sessionId)
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
    return this.getSnapshot()
  }

  async respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot> {
    const runtime =
      this.permissionRuntimes.get(response.requestId) ??
      Array.from(this.runtimes).find((candidate) =>
        candidate
          .getSnapshot()
          .pendingPermissions.some((request) => request.requestId === response.requestId)
      ) ??
      this.getActiveRuntime()
    try {
      await runtime.respondToPermission(response)
    } finally {
      this.permissionRuntimes.delete(response.requestId)
    }
    return this.getSnapshot()
  }

  // Keeps an app-owned approval on the runtime that owns the conversation, so the existing ACP
  // broker/card can be used across framework generations without a parallel responder path.
  async requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
  }): Promise<boolean> {
    return this.runtimeForSession(input.sessionId).requestAppApproval(input)
  }

  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    await this.runtimeForSession(request.sessionId).setPermissionProfile(request)
    return this.getSnapshot()
  }

  async revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpStateSnapshot> {
    await this.runtimeForSession(request.sessionId).revokePermissionGrant(request)
    return this.getSnapshot()
  }

  notifyPermissionGrantsChanged(): void {
    this.callbacks.onStateChanged?.(this.getSnapshot())
  }

  // A framework change takes effect for every future turn and workflow. The old generation stays alive
  // until its active prompts and workflow leases finish; idle sessions resume on demand.
  async requestAgentFrameworkSwitch(): Promise<void> {
    const retiring = this.activeRuntime
    if (!retiring) return

    this.retiredRuntimes.add(retiring)
    this.rotateActiveRuntime()
    await retiring.requestRetirement()
  }

  // Reconnect-triggering settings target the generation that owns future turns. Retiring generations
  // stay pinned to the backend of the workflow they are finishing; reconnecting them here can strand a
  // later workflow operation behind a barrier that its own activity lease prevents from resolving.
  requestProviderReconnect(): Promise<void> {
    return this.getActiveRuntime().requestProviderReconnect()
  }

  async requestSkillsReload(): Promise<void> {
    const retiring = this.activeRuntime
    if (!retiring) return

    // Skills are part of a runtime generation's tool list and context. Retire that generation
    // immediately so idle conversations detach before the settings call returns; active turns finish
    // on the old generation, while every later turn resumes through a freshly provisioned runtime.
    this.retiredRuntimes.add(retiring)
    this.rotateActiveRuntime()
    this.callbacks.onStateChanged?.(this.getSnapshot())
    await retiring.requestRetirement()
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
    const runtime = this.getActiveRuntime()
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
          ...(session.projectName ? { projectName: session.projectName } : {}),
          ...(session.permissionProfile ? { permissionProfile: session.permissionProfile } : {}),
          ...(session.previousFrameworkId
            ? { previousFrameworkId: session.previousFrameworkId }
            : {}),
          ...(session.previousBackendId ? { previousBackendId: session.previousBackendId } : {})
        }
        resumeInFlight = runtime.resumeSession(resumeRequest).then((response) => {
          this.sessionRuntimes.set(response.sessionId, runtime)
          this.lastRuntime = runtime
          return Boolean(response.contextReset)
        })
      }

      return resumeInFlight
    }

    return {
      buildReviewerSession: (request) => this.buildReviewerSessionOnRuntime(runtime, request),
      disposeReviewerSession: (session) => {
        this.reviewerRuntimes.delete(session)
        return runtime.disposeReviewerSession(session)
      },
      sendPrompt: async (request) => {
        this.assertPromptAdmissionOpen()
        const contextReset = await ensureActivitySession(request.sessionId)
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
      }
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
    this.sessionCancellationGenerations.set(
      sessionId,
      (this.sessionCancellationGenerations.get(sessionId) ?? 0) + 1
    )
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

  private addRuntime(): AcpRuntime {
    const runtime = this.createRuntime(
      {
        onStateChanged: (snapshot) => this.handleRuntimeState(runtime, snapshot),
        onEvent: (event) => {
          if (!this.shouldPublishEvent(runtime, event)) return
          this.callbacks.onEvent?.({ ...event, id: this.eventId(runtime, event.id) })
        },
        onPermissionRequest: (request) => {
          this.permissionRuntimes.set(request.requestId, runtime)
          this.callbacks.onPermissionRequest?.(request)
        },
        onPromptStarted: (sessionId, turnToken, promptAttemptId) => {
          const attempt = this.takePendingPromptStart(sessionId, runtime, promptAttemptId)
          this.activePromptCounts.set(sessionId, (this.activePromptCounts.get(sessionId) ?? 0) + 1)
          if (
            attempt &&
            attempt.globalCancellationGeneration === this.globalCancellationGeneration &&
            attempt.sessionCancellationGeneration ===
              (this.sessionCancellationGenerations.get(sessionId) ?? 0)
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
        },
        onPromptEnded: (sessionId, turnToken) => {
          const remaining = (this.activePromptCounts.get(sessionId) ?? 1) - 1
          if (remaining > 0) this.activePromptCounts.set(sessionId, remaining)
          else this.activePromptCounts.delete(sessionId)
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
      this.permissionGrantStore
    )
    this.runtimeSequence += 1
    this.runtimeIds.set(runtime, `runtime-${this.runtimeSequence}-${this.eventNamespace}`)
    this.runtimes.add(runtime)
    return runtime
  }

  private handleRuntimeState(runtime: AcpRuntime, snapshot: AcpStateSnapshot): void {
    const retainedEventIds = new Set(snapshot.events.map((event) => event.id))
    const publishedEventIds = this.publishedRuntimeEventIds.get(runtime)
    if (publishedEventIds) {
      for (const eventId of publishedEventIds) {
        if (!retainedEventIds.has(eventId)) publishedEventIds.delete(eventId)
      }
    }

    const attached = this.releaseMissingRuntimeSessions(runtime, snapshot)
    for (const sessionId of attached) {
      // resumeSession owns the handoff commit. AcpRuntime emits its attached snapshot just before the
      // resume promise resolves; treating that intermediate state as ownership would again suppress
      // terminal events from the draining generation during the adoption window.
      if (this.pendingSessionAdoptions.get(sessionId) === runtime) continue

      const owner = this.sessionRuntimes.get(sessionId)
      // A late state emission from a retiring runtime must not steal back a session already adopted by
      // the current generation.
      if (!owner || !this.retiredRuntimes.has(runtime) || this.retiredRuntimes.has(owner)) {
        this.sessionRuntimes.set(sessionId, runtime)
        this.sessionConnectionStatuses.set(sessionId, snapshot.status)
      }
    }
    this.callbacks.onStateChanged?.(this.getSnapshot())
    this.resolveSessionDrain(runtime, snapshot)
  }

  private releaseMissingRuntimeSessions(
    runtime: AcpRuntime,
    snapshot: AcpStateSnapshot
  ): Set<string> {
    const attached = new Set(snapshot.sessionIds)
    for (const [sessionId, owner] of this.sessionRuntimes) {
      if (owner !== runtime || attached.has(sessionId)) continue

      this.sessionRuntimes.delete(sessionId)
      if (snapshot.status === 'closed' || snapshot.status === 'error') {
        this.sessionConnectionStatuses.set(sessionId, snapshot.status)
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
    this.callbacks.onStateChanged?.(this.getSnapshot())
  }

  private releaseRuntimeOwnership(runtime: AcpRuntime): void {
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

  private visibleSessionIds(runtime: AcpRuntime, snapshot: AcpStateSnapshot): string[] {
    if (!this.retiredRuntimes.has(runtime)) return snapshot.sessionIds

    // Keep a retiring session visible only while its current turn still needs routing. Once idle it
    // deliberately disappears from coordinator aggregation; the next client turn uses resumeSession,
    // which re-discovers and adopts it under the selected framework.
    const active = new Set([
      ...snapshot.promptInFlightSessionIds,
      ...snapshot.pendingPermissions.map((request) => request.sessionId)
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

  private resolveSessionDrain(runtime: AcpRuntime, snapshot: AcpStateSnapshot): void {
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
    shutdown: (runtime: AcpRuntime) => Promise<{ reaped: boolean }>
  ): Promise<{ reaped: boolean }> {
    const runtimes = Array.from(this.runtimes)
    const outcomes = await Promise.allSettled(runtimes.map(shutdown))
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    if (failure) {
      // Awaitable shutdown paths suppress each runtime's closed-state event. Account for partial
      // success here so only runtimes that really stopped release their routing ownership.
      // Rejected teardowns may nevertheless have cleared their session maps before the failing step.
      outcomes.forEach((outcome, index) => {
        const runtime = runtimes[index]
        if (outcome.status === 'fulfilled') this.releaseRuntimeOwnership(runtime)
        else this.releaseMissingRuntimeSessions(runtime, runtime.getSnapshot())
      })
      this.callbacks.onStateChanged?.(this.getSnapshot())
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
    this.sessionRuntimes.clear()
    this.pendingSessionAdoptions.clear()
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
