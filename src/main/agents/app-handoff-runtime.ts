import { inspect } from 'node:util'

import type { AcpPromptRequest } from '../../shared/acp'
import type {
  HandoffContinuationContext,
  HandoffLifecycleFailure,
  HandoffLifecyclePhase,
  HandoffTarget
} from '../../shared/handoff-lifecycle'
import type {
  CompletionDisposition,
  CompletionGateRuntime,
  TrustedToolCompletionContext
} from './completion-gate'
import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { SessionBindingService } from '../specialist/session-binding'

type CapturedHandoff = Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>

type AppHandoffRuntimeDeps = {
  cancelPrompt(sessionId: string): Promise<void>
  waitForPromptOwnershipRelease(sessionId: string): Promise<void>
  resolveSpecialistId(sessionId: string, target: HandoffTarget): Promise<string | undefined>
  switchSpecialist(sessionId: string, specialistId: string | undefined): Promise<void>
  sendContinuation(request: AcpPromptRequest): Promise<void>
}

const continuationPrompt = (context: HandoffContinuationContext): string => {
  const completion =
    context.completion.kind === 'returned'
      ? `returned:\n${inspect(context.completion.value, { depth: 8, breakLength: 100 })}`
      : `threw:\n${inspect(context.completion.error, { depth: 8, breakLength: 100 })}`
  const target = context.target.kind === 'main' ? 'Main Agent' : context.target.name

  return [
    'Continue the original user task after the approved Specialist handoff.',
    'Do not repeat assistant output already shown before the handoff.',
    `Approved target: ${target}`,
    `Captured outer tool completion ${completion}`,
    `Original attachment ids: ${context.attachmentIds.join(', ') || '(none)'}`,
    `Original artifact ids: ${context.artifactIds.join(', ') || '(none)'}`
  ].join('\n\n')
}

// Production adapter from the shared completion gate to the existing ACP coordinator. Framework
// differences remain behind switchSpecialist/sendPrompt; this module owns no parallel state machine.
class AppHandoffRuntime implements CompletionGateRuntime {
  constructor(private readonly deps: AppHandoffRuntimeDeps) {}

  async stopOldPrompt(context: TrustedToolCompletionContext): Promise<void> {
    await this.deps.cancelPrompt(context.sessionId)
  }

  async waitForOwnershipRelease(context: TrustedToolCompletionContext): Promise<void> {
    await this.deps.waitForPromptOwnershipRelease(context.sessionId)
  }

  async reconfigure(handoff: CapturedHandoff): Promise<void> {
    if (!handoff.continuationContext) {
      throw new Error('The approved handoff continuation context is unavailable.')
    }
    await this.reconfigureContext(handoff.continuationContext)
  }

  async continueAsApproved(
    _handoff: CapturedHandoff,
    _context: TrustedToolCompletionContext,
    continuationContext?: HandoffContinuationContext
  ): Promise<void> {
    if (!continuationContext) {
      throw new Error('The approved handoff continuation context is unavailable.')
    }
    await this.continueContext(continuationContext)
  }

  async reportHandoffFailure(): Promise<void> {
    // The lifecycle coordinator retained the context and published the recoverable failed state.
  }

  async retry(
    context: HandoffContinuationContext,
    retryFrom: HandoffLifecycleFailure['retryFrom'],
    onPhase: (phase: HandoffLifecyclePhase) => void
  ): Promise<void> {
    if (retryFrom === 'switching') {
      onPhase('switching')
      await this.deps.cancelPrompt(context.sessionId)
      await this.deps.waitForPromptOwnershipRelease(context.sessionId)
    }
    if (retryFrom === 'switching' || retryFrom === 'reconfiguring') {
      onPhase('reconfiguring')
      await this.reconfigureContext(context)
    }
    onPhase('continuation-start')
    await this.continueContext(context)
    onPhase('continued')
  }

  private async reconfigureContext(context: HandoffContinuationContext): Promise<void> {
    const specialistId = await this.deps.resolveSpecialistId(context.sessionId, context.target)
    await this.deps.switchSpecialist(context.sessionId, specialistId)
  }

  private async continueContext(context: HandoffContinuationContext): Promise<void> {
    await this.deps.sendContinuation({
      sessionId: context.sessionId,
      text: continuationPrompt(context),
      provenanceContext: { promptMessageId: context.originatingUserMessageId }
    })
  }
}

const createProductionAppHandoffRuntime = (options: {
  runtime: Pick<
    AcpRuntimeCoordinator,
    'cancelPrompt' | 'waitForPromptOwnershipRelease' | 'switchSpecialist' | 'sendAppContinuation'
  >
  sessionBinding: Pick<SessionBindingService, 'resolve'>
}): AppHandoffRuntime =>
  new AppHandoffRuntime({
    cancelPrompt: (sessionId) => options.runtime.cancelPrompt({ sessionId }).then(() => undefined),
    waitForPromptOwnershipRelease: (sessionId) =>
      options.runtime.waitForPromptOwnershipRelease(sessionId),
    resolveSpecialistId: async (sessionId, target) => {
      const resolution = await options.sessionBinding.resolve(sessionId)
      if (target.kind === 'main') {
        if (resolution.kind !== 'main') {
          throw new Error('The approved Main Agent binding is no longer authoritative.')
        }
        return undefined
      }
      if (resolution.kind !== 'bound' || resolution.profile.name !== target.name) {
        throw new Error(`The approved Specialist "${target.name}" is unavailable.`)
      }
      return resolution.profile.id
    },
    switchSpecialist: (sessionId, specialistId) =>
      options.runtime.switchSpecialist(sessionId, specialistId).then(() => undefined),
    sendContinuation: (request) =>
      options.runtime.sendAppContinuation(request).then(() => undefined)
  })

export { AppHandoffRuntime, continuationPrompt, createProductionAppHandoffRuntime }
export type { AppHandoffRuntimeDeps }
