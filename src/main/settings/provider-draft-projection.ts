import { decodeProviderModels } from '../../shared/configured-provider-model'
import { decodeLocalProviderModels } from '../../shared/local-provider-preset'
import { resolveOfficialModelCatalog } from '../../shared/provider-model-catalog'
import { resolveConfiguredProviderTarget } from './manual-provider-target'
import type { ProviderDraft } from '../../shared/settings'
import {
  configuredProviderConnectionKind,
  isLocalProviderPresetId,
  isOfficialVendorId,
  selectConfiguredModelId,
  supportsConfiguredProviderModelList,
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
    if (configuredProviderConnectionKind(draft.vendorId)) {
      const configuredModels = supportsConfiguredProviderModelList(draft.vendorId)
        ? draft.manualModels
        : undefined
      const manualModels = decodeProviderModels(configuredModels)
      if (configuredModels !== undefined && !manualModels)
        throw new Error('Enter a valid model list.')
      const modelIds = manualModels?.map(({ id }) => id)
      const target = resolveConfiguredProviderTarget(
        draft.vendorId,
        draft,
        selectConfiguredModelId(draft.model, modelIds),
        draft.key,
        modelIds
      )
      const { contextWindow } = resolveCustomTokenLimits({
        type: draft.type,
        contextWindow: draft.contextWindow
      })
      const model = resolveOfficialModelCatalog({
        ...draft,
        model: target.model,
        contextWindow,
        manualModels
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
  const localModelId = selectConfiguredModelId(
    draft.model,
    localModels?.map(({ id }) => id)
  )
  const localModel = localModels?.find(({ id }) => id === localModelId)
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
