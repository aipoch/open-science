import type { AcpProviderModelCallUsage, AcpProviderTurnAdapter } from './provider-turn-adapter'

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const piTurnAdapter: AcpProviderTurnAdapter = {
  begin: ({ providerSessionId }) => {
    const calls = new Map<string, AcpProviderModelCallUsage>()
    let closed = false
    const close = (): void => {
      closed = true
      calls.clear()
    }
    return {
      observe: (value) => {
        if (closed) return
        const notification = record(value)
        if (notification?.sessionId !== providerSessionId) return
        const update = record(notification.update)
        if (update?.sessionUpdate !== 'agent_message_chunk') return
        const meta = record(record(update._meta)?.pi)
        if (meta?.event !== 'assistant_message') return
        const id = update.messageId
        const usage = record(meta.usage)
        if (typeof id !== 'string' || !id || !usage) return
        const { input, output, cacheRead, cacheWrite } = usage
        if (![input, output, cacheRead, cacheWrite].every(counter)) return
        const inputTokens = input as number
        const outputTokens = output as number
        const cachedReadTokens = cacheRead as number
        const cachedWriteTokens = cacheWrite as number
        const cacheTokens = cachedReadTokens + cachedWriteTokens
        if (!counter(inputTokens + cacheTokens)) return
        calls.set(id, {
          sourceInvocationId: id,
          inputTokens,
          outputTokens,
          cacheTokens,
          cachedReadTokens,
          cachedWriteTokens
        })
      },
      finalize: () => {
        if (closed) return {}
        const modelCalls = [...calls.values()]
        close()
        const last = modelCalls.at(-1)
        if (!last) return {}
        const total = {
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0
        }
        for (const call of modelCalls) {
          for (const key of Object.keys(total) as Array<keyof typeof total>) {
            total[key] += call[key] ?? 0
          }
        }
        if (!Object.values(total).every(counter)) return {}
        return {
          turnUsage: total,
          modelTurnCount: modelCalls.length,
          modelCalls,
          contextUsedTokens: last.inputTokens + last.cacheTokens,
          lastModelStepUsage: {
            inputTokens: last.inputTokens,
            outputTokens: last.outputTokens,
            cacheTokens: last.cacheTokens,
            cachedReadTokens: last.cachedReadTokens,
            cachedWriteTokens: last.cachedWriteTokens
          }
        }
      },
      cancel: close
    }
  }
}
