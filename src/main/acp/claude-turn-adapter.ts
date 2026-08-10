import { toAcpTurnTokenUsage } from '../../shared/acp'
import type { AcpModelStepTokenUsage } from '../../shared/acp'
import type { AcpProviderTurnAdapter, AcpProviderTurnResult } from './provider-turn-adapter'

// Unknown future origins stay eligible so a new user-driven lane does not silently under-report
// model turns before Open Science knows its name.
const CLAUDE_AUTONOMOUS_RESULT_ORIGINS = new Set([
  'task-notification',
  'peer',
  'coordinator',
  'observer',
  'observer-activity'
])

const toClaudeModelStepUsage = (
  message: Record<string, unknown>
): AcpModelStepTokenUsage | undefined => {
  if (
    message.parent_tool_use_id !== null ||
    typeof message.message !== 'object' ||
    message.message === null ||
    Array.isArray(message.message)
  ) {
    return undefined
  }
  const inner = message.message as Record<string, unknown>
  if (typeof inner.usage !== 'object' || inner.usage === null || Array.isArray(inner.usage)) {
    return undefined
  }
  const usage = inner.usage as Record<string, unknown>
  return toAcpTurnTokenUsage({
    inputTokens: usage.input_tokens,
    cachedReadTokens: usage.cache_read_input_tokens ?? 0,
    cachedWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens
  })
}

// ARD-24 owns Runtime probe selection and lifecycle wiring; this leaf only provides the
// side-effect-free Claude interpretation module for that serialized executor cutover.
export const claudeCodeTurnAdapter: AcpProviderTurnAdapter = {
  begin: ({ providerSessionId }) => {
    let modelTurnCount = 0
    let lastModelStepUsage: AcpModelStepTokenUsage | undefined
    let closed = false
    const close = (): void => {
      closed = true
      modelTurnCount = 0
      lastModelStepUsage = undefined
    }

    return {
      observe: (value) => {
        if (closed) return
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        const params = value as Record<string, unknown>
        if (params.sessionId !== providerSessionId) return
        if (
          typeof params.message !== 'object' ||
          params.message === null ||
          Array.isArray(params.message)
        ) {
          return
        }

        const message = params.message as Record<string, unknown>
        if (message.type === 'assistant') {
          lastModelStepUsage = toClaudeModelStepUsage(message) ?? lastModelStepUsage
          return
        }
        if (message.type !== 'result') return
        const origin =
          typeof message.origin === 'object' && message.origin !== null
            ? (message.origin as Record<string, unknown>).kind
            : undefined
        if (typeof origin === 'string' && CLAUDE_AUTONOMOUS_RESULT_ORIGINS.has(origin)) return
        if (!Number.isSafeInteger(message.num_turns) || (message.num_turns as number) <= 0) return

        const nextCount = modelTurnCount + (message.num_turns as number)
        if (Number.isSafeInteger(nextCount)) modelTurnCount = nextCount
      },
      finalize: ({ response }) => {
        if (closed) return {}
        const finalModelTurnCount = modelTurnCount
        const finalLastModelStepUsage = lastModelStepUsage
        close()
        const turnUsage = toAcpTurnTokenUsage(response.usage)
        const result: AcpProviderTurnResult = {
          ...(turnUsage ? { turnUsage } : {}),
          ...(finalModelTurnCount > 0 ? { modelTurnCount: finalModelTurnCount } : {}),
          ...(finalLastModelStepUsage ? { lastModelStepUsage: finalLastModelStepUsage } : {})
        }
        return result
      },
      cancel: close
    }
  }
}
