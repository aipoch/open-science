// Built-in catalog of official model vendors. Each vendor exposes an Anthropic-compatible endpoint
// (so it drives the bundled `claude` runtime through ANTHROPIC_BASE_URL) plus a list of model names
// the composer offers once the user adds a key. Unlike a custom provider (one user-typed model), an
// official vendor contributes many selectable (provider, model) options from a fixed base URL.
//
// This is plain data shared by main and renderer. Model catalogs and base URLs are the kind of thing
// that shifts over time — update the lists here as vendors publish new models. Only vendors with a
// documented Anthropic-compatible endpoint belong here (e.g. OpenAI's native API does not qualify).

export type OfficialVendorId =
  'anthropic' | 'deepseek' | 'zhipu' | 'minimax' | 'kimi' | 'kimiforcode'

// A selectable endpoint for vendors that publish more than one host — e.g. a Global vs. China region
// (MiniMax) or a separate overseas/domestic console (GLM's Z.AI vs. BigModel). Each carries its own
// base URL and, since consoles differ by region, its own key-console URL.
export type VendorRegion = {
  id: string
  label: string
  baseUrl: string
  // Where the user creates/copies a key for this endpoint; falls back to the vendor-level one.
  apiKeyUrl?: string
  // Full URL of the vendor's model-list endpoint for this region; falls back to the vendor-level one.
  modelsListUrl?: string
}

export type OfficialVendor = {
  id: OfficialVendorId
  // Human-readable name shown in the provider-type picker and composer group headings.
  label: string
  // Anthropic-compatible model ids offered in the composer once a key is stored. First entry is the
  // default selection when the vendor is first added.
  models: string[]
  // Single-endpoint vendors set `baseUrl`; multi-region vendors set `regions` instead (never both).
  baseUrl?: string
  regions?: VendorRegion[]
  // Page where the user obtains an API key. For multi-region vendors a per-region url takes priority.
  apiKeyUrl?: string
  // Full URL of a live model-list endpoint (OpenAI-style `{ data: [{ id }] }`). Set only for vendors
  // that actually expose one, so the "refresh from vendor" affordance is hidden for those that don't.
  modelsListUrl?: string
}

// The shipped vendor set. All endpoints are the vendors' own Anthropic-compatible routes.
export const OFFICIAL_VENDORS: OfficialVendor[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelsListUrl: 'https://api.anthropic.com/v1/models',
    // Models with a 1M-context variant list both the standard id and the `[1m]` one.
    models: [
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001'
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    modelsListUrl: 'https://api.deepseek.com/v1/models',
    models: ['deepseek-v4-pro', 'deepseek-v4-pro[1m]', 'deepseek-v4-flash']
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    // GLM serves overseas from Z.AI and mainland China from BigModel (智谱) — different hosts and
    // separate consoles, so they are distinct endpoints rather than one base URL.
    regions: [
      {
        id: 'global',
        label: 'Global (Z.AI)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKeyUrl: 'https://z.ai'
      },
      {
        id: 'china',
        label: 'China (BigModel)',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
      }
    ],
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5-turbo']
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    regions: [
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key'
      },
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
      }
    ],
    models: ['MiniMax-M3', 'MiniMax-M3[1m]', 'MiniMax-M2.7', 'MiniMax-M2.5']
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    // Moonshot's Anthropic-compatible route for the general Kimi platform. Models are billed per token
    // and can be refreshed from the live list endpoint below.
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiKeyUrl: 'https://platform.kimi.com/console',
    modelsListUrl: 'https://api.moonshot.cn/v1/models',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5']
  },
  {
    id: 'kimiforcode',
    label: 'Kimi For Coding',
    // The Kimi Code subscription endpoint: quota-based models (billed against a periodically refreshing
    // quota rather than per token), so it ships a fixed catalog and exposes no live model list.
    baseUrl: 'https://api.kimi.com/coding',
    apiKeyUrl: 'https://www.kimi.com/code/docs',
    models: ['kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']
  }
]

const VENDORS_BY_ID = new Map<OfficialVendorId, OfficialVendor>(
  OFFICIAL_VENDORS.map((vendor) => [vendor.id, vendor])
)

// Narrows an arbitrary string to a known vendor id (used when parsing stored settings).
export const isOfficialVendorId = (value: unknown): value is OfficialVendorId =>
  typeof value === 'string' && VENDORS_BY_ID.has(value as OfficialVendorId)

// Looks up a vendor definition, or undefined for an unknown id.
export const getOfficialVendor = (id: OfficialVendorId): OfficialVendor | undefined =>
  VENDORS_BY_ID.get(id)

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

// The default model for a freshly added vendor (first catalog entry).
export const defaultVendorModel = (id: OfficialVendorId): string | undefined =>
  VENDORS_BY_ID.get(id)?.models[0]

// Whether a vendor needs a region choice (more than one endpoint).
export const vendorHasRegions = (id: OfficialVendorId): boolean =>
  (VENDORS_BY_ID.get(id)?.regions?.length ?? 0) > 0
