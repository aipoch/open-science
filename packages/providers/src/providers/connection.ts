import type { ProviderTextGenerationTarget } from '../protocols/text-types'
import {
  resolveMessagesUrl,
  resolveChatCompletionsUrl,
  resolveResponsesUrl
} from '../protocols/endpoints'
import { getProviderDefinition } from './definitions'
import {
  resolveVendorBaseUrl,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorModelsUrl
} from './lookup'
import type { ModelProtocol } from '../protocols/types'

export function resolveModelDiscoveryUrl(id: string, region?: string): string | undefined {
  // xAI's full inventory includes non-chat models. Host pickers decide whether to expose it.
  if (id === 'xai') return 'https://api.x.ai/v1/models'
  const vendor = getProviderDefinition(id)?.textGeneration
  return vendor ? resolveVendorModelsUrl(vendor.id, region) : undefined
}

export type TextGenerationConfiguration = Readonly<{
  /** Explicit wire override for custom services. Otherwise the provider resolves its own protocol. */
  protocol?: ModelProtocol
  url?: string
  baseUrl?: string
  chatCompletionsBaseUrl?: string
  responsesBaseUrl?: string
  apiEndpoints?: readonly ModelProtocol[]
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
    configuration?.baseUrl !== undefined || configuration?.chatCompletionsBaseUrl !== undefined
  const baseUrl =
    configuration?.baseUrl ??
    (!explicitBase && vendor ? resolveVendorBaseUrl(vendor.id, region) : undefined)
  const chatCompletionsBaseUrl =
    configuration?.chatCompletionsBaseUrl ??
    (!explicitBase && vendor ? resolveVendorChatCompletionsBaseUrl(vendor.id, region) : undefined)
  const responsesBaseUrl =
    configuration?.responsesBaseUrl ??
    (!explicitBase && vendor ? resolveVendorResponsesBaseUrl(vendor.id, region) : undefined)
  const endpoints =
    configuration?.apiEndpoints ?? (vendor ? resolveVendorModelApiEndpoints(vendor.id, model) : [])
  const protocol =
    configuration?.protocol ??
    (endpoints.includes('chat-completions') &&
    resolveChatCompletionsUrl({ baseUrl, chatCompletionsBaseUrl })
      ? 'chat-completions'
      : endpoints.includes('messages') && baseUrl
        ? 'messages'
        : endpoints.includes('responses')
          ? 'responses'
          : undefined)
  const url =
    configuration?.url ??
    (protocol === 'chat-completions'
      ? resolveChatCompletionsUrl({ baseUrl, chatCompletionsBaseUrl })
      : protocol === 'messages' && baseUrl
        ? resolveMessagesUrl(baseUrl)
        : protocol === 'responses'
          ? resolveResponsesUrl({
              baseUrl,
              chatCompletionsBaseUrl: responsesBaseUrl ?? chatCompletionsBaseUrl
            })
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
    messagesApiKeyHeader: vendor
      ? vendor.id === 'anthropic' || vendor.messagesApiKeyHeader === true
      : true
  }
}
