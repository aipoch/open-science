import { OFFICIAL_VENDORS } from './data'
import type { OfficialVendorId, OfficialVendor } from './types'
import type { ModelProtocol } from '../protocols/types'
import type { ReasoningCapability } from '../protocols/types'

const VENDORS_BY_ID = new Map<OfficialVendorId, OfficialVendor>(
  OFFICIAL_VENDORS.map((vendor) => [vendor.id, vendor])
)

// Narrows an arbitrary string to a known vendor id (used when parsing stored settings).
export const isOfficialVendorId = (value: unknown): value is OfficialVendorId =>
  typeof value === 'string' && VENDORS_BY_ID.has(value as OfficialVendorId)

// Looks up a vendor definition, or undefined for an unknown id.
export const getOfficialVendor = (id: OfficialVendorId): OfficialVendor | undefined =>
  VENDORS_BY_ID.get(id)

// Resolves the bundled, model-specific effort capability. Unknown/live-fetched model ids use the
// vendor default; unknown vendors have no declared capability. This is intentionally synchronous and never consults the network.
export const getVendorModelReasoningCapability = (
  id: OfficialVendorId,
  modelId: string | undefined
): ReasoningCapability => {
  const vendor = VENDORS_BY_ID.get(id)
  const model = vendor?.models.find((candidate) => candidate.id === modelId)

  return model?.reasoningEffort ?? vendor?.reasoningEffort ?? { supported: false }
}

// Resolves the base URL for a vendor, honoring the chosen region and falling back to the first region
// when none/an unknown one is given. Returns undefined for an unknown vendor.
export const resolveVendorBaseUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined
  if (vendor.baseUrl) return vendor.baseUrl

  const regions = vendor.regions ?? []
  const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

  return region?.baseUrl
}

// Resolves a vendor's OpenAI /v1/chat/completions base, when it publishes one distinct from the
// Anthropic route (only 'both' vendors do). Undefined otherwise, so callers fall back to `baseUrl`.
export const resolveVendorChatCompletionsBaseUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined
  if (vendor.chatCompletionsBaseUrl) return vendor.chatCompletionsBaseUrl

  const regions = vendor.regions ?? []
  const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

  return region?.chatCompletionsBaseUrl
}

// Resolves a vendor's explicitly published native Responses API base, when it differs from the
// OpenAI chat base. This is intentionally separate because DeepSeek's Responses API uses the origin
// while its Chat Completions API uses `/v1`.
export const resolveVendorResponsesBaseUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined
  if (vendor.responsesBaseUrl) return vendor.responsesBaseUrl

  const regions = vendor.regions ?? []
  const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

  return region?.responsesBaseUrl
}

// Resolves where the user gets an API key for a vendor, preferring the selected region's console and
// falling back to the vendor-level one. Returns undefined for an unknown vendor or when none is set.
export const resolveVendorApiKeyUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined

  const regions = vendor.regions ?? []

  if (regions.length > 0) {
    const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

    return region.apiKeyUrl ?? vendor.apiKeyUrl
  }

  return vendor.apiKeyUrl
}

// Resolves the live model-list endpoint for a vendor (region-aware), or undefined when the vendor
// doesn't expose one — in which case the "refresh from vendor" affordance should be hidden.
export const resolveVendorModelsUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined

  const regions = vendor.regions ?? []

  if (regions.length > 0) {
    const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

    return region.modelsListUrl ?? vendor.modelsListUrl
  }

  return vendor.modelsListUrl
}

// The chat APIs a vendor speaks, defaulting to Anthropic /v1/messages when unset.
export const resolveVendorApiEndpoints = (id: OfficialVendorId): ModelProtocol[] => {
  const endpoints = VENDORS_BY_ID.get(id)?.apiEndpoints
  return endpoints && endpoints.length > 0 ? [...endpoints] : ['messages']
}

export const usesVendorMessagesApiKeyHeader = (id: OfficialVendorId): boolean =>
  VENDORS_BY_ID.get(id)?.messagesApiKeyHeader === true

// Whether a vendor needs a region choice (more than one endpoint).
export const vendorHasRegions = (id: OfficialVendorId): boolean =>
  (VENDORS_BY_ID.get(id)?.regions?.length ?? 0) > 0

// Whether a specific model from an official vendor accepts image input (multimodal vision). Resolves
// the vendor's `multimodal` rule with allMultimodal → pattern → explicit-list precedence, so it works
// for live-fetched ids too (a blanket vendor like Claude returns true for any model, not just the
// bundled four). Returns false for an unknown/absent vendor, an empty model id, or a vendor with no
// `multimodal` rule at all.
export const isVendorModelMultimodal = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): boolean => {
  if (!modelId) return false

  const rule = VENDORS_BY_ID.get(vendorId)?.multimodal
  if (!rule) return false

  if (rule.allMultimodal) return true
  if (rule.multimodalModelPattern?.test(modelId)) return true

  return rule.multimodalModels?.includes(modelId) ?? false
}

// Whether a specific model from an official vendor accepts native Responses API (/v1/responses)
// requests. A vendor that declares 'responses' in `apiEndpoints` serves it for its whole catalog, so
// every model is Responses-capable. Vendors without that declaration may still list individual models
// in `responsesModels`; those are the only ids that gain the Responses route. Returns false for an
// unknown/absent vendor, an empty model id, or a vendor with no Responses support at all.
export const isVendorModelResponsesSupported = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): boolean => {
  if (!modelId) return false

  const vendor = VENDORS_BY_ID.get(vendorId)
  if (!vendor) return false

  const modelEndpoint = vendor.models.find(({ id }) => id === modelId)?.apiEndpoint
  if (modelEndpoint) return modelEndpoint === 'responses'
  if (vendor.apiEndpoints?.includes('responses')) return true
  return vendor.responsesModels?.includes(modelId) ?? false
}

// Resolves the exact protocol set for one bundled model. Mixed-protocol gateways can override the
// vendor default with one documented endpoint; legacy `responsesModels` catalogs keep their additive
// Responses behavior.
export const resolveVendorModelApiEndpoints = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): ModelProtocol[] => {
  const modelEndpoint = VENDORS_BY_ID.get(vendorId)?.models.find(
    ({ id }) => id === modelId
  )?.apiEndpoint
  if (modelEndpoint) return [modelEndpoint]

  const vendorEndpoints = resolveVendorApiEndpoints(vendorId)
  return !vendorEndpoints.includes('responses') &&
    isVendorModelResponsesSupported(vendorId, modelId)
    ? [...vendorEndpoints, 'responses']
    : vendorEndpoints
}

/** Bundled model ids served by the chosen region, without application discovery policy. */
export const getVendorModelIds = (id: OfficialVendorId, regionId?: string): string[] => {
  const vendor = VENDORS_BY_ID.get(id)
  if (!vendor) return []
  const region = vendor.regions?.find((region) => region.id === regionId) ?? vendor.regions?.[0]
  return [...(region?.modelIds ?? vendor.models.map((model) => model.id))]
}

/** Exact published metadata; unknown models have no inferred limit. */
export const getVendorModelContextWindow = (
  id: OfficialVendorId,
  modelId: string | undefined
): number | undefined =>
  VENDORS_BY_ID.get(id)?.models.find((model) => model.id === modelId)?.contextWindow
