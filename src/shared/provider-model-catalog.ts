import {
  getOfficialVendor, resolveVendorBaseUrl, resolveVendorChatCompletionsBaseUrl,
  resolveVendorResponsesBaseUrl, resolveVendorModelApiEndpoints, isVendorModelMultimodal,
  getVendorModelReasoningCapability, type OfficialVendorId, type CatalogModel, type CatalogSnapshot
} from '@aipoch/providers'
import { getOfficialVendorModelIds } from './provider-model-policy'

export type OfficialCatalogSource = {
  vendorId?: OfficialVendorId
  region?: string
  fetchedModels?: readonly string[]
  modelCatalog?: CatalogSnapshot
}

/** Membership comes from the latest complete snapshot; bundled values only fill missing metadata. */
export function resolveOfficialModelCatalog(source: OfficialCatalogSource): CatalogModel[] {
  const { vendorId, region, modelCatalog } = source
  if (!vendorId) return []
  const vendor = getOfficialVendor(vendorId)
  if (!vendor) return []
  const ids = modelCatalog ? modelCatalog.models.map((model) => model.id) : getOfficialVendorModelIds(vendorId, region, source.fetchedModels)
  const live = new Map(modelCatalog?.models.map((model) => [model.id, model]))
  return ids.filter((id) => !/\[1m\]$/i.test(id)).map((id) => {
    const bundled = vendor.models.find((model) => model.id === id)
    const endpoints = resolveVendorModelApiEndpoints(vendorId, id)
    const routes: CatalogModel['routes'] = {}
    for (const endpoint of endpoints) {
      const base = endpoint === 'responses'
        ? resolveVendorResponsesBaseUrl(vendorId, region) ?? resolveVendorChatCompletionsBaseUrl(vendorId, region) ?? resolveVendorBaseUrl(vendorId, region)
        : endpoint === 'chat-completions'
          ? resolveVendorChatCompletionsBaseUrl(vendorId, region) ?? resolveVendorBaseUrl(vendorId, region)
          : resolveVendorBaseUrl(vendorId, region)
      if (base) routes[endpoint] = base
    }
    return {
      id, ...(bundled ? { contextWindow: bundled.contextWindow, maxOutputTokens: bundled.maxOutputTokens } : {}),
      supportsImageInput: isVendorModelMultimodal(vendorId, id),
      reasoningEffort: getVendorModelReasoningCapability(vendorId, id),
      routes, ...live.get(id)
    }
  })
}
export function isCatalogModelAvailable(model: CatalogModel): boolean {
  return !['retired', 'offline', 'shutdown'].includes(model.lifecycle ?? '') && (!model.routes || Object.keys(model.routes).length > 0)
}
