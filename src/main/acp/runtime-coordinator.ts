import type { ActiveSession } from '@agentclientprotocol/sdk'

import type {
  AcpCancelPromptRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpDeleteSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'
import { ConversationPermissionGrantStore } from './permission-broker'

const MAX_EVENTS = 500

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
}

type PendingPromptStart = {
  id: string
  runtime: AcpRuntime
  sessionCancellationGeneration: number
  globalCancellationGeneration: number
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
  private readonly permissionGrantStore = new ConversationPermissionGrantStore()
  private runtimeSequence = 0
  private initializationGeneration = 0
  private globalCancellationGeneration = 0
  private promptAttemptSequence = 0
  private readonly sessionCancellationGenerations = new Map<string, number>()
  private readonly pendingPromptStarts = new Map<string, PendingPromptStart[]>()
  private activeRuntime: AcpRuntime | undefined
  private lastRuntime: AcpRuntime | undefined

  constructor(
    private readonly createRuntime: RuntimeFactory,
    private readonly callbacks: AcpRuntimeCallbacks = {},
    private readonly defaultCwd = '',
    private readonly initializationBarrier?: Promise<unknown>,
    private readonly onDisconnected?: () => void,
    private readonly onSessionUnavailable?: (sessionId: string) => void,
    private readonly teardownCallbacks: AcpRuntimeCoordinatorTeardownCallbacks = {}
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
    const events = snapshots
      .flatMap(({ runtime, snapshot }) =>
        snapshot.events.map((event) => ({
          ...event,
          id: this.eventId(runtime, event.id)
        }))
      )
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_EVENTS)
    const sessionIds = Array.from(
      new Set(
        snapshots.flatMap(({ runtime, snapshot }) => this.visibleSessionIds(runtime, snapshot))
      )
    )
    const promptInFlightSessionIds = snapshots.flatMap(
      ({ snapshot }) => snapshot.promptInFlightSessionIds
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
      permissionGrants: this.permissionGrantStore.snapshot(),
      contextUsageBySession,
      promptInFlight: promptInFlightSessionIds.length > 0,
      promptInFlightSessionIds
    }
  }

  getActivePromptSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.runtimes).flatMap((runtime) => runtime.getActivePromptSessions())
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
    const response = await runtime.resumeSession(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
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

  sendPrompt(request: AcpPromptRequest): ReturnType<AcpRuntime['sendPrompt']> {
    const owner = this.findRuntimeForSession(request.sessionId)
    if (owner && this.retiredRuntimes.has(owner)) {
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
    return runtime
      .sendPrompt(request, attempt.id)
      .finally(() => this.removePendingPromptStart(request.sessionId, attempt))
  }

  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    this.invalidateSessionTurn(request.sessionId)
    await this.runtimeForSession(request.sessionId).cancelPrompt(request)
    return this.getSnapshot()
  }

  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    this.invalidateSessionTurn(request.sessionId)
    const runtime = this.runtimeForSession(request.sessionId)
    const ownedBeforeDelete = this.sessionRuntimes.get(request.sessionId) === runtime
    await runtime.deleteSession(request)
    const ownerAfterDelete = this.sessionRuntimes.get(request.sessionId)
    // Attached deletes emit a runtime state change, whose reconciliation already notifies exactly once.
    // Detached cleanup deliberately emits no state, so complete its session-scoped teardown here. A
    // concurrent resume may have transferred the same app session to a new generation while the old
    // agent delete was in flight; preserve that new owner and its connection status in full.
    if (ownerAfterDelete === runtime || (!ownerAfterDelete && !ownedBeforeDelete)) {
      this.sessionRuntimes.delete(request.sessionId)
      this.sessionConnectionStatuses.delete(request.sessionId)
      this.onSessionUnavailable?.(request.sessionId)
    }
    return this.getSnapshot()
  }

  respondToPermission(response: AcpPermissionResponse): AcpStateSnapshot {
    const runtime =
      this.permissionRuntimes.get(response.requestId) ??
      Array.from(this.runtimes).find((candidate) =>
        candidate
          .getSnapshot()
          .pendingPermissions.some((request) => request.requestId === response.requestId)
      ) ??
      this.getActiveRuntime()
    runtime.respondToPermission(response)
    this.permissionRuntimes.delete(response.requestId)
    return this.getSnapshot()
  }

  async setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot> {
    await this.runtimeForSession(request.sessionId).setPermissionProfile(request)
    return this.getSnapshot()
  }

  revokePermissionGrant(request: AcpRevokePermissionGrantRequest): AcpStateSnapshot {
    this.runtimeForSession(request.sessionId).revokePermissionGrant(request)
    return this.getSnapshot()
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
    const runtime = this.getActiveRuntime()
    const scopedRuntime = this.createScopedActivityRuntime(runtime, options)

    return runtime.withActivity(options, () => work(scopedRuntime))
  }

  async buildReviewerSession(
    request: Parameters<AcpRuntime['buildReviewerSession']>[0]
  ): ReturnType<AcpRuntime['buildReviewerSession']> {
    const runtime = this.getActiveRuntime()
    const built = await runtime.buildReviewerSession(request)
    this.reviewerRuntimes.set(built.session, runtime)
    return built
  }

  disposeReviewerSession(session: ActiveSession): ReturnType<AcpRuntime['disposeReviewerSession']> {
    const runtime = this.reviewerRuntimes.get(session) ?? this.getActiveRuntime()
    this.reviewerRuntimes.delete(session)
    return runtime.disposeReviewerSession(session)
  }

  reviewerRejectedToolCallCount(sessionId: string): number {
    return Array.from(this.runtimes).reduce(
      (count, runtime) => count + runtime.reviewerRejectedToolCallCount(sessionId),
      0
    )
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
      buildReviewerSession: async (request) => {
        const built = await runtime.buildReviewerSession(request)
        this.reviewerRuntimes.set(built.session, runtime)
        return built
      },
      disposeReviewerSession: (session) => {
        this.reviewerRuntimes.delete(session)
        return runtime.disposeReviewerSession(session)
      },
      sendPrompt: async (request) => {
        const contextReset = await ensureActivitySession(request.sessionId)
        const historyPreamble = options.session?.historyPreamble
        return runtime.sendPrompt(
          contextReset && historyPreamble && !request.historyPreamble
            ? { ...request, historyPreamble }
            : request
        )
      }
    }
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

  private invalidateSessionTurn(sessionId: string): void {
    this.sessionCancellationGenerations.set(
      sessionId,
      (this.sessionCancellationGenerations.get(sessionId) ?? 0) + 1
    )
    this.teardownCallbacks.onSessionCancellationRequested?.(sessionId)
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
        onEvent: (event) =>
          this.callbacks.onEvent?.({ ...event, id: this.eventId(runtime, event.id) }),
        onPermissionRequest: (request) => {
          this.permissionRuntimes.set(request.requestId, runtime)
          this.callbacks.onPermissionRequest?.(request)
        },
        onPromptStarted: (sessionId, turnToken, promptAttemptId) => {
          const attempt = this.takePendingPromptStart(sessionId, runtime, promptAttemptId)
          if (
            attempt &&
            attempt.globalCancellationGeneration === this.globalCancellationGeneration &&
            attempt.sessionCancellationGeneration ===
              (this.sessionCancellationGenerations.get(sessionId) ?? 0)
          ) {
            this.teardownCallbacks.onSessionTurnStarted?.(sessionId, turnToken)
          }
          this.callbacks.onPromptStarted?.(sessionId, turnToken)
        },
        onPromptEnded: (sessionId, turnToken) => {
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
    this.runtimeIds.set(runtime, `runtime-${this.runtimeSequence}`)
    this.runtimes.add(runtime)
    return runtime
  }

  private handleRuntimeState(runtime: AcpRuntime, snapshot: AcpStateSnapshot): void {
    const attached = this.releaseMissingRuntimeSessions(runtime, snapshot)
    for (const sessionId of attached) {
      const owner = this.sessionRuntimes.get(sessionId)
      // A late state emission from a retiring runtime must not steal back a session already adopted by
      // the current generation.
      if (!owner || !this.retiredRuntimes.has(runtime) || this.retiredRuntimes.has(owner)) {
        this.sessionRuntimes.set(sessionId, runtime)
        this.sessionConnectionStatuses.set(sessionId, snapshot.status)
      }
    }
    this.callbacks.onStateChanged?.(this.getSnapshot())
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
      this.onSessionUnavailable?.(sessionId)
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
    this.sessionConnectionStatuses.clear()
    this.permissionRuntimes.clear()
    this.pendingPromptStarts.clear()
    this.activeRuntime = undefined
    this.lastRuntime = undefined
  }
}

export { AcpRuntimeCoordinator }
