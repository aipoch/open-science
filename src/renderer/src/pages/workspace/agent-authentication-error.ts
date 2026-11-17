import type { ProviderView } from '../../../../shared/settings'
import { resolveProviderEffectiveModel } from '../../../../shared/provider-reasoning-effort'
import type { ChatSession } from '@/stores/session-store-contract'
import {
  latestOutcomePrompt,
  resolvePreparationNoticeBaseline
} from '../../../../shared/session-persistence'
import { resolveCurrentTurnOutcomeItem } from './workspace-conversation-timeline'
import type { ClassifiedFailure } from '../../../../shared/failure/contract'

// Match ACP authentication failures, including the application's session-resume wrapper.
export const isAgentAuthenticationRequired = (message: string | null | undefined): boolean =>
  /^(?:(?:ApplicationCommandError|RequestError|Error|Agent session resume failed):\s*)*Authentication required\.?$/i.test(
    message?.trim() ?? ''
  )

// Reuse authentication recovery so providers needing no Agent login still expose credential failures.
const authenticationFailure = (
  message: string | null | undefined,
  failure?: ClassifiedFailure
): boolean =>
  failure?.reason === 'configuration/auth-failed' || isAgentAuthenticationRequired(message)

export const sessionAuthenticationFailure = (
  session: ChatSession | undefined
): { message: string; at: number; providerId?: string } | undefined => {
  if (!session || session.packageOrigin) return undefined
  const candidates = session.conversationGraph?.messages ?? session.messages
  if (
    !authenticationFailure(session.error, session.failure) &&
    !authenticationFailure(
      session.promptPreparation?.previousState.error,
      session.promptPreparation?.previousState.failure
    ) &&
    !candidates.some(
      (message) =>
        message.turnOutcome?.kind === 'failed' &&
        authenticationFailure(message.turnOutcome.error, message.turnOutcome.failure)
    )
  )
    return undefined
  const outcome = resolveCurrentTurnOutcomeItem(session)
  if (outcome) {
    if (
      outcome.outcome.kind !== 'failed' ||
      !authenticationFailure(outcome.outcome.error, outcome.outcome.failure)
    )
      return undefined
    const graph = session.conversationGraph
    const message = graph?.messages.find(({ id }) => id === outcome.promptMessageId)
    const segment = graph?.runtimeSegments.find(({ id }) => id === message?.runtimeSegmentId)
    return {
      message: outcome.outcome.error ?? 'Authentication required',
      at: outcome.outcome.settledAt,
      providerId: segment?.providerId
    }
  }
  const anchor = latestOutcomePrompt(session)
  const preparing =
    anchor && !anchor.turnOutcome && session.promptPreparation?.promptMessageId === anchor.id
  if (anchor && !preparing) return undefined
  // A branch without a current outcome must not inherit another branch's session-level error.
  if (!preparing && session.conversationGraph?.messages.some((message) => message.turnOutcome))
    return undefined
  const baseline = preparing ? resolvePreparationNoticeBaseline(session) : undefined
  const legacy = baseline && !baseline.promptMessageId ? baseline.state : session
  return legacy.status === 'error' && authenticationFailure(legacy.error, legacy.failure)
    ? {
        message: legacy.error ?? 'Authentication required',
        at: session.updatedAt
      }
    : undefined
}

export const isProviderAuthenticationRestored = (
  provider: ProviderView | undefined,
  failedAt: number,
  model: string | undefined
): boolean =>
  Boolean(
    provider?.lastValidatedAt !== undefined &&
    provider.lastValidatedAt > failedAt &&
    !provider.needsKey &&
    (provider.lastValidationFailure?.category !== 'auth' ||
      provider.lastValidationFailure.at < provider.lastValidatedAt) &&
    (!provider.lastValidatedTarget?.model ||
      provider.lastValidatedTarget.model === resolveProviderEffectiveModel(provider, model))
  )
