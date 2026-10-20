import type { ModelProtocol, ModelReasoningEffort, CustomReasoningEffortTransport } from './types'
import type { ProviderTokenUsage } from './usage'

/** One already-selected wire endpoint. Account selection and saved identities belong to the caller. */
export type ProviderTextGenerationTarget = Readonly<{
  protocol: ModelProtocol
  url: string
  model: string
  key?: string
  vendorId?: string
  messagesApiKeyHeader?: boolean
  reasoningEffort?: ModelReasoningEffort | 'default'
  reasoningEffortTransport?: CustomReasoningEffortTransport
  maxOutputTokens?: number
}>
export type ProviderTextGenerationRequest = Readonly<{
  target: ProviderTextGenerationTarget
  systemPrompt: string
  prompt: string
  signal: AbortSignal
  maxOutputTokens: number
  outputLimitBytes: number
  onUsage?: (usage: ProviderTokenUsage) => void
}>
export type TextCodec = {
  encode(input: ProviderTextGenerationRequest): Record<string, unknown>
  usage(value: unknown): ProviderTokenUsage | undefined
  text(value: unknown): string
}
