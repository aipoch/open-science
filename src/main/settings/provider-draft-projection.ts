import type { ChatApiEndpoint, ProviderDraft } from '../../shared/settings'
import {
  defaultVendorModel,
  isOfficialVendorId,
  isVendorModelResponsesSupported,
  resolveCustomModelContextWindow,
  resolveVendorApiEndpoints,
  resolveVendorBaseUrl,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import type { ResolvedProvider } from './provider-env'
import { resolveCustomTokenLimits } from './provider-token-limits'

export const resolveProviderDraft = (draft: ProviderDraft): ResolvedProvider => {
  if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
    const draftModel = draft.model ?? defaultVendorModel(draft.vendorId)
    const vendorEndpoints = resolveVendorApiEndpoints(draft.vendorId)
    const draftEndpoints: ChatApiEndpoint[] =
      !vendorEndpoints.includes('responses') &&
      isVendorModelResponsesSupported(draft.vendorId, draftModel)
        ? [...vendorEndpoints, 'responses']
        : vendorEndpoints
    return {
      type: 'custom',
      vendorId: draft.vendorId,
      baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
      openaiBaseUrl: resolveVendorOpenAiBaseUrl(draft.vendorId, draft.region),
      model: draftModel,
      key: draft.key,
      apiEndpoints: draftEndpoints
    }
  }
  const tokenLimits = draft.type === 'custom' ? resolveCustomTokenLimits(draft) : undefined
  return {
    type: draft.type,
    baseUrl: draft.baseUrl,
    model: draft.model,
    ...(draft.type === 'custom'
      ? {
          contextWindow: resolveCustomModelContextWindow(tokenLimits?.contextWindow),
          ...(tokenLimits?.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: tokenLimits.maxInputTokens }),
          ...(tokenLimits?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: tokenLimits.maxOutputTokens })
        }
      : {}),
    key: draft.key,
    apiEndpoints: draft.apiEndpoints ?? ['anthropic'],
    ...(draft.type === 'custom' ? { reasoningEffortTransport: draft.reasoningEffortTransport } : {})
  }
}
