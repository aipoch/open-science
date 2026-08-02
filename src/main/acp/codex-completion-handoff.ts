// Codex's concrete bridge for the application-owned completion gate.
//
// This module deliberately owns no transition state. The generic gate decides whether an outer tool
// completion belongs to the old prompt or the approved handoff; this adapter only translates that
// decision into the ACP runtime operations Codex needs (cancel → explicit drain → per-turn projection
// refresh → continuation).

import type {
  CompletionDisposition,
  CompletionGateRuntime,
  ToolCompletionEnvelope,
  TrustedToolCompletionContext
} from '../agents/completion-gate'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'

type CodexCompletionHandoffOptions = {
  // Keep the adapter coupled to the operational surface it actually drives. This lets the
  // composition root provide the real coordinator while certification uses a faithful provider
  // double instead of an unsafe whole-coordinator cast.
  runtime: Pick<
    AcpRuntimeCoordinator,
    | 'isSessionUsingFramework'
    | 'cancelPrompt'
    | 'waitForPromptRelease'
    | 'switchSpecialist'
    | 'continueApprovedHandoff'
  >
  // The durable SessionBindingService is the source of truth after approval commits. Keeping this as
  // a narrow resolver makes the adapter independent of profile storage and avoids a parallel switch
  // state machine.
  resolveApprovedSpecialistId(sessionId: string): string | undefined
}

const continuationTextFor = (envelope: ToolCompletionEnvelope): string => {
  const outcome =
    envelope.kind === 'returned'
      ? safeCompletionValue(envelope.value)
      : envelope.error instanceof Error
        ? envelope.error.message
        : String(envelope.error)
  const kind = envelope.kind === 'returned' ? 'result' : 'error'
  return [
    'Continue the original user task after the approved specialist handoff.',
    `The preceding control tool ${kind} was captured by the application: ${outcome}`,
    'Continue from the existing conversation and do not repeat completed output.'
  ].join('\n\n')
}

const safeCompletionValue = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

export const createCodexCompletionGateRuntime = (
  options: CodexCompletionHandoffOptions
): CompletionGateRuntime => ({
  canHandle: (context) => options.runtime.isSessionUsingFramework(context.sessionId, 'codex'),
  stopOldPrompt: async (context: TrustedToolCompletionContext) => {
    await options.runtime.cancelPrompt({ sessionId: context.sessionId })
  },
  waitForOwnershipRelease: (context: TrustedToolCompletionContext) =>
    options.runtime.waitForPromptRelease(context.sessionId),
  reconfigure: async (
    _handoff: Pick<Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>, 'targetName'>,
    context
  ) => {
    const specialistId = options.resolveApprovedSpecialistId(context.sessionId)
    await options.runtime.switchSpecialist(context.sessionId, specialistId)
  },
  continueAsApproved: async (handoff, context) => {
    await options.runtime.continueApprovedHandoff(
      context.sessionId,
      continuationTextFor(handoff.envelope)
    )
  },
  // The completion gate has already retained the envelope and suppressed delivery to the old prompt.
  // Failure presentation/retry is added by the shared fail-closed handoff lifecycle; doing nothing
  // here is intentionally safer than attempting to revive the old Codex turn.
  reportHandoffFailure: async () => undefined
})
