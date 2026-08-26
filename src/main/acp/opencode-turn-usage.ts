import type { AcpModelStepTokenUsage, AcpTurnTokenUsage } from '../../shared/acp'
import type { AcpProviderModelCallUsage } from './provider-turn-adapter'
import type { ResolvedAgentBackend } from '../agent-framework'

export type OpenCodeUsageSnapshot = {
  assistantMessageIds: Set<string>
  usageByMessageId: Map<string, AcpTurnTokenUsage>
}

type OpenCodeMessageInfo = {
  id?: unknown
  role?: unknown
  tokens?: unknown
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const messageUsage = (value: unknown): AcpTurnTokenUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const tokens = value as {
    input?: unknown
    output?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  const inputTokens = tokenCount(tokens.input)
  const outputTokens = tokenCount(tokens.output)
  const cachedReadTokens = tokenCount(tokens.cache?.read ?? 0)
  const cachedWriteTokens = tokenCount(tokens.cache?.write ?? 0)
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedReadTokens === undefined ||
    cachedWriteTokens === undefined
  ) {
    return undefined
  }

  const cacheTokens = cachedReadTokens + cachedWriteTokens
  const hasCacheBreakdown =
    tokenCount(tokens.cache?.read) !== undefined && tokenCount(tokens.cache?.write) !== undefined
  return Number.isSafeInteger(cacheTokens)
    ? {
        inputTokens,
        cacheTokens,
        ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
        outputTokens
      }
    : undefined
}

export const fetchOpenCodeUsageSnapshot = async (
  api: NonNullable<ResolvedAgentBackend['opencodeUsageApi']>,
  sessionId: string,
  cwd: string,
  fetchImpl: typeof fetch = fetch
): Promise<OpenCodeUsageSnapshot | undefined> => {
  try {
    const url = new URL(
      `/session/${encodeURIComponent(sessionId)}/message`,
      api.baseUrl.endsWith('/') ? api.baseUrl : `${api.baseUrl}/`
    )
    url.searchParams.set('directory', cwd)
    const response = await fetchImpl(url, {
      headers: { authorization: api.authorization },
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return undefined

    const messages = (await response.json()) as unknown
    if (!Array.isArray(messages)) return undefined

    const assistantMessageIds = new Set<string>()
    const usageByMessageId = new Map<string, AcpTurnTokenUsage>()
    for (const message of messages) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
      const info = (message as { info?: OpenCodeMessageInfo }).info
      if (!info || info.role !== 'assistant' || typeof info.id !== 'string') continue
      assistantMessageIds.add(info.id)
      const usage = messageUsage(info.tokens)
      if (usage) usageByMessageId.set(info.id, usage)
    }

    return { assistantMessageIds, usageByMessageId }
  } catch {
    return undefined
  }
}

export type OpenCodeTurnUsageDiff = Readonly<{
  turnUsage: AcpTurnTokenUsage
  lastModelStepUsage: AcpModelStepTokenUsage
  modelCalls: ReadonlyArray<AcpProviderModelCallUsage & { sourceInvocationId: string }>
}>

export const diffOpenCodeTurnUsage = (
  before: OpenCodeUsageSnapshot | undefined,
  after: OpenCodeUsageSnapshot | undefined
): OpenCodeTurnUsageDiff | undefined => {
  if (!before || !after) return undefined

  const newMessageIds = [...after.assistantMessageIds].filter(
    (messageId) => !before.assistantMessageIds.has(messageId)
  )
  if (newMessageIds.length === 0) return undefined

  let inputTokens = 0
  let cacheTokens = 0
  let cachedReadTokens = 0
  let cachedWriteTokens = 0
  let hasCacheBreakdown = true
  let outputTokens = 0
  const modelCalls: Array<AcpProviderModelCallUsage & { sourceInvocationId: string }> = []
  for (const messageId of newMessageIds) {
    const usage = after.usageByMessageId.get(messageId)
    // Never publish a partial sum when OpenCode changes or omits one new assistant record.
    if (!usage) return undefined
    inputTokens += usage.inputTokens
    cacheTokens += usage.cacheTokens
    if (usage.cachedReadTokens === undefined || usage.cachedWriteTokens === undefined) {
      hasCacheBreakdown = false
    } else {
      cachedReadTokens += usage.cachedReadTokens
      cachedWriteTokens += usage.cachedWriteTokens
    }
    outputTokens += usage.outputTokens
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(cacheTokens) ||
      !Number.isSafeInteger(cachedReadTokens) ||
      !Number.isSafeInteger(cachedWriteTokens) ||
      !Number.isSafeInteger(outputTokens)
    ) {
      return undefined
    }
    const contextUsedTokens =
      usage.cachedReadTokens === undefined ? undefined : usage.inputTokens + usage.cachedReadTokens
    if (contextUsedTokens !== undefined && !Number.isSafeInteger(contextUsedTokens)) {
      return undefined
    }
    modelCalls.push({
      sourceInvocationId: messageId,
      ...usage,
      ...(contextUsedTokens === undefined ? {} : { contextUsedTokens })
    })
  }

  const lastModelStepUsage = after.usageByMessageId.get(newMessageIds.at(-1)!)
  if (!lastModelStepUsage) return undefined

  return {
    turnUsage: {
      inputTokens,
      cacheTokens,
      ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
      outputTokens,
      turnCount: newMessageIds.length
    },
    lastModelStepUsage: { ...lastModelStepUsage },
    modelCalls
  }
}

export const sumOpenCodeTurnUsage = (
  before: OpenCodeUsageSnapshot | undefined,
  after: OpenCodeUsageSnapshot | undefined
): AcpTurnTokenUsage | undefined => diffOpenCodeTurnUsage(before, after)?.turnUsage
