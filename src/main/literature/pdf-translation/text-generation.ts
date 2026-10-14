import { createHash } from 'node:crypto'
import { createTextGenerationClient, ProviderTextGenerationError } from '@aipoch/providers/client'
import type {
  ChatApiEndpoint,
  OfficialVendorId,
  ResolvedReasoningEffort,
  CustomReasoningEffortTransport
} from '@aipoch/providers'
import {
  anthropicMessagesUrl,
  openAiChatCompletionsUrl,
  openAiResponsesUrl,
  type ProviderTokenUsage
} from '@aipoch/providers/protocol'
import { customProviderRequiresKey } from '../../../shared/provider-url-policy'

export type ProviderTextGenerationConfiguration = Readonly<{
  type: 'custom' | 'official'
  key?: string
  baseUrl?: string
  openaiBaseUrl?: string
  apiEndpoints?: readonly ChatApiEndpoint[]
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
  maxOutputTokens?: number
}>

export type ProviderTextGenerationTarget = Readonly<{
  providerId: string
  model?: string
  reasoningEffort?: ResolvedReasoningEffort
  provider: ProviderTextGenerationConfiguration
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

/** Stable non-secret identity for resuming work with the same provider configuration. */
export function providerTextGenerationTargetKey(target: ProviderTextGenerationTarget): string {
  // Preserve existing persisted keys, including omitted/default reasoning equivalence.
  const identity = [
    'api',
    target.providerId,
    target.model,
    target.provider.apiEndpoints,
    target.provider.baseUrl,
    target.provider.openaiBaseUrl,
    ...(target.reasoningEffort && target.reasoningEffort !== 'default'
      ? [target.reasoningEffort, target.provider.vendorId, target.provider.reasoningEffortTransport]
      : [])
  ]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export class ProviderTextGenerationService {
  constructor(private readonly fetchImpl: typeof fetch) {}
  supportsTarget(target: ProviderTextGenerationTarget): boolean {
    const provider = target.provider
    const hasKey = typeof provider.key === 'string' && provider.key.length > 0
    const hasModel = typeof target.model === 'string' && target.model.length > 0
    const hasOpenAi =
      provider.apiEndpoints?.includes('openai') && openAiChatCompletionsUrl(provider)
    const hasResponses =
      provider.apiEndpoints?.includes('responses') && openAiResponsesUrl(provider)
    const hasAnthropic = provider.apiEndpoints?.includes('anthropic') && provider.baseUrl
    return (
      (provider.type === 'custom' || provider.type === 'official') &&
      (hasKey || (provider.type === 'custom' && !customProviderRequiresKey(provider.baseUrl))) &&
      hasModel &&
      Boolean(hasOpenAi || hasAnthropic || hasResponses)
    )
  }

  async run(
    input: ProviderTextGenerationRequest
  ): Promise<{ text: string; stopReason: 'end_turn' }> {
    input.signal.throwIfAborted()
    if (!this.supportsTarget(input.target))
      throw new ProviderTextGenerationError('unsupported-target', 'Text generation is unavailable.')
    const provider = input.target.provider
    const protocol =
      provider.apiEndpoints?.includes('openai') && openAiChatCompletionsUrl(provider)
        ? 'openai'
        : provider.apiEndpoints?.includes('anthropic') && provider.baseUrl
          ? 'anthropic'
          : 'responses'
    const url =
      protocol === 'openai'
        ? openAiChatCompletionsUrl(provider)!
        : protocol === 'responses'
          ? openAiResponsesUrl(provider)!
          : anthropicMessagesUrl(provider.baseUrl!)
    return createTextGenerationClient(this.fetchImpl).run({
      ...input,
      target: {
        protocol,
        url,
        model: input.target.model!,
        key: provider.key,
        vendorId: provider.vendorId,
        reasoningEffortTransport: provider.reasoningEffortTransport,
        reasoningEffort: input.target.reasoningEffort,
        maxOutputTokens: provider.maxOutputTokens
      }
    })
  }
}
