// Built-in catalog of official model vendors. Each vendor exposes a documented API endpoint plus a
// list of model names the composer offers once the user adds a key. Unlike a custom provider (one
// user-typed model), an official vendor contributes many selectable (provider, model) options from a
// fixed base URL.
//
// This is plain data shared by main and renderer. Model catalogs and base URLs are the kind of thing
// that shifts over time — update the lists here as vendors publish new models. Only vendors with a
// documented endpoint belongs here, including native Responses providers.

import type { ChatApiEndpoint } from './settings'
import {
  resolveReasoningEffortProfile,
  type ReasoningEffortPresetSetting,
  type ReasoningEffortProfile
} from './reasoning-effort'

export type OfficialVendorId =
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'apodex'
  | 'deepseek'
  | 'bailian'
  | 'bailianplan'
  | 'zhipu'
  | 'glmcodingplan'
  | 'kimi'
  | 'kimiforcode'
  | 'minimax'
  | 'stepfun'
  | 'stepplan'
  | 'xiaomimimo'
  | 'sensenova'
  | 'volcengine'
  | 'tencent'
  | 'tencentcodingplan'
  | 'tencenttokenplan'
  | 'nvidia'
  | 'opencode-go'
  | 'opencode'
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
  // Optional exact protocol override for mixed-protocol vendor catalogs. Absent means the model uses
  // the vendor-level endpoint set.
  apiEndpoint?: ChatApiEndpoint
  // Optional override for a model whose effort levels differ from the vendor default.
  reasoningEffort?: ReasoningEffortPresetSetting
}

