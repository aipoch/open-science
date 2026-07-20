// Built-in catalog of official model vendors. Each vendor exposes a documented API endpoint plus a
// list of model names the composer offers once the user adds a key. Unlike a custom provider (one
// user-typed model), an official vendor contributes many selectable (provider, model) options from a
// fixed base URL.
//
// This is plain data shared by main and renderer. Model catalogs and base URLs are the kind of thing
// that shifts over time — update the lists here as vendors publish new models. Only vendors with a
// documented endpoint belongs here, including native Responses providers.

import type { ChatApiEndpoint } from './settings'

export type OfficialVendorId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'zhipu'
  | 'minimax'
  | 'kimi'
  | 'kimiforcode'
  | 'xiaomimimo'
  | 'openrouter'

// A selectable endpoint for vendors that publish more than one host — e.g. a Global vs. China region
// (MiniMax) or a separate overseas/domestic console (GLM's Z.AI vs. BigModel). Each carries its own
// base URL and, since consoles differ by region, its own key-console URL.
export type VendorRegion = {
  id: string
  label: string
  baseUrl: string
  // The region's OpenAI /v1/chat/completions base, when it differs from the Anthropic `baseUrl` and the
  // vendor supports both endpoints. Falls back to the region's `baseUrl` when absent.
  openaiBaseUrl?: string
  // Where the user creates/copies a key for this endpoint; falls back to the vendor-level one.
  apiKeyUrl?: string
  // Full URL of the vendor's model-list endpoint for this region; falls back to the vendor-level one.
  modelsListUrl?: string
}

export type OfficialVendor = {
  id: OfficialVendorId
  // Human-readable name shown in the provider-type picker and composer group headings.
  label: string
  // Which chat APIs this vendor serves; drives per-framework availability. Absent ⇒ ['anthropic']
  // for legacy Anthropic-compatible vendor entries. A dual-endpoint vendor lists both, e.g.
  // ['anthropic', 'openai'].
  apiEndpoints?: readonly ChatApiEndpoint[]
  // Model ids offered in the composer once a key is stored. First entry is the default selection when
  // the vendor is first added.
  models: string[]
  // Models this vendor is known (via our own dev testing, before release) NOT to drive cleanly over
  // the Codex Responses->Chat bridge. Ships with the app so such models are greyed in the picker
  // rather than user-tested. Absent/empty ⇒ every listed model is bridge-compatible.
  bridgeUnsupportedModels?: readonly string[]
  // Models that support image input (multimodal vision capabilities). Absent/empty ⇒ no models support
  // images. When present, only listed model ids accept image attachments; others are text-only.
  multimodalModels?: readonly string[]
  // Single-endpoint vendors set `baseUrl`; multi-region vendors set `regions` instead (never both).
  // For dual-endpoint vendors, `baseUrl` is the Anthropic /v1/messages route and `openaiBaseUrl` is the
  // separate OpenAI /v1/chat/completions root. Set both only for a vendor whose apiEndpoints include
  // 'openai'.
  baseUrl?: string
  openaiBaseUrl?: string
  regions?: VendorRegion[]
  // Page where the user obtains an API key. For multi-region vendors a per-region url takes priority.
  apiKeyUrl?: string
  // Full URL of a live model-list endpoint (OpenAI-style `{ data: [{ id }] }`). Set only for vendors
  // that actually expose one, so the "refresh from vendor" affordance is hidden for those that don't.
  modelsListUrl?: string
}

