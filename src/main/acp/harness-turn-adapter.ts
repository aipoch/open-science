import { z } from 'zod'
import type { AcpProviderModelCallUsage, AcpProviderTurnAdapter } from './provider-turn-adapter'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const receipt = z
  .array(
    z.object({
      id: z.string().min(1),
      status: z.enum(['started', 'completed', 'failed', 'interrupted']),
      usage: z
        .object({
          inputTokens: count,
          outputTokens: count,
          cacheReadTokens: count.optional(),
          cacheWriteTokens: count.optional()
        })
        .optional()
    })
  )
  .min(1)

/** Host accounting consumes package receipts; it does not run another model loop. */
export const harnessTurnAdapter: AcpProviderTurnAdapter = {
  begin: () => ({
    finalize: ({ response }) => {
      const parsed = receipt.safeParse(response._meta?.['open-science-agent/requests'])
      if (!parsed.success || new Set(parsed.data.map((r) => r.id)).size !== parsed.data.length)
        return {}
      const modelTurnCount = parsed.data.length
      if (parsed.data.some((r) => r.status !== 'completed' || !r.usage)) return { modelTurnCount }
      const calls: AcpProviderModelCallUsage[] = []
      for (const request of parsed.data) {
        const usage = request.usage!
        const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        if (!Number.isSafeInteger(cache) || cache > usage.inputTokens) return { modelTurnCount }
        calls.push({
          sourceInvocationId: request.id,
          inputTokens: usage.inputTokens - cache,
          outputTokens: usage.outputTokens,
          cacheTokens: cache,
          ...(usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
            ? {
                cachedReadTokens: usage.cacheReadTokens,
                cachedWriteTokens: usage.cacheWriteTokens
              }
            : {}),
          contextUsedTokens: usage.inputTokens
        })
      }
      const total = calls.reduce(
        (a, c) => ({
          inputTokens: a.inputTokens + c.inputTokens,
          outputTokens: a.outputTokens + c.outputTokens,
          cacheTokens: a.cacheTokens + c.cacheTokens
        }),
        { inputTokens: 0, outputTokens: 0, cacheTokens: 0 }
      )
      if (!Object.values(total).every(Number.isSafeInteger)) return { modelTurnCount }
      const last = calls.at(-1)!
      return {
        modelTurnCount,
        modelCalls: calls,
        turnUsage: total,
        contextUsedTokens: last.contextUsedTokens,
        lastModelStepUsage: last
      }
    },
    cancel: () => undefined
  })
}
