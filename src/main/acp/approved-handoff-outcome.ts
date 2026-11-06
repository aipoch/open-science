import { completionContextKey } from '../agents/completion-gate'
import type { CompletionGateRuntime } from '../agents/completion-gate-contract'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'

// Capture before the provider cancellation drains the Attempt. Reconfiguration may fail before
// continuation admission, so its failure still belongs to that already-admitted original turn.
export const withApprovedHandoffOutcome = (
  runtime: Pick<AcpRuntimeCoordinator, 'captureApprovedHandoffFailure' | 'captureHandoffProcess'>,
  adapter: CompletionGateRuntime
): CompletionGateRuntime => {
  const failures = new Map<
    string,
    {
      key: string
      generation?: number
      report?: () => Promise<void>
      release?: () => void
      process: ReturnType<AcpRuntimeCoordinator['captureHandoffProcess']>
    }
  >()
  const releaseProcess = (captured: { release?: () => void }): void => {
    captured.release?.()
    captured.release = undefined
  }
  const restoreProcess = async (
    handoff: Parameters<CompletionGateRuntime['reconfigure']>[0],
    context: Parameters<CompletionGateRuntime['reconfigure']>[1]
  ): Promise<void> => {
    const captured = failures.get(context.sessionId)
    if (
      captured?.key === completionContextKey(context) &&
      captured.generation !== undefined &&
      'generation' in handoff &&
      captured.generation !== handoff.generation
    )
      throw new Error('The approved handoff attempt was superseded.')
    if (captured?.key !== completionContextKey(context) || captured.release || !captured.process)
      return
    captured.release = captured.process.hold()
    await captured.process.restoreSession(
      handoff.targetName === null ? undefined : handoff.approvedSpecialistId
    )
    if (failures.get(context.sessionId) !== captured || !captured.release)
      throw new Error('The approved handoff attempt was superseded.')
  }
  const ownsInvocation = (
    context: Parameters<CompletionGateRuntime['stopOldPrompt']>[0]
  ): boolean => failures.get(context.sessionId)?.key === completionContextKey(context)
  return {
    ...(adapter.canHandle
      ? { canHandle: (context) => ownsInvocation(context) || adapter.canHandle!(context) }
      : {}),
    ...(adapter.canCapture
      ? { canCapture: (context) => ownsInvocation(context) || adapter.canCapture!(context) }
      : {}),
    stopOldPrompt: async (context, generation) => {
      const process = runtime.captureHandoffProcess(context.sessionId)
      const report = runtime.captureApprovedHandoffFailure(context.sessionId)
      const release = process?.hold()
      const previous = failures.get(context.sessionId)
      if (previous) releaseProcess(previous)
      failures.set(context.sessionId, {
        key: completionContextKey(context),
        generation,
        report,
        release,
        process
      })
      await adapter.stopOldPrompt(context)
    },
    releaseSupersededHandoff: (context, generation) => {
      const captured = failures.get(context.sessionId)
      if (captured?.key !== completionContextKey(context) || captured.generation !== generation)
        return
      failures.delete(context.sessionId)
      releaseProcess(captured)
    },
    waitForOwnershipRelease: (context) => adapter.waitForOwnershipRelease(context),
    cleanupCancelledHandoff: async (context) => {
      const captured = failures.get(context.sessionId)
      if (captured?.key === completionContextKey(context)) failures.delete(context.sessionId)
      try {
        await adapter.cleanupCancelledHandoff?.(context)
      } finally {
        if (captured?.key === completionContextKey(context)) releaseProcess(captured)
      }
    },
    reconfigure: async (handoff, context, isCurrentAttempt) => {
      if (isCurrentAttempt && !isCurrentAttempt())
        throw new Error('The approved handoff attempt was superseded.')
      await restoreProcess(handoff, context)
      if (isCurrentAttempt && !isCurrentAttempt())
        throw new Error('The approved handoff attempt was superseded.')
      await adapter.reconfigure(handoff, context, isCurrentAttempt)
    },
    continueAsApproved: async (handoff, context, continuationContext) => {
      const captured = failures.get(context.sessionId)
      await restoreProcess(handoff, context)
      await adapter.continueAsApproved(handoff, context, continuationContext)
      if (
        captured?.key === completionContextKey(context) &&
        failures.get(context.sessionId) === captured
      ) {
        releaseProcess(captured)
        failures.delete(context.sessionId)
      }
    },
    reportHandoffFailure: async (error, handoff, context) => {
      const key = completionContextKey(context)
      const captured = failures.get(context.sessionId)
      if (
        captured?.key === key &&
        captured.generation !== undefined &&
        captured.generation !== handoff.generation
      )
        return
      const report = captured?.key === key ? captured.report : undefined
      if (captured?.key === key) captured.report = undefined
      try {
        await adapter.reportHandoffFailure(error, handoff, context)
      } finally {
        try {
          await report?.()
        } finally {
          if (captured?.key === key) releaseProcess(captured)
        }
      }
    }
  }
}
