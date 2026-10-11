import type { PdfTranslationAgentModel } from './contracts.js'
export type TranslationUsage = {
  inputTokens: number
  cacheTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  outputTokens: number
  turnCount?: number
}
export type TranslationAgentTarget = Readonly<{
  frameworkId: PdfTranslationAgentModel['frameworkId']
  providerId: string
  providerName?: string
  model: Readonly<{ kind: 'required'; id: string }> | Readonly<{ kind: 'provider-default' }>
  reasoningEffort: PdfTranslationAgentModel['reasoningEffort']
}>
export type TranslationApiTarget = Readonly<{
  providerId: string
  providerName?: string
  model?: string
  reasoningEffort?: string
}>
export type TranslationInferenceResult = Readonly<{
  text: string
  stopReason: string
  usage?: TranslationUsage
  model?: string
}>
export type TranslationAgentRunner<Target extends TranslationAgentTarget> = {
  run(
    input: Readonly<{
      target: Target
      prompt: string
      systemPrompt: string
      agentName: string
      description: string
      signal?: AbortSignal
      outputLimitBytes?: number
    }>
  ): Promise<TranslationInferenceResult>
  supportsTarget(target: Target): boolean
  shutdown(): Promise<void>
  sweepStaleProfiles(): Promise<void>
}
export type TranslationApiRunner<Target extends TranslationApiTarget> = {
  run(
    input: Readonly<{
      target: Target
      systemPrompt: string
      prompt: string
      signal: AbortSignal
      maxOutputTokens: number
      outputLimitBytes: number
      onUsage?: (usage: TranslationUsage) => void
    }>
  ): Promise<TranslationInferenceResult>
  supportsTarget(target: Target): boolean
}
export type TranslationUsageContext = {
  runId: string
  sourceId?: string
  sourceIndex: number
  providerId: string
  frameworkId: string
  model: string
}
export type TranslationUsageCompletion = {
  status: 'completed' | 'failed' | 'interrupted'
  model?: string
  usage?: TranslationUsage
}
export type TranslationUsageRecorder = {
  start(
    context: TranslationUsageContext
  ): Promise<(completion: TranslationUsageCompletion) => Promise<void>>
  recover(): Promise<void>
  flush(): Promise<void>
}
export type TranslationProviderErrors = {
  isProviderError(error: unknown): error is Error & { code: string }
  failure(error: unknown): { kind: string; status?: number } | undefined
  details(error: unknown): string
}
export const defaultProviderErrors: TranslationProviderErrors = {
  isProviderError: (error): error is Error & { code: string } => {
    void error
    return false
  },
  failure: () => undefined,
  details: () => 'Translation provider request failed.'
}

const asTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

// Re-validates the durable projection when loading session JSON, dropping unknown or unsafe values.
export const sanitizeTranslationUsage = (value: unknown): TranslationUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined

  const usage = value as Record<string, unknown>
  const inputTokens = asTokenCount(usage.inputTokens)
  const cacheTokens = asTokenCount(usage.cacheTokens)
  const outputTokens = asTokenCount(usage.outputTokens)
  const turnCount = asTokenCount(usage.turnCount)

  if (inputTokens === undefined || cacheTokens === undefined || outputTokens === undefined) {
    return undefined
  }

  const cachedReadTokens = asTokenCount(usage.cachedReadTokens)
  const cachedWriteTokens = asTokenCount(usage.cachedWriteTokens)
  const hasCacheBreakdown =
    cachedReadTokens !== undefined &&
    cachedWriteTokens !== undefined &&
    Number.isSafeInteger(cachedReadTokens + cachedWriteTokens) &&
    cachedReadTokens + cachedWriteTokens === cacheTokens

  return {
    inputTokens,
    cacheTokens,
    ...(hasCacheBreakdown ? { cachedReadTokens, cachedWriteTokens } : {}),
    outputTokens,
    ...(turnCount !== undefined && turnCount > 0 ? { turnCount } : {})
  }
}
export const extractTranslationUsage = (error: unknown): TranslationUsage | undefined =>
  error instanceof Error
    ? sanitizeTranslationUsage(Object.getOwnPropertyDescriptor(error, 'usage')?.value)
    : undefined
