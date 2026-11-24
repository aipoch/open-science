import { supportsManualProviderContextWindow } from '../../shared/manual-provider'
import { decodeProviderModels } from '../../shared/configured-provider-model'
import {
  decodeLocalProviderModels,
  isLocalProviderPresetId
} from '../../shared/local-provider-preset'
import { resolveOfficialModelCatalog } from '../../shared/provider-model-catalog'
import { resolveCloudflareGateway, resolveManualProviderTarget } from './manual-provider-target'
import type { ProviderDraft } from '../../shared/settings'
import {
  isOfficialVendorId,
  resolveVendorBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl
} from '@aipoch/providers'
import {
  defaultVendorModel,
  resolveCustomModelContextWindow
} from '../../shared/provider-model-policy'
import type { ResolvedProvider } from './provider-env'
import { resolveCustomTokenLimits } from './provider-token-limits'

export const resolveProviderDraft = (draft: ProviderDraft): ResolvedProvider => {
  if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
    if (supportsManualProviderContextWindow(draft.vendorId)) {
      const target =
        draft.vendorId === 'cloudflare-ai-gateway'
          ? resolveCloudflareGateway(draft.cloudflare, draft.model, draft.key?.trim())
          : resolveManualProviderTarget(
              draft.vendorId,
              draft.manualConnection,
              draft.model,
              draft.key
            )
      const { contextWindow } = resolveCustomTokenLimits({
        type: draft.type,
        contextWindow: draft.contextWindow
      })
      const model = resolveOfficialModelCatalog({
        ...draft,
        model: target.model,
        contextWindow,
        manualModels: decodeProviderModels(draft.manualModels)
      }).find(({ id }) => id === target.model)
      return { ...target, contextWindow: model?.contextWindow }
    }
    const draftModel = draft.model ?? defaultVendorModel(draft.vendorId, draft.region)
    return {
      type: 'custom',
      vendorId: draft.vendorId,
      baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
      chatCompletionsBaseUrl: resolveVendorChatCompletionsBaseUrl(draft.vendorId, draft.region),
      responsesBaseUrl: resolveVendorResponsesBaseUrl(draft.vendorId, draft.region),
      model: draftModel,
      key: draft.key,
      apiEndpoints: resolveVendorModelApiEndpoints(draft.vendorId, draftModel)
    }
  }
  const tokenLimits = draft.type === 'custom' ? resolveCustomTokenLimits(draft) : undefined
  const localModels =
    draft.type === 'custom' && isLocalProviderPresetId(draft.localPresetId)
      ? decodeLocalProviderModels(draft.localModels)
      : undefined
  const localModel = localModels?.find(({ id }) => id === draft.model) ?? localModels?.[0]
  return {
    type: draft.type,
    ...(draft.codexTransport === undefined ? {} : { codexTransport: draft.codexTransport }),
    baseUrl: draft.baseUrl,
    model: localModel?.id ?? draft.model,
    ...(draft.type === 'custom'
      ? {
          contextWindow: resolveCustomModelContextWindow(
            localModel ? localModel.contextWindow : tokenLimits?.contextWindow
          ),
          ...(tokenLimits?.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: tokenLimits.maxInputTokens }),
          ...(tokenLimits?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: tokenLimits.maxOutputTokens })
        }
      : {}),
    key: draft.key,
    apiEndpoints: draft.apiEndpoints ?? ['messages'],
    ...(draft.type === 'custom' ? { reasoningEffortTransport: draft.reasoningEffortTransport } : {})
  }
}
