import {
  ACP_MODEL_CALL_USAGE_META_KEY,
  ACP_MODEL_TURN_COUNT_META_KEY,
  ACP_TURN_TOKEN_USAGE_META_KEY,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import { toCodexTurnTokenUsage } from './codex-turn-usage'
import type { AcpProviderModelCallUsage, AcpProviderTurnAdapter } from './provider-turn-adapter'

const nonNegativeSafeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const positiveSafeInteger = (value: unknown): number | undefined => {
  const count = nonNegativeSafeInteger(value)
  return count !== undefined && count > 0 ? count : undefined
}

const sameUsage = (
  usage: Pick<AcpTurnTokenUsage, 'inputTokens' | 'cacheTokens' | 'outputTokens'>,
  expected: Pick<AcpTurnTokenUsage, 'inputTokens' | 'cacheTokens' | 'outputTokens'>
): boolean =>
  usage.inputTokens === expected.inputTokens &&
  usage.cacheTokens === expected.cacheTokens &&
  usage.outputTokens === expected.outputTokens

const toManagedModelCalls = (value: unknown): AcpProviderModelCallUsage[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const calls = value.map((candidate) => toCodexTurnTokenUsage(candidate))
  return calls.every((call): call is AcpProviderModelCallUsage => call !== undefined)
    ? calls
    : undefined
}

const hasExactCallCoverage = (
  calls: readonly AcpProviderModelCallUsage[],
  count: number,
  turnUsage: AcpTurnTokenUsage | undefined
): boolean => {
  if (!turnUsage || calls.length !== count) return false
  const aggregate = calls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.inputTokens,
      cacheTokens: sum.cacheTokens + call.cacheTokens,
      outputTokens: sum.outputTokens + call.outputTokens
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0 }
  )
  return sameUsage(aggregate, turnUsage)
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
        const rawModelCalls = response._meta?.[ACP_MODEL_CALL_USAGE_META_KEY]
        const managedModelCalls = toManagedModelCalls(rawModelCalls)
        const modelCalls =
          modelTurnCount !== undefined &&
          managedModelCalls &&
          hasExactCallCoverage(managedModelCalls, modelTurnCount, turnUsage)
            ? managedModelCalls
            : rawModelCalls === undefined &&
                modelTurnCount === 1 &&
                terminalUsage &&
                turnUsage &&
                sameUsage(terminalUsage, turnUsage)
              ? [terminalUsage]
              : undefined
        return {
          ...(turnUsage ? { turnUsage } : {}),
          ...(modelTurnCount === undefined ? {} : { modelTurnCount }),
          ...(contextUsedTokens === undefined ? {} : { contextUsedTokens }),
          ...(terminalUsage ? { lastModelStepUsage: terminalUsage } : {}),
          ...(modelCalls ? { modelCalls } : {})
        }
      },
      cancel: () => {
        closed = true
      }
    }
  }
})

export { createCodexTurnAdapter }