export type OfficialVendor = {
  id: OfficialVendorId
  // Human-readable name shown in the provider-type picker and composer group headings.
  label: string
  // Which chat APIs this vendor serves; drives per-framework availability. Absent ⇒ ['anthropic']
  // for legacy Anthropic-compatible vendor entries. A dual-endpoint vendor lists both, e.g.
  // ['anthropic', 'openai'].
  apiEndpoints?: readonly ChatApiEndpoint[]
  // Whether Anthropic Messages authenticates with `x-api-key` instead of `Authorization: Bearer`.
  // Absent keeps the existing bearer behavior used by the other compatible vendors.
  anthropicApiKeyHeader?: boolean
  // Model ids offered in the composer once a key is stored. First entry is the default selection when
  // the vendor is first added.
  models: OfficialModel[]
  // Static model capability used to project the app's five intent slots into the model's real
  // 2-5 effort choices. Model entries may override it; no runtime capability fetch is required.
  reasoningEffort: ReasoningEffortPresetSetting
  // Models this vendor is known (via our own dev testing, before release) NOT to drive cleanly over
  // the Codex Responses->Chat bridge. Ships with the app so such models are greyed in the picker
  // rather than user-tested. Absent/empty ⇒ every listed model is bridge-compatible.
  bridgeUnsupportedModels?: readonly string[]
  // Models that accept native Responses API (/v1/responses) requests, for vendors where only a
  // subset of the catalog implements the Responses protocol while the vendor-level `apiEndpoints`
  // does not include 'responses'. A vendor that declares 'responses' in `apiEndpoints` serves it
  // for its whole catalog and must not set this field. Absent ⇒ Responses availability is purely
  // governed by `apiEndpoints`.
  responsesModels?: readonly string[]
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
    reasoningEffort: 'low-medium-high-xhigh',
    apiEndpoints: ['responses'],
    baseUrl: 'https://api.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    // The API exposes a broader mixed catalog (embeddings, image, and audio models); keep the coding
    // catalog curated here instead of importing every id from /v1/models.
    models: [
      {
        id: 'gpt-5.6-sol',
        contextWindow: 1_050_000,
        reasoningEffort: 'low-medium-high-xhigh-ultra'
      },
      {
        id: 'gpt-5.6-terra',
        contextWindow: 1_050_000,
        reasoningEffort: 'low-medium-high-xhigh-ultra'
      },
      { id: 'gpt-5.6-luna', contextWindow: 1_050_000, reasoningEffort: 'standard-5' },
      // GPT-5.5 documents none as its latency-first, no-reasoning mode.
      {
        id: 'gpt-5.5',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      { id: 'gpt-5.4', contextWindow: 1_050_000 },
      { id: 'gpt-5.4-mini', contextWindow: 400_000 }
    ],
    // The curated coding catalog is all GPT-5+, which is vision-capable across the board.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    reasoningEffort: 'standard-5',
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelsListUrl: 'https://api.anthropic.com/v1/models',
    // Models with a 1M-context variant list both the standard id and the `[1m]` one.
    models: [
      { id: 'claude-opus-5', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8[1m]', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', contextWindow: 1_000_000 },
      {
        id: 'claude-haiku-4-5-20251001',
        contextWindow: 200_000,
        reasoningEffort: 'unsupported'
      }
    ],
    // Every current Claude model is vision-capable, including any surfaced by the live model-list
    // refresh above — so this is a blanket rule, not the four bundled ids.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    // xAI documents four selectable effort values for Grok 4.6. Models with a different capability
    // override this default below; models without a documented effort control stay unsupported.
    reasoningEffort: 'low-medium-high-xhigh',
    // xAI serves OpenAI-compatible Chat Completions and native Responses from the same versioned
    // `/v1` base. Keep the bare API root in baseUrl for the official-vendor invariant and publish the
    // exact versioned base separately so OpenCode, validation, and Codex do not append another `/v1`.
    apiEndpoints: ['openai', 'responses'],
    baseUrl: 'https://api.x.ai',
    openaiBaseUrl: 'https://api.x.ai/v1',
    apiKeyUrl: 'https://console.x.ai/team/default/api-keys',
    // Curated from xAI's language-model catalog. The live /v1/models response also includes image,
    // audio, and video generation models, so exposing refresh would pollute the chat-model picker.
    // Experimental Grok 4.20 beta variants are intentionally omitted from the stable default list.
    models: [
      { id: 'grok-4.6', contextWindow: 500_000 },
      { id: 'grok-4.5', contextWindow: 500_000 },
      {
        id: 'grok-4.3',
        contextWindow: 1_000_000,
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      { id: 'grok-build-0.1', contextWindow: 256_000, reasoningEffort: 'unsupported' }
    ],
    // Every curated xAI language model accepts text and image input.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'apodex',
    label: 'Apodex',
    // Apodex exposes only a thinking on/off switch, not the product's effort ladder.
    reasoningEffort: 'unsupported',
    apiEndpoints: ['anthropic', 'openai'],
    anthropicApiKeyHeader: true,
    baseUrl: 'https://api.apodex.ai',
    openaiBaseUrl: 'https://api.apodex.ai/v1',
    apiKeyUrl: 'https://platform.apodex.ai/console',
    // Keep this curated: the account catalog can also contain Deep Research SKUs with different
    // request semantics, while this provider entry is for the two core text models.
    models: [
      { id: 'apodex-1.1', contextWindow: 262_144 },
      { id: 'apodex-1.1-mini', contextWindow: 262_144 }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // DeepSeek V4 supports an explicit thinking-off switch plus high/max reasoning effort.
    reasoningEffort: 'none-high-max',
    // DeepSeek exposes both routes: Anthropic /v1/messages under `/anthropic`, and the OpenAI-compatible
    // route under `/v1`. The same model ids work on both, so it's safe to prefer OpenAI where the
    // framework supports it (e.g. OpenCode). openaiBaseUrl is the exact version-carrying base clients
    // append `/chat/completions` to, and the same `/v1` root serves `/v1/responses` for Responses-capable
    // models.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.deepseek.com/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    modelsListUrl: 'https://api.deepseek.com/v1/models',
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro[1m]', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000 }
    ],
    // Bundled DeepSeek V4 models serve the native Responses API. Keep the explicit list because the
    // vendor also exposes non-Responses models through its live model catalog.
    responsesModels: [
      'deepseek-v4-pro',
      'deepseek-v4-pro[1m]',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp'
    ],
    // Only the vision-exp id accepts image input. Pro and flash stay text-only; sending images to
    // them returns 400. The explicit list also covers the same id when it arrives via live refresh.
    multimodal: { multimodalModels: ['deepseek-v4-flash-vision-exp'] }
  },
  {
    id: 'bailian',
    label: 'Bailian',
    // Keep effort hidden for models that only expose protocol-specific thinking controls. Models
    // with a documented cross-protocol effort vocabulary override this default below.
    reasoningEffort: 'unsupported',
    // Both regions expose Anthropic Messages plus OpenAI-compatible Chat Completions. Responses is
    // available only for the Qwen models listed below.
    // The Anthropic URL is kept in its documented full-endpoint form; the shared URL normalizer strips
    // `/v1/messages` before Claude Code/OpenCode append their own protocol suffix.
    apiEndpoints: ['anthropic', 'openai'],
    regions: [
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages',
        openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key'
      },
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages',
        openaiBaseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/us-east-1?tab=model#/api-key'
      }
    ],
    // Curated from Bailian's model marketplace. Keep refresh hidden because the full catalog also
    // contains image, audio, video, embedding, and other models outside this chat-provider surface.
    models: [
      {
        id: 'qwen3.8-max',
        contextWindow: 983_616,
        reasoningEffort: 'low-medium-xhigh'
      },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-flash', contextWindow: 1_000_000 },
      { id: 'qwen3.6-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      {
        id: 'deepseek-v4-flash-0731',
        contextWindow: 1_000_000,
        reasoningEffort: 'high-max'
      },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, reasoningEffort: 'high-max' }
    ],
    responsesModels: [
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3.7-flash',
      'qwen3.6-plus',
      'qwen3.6-flash'
    ],
    multimodal: {
      multimodalModels: [
        'qwen3.8-max',
        'qwen3.7-plus',
        'qwen3.7-flash',
        'qwen3.6-plus',
        'qwen3.6-flash'
      ]
    }
  },
  {
    id: 'bailianplan',
    label: 'Bailian for Plan',
    // The qwen3.8, GLM, and DeepSeek entries below override this conservative default.
    reasoningEffort: 'unsupported',
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    openaiBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview',
    models: [
      {
        id: 'qwen3.8-max',
        contextWindow: 983_616,
        reasoningEffort: 'low-medium-xhigh'
      },
      {
        id: 'qwen3.8-max-preview',
        contextWindow: 983_616,
        reasoningEffort: 'low-medium-xhigh'
      },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      {
        id: 'deepseek-v4-flash-0731',
        contextWindow: 1_000_000,
        reasoningEffort: 'high-max'
      }
    ],
    multimodal: {
      multimodalModels: ['qwen3.8-max', 'qwen3.8-max-preview', 'qwen3.7-plus', 'qwen3.6-flash']
    }
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    reasoningEffort: 'unsupported',
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
      { id: 'glm-5.3', contextWindow: 1_000_000, reasoningEffort: 'low-high-max' },
      { id: 'glm-5.3-flash', contextWindow: 1_000_000, reasoningEffort: 'low-high-max' },
      { id: 'glm-5.2', contextWindow: 1_000_000, reasoningEffort: 'none-high-max' },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5v-turbo', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 },
      { id: 'glm-4.5-air', contextWindow: 128_000 }
    ],
    // GLM usually marks vision variants with a `v` after the major version (e.g. glm-5v-turbo), but
    // GLM-5.3-Flash is also natively multimodal without that marker.
    multimodal: {
      multimodalModelPattern: /glm-\d+v/i,
      multimodalModels: ['glm-5.3-flash']
    }
  },
  {
    id: 'glmcodingplan',
    label: 'GLM Coding Plan',
    reasoningEffort: 'unsupported',
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
    // The coding plan omits glm-5v-turbo, but serves the natively multimodal GLM-5.3-Flash.
    models: [
      { id: 'glm-5.3', contextWindow: 1_000_000, reasoningEffort: 'low-high-max' },
      { id: 'glm-5.3-flash', contextWindow: 1_000_000, reasoningEffort: 'low-high-max' },
      { id: 'glm-5.2', contextWindow: 1_000_000, reasoningEffort: 'none-high-max' },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 }
    ],
    multimodal: { multimodalModels: ['glm-5.3-flash'] }
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    reasoningEffort: 'standard-5',
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
    reasoningEffort: 'low-high-max',
    // The Kimi Code subscription endpoint: quota-based models (billed against a periodically refreshing
    // quota rather than per token), so it ships a fixed catalog and exposes no live model list. It
    // serves both the Anthropic route and the OpenAI-compatible /v1/chat/completions under `/coding/v1`
    // (Kimi documents this plan for Codex and OpenCode), so `both` lets Codex bridge it.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.kimi.com/coding',
    openaiBaseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyUrl: 'https://www.kimi.com/code/docs',
    models: [
      { id: 'kimi-k3', contextWindow: 1_000_000, reasoningEffort: 'standard-5' },
      { id: 'kimi-for-coding', contextWindow: 256_000 },
      { id: 'kimi-for-coding-highspeed', contextWindow: 256_000 }
    ],
    // Only the k3 model in this plan is vision-capable; the coding-tuned ids are text-only.
    multimodal: { multimodalModels: ['kimi-k3'] }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    reasoningEffort: 'unsupported',
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
      // MiniMax documents M3 reasoning as a binary thinking switch: none disables thinking and high
      // enables Adaptive Thinking. Older M2 models remain conservative until documented otherwise.
      { id: 'MiniMax-M3', contextWindow: 1_000_000, reasoningEffort: 'none-high' },
      { id: 'MiniMax-M3[1m]', contextWindow: 1_000_000, reasoningEffort: 'none-high' },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 }
    ],
    // M3 is natively multimodal; older M2 models remain text-only.
    multimodal: { multimodalModels: ['MiniMax-M3', 'MiniMax-M3[1m]'] }
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    reasoningEffort: 'low-medium-high',
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
    id: 'stepplan',
    label: 'Step Plan',
    reasoningEffort: 'low-medium-high',
    // StepFun's Step Plan is a quota-based subscription (platform.stepfun.com/plan-subscribe) that
    // routes under `/step_plan` on the mainland-China host: Anthropic /v1/messages and the
    // OpenAI-compatible /v1/chat/completions. `baseUrl` is the `/step_plan` root the Anthropic client
    // appends /v1/messages to; `openaiBaseUrl` is the /step_plan/v1 base clients append
    // /chat/completions to. Quota plans ship a fixed catalog and expose no live model list.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.stepfun.com/step_plan',
    openaiBaseUrl: 'https://api.stepfun.com/step_plan/v1',
    apiKeyUrl: 'https://platform.stepfun.com/plan-subscribe',
    // step-router-v1 auto-switches between deepseek-v4-pro and step-3.7-flash; step-3.5-flash-2603 is
    // the high-frequency-agent build. step-3.7-flash leads as the recommended flagship default.
    models: [
      { id: 'step-3.7-flash', contextWindow: 262_144 },
      { id: 'step-3.5-flash', contextWindow: 262_144 },
      { id: 'step-3.5-flash-2603', contextWindow: 262_144, reasoningEffort: 'low-high' },
      { id: 'step-router-v1', contextWindow: 262_144 }
    ],
    // Only the step-3.7-flash flagship is multimodal (vision); the agent/code builds are text-only.
    multimodal: { multimodalModels: ['step-3.7-flash'] }
  },
  {
    id: 'xiaomimimo',
    label: 'Xiaomi MIMO',
    reasoningEffort: 'none-high',
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
    reasoningEffort: 'unsupported',
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
    reasoningEffort: 'minimal-low-medium-high',
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
      { id: 'doubao-seed-2-1-turbo-260628', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-pro-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-lite-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-mini-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-code-preview-260215', contextWindow: 256_000 }
    ],
    // The Seed 2.x general models accept image input; the code-preview coding model is text-only.
    multimodal: {
      multimodalModels: [
        'doubao-seed-2-1-pro-260628',
        'doubao-seed-2-1-turbo-260628',
        'doubao-seed-2-0-pro-260215',
        'doubao-seed-2-0-lite-260215',
        'doubao-seed-2-0-mini-260215'
      ]
    }
  },
  {
    id: 'tencent',
    label: 'Tencent TokenHub',
    reasoningEffort: 'unsupported',
    // TokenHub exposes Anthropic Messages, OpenAI Chat Completions, and Responses from regional
    // hosts. China and International are separate account sites with distinct consoles, API keys,
    // and domains, so keep the site explicit rather than retrying credentials across editions. The
    // broader TokenHub catalog also contains non-language models, so this provider stays curated.
    apiEndpoints: ['anthropic', 'openai', 'responses'],
    anthropicApiKeyHeader: true,
    regions: [
      {
        id: 'international',
        label: 'International (Singapore)',
        baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com',
        openaiBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
        apiKeyUrl: 'https://console.tencentcloud.com/tokenhub/apikey'
      },
      {
        id: 'china',
        label: 'China (Guangzhou)',
        baseUrl: 'https://tokenhub.tencentmaas.com',
        openaiBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
        apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey'
      }
    ],
    models: [
      { id: 'hy4-preview', contextWindow: 1_000_000 },
      { id: 'glm-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.3-flash', contextWindow: 1_000_000 },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 1_000_000 }
    ]
    // The curated language models above are text-only in TokenHub's model matrix, so no
    // `multimodal` rule.
  },
  {
    id: 'tencentcodingplan',
    label: 'Tencent Coding Plan',
    reasoningEffort: 'unsupported',
    // Mainland China's subscription plan exposes separate Anthropic Messages and OpenAI Chat
    // Completions routes. Tencent documents ANTHROPIC_AUTH_TOKEN for the former, so it keeps the
    // default Authorization: Bearer transport. Accepted aliases are intentionally omitted so the
    // picker shows each model once; the first documented id is the canonical selection.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
    openaiBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/codingplan',
    models: [
      { id: 'deepseek-v4-flash-202605', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro-202606', contextWindow: 1_000_000 },
      { id: 'minimax-m2.7', contextWindow: 204_800 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'hy3', contextWindow: 256_000 }
    ]
  },
  {
    id: 'tencenttokenplan',
    label: 'Tencent Token Plan',
    reasoningEffort: 'unsupported',
    // The international subscription is a distinct product with its own key, endpoints, and model
    // catalog. Its Claude Code guide also uses ANTHROPIC_AUTH_TOKEN (Authorization: Bearer). Keep it
    // separate from both mainland Coding Plan and pay-as-you-go Tencent TokenHub.
    apiEndpoints: ['anthropic', 'openai'],
    baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic',
    openaiBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3',
    apiKeyUrl: 'https://console.intl.cloud.tencent.com/tokenhub/tokenplan',
    models: [
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'kimi-k2.6', contextWindow: 256_000 },
      { id: 'deepseek-v4-pro-202606', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-202605', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 1_000_000 }
    ],
    multimodal: { multimodalModels: ['kimi-k2.6'] }
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    reasoningEffort: 'unsupported',
    apiEndpoints: ['openai'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    // The live catalog mixes chat, embedding, image, OCR, safety, and other model types, so keep the
    // agent-capable chat catalog curated instead of exposing refresh-from-vendor.
    models: [
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', contextWindow: 1_000_000 },
      { id: 'deepseek-ai/deepseek-v4-pro-0813', contextWindow: 1_000_000 },
      { id: 'minimaxai/minimax-m3', contextWindow: 1_000_000 },
      { id: 'poolside/laguna-xs-2.1', contextWindow: 262_144 },
      { id: 'meta/muse-glimmer-30b', contextWindow: 131_072 },
      { id: 'moonshotai/kimi-k3', contextWindow: 1_048_576 }
    ],
    multimodal: {
      multimodalModels: ['minimaxai/minimax-m3', 'meta/muse-glimmer-30b', 'moonshotai/kimi-k3']
    }
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    reasoningEffort: 'unsupported',
    apiEndpoints: ['openai'],
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyUrl: 'https://opencode.ai/zen',
    // OpenCode documents one protocol per model. Keep the catalog bundled so deprecated and temporary
    // free entries do not appear through the broader live model endpoint.
    models: [
      { id: 'kimi-k2.7-code', contextWindow: 262_144 },
      {
        id: 'grok-4.6',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.6-luna',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: 'low-high-max'
      },
      { id: 'glm-5.3', contextWindow: 1_000_000, reasoningEffort: 'low-high-max' },
      { id: 'glm-5.2', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      { id: 'glm-5.1', contextWindow: 202_752 },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.6', contextWindow: 262_144 },
      { id: 'longcat-2.0', contextWindow: 1_000_000, reasoningEffort: 'none-high' },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      {
        id: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
        reasoningEffort: 'low-high-max'
      },
      {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: 1_000_000,
        reasoningEffort: 'none-high-max'
      },
      { id: 'mimo-v2.5', contextWindow: 1_000_000 },
      { id: 'mimo-v2.5-pro', contextWindow: 1_048_576 },
      {
        id: 'minimax-m3',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      {
        id: 'muse-spark-1.2-contributor',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: 'minimal-low-medium-high'
      },
      {
        id: 'qwen3.8-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      {
        id: 'qwen3.7-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      { id: 'hy3', contextWindow: 256_000, reasoningEffort: 'none-high' }
    ],
    multimodal: {
      multimodalModels: [
        'kimi-k2.7-code',
        'grok-4.6',
        'gpt-5.6-luna',
        'glm-5.3-flash',
        'kimi-k3',
        'kimi-k2.6',
        'deepseek-v4-flash-vision-exp',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'muse-spark-1.2-contributor',
        'qwen3.8-max',
        'qwen3.7-plus'
      ]
    }
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    reasoningEffort: 'unsupported',
    apiEndpoints: ['openai'],
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyUrl: 'https://opencode.ai/zen',
    // Zen also mixes protocols. Exclude Google-native, temporary free, deprecated, and explicitly
    // product-excluded models while preserving the existing Kimi default.
    models: [
      { id: 'kimi-k2.7-code', contextWindow: 262_144 },
      {
        id: 'gpt-5.6-sol',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'gpt-5.6-terra',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'gpt-5.6-luna',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'claude-fable-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'standard-5'
      },
      {
        id: 'claude-opus-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'standard-5'
      },
      {
        id: 'claude-sonnet-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'standard-5'
      },
      {
        id: 'grok-4.6',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.5',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.5-pro',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'medium-high-xhigh'
      },
      {
        id: 'gpt-5.4',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.4-pro',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'medium-high-xhigh'
      },
      {
        id: 'gpt-5.4-mini',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.4-nano',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.3-codex',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.3-codex-spark',
        contextWindow: 128_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.2',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'gpt-5.1',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'low-medium-high'
      },
      {
        id: 'gpt-5',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'minimal-low-medium-high'
      },
      {
        id: 'gpt-5-nano',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'minimal-low-medium-high'
      },
      {
        id: 'claude-opus-4-8',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'standard-5'
      },
      {
        id: 'claude-opus-4-7',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'standard-5'
      },
      {
        id: 'claude-opus-4-6',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'low-medium-high-max'
      },
      {
        id: 'claude-opus-4-5',
        contextWindow: 200_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'low-medium-high'
      },
      {
        id: 'claude-sonnet-4-6',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'low-medium-high-max'
      },
      { id: 'claude-sonnet-4-5', contextWindow: 1_000_000, apiEndpoint: 'anthropic' },
      { id: 'claude-haiku-4-5', contextWindow: 200_000, apiEndpoint: 'anthropic' },
      {
        id: 'grok-4.5',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: 'low-medium-high'
      },
      { id: 'grok-build-0.1', contextWindow: 256_000, apiEndpoint: 'responses' },
      {
        id: 'muse-spark-1.2',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: 'minimal-low-medium-high'
      },
      {
        id: 'qwen3.7-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1_000_000,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      {
        id: 'qwen3.5-plus',
        contextWindow: 262_144,
        apiEndpoint: 'anthropic',
        reasoningEffort: 'none-high'
      },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.6', contextWindow: 262_144, reasoningEffort: 'none-high' },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 512_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000, reasoningEffort: 'high-max' },
      { id: 'glm-5.1', contextWindow: 204_800, reasoningEffort: 'none-high' }
    ],
    multimodal: {
      multimodalModels: [
        'kimi-k2.7-code',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'claude-fable-5',
        'claude-opus-5',
        'claude-sonnet-5',
        'grok-4.6',
        'gpt-5.5',
        'gpt-5.5-pro',
        'gpt-5.4',
        'gpt-5.4-pro',
        'gpt-5.4-mini',
        'gpt-5.4-nano',
        'gpt-5.3-codex',
        'gpt-5.2',
        'gpt-5.1',
        'gpt-5',
        'gpt-5-nano',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-opus-4-5',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'grok-4.5',
        'grok-build-0.1',
        'muse-spark-1.2',
        'qwen3.5-plus',
        'kimi-k3',
        'kimi-k2.6',
        'minimax-m3'
      ]
    }
  },
  // OpenRouter is an aggregation gateway (many vendors behind one key), so it sits last in the picker.
  {
    id: 'openrouter',
    label: 'OpenRouter',
    // The gateway aggregates unrelated model families, so every curated entry below declares its
    // own capability. Unknown additions stay conservative instead of pretending to support five.
    reasoningEffort: 'unsupported',
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
      {
        id: 'anthropic/claude-opus-5',
        contextWindow: 1_000_000,
        reasoningEffort: 'standard-5'
      },
      {
        id: 'anthropic/claude-opus-4.8',
        contextWindow: 1_000_000,
        reasoningEffort: 'standard-5'
      },
      {
        id: 'anthropic/claude-sonnet-5',
        contextWindow: 1_000_000,
        reasoningEffort: 'standard-5'
      },
      {
        id: 'anthropic/claude-haiku-4.5',
        contextWindow: 200_000,
        reasoningEffort: 'unsupported'
      },
      // OpenAI
      // These profiles are baked from OpenRouter's public model reasoning metadata. Where a model
      // exposes six values, keep the product's five-option ceiling and span off through its top rung.
      {
        id: 'openai/gpt-5.6-terra-pro',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.6-terra',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.6-sol-pro',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.6-sol',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.6-luna-pro',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-max'
      },
      {
        id: 'openai/gpt-5.5-pro',
        contextWindow: 1_050_000,
        reasoningEffort: 'medium-high-xhigh'
      },
      {
        id: 'openai/gpt-5.5',
        contextWindow: 1_050_000,
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      {
        id: 'openai/gpt-5.3-codex',
        contextWindow: 400_000,
        reasoningEffort: 'none-low-medium-high-xhigh'
      },
      // Other top-ranked vendors on OpenRouter
      {
        id: 'google/gemini-3.1-pro-preview',
        contextWindow: 1_048_576,
        reasoningEffort: 'unsupported'
      },
      {
        id: 'google/gemini-3.6-flash',
        contextWindow: 1_048_576,
        reasoningEffort: 'minimal-low-medium-high'
      },
      {
        id: 'google/gemini-3.5-flash',
        contextWindow: 1_048_576,
        reasoningEffort: 'unsupported'
      },
      { id: 'x-ai/grok-4.5', contextWindow: 500_000, reasoningEffort: 'unsupported' },
      {
        id: 'deepseek/deepseek-v4-pro',
        contextWindow: 1_048_576,
        reasoningEffort: 'none-high-xhigh'
      },
      {
        id: 'z-ai/glm-5.2',
        contextWindow: 1_048_576,
        reasoningEffort: 'none-high-xhigh'
      },
      {
        id: 'moonshotai/kimi-k3',
        contextWindow: 1_048_576,
        reasoningEffort: 'low-high-max'
      },
      {
        id: 'qwen/qwen3.7-max',
        contextWindow: 1_000_000,
        reasoningEffort: 'none-high'
      }
    ],
    // OpenRouter's catalog is curated (no live refresh), and vision support is an unpredictable subset
    // across vendors — so it is an explicit id list rather than a blanket rule or pattern. The
    // text-only members (gpt-5.3-codex, deepseek-v4-pro, glm-5.2) are intentionally omitted.
    multimodal: {
      multimodalModels: [
        'anthropic/claude-opus-5',
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
        'google/gemini-3.6-flash',
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

// Resolves the bundled, model-specific effort capability. Unknown/live-fetched model ids use the
// vendor default; a vendor without an explicit declaration keeps the product's standard five-level
// compatibility default. This is intentionally synchronous and never consults the network.
export const resolveVendorModelReasoningEffort = (
  id: OfficialVendorId,
  modelId: string | undefined
): ReasoningEffortProfile => {
  const vendor = VENDORS_BY_ID.get(id)
  const model = vendor?.models.find((candidate) => candidate.id === modelId)

  return resolveReasoningEffortProfile(model?.reasoningEffort ?? vendor?.reasoningEffort)
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

export const usesVendorAnthropicApiKeyHeader = (id: OfficialVendorId): boolean =>
  VENDORS_BY_ID.get(id)?.anthropicApiKeyHeader === true

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
): ChatApiEndpoint[] => {
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
