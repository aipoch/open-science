import type { ModelProtocol } from '../protocols/types'
import type { ReasoningCapability } from '../protocols/types'

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
  | 'requesty'

// A selectable endpoint for vendors that publish more than one host — e.g. a Global vs. China region
// (MiniMax) or a separate overseas/domestic console (GLM's Z.AI vs. BigModel). Each carries its own
// base URL and, since consoles differ by region, its own key-console URL.
export type VendorRegion = {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  // The region's OpenAI /v1/chat/completions base, when it differs from the Anthropic `baseUrl` and the
  // vendor supports both endpoints. Falls back to the region's `baseUrl` when absent.
  readonly chatCompletionsBaseUrl?: string
  // The region's native Responses API base, when it differs from the OpenAI chat base. Falls back to
  // `chatCompletionsBaseUrl` and then `baseUrl` when absent.
  readonly responsesBaseUrl?: string
  // Where the user creates/copies a key for this endpoint; falls back to the vendor-level one.
  readonly apiKeyUrl?: string
  // Full URL of the vendor's model-list endpoint for this region; falls back to the vendor-level one.
  readonly modelsListUrl?: string
  // An authoritative curated subset when this region serves fewer models than the vendor catalog.
  readonly modelIds?: readonly string[]
}

export type OfficialModel = {
  readonly id: string
  // Advertised context-window size for this exact model, in tokens.
  readonly contextWindow: number
  // Optional exact protocol override for mixed-protocol vendor catalogs. Absent means the model uses
  // the vendor-level endpoint set.
  readonly apiEndpoint?: ModelProtocol
  // Optional override for a model whose effort levels differ from the vendor default.
  readonly reasoningEffort?: ReasoningCapability
}

export type OfficialVendor = {
  readonly id: OfficialVendorId
  // Human-readable name shown in the provider-type picker and composer group headings.
  readonly label: string
  // Which chat APIs this vendor serves; drives per-framework availability. Absent ⇒ ['messages']
  // for legacy Anthropic-compatible vendor entries. A dual-endpoint vendor lists both, e.g.
  // ['messages', 'chat-completions'].
  readonly apiEndpoints?: readonly ModelProtocol[]
  // Whether Anthropic Messages authenticates with `x-api-key` instead of `Authorization: Bearer`.
  // Absent keeps the existing bearer behavior used by the other compatible vendors.
  readonly messagesApiKeyHeader?: boolean
  // Model ids offered in the composer once a key is stored. First entry is the default selection when
  // the vendor is first added.
  readonly models: readonly OfficialModel[]
  // Concrete supported reasoning values. Model entries may override the vendor capability.
  readonly reasoningEffort: ReasoningCapability
  // Models that accept native Responses API (/v1/responses) requests, for vendors where only a
  // subset of the catalog implements the Responses protocol while the vendor-level `apiEndpoints`
  // does not include 'responses'. A vendor that declares 'responses' in `apiEndpoints` serves it
  // for its whole catalog and must not set this field. Absent ⇒ Responses availability is purely
  // governed by `apiEndpoints`.
  readonly responsesModels?: readonly string[]
  // Describes which of this vendor's models accept image input (multimodal vision). Absent ⇒ the vendor
  // has no vision models. This must cover live-fetched ids too — a vendor that refreshes its catalog can
  // surface a vision model not in the bundled `models` array — so it is a rule, not a static id list:
  //   - allMultimodal: true       — every model this vendor serves supports vision (e.g. Claude, GPT-5+)
  //   - multimodalModelPattern    — a RegExp matched against the model id (e.g. GLM's `v` vision variants)
  //   - multimodalModels          — an explicit id list, for catalogs where vision is an unpredictable
  //                                 subset (e.g. OpenRouter's cross-vendor slugs)
  // Precedence when resolving support: allMultimodal → pattern → explicit list.
  readonly multimodal?: {
    readonly allMultimodal?: boolean
    readonly multimodalModelPattern?: RegExp
    readonly multimodalModels?: readonly string[]
  }
  // Single-endpoint vendors set `baseUrl`; multi-region vendors set `regions` instead (never both).
  // For dual-endpoint vendors, `baseUrl` is the Anthropic /v1/messages route and `chatCompletionsBaseUrl` is the
  // separate OpenAI /v1/chat/completions root. `responsesBaseUrl` may differ when the vendor's native
  // Responses API uses a different base path. Set these only when the vendor exposes the
  // corresponding endpoint.
  readonly baseUrl?: string
  readonly chatCompletionsBaseUrl?: string
  readonly responsesBaseUrl?: string
  readonly regions?: readonly VendorRegion[]
  // Page where the user obtains an API key. For multi-region vendors a per-region url takes priority.
  readonly apiKeyUrl?: string
  // Full URL of a live model-list endpoint (OpenAI-style `{ data: [{ id }] }`). Set only for vendors
  // that actually expose one, so the "refresh from vendor" affordance is hidden for those that don't.
  readonly modelsListUrl?: string
}
