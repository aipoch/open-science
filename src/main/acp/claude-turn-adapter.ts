import { toAcpTurnTokenUsage } from '../../shared/acp'
import type { AcpModelStepTokenUsage, AcpTurnTokenUsage } from '../../shared/acp'
import type {
  AcpProviderModelCallUsage,
  AcpProviderTurnAdapter,
  AcpProviderTurnResult
} from './provider-turn-adapter'

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
): AcpProviderModelCallUsage | undefined => {
  if (
    (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null) ||
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
  const modelUsage = toAcpTurnTokenUsage({
    inputTokens: usage.input_tokens,
    cachedReadTokens: usage.cache_read_input_tokens ?? 0,
    cachedWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens
  })
  if (!modelUsage) return undefined
  return {
    ...modelUsage,
    ...(typeof inner.id === 'string' && inner.id.length > 0 ? { sourceInvocationId: inner.id } : {})
  }
}

const sameClaudeModelCallUsage = (
  left: AcpProviderModelCallUsage,
  right: AcpProviderModelCallUsage
): boolean =>
  left.inputTokens === right.inputTokens &&
  left.cacheTokens === right.cacheTokens &&
  left.cachedReadTokens === right.cachedReadTokens &&
  left.cachedWriteTokens === right.cachedWriteTokens &&
  left.outputTokens === right.outputTokens

const hasExactClaudeCallCoverage = (
  calls: readonly AcpProviderModelCallUsage[],
  count: number,
  turnUsage: AcpTurnTokenUsage | undefined
): boolean => {
  if (!turnUsage || calls.length !== count) return false
  const totals = calls.reduce<{
    inputTokens: number
    cacheTokens: number
    cachedReadTokens: number
    cachedWriteTokens: number
    outputTokens: number
  }>(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.inputTokens,
      cacheTokens: sum.cacheTokens + call.cacheTokens,
      cachedReadTokens: sum.cachedReadTokens + (call.cachedReadTokens ?? 0),
      cachedWriteTokens: sum.cachedWriteTokens + (call.cachedWriteTokens ?? 0),
      outputTokens: sum.outputTokens + call.outputTokens
    }),
    {
      inputTokens: 0,
      cacheTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 0
    }
  )
  return (
    totals.inputTokens === turnUsage.inputTokens &&
    totals.cacheTokens === turnUsage.cacheTokens &&
    totals.outputTokens === turnUsage.outputTokens &&
    (turnUsage.cachedReadTokens === undefined ||
      totals.cachedReadTokens === turnUsage.cachedReadTokens) &&
    (turnUsage.cachedWriteTokens === undefined ||
      totals.cachedWriteTokens === turnUsage.cachedWriteTokens)
  )
}

type ClaudeTranscriptReader = (
  input: Readonly<{
    providerSessionId: string
    cwd: string
  }>
) => Promise<readonly unknown[]>

type ClaudeCodeTurnAdapterOptions = Readonly<{
  readTranscriptMessages?: ClaudeTranscriptReader
}>

const recoverClaudeModelCalls = async (
  readTranscriptMessages: ClaudeTranscriptReader | undefined,
  input: Readonly<{
    providerSessionId: string
    cwd: string
    observedCalls: readonly AcpProviderModelCallUsage[]
    modelTurnCount: number
    turnUsage: AcpTurnTokenUsage | undefined
  }>
): Promise<readonly AcpProviderModelCallUsage[] | undefined> => {
  if (!readTranscriptMessages || input.observedCalls.length !== input.modelTurnCount) {
    return undefined
  }
  const invocationIds = input.observedCalls.map((call) => call.sourceInvocationId)
  if (invocationIds.some((id) => !id)) return undefined

  let messages: readonly unknown[]
  try {
    messages = await readTranscriptMessages({
      providerSessionId: input.providerSessionId,
      cwd: input.cwd
    })
  } catch {
    return undefined
  }

  const expectedIds = new Set(invocationIds as string[])
  const recoveredById = new Map<string, AcpProviderModelCallUsage>()
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (message.type !== 'assistant') continue
    const call = toClaudeModelStepUsage(message)
    const id = call?.sourceInvocationId
    if (!call || !id || !expectedIds.has(id)) continue
    const previous = recoveredById.get(id)
    if (previous && !sameClaudeModelCallUsage(previous, call)) return undefined
    recoveredById.set(id, call)
  }

  const recovered = (invocationIds as string[]).flatMap((id) => {
    const call = recoveredById.get(id)
    return call ? [call] : []
  })
  return hasExactClaudeCallCoverage(recovered, input.modelTurnCount, input.turnUsage)
    ? recovered
    : undefined
}

// ARD-24 owns Runtime probe selection and lifecycle wiring; this leaf only provides the
// side-effect-free Claude interpretation module for that serialized executor cutover.
export const createClaudeCodeTurnAdapter = (
  options: ClaudeCodeTurnAdapterOptions = {}
): AcpProviderTurnAdapter => ({
  begin: ({ providerSessionId, cwd }) => {
    let modelTurnCount = 0
    let lastModelStepUsage: AcpModelStepTokenUsage | undefined
    let modelCalls: AcpProviderModelCallUsage[] = []
    let modelCallIndexes = new Map<string, number>()
    let modelCallsTrusted = true
    let closed = false
    const close = (): void => {
      closed = true
      modelTurnCount = 0
      lastModelStepUsage = undefined
      modelCalls = []
      modelCallIndexes = new Map()
      modelCallsTrusted = true
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
          const modelCall = toClaudeModelStepUsage(message)
          if (modelCall) {
            lastModelStepUsage = modelCall
            const sourceInvocationId = modelCall.sourceInvocationId
            const existingIndex = sourceInvocationId
              ? modelCallIndexes.get(sourceInvocationId)
              : undefined
            if (existingIndex === undefined) {
              if (sourceInvocationId) modelCallIndexes.set(sourceInvocationId, modelCalls.length)
              modelCalls.push(modelCall)
            } else if (!sameClaudeModelCallUsage(modelCalls[existingIndex], modelCall)) {
              modelCallsTrusted = false
            }
          }
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
      finalize: async ({ response }) => {
        if (closed) return {}
        const finalModelTurnCount = modelTurnCount
        const finalLastModelStepUsage = lastModelStepUsage
        const finalModelCalls = modelCalls
        const finalModelCallsTrusted = modelCallsTrusted
        close()
        const turnUsage = toAcpTurnTokenUsage(response.usage)
        const exactLiveCalls =
          finalModelCallsTrusted &&
          hasExactClaudeCallCoverage(finalModelCalls, finalModelTurnCount, turnUsage)
            ? finalModelCalls
            : undefined
        const exactModelCalls =
          exactLiveCalls ??
          (await recoverClaudeModelCalls(options.readTranscriptMessages, {
            providerSessionId,
            cwd,
            observedCalls: finalModelCalls,
            modelTurnCount: finalModelTurnCount,
            turnUsage
          }))
        const exactLastModelStepUsage = exactModelCalls?.at(-1) ?? finalLastModelStepUsage
        const result: AcpProviderTurnResult = {
          ...(turnUsage ? { turnUsage } : {}),
          ...(finalModelTurnCount > 0 ? { modelTurnCount: finalModelTurnCount } : {}),
          ...(exactLastModelStepUsage ? { lastModelStepUsage: exactLastModelStepUsage } : {}),
          ...(exactModelCalls ? { modelCalls: exactModelCalls } : {})
        }
        return result
      },
      cancel: close
    }
  }
})

export const claudeCodeTurnAdapter = createClaudeCodeTurnAdapter()

export type { ClaudeTranscriptReader }
