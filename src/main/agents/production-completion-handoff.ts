import { inspect } from 'node:util'

import type { CompletionGateRuntime, TrustedToolCompletionContext } from './completion-gate'

export type ProductionCompletionHandoffDependencies = {
  stopPromptForHandoff(sessionId: string): Promise<void>
  waitForSessionInteractionRelease(sessionId: string): Promise<void>
  getSpecialistBinding(sessionId: string): string | undefined | Promise<string | undefined>
  getSpecialist(
    specialistId: string
  ):
    | { name: string; revision: number; enabled: boolean }
    | undefined
    | Promise<{ name: string; revision: number; enabled: boolean } | undefined>
  switchSpecialist(sessionId: string, specialistId: string | undefined): Promise<void>
  continueAsApproved: CompletionGateRuntime['continueAsApproved']
  reportHandoffFailure?: CompletionGateRuntime['reportHandoffFailure']
}

export const createApprovedContinuationPrompt = (
  handoff: Parameters<CompletionGateRuntime['continueAsApproved']>[0]
): string =>
  [
    'Continue the same user turn after the application completed an approved Specialist switch.',
    'Do not repeat the completed outer control tool. Use its captured completion below as context and continue the task under the newly approved identity.',
    `Approved switch readback: ${inspect(handoff.switchReadback, { depth: 4, maxStringLength: 1_000 })}`,
    `Captured completion: ${inspect(handoff.envelope, { depth: 5, maxArrayLength: 50, maxStringLength: 4_000 })}`
  ].join('\n\n')

// Apply the same durable approval checks to every provider adapter before it can rearm a binding.
// Current Session binding alone cannot authorize a retry of an older captured handoff.
export const withApprovedSpecialistBinding = (
  adapter: CompletionGateRuntime,
  dependencies: Pick<
    ProductionCompletionHandoffDependencies,
    'getSpecialistBinding' | 'getSpecialist'
  >
): CompletionGateRuntime => ({
  ...(adapter.canHandle ? { canHandle: (context) => adapter.canHandle!(context) } : {}),
  ...(adapter.canCapture ? { canCapture: (context) => adapter.canCapture!(context) } : {}),
  stopOldPrompt: (context) => adapter.stopOldPrompt(context),
  waitForOwnershipRelease: (context) => adapter.waitForOwnershipRelease(context),
  cleanupCancelledHandoff: (context) =>
    adapter.cleanupCancelledHandoff?.(context) ?? Promise.resolve(),
  reconfigure: async (handoff, context, isCurrentAttempt) => {
    const reconfigureIfCurrent = async (): Promise<void> => {
      if (isCurrentAttempt && !isCurrentAttempt()) {
        throw new Error('The approved handoff attempt was superseded.')
      }
      await adapter.reconfigure(handoff, context, isCurrentAttempt)
    }
    const currentBinding = await dependencies.getSpecialistBinding(context.sessionId)
    if (handoff.targetName === null) {
      if (currentBinding !== undefined)
        throw new Error('The approved Main Agent binding was superseded.')
      await reconfigureIfCurrent()
      return
    }
    if (!handoff.approvedSpecialistId || handoff.approvedSpecialistRevision === undefined) {
      throw new Error('The durable approved Specialist identity is unavailable.')
    }
    if (currentBinding !== handoff.approvedSpecialistId) {
      throw new Error('The approved Specialist binding was superseded.')
    }
    const approved = await dependencies.getSpecialist(handoff.approvedSpecialistId)
    if (
      !approved ||
      !approved.enabled ||
      approved.name !== handoff.targetName ||
      approved.revision !== handoff.approvedSpecialistRevision
    ) {
      throw new Error('The durable approved Specialist identity no longer matches its approval.')
    }
    // Profile lookup can yield to a newer picker switch. Reject before an adapter can restore a
    // detached provider, stage replay, or apply the old identity.
    if (
      (await dependencies.getSpecialistBinding(context.sessionId)) !== handoff.approvedSpecialistId
    ) {
      throw new Error('The approved Specialist binding was superseded.')
    }
    await reconfigureIfCurrent()
  },
  continueAsApproved: (handoff, context, continuationContext) =>
    adapter.continueAsApproved(handoff, context, continuationContext),
  reportHandoffFailure: (error, handoff, context) =>
    adapter.reportHandoffFailure(error, handoff, context)
})

// Provider-neutral production fallback. Framework continuation callbacks re-enter ACP through an
// application-owned, non-user prompt route after the shared approval checks.
export const createProductionCompletionHandoffRuntime = (
  dependencies: ProductionCompletionHandoffDependencies
): CompletionGateRuntime =>
  withApprovedSpecialistBinding(
    {
      stopOldPrompt: (context) => dependencies.stopPromptForHandoff(context.sessionId),
      waitForOwnershipRelease: (context) =>
        dependencies.waitForSessionInteractionRelease(context.sessionId),
      reconfigure: (handoff, context) =>
        dependencies.switchSpecialist(
          context.sessionId,
          handoff.targetName === null ? undefined : handoff.approvedSpecialistId
        ),
      continueAsApproved: dependencies.continueAsApproved,
      reportHandoffFailure: (error, handoff, context: TrustedToolCompletionContext) =>
        dependencies.reportHandoffFailure?.(error, handoff, context) ?? Promise.resolve()
    },
    dependencies
  )
