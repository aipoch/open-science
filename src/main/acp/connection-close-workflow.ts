import type { AcpStateSnapshot } from '../../shared/acp'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AcpBackendGenerationOwner } from './backend-generation-owner'
import type { AcpConnectionResourceOwner } from './connection-resource-owner'
import type { AcpConnectionTransitionOwner } from './connection-transition-owner'
import type { AcpModelChangeWorkflow } from './model-change-workflow'
type CleanupFailure = (stage: string, error: unknown) => void
type CloseStatus = AcpStateSnapshot['status']
type DisconnectCurrent = (...args: [boolean, number]) => Promise<AcpStateSnapshot>
type CloseState = Readonly<{
  invalidatePendingSessionStartups: () => void
  disposePermissionContext: () => void
  disposeElicitationOwner: () => void
  clearPendingAppContinuations: () => void
  clearReviewerState: () => void
  clearPlanInteractions: () => void
  settleActivePrompts: () => readonly unknown[]
  supersedeInteractions: () => void
  clearContextUsage: () => void
  clearAppliedSessionModels: () => void
  activeSessionIds: () => string[]
  disposeSessionCapabilities: (sessionIds: string[]) => void
  disposeActiveSessions: (recordFailure: CleanupFailure) => void
  detachSessionConnections: (clearPermissionProfile: boolean) => void
  clearPromptContent: () => void
  clearHandoffContinuity: () => void
  clearSessionProjection: () => void
  disposeSessionProjection: () => void
  clearHttpRoutes: () => void
  selectSession: () => void
  publishInterruptedPromptFailures: (prompts: readonly unknown[]) => void
  setStatus: (status: CloseStatus) => void
  transitionStatus: (status: CloseStatus) => void
  emitState: () => void
  hasContextUsage: () => boolean
}>
type AcpConnectionCloseWorkflowOptions = Readonly<{
  currentGeneration: () => number
  currentStatus: () => CloseStatus
  getSnapshot: () => AcpStateSnapshot
  disconnectCurrent?: DisconnectCurrent
  transitions: Pick<
    AcpConnectionTransitionOwner,
    | 'settleTeardown'
    | 'resetReconnect'
    | 'activityChanged'
    | 'requestProviderReconnect'
    | 'requestRetirement'
  >
  resources: Pick<
    AcpConnectionResourceOwner,
    | 'supersede'
    | 'restorePublished'
    | 'teardown'
    | 'closeMcp'
    | 'cleanupUnexpectedClose'
    | 'shutdownSynchronously'
    | 'beginAwaitableShutdown'
  >
  backendGeneration: Pick<AcpBackendGenerationOwner, 'supersede'>
  modelChanges: Pick<AcpModelChangeWorkflow, 'cancel' | 'cancelAndDrain'>
  state: CloseState
  reportFailure: (message: string, error: unknown) => void
}>
class AcpConnectionCloseWorkflow {
  private candidateTreeKillReaped = true
  private readonly expectedProcessExits = new WeakSet<ChildProcessWithoutNullStreams>()
  constructor(private readonly options: AcpConnectionCloseWorkflowOptions) {}
  async disconnect(emitClosedStatus = true): Promise<AcpStateSnapshot> {
    this.options.modelChanges.cancel()
    return this.options.transitions.settleTeardown(async () => {
      const teardownGeneration = this.options.resources.supersede()
      this.options.state.invalidatePendingSessionStartups()
      try {
        return await (this.options.disconnectCurrent?.(emitClosedStatus, teardownGeneration) ??
          this.disconnectCurrent(emitClosedStatus, teardownGeneration))
      } catch (error) {
        this.options.resources.restorePublished(teardownGeneration)
        throw error
      } finally {
        await this.options.resources.closeMcp(teardownGeneration)
      }
    })
  }
  async disconnectCurrent(
    emitClosedStatus = true,
    teardownGeneration = this.options.currentGeneration()
  ): Promise<AcpStateSnapshot> {
    let teardownFailed = false
    let teardownFailure: unknown
    const recordFailure: CleanupFailure = (stage, error) => {
      if (!teardownFailed) {
        teardownFailed = true
        teardownFailure = error
        return
      }
      this.reportFailure('secondary ACP disconnect cleanup failed', { stage, error })
    }
    const runCleanup = (stage: string, cleanup: () => void): void => {
      try {
        cleanup()
      } catch (error) {
        recordFailure(stage, error)
      }
    }
    runCleanup('permission-context', this.options.state.disposePermissionContext)
    runCleanup('elicitation-owner', this.options.state.disposeElicitationOwner)
    this.options.state.clearPendingAppContinuations()
    runCleanup('reviewer-state', this.options.state.clearReviewerState)
    runCleanup('plan-interactions', this.options.state.clearPlanInteractions)
    this.options.state.supersedeInteractions()
    this.options.state.clearContextUsage()
    this.options.state.clearAppliedSessionModels()
    const activeSessionIds = this.options.state.activeSessionIds()
    this.options.state.disposeSessionCapabilities(activeSessionIds)
    this.options.state.disposeActiveSessions((stage, error) => recordFailure(stage, error))
    this.options.state.detachSessionConnections(true)
    this.options.state.clearPromptContent()
    this.options.state.clearSessionProjection()
    runCleanup('MCP HTTP routes', this.options.state.clearHttpRoutes)
    this.options.state.selectSession()
    await this.options.resources.teardown(teardownGeneration, recordFailure)
    if (emitClosedStatus && teardownGeneration === this.options.currentGeneration()) {
      runCleanup('closed-status', () => this.options.state.setStatus('closed'))
    }
    this.options.backendGeneration.supersede(teardownGeneration - 1)
    if (teardownFailed) throw teardownFailure
    return this.options.getSnapshot()
  }
  handleUnexpectedClose(): void {
    if (
      this.options.currentStatus() !== 'connected' &&
      this.options.currentStatus() !== 'connecting'
    ) {
      return
    }
    this.options.modelChanges.cancel()
    const teardownGeneration = this.options.currentGeneration()
    const interruptedPrompts = this.options.state.settleActivePrompts()
    this.options.state.invalidatePendingSessionStartups()
    this.options.state.disposePermissionContext()
    this.options.state.disposeElicitationOwner()
    this.options.state.clearPendingAppContinuations()
    this.options.state.clearReviewerState()
    this.options.state.clearPlanInteractions()
    this.options.resources.cleanupUnexpectedClose(teardownGeneration)
    this.options.backendGeneration.supersede(teardownGeneration)
    this.options.state.disposeSessionCapabilities(this.options.state.activeSessionIds())
    this.options.state.detachSessionConnections(false)
    this.options.state.clearPromptContent()
    this.options.state.clearHandoffContinuity()
    this.options.state.disposeSessionProjection()
    this.options.state.clearContextUsage()
    this.options.state.clearHttpRoutes()
    this.options.state.selectSession()
    this.options.state.supersedeInteractions()
    this.options.transitions.resetReconnect()
    void this.options.resources.closeMcp(teardownGeneration)
    try {
      this.options.state.setStatus('closed')
    } finally {
      this.options.state.publishInterruptedPromptFailures(interruptedPrompts)
      this.options.transitions.activityChanged()
    }
  }
  shutdown(): void {
    this.options.modelChanges.cancel()
    this.options.resources.shutdownSynchronously(() => {
      this.options.state.invalidatePendingSessionStartups()
      this.options.backendGeneration.supersede(this.options.currentGeneration() - 1)
    })
    this.options.transitions.resetReconnect()
    this.options.state.clearPlanInteractions()
    this.options.state.clearSessionProjection()
    this.options.state.clearContextUsage()
    this.options.state.clearAppliedSessionModels()
  }
  async shutdownForQuit(): Promise<{ reaped: boolean }> {
    this.candidateTreeKillReaped = true
    const shutdown = this.options.resources.beginAwaitableShutdown(true)
    await this.disconnect(false)
    const outcome = await shutdown.finish()
    return { reaped: outcome.reaped && this.candidateTreeKillReaped }
  }
  async shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    this.candidateTreeKillReaped = true
    const shutdown = this.options.resources.beginAwaitableShutdown(false)
    await this.disconnect(false)
    const outcome = await shutdown.finish()
    return { reaped: outcome.reaped && this.candidateTreeKillReaped }
  }
  async requestProviderReconnect(): Promise<void> {
    await this.options.modelChanges.cancelAndDrain()
    if (this.options.state.hasContextUsage()) {
      this.options.state.clearContextUsage()
      this.options.state.clearAppliedSessionModels()
      this.options.state.emitState()
    }
    await this.options.transitions.requestProviderReconnect()
  }
  async requestRetirement(): Promise<void> {
    await this.options.modelChanges.cancelAndDrain()
    await this.options.transitions.requestRetirement()
  }
  recoverFailedDeferredDisconnect(): void {
    const teardownGeneration = this.options.resources.supersede()
    this.options.backendGeneration.supersede(teardownGeneration - 1)
    void this.options.resources.teardown(teardownGeneration, (stage, error) => {
      this.reportFailure(`${stage} cleanup after failed deferred disconnect failed`, error)
    })
    this.options.state.transitionStatus('closed')
    try {
      this.options.state.emitState()
    } catch (error) {
      this.reportFailure('emitState after failed deferred disconnect failed', error)
    }
  }
  recordProcessTreeReaped(reaped: boolean): void {
    this.candidateTreeKillReaped = this.candidateTreeKillReaped && reaped
  }
  markExpected(process: ChildProcessWithoutNullStreams): void {
    this.expectedProcessExits.add(process)
  }
  isExpected(process: ChildProcessWithoutNullStreams): boolean {
    return this.expectedProcessExits.has(process)
  }
  private reportFailure(message: string, error: unknown): void {
    try {
      this.options.reportFailure(message, error)
    } catch {
      // Close ordering and the original failure take precedence over diagnostics.
    }
  }
}

export { AcpConnectionCloseWorkflow }
export type { AcpConnectionCloseWorkflowOptions, CloseState }
