import { ACP_MODEL_TURN_COUNT_META_KEY, ACP_TURN_TOKEN_USAGE_META_KEY } from '../../shared/acp'
import { toCodexTurnTokenUsage } from './codex-turn-usage'
import type { AcpProviderTurnAdapter } from './provider-turn-adapter'

const nonNegativeSafeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const positiveSafeInteger = (value: unknown): number | undefined => {
  const count = nonNegativeSafeInteger(value)
  return count !== undefined && count > 0 ? count : undefined
}

// Runtime selection is intentionally deferred to the ARD-24 serialized executor cutover.
const createCodexTurnAdapter = (): AcpProviderTurnAdapter => ({
  begin: () => {
    let closed = false
    return {
      finalize: ({ response }) => {
        if (closed) return {}
        closed = true
        const terminalUsage = toCodexTurnTokenUsage(response.usage)
        // Managed Codex metadata carries whole-turn footer usage, while PromptResponse.usage remains
        // the latest request snapshot and therefore the exact context numerator. The pinned adapter
        // publishes uncached and cached-read input as exclusive categories, so recombine them here;
        // cache writes populate future requests and are not part of the current model input.
        const turnUsage =
          toCodexTurnTokenUsage(response._meta?.[ACP_TURN_TOKEN_USAGE_META_KEY]) ?? terminalUsage
        const contextInputTokens = nonNegativeSafeInteger(response.usage?.inputTokens)
        const contextCachedReadTokens = nonNegativeSafeInteger(
          response.usage?.cachedReadTokens ?? 0
        )
        const reportedContextUsedTokens =
          contextInputTokens !== undefined && contextCachedReadTokens !== undefined
            ? contextInputTokens + contextCachedReadTokens
            : undefined
        const contextUsedTokens = Number.isSafeInteger(reportedContextUsedTokens)
          ? reportedContextUsedTokens
          : undefined
        const modelTurnCount = positiveSafeInteger(response._meta?.[ACP_MODEL_TURN_COUNT_META_KEY])
        return {
          ...(turnUsage ? { turnUsage } : {}),
          ...(modelTurnCount === undefined ? {} : { modelTurnCount }),
          ...(contextUsedTokens === undefined ? {} : { contextUsedTokens }),
          ...(terminalUsage ? { lastModelStepUsage: terminalUsage } : {})
        }
      },
      cancel: () => {
        closed = true
      }
    }
  }
})

export { createCodexTurnAdapter }
