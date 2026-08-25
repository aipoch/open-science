import type { AcpTurnTokenUsage } from '../../shared/acp'
import type {
  AcpProviderModelCallUsage,
  AcpProviderTurnAdapter,
  AcpProviderTurnResult
} from './provider-turn-adapter'
import { normalizeOpenAiChatModelStepUsage } from '../settings/openai-chat-usage'

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const sumModelSteps = (
  steps: readonly AcpProviderModelCallUsage[]
): AcpProviderTurnResult | undefined => {
  if (steps.length === 0) return undefined

  let inputTokens = 0
  let cachedReadTokens = 0
  let cachedWriteTokens = 0
  let outputTokens = 0
  for (const usage of steps) {
    inputTokens += usage.inputTokens
    cachedReadTokens += usage.cachedReadTokens ?? 0
    cachedWriteTokens += usage.cachedWriteTokens ?? 0
    outputTokens += usage.outputTokens
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(cachedReadTokens) ||
      !Number.isSafeInteger(cachedWriteTokens) ||
      !Number.isSafeInteger(outputTokens)
    ) {
      return undefined
    }
  }

  const cacheTokens = cachedReadTokens + cachedWriteTokens
  if (!Number.isSafeInteger(cacheTokens)) return undefined
  const lastModelStepUsage = steps.at(-1)!
  const contextUsedTokens =
    lastModelStepUsage.inputTokens + (lastModelStepUsage.cachedReadTokens ?? 0)
  if (!Number.isSafeInteger(contextUsedTokens)) return undefined

  const turnUsage: Omit<AcpTurnTokenUsage, 'turnCount'> = {
    inputTokens,
    cacheTokens,
    cachedReadTokens,
    cachedWriteTokens,
    outputTokens
  }
  return {
    turnUsage,
    modelTurnCount: steps.length,
    modelCalls: steps.map((step) => Object.freeze({ ...step })),
    contextUsedTokens,
    lastModelStepUsage: {
      inputTokens: lastModelStepUsage.inputTokens,
      cacheTokens: lastModelStepUsage.cacheTokens,
      cachedReadTokens: lastModelStepUsage.cachedReadTokens,
      cachedWriteTokens: lastModelStepUsage.cachedWriteTokens,
      outputTokens: lastModelStepUsage.outputTokens
    }
  }
}

export const codeBuddyTurnAdapter: AcpProviderTurnAdapter = {
  begin: ({ providerSessionId }) => {
    // CodeBuddy omits PromptResponse.usage. Its per-model-call usage snapshots arrive as ACP
    // updates instead, so keep one latest snapshot per message for turn totals and context.
    const usageByMessageId = new Map<string, AcpProviderModelCallUsage>()
    let closed = false
    const close = (): void => {
      closed = true
      usageByMessageId.clear()
    }

    return {
      observe: (value) => {
        if (closed) return
        const notification = record(value)
        if (notification?.sessionId !== providerSessionId) return
        const update = record(notification.update)
        if (update?.sessionUpdate !== 'usage_update') return
        const meta = record(update._meta)
        const messageId = meta?.['codebuddy.ai/messageId']
        if (typeof messageId !== 'string' || !messageId) return
        const usage = normalizeOpenAiChatModelStepUsage(meta?.usage)
        if (usage) usageByMessageId.set(messageId, { ...usage, sourceInvocationId: messageId })
      },
      finalize: () => {
        if (closed) return {}
        const steps = [...usageByMessageId.values()]
        close()
        return sumModelSteps(steps) ?? {}
      },
      cancel: close
    }
  }
}