// The shipped vendor set. Each entry owns its endpoint and catalog; model lists are intentionally
// conservative so a vendor's unrelated model types do not appear in the composer.
export const OFFICIAL_VENDORS: OfficialVendor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    apiEndpoints: ['responses'],
    baseUrl: 'https://api.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    // The API exposes a broader mixed catalog (embeddings, image, and audio models); keep the coding
    // catalog curated here instead of importing every id from /v1/models.
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    // All GPT-5+ models support vision
    multimodalModels: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini'
    ]
  },
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
    ],
    // All Claude models support vision
    multimodalModels: [
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001'
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // DeepSeek exposes both routes: Anthropic /v1/messages under `/anthropic`, and the OpenAI-compatible
    // route under `/v1`. The same model ids work on both, so it's safe to prefer OpenAI where the
    // framework supports it (e.g. OpenCode). openaiBaseUrl is the exact version-carrying base clients
    // append `/chat/completions` to.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.deepseek.com/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    modelsListUrl: 'https://api.deepseek.com/v1/models',
    models: ['deepseek-v4-pro', 'deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
    // DeepSeek v4 models do not support vision yet (text-only)
    multimodalModels: []
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    // GLM serves overseas from Z.AI and mainland China from BigModel (智谱) — different hosts and
    // separate consoles, so they are distinct endpoints rather than one base URL. Each region also
    // publishes an OpenAI-compatible route under `/api/paas/v4` (not `/v1`), so Codex can bridge it.
    apiEndpoints: ['anthropic', 'openai'],
    regions: [
      {
        id: 'global',
        label: 'Global (Z.AI)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        openaiBaseUrl: 'https://api.z.ai/api/paas/v4',
        apiKeyUrl: 'https://z.ai'
      },
      {
        id: 'china',
        label: 'China (BigModel)',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
      }
    ],
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5-turbo'],
    // Only the 'v' variants support vision (glm-5v-turbo has multimodal capabilities)
    multimodalModels: ['glm-5v-turbo']
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
    models: ['MiniMax-M3', 'MiniMax-M3[1m]', 'MiniMax-M2.7', 'MiniMax-M2.5'],
    // MiniMax models do not support vision yet (text-only)
    multimodalModels: []
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    // Moonshot serves both routes on one host: Anthropic /v1/messages under `/anthropic` and the
    // OpenAI-compatible /v1/chat/completions under `/v1` (see the live model list below). `both` lets
    // Codex drive it through the Responses->Chat bridge.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.moonshot.cn/anthropic',
    openaiBaseUrl: 'https://api.moonshot.cn/v1',
    apiKeyUrl: 'https://platform.kimi.com/console',
    modelsListUrl: 'https://api.moonshot.cn/v1/models',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'],
    // Kimi models support vision starting from k3
    multimodalModels: ['kimi-k3']
  },
  {
    id: 'kimiforcode',
    label: 'Kimi For Coding',
    // The Kimi Code subscription endpoint: quota-based models (billed against a periodically refreshing
    // quota rather than per token), so it ships a fixed catalog and exposes no live model list. It
    // serves both the Anthropic route and the OpenAI-compatible /v1/chat/completions under `/coding/v1`
    // (Kimi documents this plan for Codex and OpenCode), so `both` lets Codex bridge it.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.kimi.com/coding',
    openaiBaseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyUrl: 'https://www.kimi.com/code/docs',
    models: ['kimi-k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    // Only k3 supports vision in the coding plan
    multimodalModels: ['kimi-k3']
  },
  {
    id: 'xiaomimimo',
    label: 'Xiaomi MIMO',
    // Xiaomi MiMo exposes both routes: Anthropic /v1/messages under `/anthropic` and the OpenAI-compatible
    // /v1/chat/completions under `/v1`. The same model ids work on both.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    openaiBaseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyUrl: 'https://platform.xiaomimimo.com/console/api-keys',
    modelsListUrl: 'https://api.xiaomimimo.com/v1/models',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    // Xiaomi MIMO models do not support vision yet (text-only)
    multimodalModels: []
  },
  // OpenRouter is an aggregation gateway (many vendors behind one key), so it sits last in the picker.
  {
    id: 'openrouter',
    label: 'OpenRouter',
    // Multi-vendor gateway: Anthropic /v1/messages under `/api` and the OpenAI-compatible
    // /v1/chat/completions under `/api/v1`. Its live catalog is 300+ ids, so this ships a curated set of
    // the top models across vendors (no modelsListUrl) rather than a "refresh from vendor" that would
    // flood the model picker. Model slugs use OpenRouter's `vendor/model` form.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://openrouter.ai/api',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/workspaces/default/keys',
    models: [
      // Anthropic
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      // OpenAI
      'openai/gpt-5.6-terra-pro',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-sol-pro',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-luna-pro',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.5-pro',
      'openai/gpt-5.5',
      'openai/gpt-5.3-codex',
      // Other top-ranked vendors on OpenRouter
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.5-flash',
      'x-ai/grok-4.5',
      'deepseek/deepseek-v4-pro',
      'z-ai/glm-5.2',
      'moonshotai/kimi-k3',
      'qwen/qwen3.7-max'
    ],
    // Most models on OpenRouter support vision (Claude, GPT-5+, Gemini, Grok)
    multimodalModels: [
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.6-terra-pro',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-sol-pro',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-luna-pro',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.5-pro',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.5-flash',
      'x-ai/grok-4.5',
      'moonshotai/kimi-k3',
      'qwen/qwen3.7-max'
    ]
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

// Resolves a vendor's OpenAI /v1/chat/completions base, when it publishes one distinct from the
// Anthropic route (only 'both' vendors do). Undefined otherwise, so callers fall back to `baseUrl`.
export const resolveVendorOpenAiBaseUrl = (
  id: OfficialVendorId,
  regionId?: string
): string | undefined => {
  const vendor = VENDORS_BY_ID.get(id)

  if (!vendor) return undefined
  if (vendor.openaiBaseUrl) return vendor.openaiBaseUrl

  const regions = vendor.regions ?? []
  const region = regions.find((candidate) => candidate.id === regionId) ?? regions[0]

  return region?.openaiBaseUrl
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

// The chat APIs a vendor speaks, defaulting to Anthropic /v1/messages when unset.
export const resolveVendorApiEndpoints = (id: OfficialVendorId): ChatApiEndpoint[] => {
  const endpoints = VENDORS_BY_ID.get(id)?.apiEndpoints
  return endpoints && endpoints.length > 0 ? [...endpoints] : ['anthropic']
}

// Models a vendor is statically known not to drive over the Codex Responses->Chat bridge (see
// OfficialVendor.bridgeUnsupportedModels). Empty for every vendor whose whole catalog converts.
export const resolveVendorBridgeUnsupportedModels = (id: OfficialVendorId): readonly string[] =>
  VENDORS_BY_ID.get(id)?.bridgeUnsupportedModels ?? []

// Static, ships-with-the-app check: whether a model can be driven over the Codex Responses->Chat
// bridge. Only meaningful for the bridged (openai) path; callers gate it behind the Codex framework.
// Custom providers (no vendorId) are assumed compatible — their key is what gets tested, not the model.
export const isModelBridgeSupported = (
  provider: { vendorId?: OfficialVendorId },
  model: string | undefined
): boolean =>
  !provider.vendorId || model === undefined
    ? true
    : !resolveVendorBridgeUnsupportedModels(provider.vendorId).includes(model)

// Whether a vendor needs a region choice (more than one endpoint).
export const vendorHasRegions = (id: OfficialVendorId): boolean =>
  (VENDORS_BY_ID.get(id)?.regions?.length ?? 0) > 0

// Checks whether a specific model from an official vendor supports image input (multimodal vision).
// Returns false for unknown vendors, unknown models, or models not in the vendor's multimodalModels list.
export const isVendorModelMultimodal = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): boolean => {
  if (!modelId) return false

  const vendor = VENDORS_BY_ID.get(vendorId)
  if (!vendor) return false

  const multimodalModels = vendor.multimodalModels ?? []
  return multimodalModels.includes(modelId)
}
