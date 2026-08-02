import type { Logger } from '../logger'
import type { CompletionGateCoordinator, CompletionGateLifecycleEvent } from './completion-gate'

type CompletionGateDiagnosticsDependencies = {
  log: Pick<Logger, 'debug' | 'warn'>
  broadcast(event: CompletionGateLifecycleEvent): void
}

// Installs the production sinks for the coordinator's deliberately narrow lifecycle contract. The
// logger already bounds on-disk retention; renderer delivery is stateless; and the returned disposer
// releases the only in-memory subscription during application-runtime teardown.
export const installCompletionGateDiagnostics = (
  coordinator: CompletionGateCoordinator,
  dependencies: CompletionGateDiagnosticsDependencies
): (() => void) =>
  coordinator.subscribeLifecycle((event) => {
    const log = event.kind === 'handoff-failed' ? dependencies.log.warn : dependencies.log.debug
    log('specialist handoff lifecycle', event)
    try {
      dependencies.broadcast(event)
    } catch {
      // Broadcast failures are diagnostic failures, not handoff failures. Report only correlation
      // metadata from the already-sanitized event and never attach a raw renderer/Electron error.
      dependencies.log.warn('specialist handoff lifecycle broadcast failed', {
        order: event.order,
        kind: event.kind,
        sessionId: event.sessionId,
        controlInvocationGeneration: event.controlInvocationGeneration,
        handoffGeneration: event.handoffGeneration
      })
    }
  })
