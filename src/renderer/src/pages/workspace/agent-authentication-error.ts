import type { ProviderView } from '../../../../shared/settings'
import { resolveProviderEffectiveModel } from '../../../../shared/provider-reasoning-effort'
import type { ChatSession } from '@/stores/session-store-contract'
import {
  latestOutcomePrompt,
  resolvePreparationNoticeBaseline
} from '../../../../shared/session-persistence'
import { resolveCurrentTurnOutcomeItem } from './workspace-conversation-timeline'

// Match ACP authentication failures, including the application's session-resume wrapper.
export const isAgentAuthenticationRequired = (message: string | null | undefined): boolean =>
  /^(?:(?:ApplicationCommandError|RequestError|Error|Agent session resume failed):\s*)*Authentication required\.?$/i.test(
    message?.trim() ?? ''
  )

export const sessionAuthenticationFailure = (
  session: ChatSession | undefined
): { message: string; at: number; providerId?: string } | undefined => {
  if (!session || session.packageOrigin) return undefined
  const candidates = session.conversationGraph?.messages ?? session.messages
  if (
    !isAgentAuthenticationRequired(session.error) &&
    !isAgentAuthenticationRequired(session.promptPreparation?.previousState.error) &&
    !candidates.some(
      (message) =>
        message.turnOutcome?.kind === 'failed' &&
        isAgentAuthenticationRequired(message.turnOutcome.error)
    )
  )
    return undefined
  const outcome = resolveCurrentTurnOutcomeItem(session)
  if (outcome) {
    if (outcome.outcome.kind !== 'failed' || !isAgentAuthenticationRequired(outcome.outcome.error))
      return undefined
    const graph = session.conversationGraph
    const message = graph?.messages.find(({ id }) => id === outcome.promptMessageId)
    const segment = graph?.runtimeSegments.find(({ id }) => id === message?.runtimeSegmentId)
    return {
      message: outcome.outcome.error!,
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
  return legacy.status === 'error' && isAgentAuthenticationRequired(legacy.error)
    ? { message: legacy.error!, at: session.updatedAt }
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
