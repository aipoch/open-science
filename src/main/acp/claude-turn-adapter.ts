import { toAcpTurnTokenUsage } from '../../shared/acp'
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

// ARD-24 owns Runtime probe selection and lifecycle wiring; this leaf only provides the
// side-effect-free Claude interpretation module for that serialized executor cutover.
export const claudeCodeTurnAdapter: AcpProviderTurnAdapter = {
  begin: ({ providerSessionId }) => {
    let modelTurnCount = 0
    let closed = false
    const close = (): void => {
      closed = true
      modelTurnCount = 0
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
        close()
        const turnUsage = toAcpTurnTokenUsage(response.usage)
        const result: AcpProviderTurnResult = {
          ...(turnUsage ? { turnUsage } : {}),
          ...(finalModelTurnCount > 0 ? { modelTurnCount: finalModelTurnCount } : {})
        }
        return result
      },
      cancel: close
    }
  }
}
