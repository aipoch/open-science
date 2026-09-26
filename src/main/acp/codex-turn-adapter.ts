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
        // Raw Codex input already includes cached reads; pinned ACP publishes mutually exclusive
        // input/cache categories. Recombine those once, using the latest request rather than the turn sum.
        const turnUsage =
          toCodexTurnTokenUsage(response._meta?.[ACP_TURN_TOKEN_USAGE_META_KEY]) ?? terminalUsage
        const reportedContextUsedTokens = terminalUsage
          ? terminalUsage.inputTokens + terminalUsage.cacheTokens
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
