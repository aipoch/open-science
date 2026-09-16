import type { AcpProviderTurnResult } from './provider-turn-adapter'

// A review pause splits one logical prompt into multiple Provider turns. Missing usage remains
// missing rather than presenting the last segment as the total. Context size is the latest reading.
export const combineProviderPromptFacts = (
  previous: AcpProviderTurnResult,
  current: AcpProviderTurnResult
): AcpProviderTurnResult => {
  const sum = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a === undefined || b === undefined) return undefined
    const value = a + b
    return Number.isSafeInteger(value) ? value : undefined
  }
  const left = previous.turnUsage
  const right = current.turnUsage
  const inputTokens = sum(left?.inputTokens, right?.inputTokens)
  const outputTokens = sum(left?.outputTokens, right?.outputTokens)
  const cacheTokens = sum(left?.cacheTokens, right?.cacheTokens)
  const cachedReadTokens = sum(left?.cachedReadTokens, right?.cachedReadTokens)
  const cachedWriteTokens = sum(left?.cachedWriteTokens, right?.cachedWriteTokens)
  const modelTurnCount = sum(previous.modelTurnCount, current.modelTurnCount)
  return {
    ...(inputTokens !== undefined && outputTokens !== undefined && cacheTokens !== undefined
      ? {
          turnUsage: {
            inputTokens,
            outputTokens,
            cacheTokens,
            ...(cachedReadTokens !== undefined && cachedWriteTokens !== undefined
              ? { cachedReadTokens, cachedWriteTokens }
              : {})
          }
        }
      : {}),
    ...(modelTurnCount !== undefined ? { modelTurnCount } : {}),
    ...(previous.modelCalls && current.modelCalls
      ? { modelCalls: [...previous.modelCalls, ...current.modelCalls] }
      : {}),
    ...(current.contextUsedTokens !== undefined
      ? { contextUsedTokens: current.contextUsedTokens }
      : {}),
    ...(current.lastModelStepUsage ? { lastModelStepUsage: current.lastModelStepUsage } : {})
  }
}
