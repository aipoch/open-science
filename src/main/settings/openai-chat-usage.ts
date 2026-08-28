import type { AcpModelStepTokenUsage } from '../../shared/acp'

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const firstTokenCount = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const count = tokenCount(value)
    if (count !== undefined) return count
  }
  return undefined
}

const normalizeOpenAiChatModelStepUsage = (value: unknown): AcpModelStepTokenUsage | undefined => {
  const usage = record(value)
  if (!usage) return undefined

  const inputDetails = record(
    usage.prompt_tokens_details ??
      usage.promptTokensDetails ??
      usage.input_tokens_details ??
      usage.inputTokensDetails
  )
  const reportedInputTokens = firstTokenCount(
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input_tokens,
    usage.inputTokens
  )
  const outputTokens = firstTokenCount(
    usage.completion_tokens,
    usage.completionTokens,
    usage.output_tokens,
    usage.outputTokens
  )
  const cachedReadTokens =
    firstTokenCount(
      usage.cachedReadTokens,
      usage.cache_read_input_tokens,
      inputDetails?.cached_tokens,
      inputDetails?.cachedTokens
    ) ?? 0
  const cachedWriteTokens =
    firstTokenCount(usage.cachedWriteTokens, usage.cache_creation_input_tokens) ?? 0
  if (reportedInputTokens === undefined || outputTokens === undefined) return undefined

  const inputTokens = reportedInputTokens - cachedReadTokens - cachedWriteTokens
  const cacheTokens = cachedReadTokens + cachedWriteTokens
  if (inputTokens < 0 || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(cacheTokens)) {
    return undefined
  }
  return { inputTokens, cacheTokens, cachedReadTokens, cachedWriteTokens, outputTokens }
}

export { normalizeOpenAiChatModelStepUsage }
