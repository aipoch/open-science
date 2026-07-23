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
import type { ReasoningEffort } from '../../shared/settings'
import { AcpRuntime, type AcpRuntimeCallbacks } from './runtime'
import type { AcpRuntimeActivity, AcpRuntimeActivityOptions } from './runtime-activity'

const MAX_EVENTS = 500

type RuntimeFactory = (callbacks: AcpRuntimeCallbacks) => AcpRuntime

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
  private runtimeSequence = 0
  private activeRuntime: AcpRuntime | undefined
  private lastRuntime: AcpRuntime | undefined

  constructor(
    private readonly createRuntime: RuntimeFactory,
    private readonly callbacks: AcpRuntimeCallbacks = {},
    private readonly defaultCwd = ''
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
      permissionGrants: Object.assign(
        {},
        ...snapshots.map(({ snapshot }) => snapshot.permissionGrants)
      ),
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
    const runtime = this.getActiveRuntime()
    await runtime.connect(request)
    return this.getSnapshot()
  }

  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    const runtimes = Array.from(this.runtimes)
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.disconnect(emitClosedStatus))
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    // Keep ownership when any teardown fails so a later disconnect/shutdown can retry the runtime.
    if (failure) throw failure.reason
    this.clearRuntimeOwnership()
    return this.getSnapshot()
  }

  shutdown(): void {
    for (const runtime of this.runtimes) runtime.shutdown()
    this.clearRuntimeOwnership()
  }

  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    return this.shutdownAll((runtime) => runtime.shutdownForQuit())
  }

  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    return this.shutdownAll((runtime) => runtime.shutdownForUpdateGate())
  }

  async createSession(request: AcpCreateSessionRequest = {}): Promise<AcpCreateSessionResponse> {
    const runtime = this.getActiveRuntime()
    const response = await runtime.createSession(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  async resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const owner = this.findRuntimeForSession(request.sessionId)
    const runtime = owner && !this.retiredRuntimes.has(owner) ? owner : this.getActiveRuntime()
    const response = await runtime.resumeSession(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  async resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse> {
    const runtime = this.runtimeForSession(request.sessionId)
    const response = await runtime.resetSessionContext(request)
    this.sessionRuntimes.set(response.sessionId, runtime)
    this.lastRuntime = runtime
    return response
  }

  sendPrompt(request: AcpPromptRequest): ReturnType<AcpRuntime['sendPrompt']> {
    return this.runtimeForSession(request.sessionId).sendPrompt(request)
  }

  async cancelPrompt(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot> {
    await this.runtimeForSession(request.sessionId).cancelPrompt(request)
    return this.getSnapshot()
  }

  async deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot> {
    const runtime = this.runtimeForSession(request.sessionId)
    await runtime.deleteSession(request)
    this.sessionRuntimes.delete(request.sessionId)
    this.sessionConnectionStatuses.delete(request.sessionId)
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

  requestSkillsReload(): Promise<void> {
    return this.getActiveRuntime().requestSkillsReload()
  }

  async applyReasoningEffortChange(effort: ReasoningEffort): Promise<boolean> {
    const active = this.getActiveRuntime()
    const activeResult = active.applyReasoningEffortChange(effort)
    const otherResults = Array.from(this.runtimes)
      .filter((runtime) => runtime !== active)
      .map((runtime) => runtime.applyReasoningEffortChange(effort))

    // Effort is a non-disruptive live session option, so every still-running generation receives the
    // global preference. Only the active result controls reconnect fallback: an old generation that
    // cannot apply effort or rejects must not force the selected generation to respawn unnecessarily.
    const results = await Promise.allSettled([activeResult, ...otherResults])
    const activeOutcome = results[0]
    if (activeOutcome.status === 'rejected') throw activeOutcome.reason
    return activeOutcome.value
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
    const runtime = this.createRuntime({
      onStateChanged: (snapshot) => this.handleRuntimeState(runtime, snapshot),
      onEvent: (event) =>
        this.callbacks.onEvent?.({ ...event, id: this.eventId(runtime, event.id) }),
      onPermissionRequest: (request) => {
        this.permissionRuntimes.set(request.requestId, runtime)
        this.callbacks.onPermissionRequest?.(request)
      },
      onRetired: () => this.handleRuntimeRetired(runtime)
    })
    this.runtimeSequence += 1
    this.runtimeIds.set(runtime, `runtime-${this.runtimeSequence}`)
    this.runtimes.add(runtime)
    return runtime
  }

  private handleRuntimeState(runtime: AcpRuntime, snapshot: AcpStateSnapshot): void {
    const attached = new Set(snapshot.sessionIds)
    for (const [sessionId, owner] of this.sessionRuntimes) {
      if (owner !== runtime || attached.has(sessionId)) continue

      this.sessionRuntimes.delete(sessionId)
      if (snapshot.status === 'closed' || snapshot.status === 'error') {
        this.sessionConnectionStatuses.set(sessionId, snapshot.status)
      } else {
        this.sessionConnectionStatuses.delete(sessionId)
      }
    }
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

  private handleRuntimeRetired(runtime: AcpRuntime): void {
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
    }
    for (const [requestId, owner] of this.permissionRuntimes) {
      if (owner === runtime) this.permissionRuntimes.delete(requestId)
    }
    if (this.activeRuntime === runtime) this.activeRuntime = undefined
    if (this.lastRuntime === runtime) this.lastRuntime = this.activeRuntime
    this.callbacks.onStateChanged?.(this.getSnapshot())
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
    // Preserve failed runtime ownership so a bounded caller can retry or use the synchronous guard.
    if (failure) throw failure.reason
    this.clearRuntimeOwnership()
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
    this.activeRuntime = undefined
    this.lastRuntime = undefined
  }
}

export { AcpRuntimeCoordinator }
