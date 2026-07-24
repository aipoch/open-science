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
  | 'glmcodingplan'
  | 'kimi'
  | 'kimiforcode'
  | 'minimax'
  | 'stepfun'
  | 'xiaomimimo'
  | 'sensenova'
  | 'volcengine'
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

export type OfficialModel = {
  id: string
  // Advertised context-window size for this exact model, in tokens.
  contextWindow: number
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
  models: OfficialModel[]
  // Models this vendor is known (via our own dev testing, before release) NOT to drive cleanly over
  // the Codex Responses->Chat bridge. Ships with the app so such models are greyed in the picker
  // rather than user-tested. Absent/empty ⇒ every listed model is bridge-compatible.
  bridgeUnsupportedModels?: readonly string[]
  // Describes which of this vendor's models accept image input (multimodal vision). Absent ⇒ the vendor
  // has no vision models. This must cover live-fetched ids too — a vendor that refreshes its catalog can
  // surface a vision model not in the bundled `models` array — so it is a rule, not a static id list:
  //   - allMultimodal: true       — every model this vendor serves supports vision (e.g. Claude, GPT-5+)
  //   - multimodalModelPattern    — a RegExp matched against the model id (e.g. GLM's `v` vision variants)
  //   - multimodalModels          — an explicit id list, for catalogs where vision is an unpredictable
  //                                 subset (e.g. OpenRouter's cross-vendor slugs)
  // Precedence when resolving support: allMultimodal → pattern → explicit list.
  multimodal?: {
    allMultimodal?: boolean
    multimodalModelPattern?: RegExp
    multimodalModels?: readonly string[]
  }
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
    models: [
      { id: 'gpt-5.6-sol', contextWindow: 1_050_000 },
      { id: 'gpt-5.6-terra', contextWindow: 1_050_000 },
      { id: 'gpt-5.6-luna', contextWindow: 1_050_000 },
      { id: 'gpt-5.5', contextWindow: 1_050_000 },
      { id: 'gpt-5.4', contextWindow: 1_050_000 },
      { id: 'gpt-5.4-mini', contextWindow: 400_000 }
    ],
    // The curated coding catalog is all GPT-5+, which is vision-capable across the board.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelsListUrl: 'https://api.anthropic.com/v1/models',
    // Models with a 1M-context variant list both the standard id and the `[1m]` one.
    models: [
      { id: 'claude-opus-4-8', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8[1m]', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', contextWindow: 1_000_000 },
      { id: 'claude-haiku-4-5-20251001', contextWindow: 200_000 }
    ],
    // Every current Claude model is vision-capable, including any surfaced by the live model-list
    // refresh above — so this is a blanket rule, not the four bundled ids.
    multimodal: { allMultimodal: true }
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
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro[1m]', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 }
    ]
    // DeepSeek's chat models are text-only, so no `multimodal` rule (image input stays disabled).
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
    models: [
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5v-turbo', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 }
    ],
    // GLM marks vision variants with a `v` after the major version (e.g. glm-5v-turbo); the pattern
    // also covers future `Nv` ids the live refresh may surface.
    multimodal: { multimodalModelPattern: /glm-\d+v/i }
  },
  {
    id: 'glmcodingplan',
    label: 'GLM Coding Plan',
    // The GLM Coding Plan subscription (Z.AI's z.ai/subscribe, BigModel's glm-coding): a quota-based
    // plan that reuses GLM's regions but routes the OpenAI path through `/api/coding/paas/v4` instead
    // of `/api/paas/v4`. The Anthropic route (`/api/anthropic`) is unchanged from the pay-as-you-go
    // GLM endpoint. Quota-based catalogs ship a fixed model list and expose no live model list.
    apiEndpoints: ['anthropic', 'openai'],
    regions: [
      {
        id: 'global',
        label: 'Global (Z.AI)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        openaiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
        apiKeyUrl: 'https://z.ai/subscribe'
      },
      {
        id: 'china',
        label: 'China (BigModel)',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        openaiBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKeyUrl: 'https://bigmodel.cn/glm-coding'
      }
    ],
    // The coding plan does not serve GLM's vision variant, so glm-5v-turbo is omitted and there is no
    // `multimodal` rule (image input stays disabled for this endpoint).
    models: [
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 }
    ]
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
    models: [
      { id: 'kimi-k3', contextWindow: 1_000_000 },
      { id: 'kimi-k2.7-code', contextWindow: 256_000 },
      { id: 'kimi-k2.6', contextWindow: 256_000 },
      { id: 'kimi-k2.5', contextWindow: 256_000 }
    ],
    // Vision arrives with the k3 generation; older k2.x chat models are text-only.
    multimodal: { multimodalModels: ['kimi-k3'] }
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
    models: [
      { id: 'kimi-k3', contextWindow: 1_000_000 },
      { id: 'kimi-for-coding', contextWindow: 256_000 },
      { id: 'kimi-for-coding-highspeed', contextWindow: 256_000 }
    ],
    // Only the k3 model in this plan is vision-capable; the coding-tuned ids are text-only.
    multimodal: { multimodalModels: ['kimi-k3'] }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    // MiniMax serves the Anthropic /v1/messages route under `/anthropic`, plus the OpenAI-compatible
    // /v1/chat/completions and OpenAI Responses /v1/responses under `/v1`, from a Global host (.io) and
    // a mainland-China one (.com). `baseUrl` is the Anthropic route; `openaiBaseUrl` is the `/v1` base
    // clients append `/chat/completions` to, and the Responses probe derives `/v1/responses` from it.
    apiEndpoints: ['anthropic', 'openai', 'responses'],
    regions: [
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.minimax.io/anthropic',
        openaiBaseUrl: 'https://api.minimax.io/v1',
        apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key'
      },
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        openaiBaseUrl: 'https://api.minimaxi.com/v1',
        apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
      }
    ],
    models: [
      { id: 'MiniMax-M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M3[1m]', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 }
    ]
    // MiniMax's chat models are text-only, so no `multimodal` rule (image input stays disabled).
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    // StepFun serves all three routes on one host per region — Anthropic /v1/messages, the
    // OpenAI-compatible /v1/chat/completions, and OpenAI Responses /v1/responses — from an overseas
    // console (.ai) and a mainland-China one (.com). `baseUrl` is the bare root (the Anthropic client
    // appends /v1/messages); `openaiBaseUrl` is the /v1 base clients append /chat/completions to, and
    // the Responses probe derives /v1/responses from it.
    apiEndpoints: ['anthropic', 'openai', 'responses'],
    regions: [
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.stepfun.ai',
        openaiBaseUrl: 'https://api.stepfun.ai/v1',
        apiKeyUrl: 'https://platform.stepfun.ai/interface-key',
        modelsListUrl: 'https://api.stepfun.ai/v1/models'
      },
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.stepfun.com',
        openaiBaseUrl: 'https://api.stepfun.com/v1',
        apiKeyUrl: 'https://platform.stepfun.com/interface-key',
        modelsListUrl: 'https://api.stepfun.com/v1/models'
      }
    ],
    models: [
      { id: 'step-3.7-flash', contextWindow: 262_144 },
      { id: 'step-3.5-flash', contextWindow: 262_144 }
    ],
    // step-3.7-flash is multimodal (vision); step-3.5-flash is text-only.
    multimodal: { multimodalModels: ['step-3.7-flash'] }
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
    models: [
      { id: 'mimo-v2.5-pro', contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', contextWindow: 1_000_000 }
    ]
    // Xiaomi MiMo's chat models are text-only, so no `multimodal` rule (image input stays disabled).
  },
  {
    id: 'sensenova',
    label: 'SenseNova',
    // SenseTime's SenseNova serves both routes on one host: the Anthropic-compatible /v1/messages
    // at the bare root and the OpenAI-compatible /v1/chat/completions under /v1. The same model ids
    // work on both. No modelsListUrl: the live /v1/models list also serves the image-generation-only
    // sensenova-u1-fast (POST /v1/images/generations, not a chat model), and the refresh has no
    // modality filter — so the catalog stays curated to the two chat ids.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://token.sensenova.cn',
    openaiBaseUrl: 'https://token.sensenova.cn/v1',
    apiKeyUrl: 'https://platform.sensenova.cn/token-plan',
    models: [
      { id: 'sensenova-6.7-flash-lite', contextWindow: 256_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 }
    ],
    // Only sensenova-6.7-flash-lite accepts image input; deepseek-v4-flash is text-only.
    multimodal: { multimodalModels: ['sensenova-6.7-flash-lite'] }
  },
  {
    id: 'volcengine',
    label: 'Volcengine Ark',
    // ByteDance's Volcengine Ark serves all three routes on one host: the Anthropic-compatible
    // /v1/messages under /api/compatible, the OpenAI-compatible /v1/chat/completions under /api/v3,
    // and OpenAI Responses at /api/v3/responses (the probe derives it from `openaiBaseUrl`). The same
    // model ids work on all three. No modelsListUrl: Ark's catalog also serves embedding, image
    // (Seedream), and video (Seedance) models alongside the chat ids, and the refresh has no
    // modality filter — so the Doubao Seed chat catalog stays curated.
    apiEndpoints: ['anthropic', 'openai', 'responses'],
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    openaiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    models: [
      { id: 'doubao-seed-2-1-pro-260628', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-pro-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-lite-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-mini-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-code-preview-260215', contextWindow: 256_000 }
    ],
    // The Seed 2.x general models accept image input; the code-preview coding model is text-only.
    multimodal: {
      multimodalModels: [
        'doubao-seed-2-1-pro-260628',
        'doubao-seed-2-0-pro-260215',
        'doubao-seed-2-0-lite-260215',
        'doubao-seed-2-0-mini-260215'
      ]
    }
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
      { id: 'anthropic/claude-opus-4.8', contextWindow: 1_000_000 },
      { id: 'anthropic/claude-sonnet-5', contextWindow: 1_000_000 },
      { id: 'anthropic/claude-haiku-4.5', contextWindow: 200_000 },
      // OpenAI
      { id: 'openai/gpt-5.6-terra-pro', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.6-terra', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.6-sol-pro', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.6-sol', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.6-luna-pro', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.6-luna', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.5-pro', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.5', contextWindow: 1_050_000 },
      { id: 'openai/gpt-5.3-codex', contextWindow: 400_000 },
      // Other top-ranked vendors on OpenRouter
      { id: 'google/gemini-3.1-pro-preview', contextWindow: 1_048_576 },
      { id: 'google/gemini-3.5-flash', contextWindow: 1_048_576 },
      { id: 'x-ai/grok-4.5', contextWindow: 500_000 },
      { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_048_576 },
      { id: 'z-ai/glm-5.2', contextWindow: 1_048_576 },
      { id: 'moonshotai/kimi-k3', contextWindow: 1_048_576 },
      { id: 'qwen/qwen3.7-max', contextWindow: 1_000_000 }
    ],
    // OpenRouter's catalog is curated (no live refresh), and vision support is an unpredictable subset
    // across vendors — so it is an explicit id list rather than a blanket rule or pattern. The
    // text-only members (gpt-5.3-codex, deepseek-v4-pro, glm-5.2) are intentionally omitted.
    multimodal: {
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

// Projects the structured bundled catalog into the string ids used by settings persistence and UI.
export const getOfficialVendorModelIds = (id: OfficialVendorId): string[] =>
  VENDORS_BY_ID.get(id)?.models.map((model) => model.id) ?? []

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
  VENDORS_BY_ID.get(id)?.models[0]?.id

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

// Custom model ids are opaque: guessing from their name is less reliable than a stable documented
// default. Users can override this on the provider; an omitted value intentionally means 200k.
export const DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW = 200_000

// Live model-list endpoints expose ids but generally omit context limits. Unknown refreshed ids use a
// stable conservative fallback until their exact metadata is added to the bundled catalog.
export const DEFAULT_OFFICIAL_MODEL_CONTEXT_WINDOW = 200_000

// The universal, exact convention: a model id ending in `[1m]` denotes a 1M-token context variant.
const ONE_MILLION_SUFFIX = /\[1m\]$/i

// Resolves an official vendor model's context window from the exact bundled entry. For ids returned
// later by a live model-list refresh, an exact `[1m]` suffix wins before the conservative fallback.
// A missing model id or unknown vendor remains unknown.
export const resolveModelContextWindow = (
  vendorId: OfficialVendorId,
  modelId: string | undefined
): number | undefined => {
  if (!modelId) return undefined

  const vendor = VENDORS_BY_ID.get(vendorId)
  if (!vendor) return undefined

  const bundledModel = vendor.models.find((model) => model.id === modelId)
  if (bundledModel) return bundledModel.contextWindow

  if (ONE_MILLION_SUFFIX.test(modelId)) return 1_000_000

  return DEFAULT_OFFICIAL_MODEL_CONTEXT_WINDOW
}

// Resolves a custom provider's user-configured window. Model ids are deliberately not inspected:
// gateway aliases frequently contain vendor-like names without sharing the upstream model's limits.
export const resolveCustomModelContextWindow = (configured?: number): number =>
  configured ?? DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW
