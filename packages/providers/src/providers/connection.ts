import type { ProviderTextGenerationTarget } from '../protocols/text-types'
import {
  anthropicMessagesUrl,
  openAiChatCompletionsUrl,
  openAiResponsesUrl
} from '../protocols/endpoints'
import { getProviderDefinition } from './definitions'
import {
  resolveVendorBaseUrl,
  resolveVendorOpenAiBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorModelsUrl
} from './lookup'
import type { ChatApiEndpoint } from '../protocols/types'

export function resolveModelDiscoveryUrl(id: string, region?: string): string | undefined {
  // xAI's full inventory includes non-chat models. Host pickers decide whether to expose it.
  if (id === 'xai') return 'https://api.x.ai/v1/models'
  const vendor = getProviderDefinition(id)?.textGeneration
  return vendor ? resolveVendorModelsUrl(vendor.id, region) : undefined
}

export type TextGenerationConfiguration = Readonly<{
  /** Explicit wire override for custom services. Otherwise the provider resolves its own protocol. */
  protocol?: ChatApiEndpoint
  url?: string
  baseUrl?: string
  openaiBaseUrl?: string
  responsesBaseUrl?: string
  apiEndpoints?: readonly ChatApiEndpoint[]
  reasoningEffort?: ProviderTextGenerationTarget['reasoningEffort']
  reasoningEffortTransport?: ProviderTextGenerationTarget['reasoningEffortTransport']
  maxOutputTokens?: number
}>

export function resolveTextConnection(
  id: string,
  model: string,
  region: string | undefined,
  configuration: TextGenerationConfiguration | undefined
): ProviderTextGenerationTarget {
  const vendor = getProviderDefinition(id)?.textGeneration
  const explicitBase =
    configuration?.baseUrl !== undefined || configuration?.openaiBaseUrl !== undefined
  const baseUrl =
    configuration?.baseUrl ??
    (!explicitBase && vendor ? resolveVendorBaseUrl(vendor.id, region) : undefined)
  const openaiBaseUrl =
    configuration?.openaiBaseUrl ??
    (!explicitBase && vendor ? resolveVendorOpenAiBaseUrl(vendor.id, region) : undefined)
  const responsesBaseUrl =
    configuration?.responsesBaseUrl ??
    (!explicitBase && vendor ? resolveVendorResponsesBaseUrl(vendor.id, region) : undefined)
  const endpoints =
    configuration?.apiEndpoints ?? (vendor ? resolveVendorModelApiEndpoints(vendor.id, model) : [])
  const protocol =
    configuration?.protocol ??
    (endpoints.includes('openai') && openAiChatCompletionsUrl({ baseUrl, openaiBaseUrl })
      ? 'openai'
      : endpoints.includes('anthropic') && baseUrl
        ? 'anthropic'
        : endpoints.includes('responses')
          ? 'responses'
          : undefined)
  const url =
    configuration?.url ??
    (protocol === 'openai'
      ? openAiChatCompletionsUrl({ baseUrl, openaiBaseUrl })
      : protocol === 'anthropic' && baseUrl
        ? anthropicMessagesUrl(baseUrl)
        : protocol === 'responses'
          ? openAiResponsesUrl({ baseUrl, openaiBaseUrl: responsesBaseUrl ?? openaiBaseUrl })
          : undefined)
  if (!protocol || !url)
    throw new TypeError(`Provider ${id} requires an explicit remote text endpoint.`)
  return {
    protocol,
    url,
    model,
    vendorId: vendor?.id,
    reasoningEffort: configuration?.reasoningEffort,
    reasoningEffortTransport: configuration?.reasoningEffortTransport,
    maxOutputTokens: configuration?.maxOutputTokens,
    anthropicApiKeyHeader: vendor
      ? vendor.id === 'anthropic' || vendor.anthropicApiKeyHeader === true
      : true
  }
}
