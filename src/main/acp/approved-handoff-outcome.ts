import type { CompletionGateRuntime } from '../agents/completion-gate'
import { completionContextKey } from '../agents/completion-gate'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'

// Capture before the provider cancellation drains the Attempt. Reconfiguration may fail before
// continuation admission, so its failure still belongs to that already-admitted original turn.
export const withApprovedHandoffOutcome = (
  runtime: Pick<AcpRuntimeCoordinator, 'captureApprovedHandoffFailure'>,
  adapter: CompletionGateRuntime
): CompletionGateRuntime => {
  const failures = new Map<string, { key: string; report: () => Promise<void> }>()
  return {
    ...(adapter.canHandle ? { canHandle: (context) => adapter.canHandle!(context) } : {}),
    ...(adapter.canCapture ? { canCapture: (context) => adapter.canCapture!(context) } : {}),
    stopOldPrompt: async (context) => {
      const report = runtime.captureApprovedHandoffFailure(context.sessionId)
      if (report) {
        failures.delete(context.sessionId)
        failures.set(context.sessionId, { key: completionContextKey(context), report })
      }
      await adapter.stopOldPrompt(context)
    },
    waitForOwnershipRelease: (context) => adapter.waitForOwnershipRelease(context),
    cleanupCancelledHandoff: async (context) => {
      if (failures.get(context.sessionId)?.key === completionContextKey(context))
        failures.delete(context.sessionId)
      await adapter.cleanupCancelledHandoff?.(context)
    },
    reconfigure: (handoff, context, isCurrentAttempt) =>
      adapter.reconfigure(handoff, context, isCurrentAttempt),
    continueAsApproved: async (handoff, context, continuationContext) => {
      await adapter.continueAsApproved(handoff, context, continuationContext)
      if (failures.get(context.sessionId)?.key === completionContextKey(context))
        failures.delete(context.sessionId)
    },
    reportHandoffFailure: async (error, handoff, context) => {
      const key = completionContextKey(context)
      const captured = failures.get(context.sessionId)
      const report = captured?.key === key ? captured.report : undefined
      if (captured?.key === key) failures.delete(context.sessionId)
      try {
        await adapter.reportHandoffFailure(error, handoff, context)
      } finally {
        await report?.()
      }
    }
  }
}
