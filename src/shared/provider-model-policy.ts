import { getOfficialVendor, type OfficialVendorId } from '@aipoch/providers'

// Application defaults and compatibility for persisted/discovered model selections.
export const getOfficialVendorModelIds = (
  id: OfficialVendorId,
  regionId?: string,
  fetchedModels?: readonly string[]
): string[] => {
  const vendor = getOfficialVendor(id)
  if (!vendor) return []
  const region =
    vendor.regions?.find((candidate) => candidate.id === regionId) ?? vendor.regions?.[0]
  // Context suffixes are Claude Code syntax, not official API model ids. Filter discovered
  // catalogs on read without rewriting persisted selections or the vendor cache. An all-alias
  // cache falls back to the bundled catalog so an empty list cannot bypass model validation.
  const discoveredModels = fetchedModels?.filter((model) => !/\[1m\]$/i.test(model))
  // DeepSeek discovery omits still-routable legacy ids. Preserve the bundled API names so
  // pinned sessions remain usable, including settings cached before this compatibility rule.
  if (id === 'deepseek' && discoveredModels?.length) {
    return [...new Set([...discoveredModels, ...vendor.models.map((model) => model.id)])]
  }
  return [
    ...(region?.modelIds ??
      (discoveredModels?.length ? discoveredModels : vendor.models.map((model) => model.id)))
  ]
}

export const defaultVendorModel = (id: OfficialVendorId, regionId?: string): string | undefined =>
  getOfficialVendorModelIds(id, regionId)[0]

export const DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW = 200_000

export const DEFAULT_OFFICIAL_MODEL_CONTEXT_WINDOW = 200_000

export const resolveModelContextWindow = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): number | undefined => {
  if (!modelId) return undefined

  const vendor = getOfficialVendor(vendorId)
  if (!vendor) return undefined

  const bundledModel = vendor.models.find((model) => model.id === modelId)
  if (bundledModel) return bundledModel.contextWindow

  return DEFAULT_OFFICIAL_MODEL_CONTEXT_WINDOW
}

export const resolveCustomModelContextWindow = (configured?: number): number =>
  configured ?? DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW
