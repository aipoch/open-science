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

// Provider-neutral production fallback. It performs the safety-critical cancellation, explicit
// ownership-release wait, and binding reconfigure against the real ACP coordinator. Framework
// continuation callback re-enters ACP through an application-owned, non-user prompt route.
export const createProductionCompletionHandoffRuntime = (
  dependencies: ProductionCompletionHandoffDependencies
): CompletionGateRuntime => ({
  stopOldPrompt: (context) => dependencies.stopPromptForHandoff(context.sessionId),
  waitForOwnershipRelease: (context) =>
    dependencies.waitForSessionInteractionRelease(context.sessionId),
  reconfigure: async (handoff, context) => {
    const currentBinding = await dependencies.getSpecialistBinding(context.sessionId)
    if (handoff.targetName === null) {
      if (currentBinding) throw new Error('The approved Main Agent binding was superseded.')
      await dependencies.switchSpecialist(context.sessionId, undefined)
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
    await dependencies.switchSpecialist(context.sessionId, handoff.approvedSpecialistId)
  },
  continueAsApproved: dependencies.continueAsApproved,
  reportHandoffFailure: (error, handoff, context: TrustedToolCompletionContext) =>
    dependencies.reportHandoffFailure?.(error, handoff, context) ?? Promise.resolve()
})
