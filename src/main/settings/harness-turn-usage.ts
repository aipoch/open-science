import { sanitizeAcpTurnTokenUsage } from '../../shared/acp'
import type { AcpModelCallUsage, AcpTurnTokenUsage } from '../../shared/acp-usage-contract'
import type { HarnessModelObservation } from './harness-model-request'

export type HarnessTurnUsage =
  | {
      turnUsage: AcpTurnTokenUsage
      modelCallUsage: AcpModelCallUsage[]
      turnUsageUnavailable?: undefined
    }
  | { turnUsage?: undefined; modelCallUsage?: undefined; turnUsageUnavailable: true }

/** Call only after the turn settles, with the latest durable receipt for every attempted request. */
export function projectHarnessTurnUsage(input: {
  turnId: string
  route: HarnessModelObservation['route']
  requestCount: number
  observations: readonly HarnessModelObservation[]
}): HarnessTurnUsage {
  const { observations, requestCount, route, turnId } = input
  // Explicit undefined clears stale fields when the host merges the result into a message.
  const unavailable: HarnessTurnUsage = {
    turnUsage: undefined,
    modelCallUsage: undefined,
    turnUsageUnavailable: true
  }
  if (!turnId.trim() || !Number.isSafeInteger(requestCount) || requestCount < 0)
    throw new Error('Invalid harness usage scope')
  const ids = new Set<string>()
  const steps = new Set<number>()
  for (const event of observations) {
    if (
      event.turnId !== turnId ||
      event.route.id !== route.id ||
      event.route.providerId !== route.providerId ||
      event.route.configRevision !== route.configRevision ||
      event.route.model !== route.model ||
      event.route.protocol !== route.protocol ||
      !event.requestId.trim() ||
      ids.has(event.requestId) ||
      !Number.isSafeInteger(event.step) ||
      event.step < 0 ||
      steps.has(event.step)
    )
      throw new Error('Mismatched or duplicate harness usage receipt')
    ids.add(event.requestId)
    steps.add(event.step)
  }
  if (observations.length > requestCount) throw new Error('Unexpected harness usage receipt')
  if (!requestCount || observations.length !== requestCount) return unavailable

  const modelCallUsage: AcpModelCallUsage[] = []
  for (const event of [...observations].sort((left, right) => left.step - right.step)) {
    const usage = sanitizeAcpTurnTokenUsage(event.usage)
    if (!['completed', 'failed', 'interrupted'].includes(event.status) || !usage) return unavailable
    // A failed response can still report billable usage; completion status is not a usage filter.
    modelCallUsage.push({
      id: event.requestId,
      index: modelCallUsage.length,
      inputTokens: usage.inputTokens,
      cacheTokens: usage.cacheTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedReadTokens === undefined
        ? {}
        : { cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens })
    })
  }
  const total = (field: 'inputTokens' | 'cacheTokens' | 'outputTokens'): number =>
    modelCallUsage.reduce((sum, call) => sum + call[field], 0)
  const totals = {
    inputTokens: total('inputTokens'),
    cacheTokens: total('cacheTokens'),
    outputTokens: total('outputTokens')
  }
  if (!Object.values(totals).every(Number.isSafeInteger)) return unavailable
  const hasCacheBreakdown = modelCallUsage.every((call) => call.cachedReadTokens !== undefined)
  return {
    turnUsageUnavailable: undefined,
    turnUsage: {
      ...totals,
      turnCount: requestCount,
      ...(hasCacheBreakdown
        ? {
            cachedReadTokens: modelCallUsage.reduce((sum, call) => sum + call.cachedReadTokens!, 0),
            cachedWriteTokens: modelCallUsage.reduce(
              (sum, call) => sum + call.cachedWriteTokens!,
              0
            )
          }
        : {})
    },
    modelCallUsage
  }
}
