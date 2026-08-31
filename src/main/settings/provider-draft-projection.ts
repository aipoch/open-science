import type { ProviderDraft } from '../../shared/settings'
import {
  defaultVendorModel,
  isOfficialVendorId,
  resolveCustomModelContextWindow,
  resolveVendorBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import type { ResolvedProvider } from './provider-env'
import { resolveCustomTokenLimits } from './provider-token-limits'

export const resolveProviderDraft = (draft: ProviderDraft): ResolvedProvider => {
  if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
    const draftModel = draft.model ?? defaultVendorModel(draft.vendorId)
    return {
      type: 'custom',
      vendorId: draft.vendorId,
      baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
      openaiBaseUrl: resolveVendorOpenAiBaseUrl(draft.vendorId, draft.region),
      model: draftModel,
      key: draft.key,
      apiEndpoints: resolveVendorModelApiEndpoints(draft.vendorId, draftModel)
    }
  }
  const tokenLimits = draft.type === 'custom' ? resolveCustomTokenLimits(draft) : undefined
  return {
    type: draft.type,
    ...(draft.codexTransport === undefined ? {} : { codexTransport: draft.codexTransport }),
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
