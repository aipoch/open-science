import {
  claudeIsolatedProviderIdentity,
  codexSubscriptionProviderIdentity,
  xaiSubscriptionProviderIdentity,
  preferredEndpoint,
  type AgentFrameworkId,
  type ChatApiEndpoint,
  type CodexSubscriptionTransport,
  type ProviderDraft,
  type ProviderType
} from '../../../../shared/settings'
import {
  OFFICIAL_VENDORS,
  defaultVendorModel,
  getOfficialVendor,
  resolveVendorModelApiEndpoints,
  type OfficialVendorId
} from '../../../../shared/provider-registry'
import type {
  CustomReasoningEffortTransport,
  ReasoningEffortPresetSetting
} from '../../../../shared/reasoning-effort'

// Editable value for the provider form, kept in its own module so the component file only exports a
// component (satisfying react-refresh) while the wizard and settings page share this shape/factory.
export type ProviderFormValue = {
  type: ProviderType
  codexTransport: CodexSubscriptionTransport
  name: string
  baseUrl: string
  model: string
  // Kept as text so empty optional numeric inputs remain distinct from the 200k context default.
  contextWindow: string
  maxInputTokens: string
  maxOutputTokens: string
  // Which chat API a custom gateway speaks; drives which agent frameworks can use it. Defaults to
  // 'anthropic'. A custom provider serves exactly one endpoint (official providers take theirs from
  // the registry); it is stored as the single-entry apiEndpoints array.
  apiEndpoint: ChatApiEndpoint
  // Form-only state: protects any user-edited onboarding draft when the step remounts or the active
  // framework changes. It is intentionally omitted from the persisted provider request.
  providerFormTouched: boolean
  supportsImageInput: boolean
  // Optional at rest for backwards compatibility; the form always materializes the five-level default.
  reasoningEffortPreset: ReasoningEffortPresetSetting
  // The request-body shape used by the custom gateway for model effort.
  reasoningEffortTransport: CustomReasoningEffortTransport
  // Set when type is 'official': the chosen vendor and (for multi-region vendors) the endpoint. Base
  // URL and the model catalog then come from the registry rather than these free-text fields.
  vendorId?: OfficialVendorId
  region?: string
  // Plaintext only while the user is typing a new key; empty means "keep the stored key".
  key: string
}

// Builds an empty form value, defaulting to a custom provider (the common first-run case).
export const createEmptyProviderFormValue = (
  overrides: Partial<ProviderFormValue> = {}
): ProviderFormValue => ({
  type: 'custom',
  codexTransport: 'auto',
  name: '',
  baseUrl: '',
  model: '',
  contextWindow: '',
  maxInputTokens: '',
  maxOutputTokens: '',
  apiEndpoint: 'anthropic',
  providerFormTouched: false,
  supportsImageInput: false,
  reasoningEffortPreset: 'unsupported',
  reasoningEffortTransport: 'reasoning-effort',
  key: '',
  ...overrides
})

type ProviderFormTokenLimits = Pick<
  ProviderDraft,
  'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'
>

// Both Settings and onboarding persist this shared form. Keep optional-number conversion here so a
// blank custom value explicitly clears a saved override while non-custom requests omit the fields.
export const providerFormTokenLimits = (value: ProviderFormValue): ProviderFormTokenLimits =>
  value.type === 'custom'
    ? {
        contextWindow: value.contextWindow.trim() ? Number(value.contextWindow) : null,
        maxInputTokens: value.maxInputTokens.trim() ? Number(value.maxInputTokens) : null,
        maxOutputTokens: value.maxOutputTokens.trim() ? Number(value.maxOutputTokens) : null
      }
    : {}

// Chooses the framework's preferred wire protocol for a new custom gateway. This mirrors runtime
// endpoint selection: Responses wins when available, then Chat Completions, then Messages. The
// legacy Messages default remains the safe fallback while framework capabilities are still loading.
export const defaultCustomApiEndpoint = (
  frameworkEndpoints: readonly ChatApiEndpoint[]
): ChatApiEndpoint => preferredEndpoint(frameworkEndpoints, frameworkEndpoints) ?? 'anthropic'

// Built-in providers resolve the exact protocol for the selected/default model. `apiEndpoint` only
// represents the single format selected for a custom gateway and may be stale after switching
// provider kinds.
export const providerFormApiEndpoints = (value: ProviderFormValue): ChatApiEndpoint[] => {
  if (value.type === 'official' && value.vendorId) {
    return resolveVendorModelApiEndpoints(
      value.vendorId,
      value.model.trim() || defaultVendorModel(value.vendorId)
    )
  }
  if (value.type === 'xai-subscription') return ['anthropic', 'openai', 'responses']
  return [value.apiEndpoint]
}

// Before an official provider is saved, select the first model that speaks a protocol the active
// framework consumes directly. If none does, keep the vendor default so the normal compatibility
// gate can reject the pair (or allow Codex's Chat bridge).
export const providerFormModelForFramework = (
  value: ProviderFormValue,
  frameworkEndpoints: readonly ChatApiEndpoint[]
): string | undefined => {
  const selectedModel = value.model.trim()
  if (selectedModel || value.type !== 'official' || !value.vendorId) {
    return selectedModel || undefined
  }

  const vendorId = value.vendorId
  return (
    getOfficialVendor(vendorId)?.models.find(({ id }) =>
      resolveVendorModelApiEndpoints(vendorId, id).some((endpoint) =>
        frameworkEndpoints.includes(endpoint)
      )
    )?.id ?? defaultVendorModel(vendorId)
  )
}

// The provider kind pre-selected when the Add provider form opens, matched to the active agent
// framework's most common official vendor: Claude Code → Anthropic, Codex → OpenAI,
// OpenCode → DeepSeek, CodeBuddy → MiniMax. Exhaustive over AgentFrameworkId so a new framework
// forces a deliberate choice, and keyed off OfficialVendorId so a registry rename fails at compile
// time.
export const defaultProviderKindKey = (
  frameworkId: AgentFrameworkId
): `official:${OfficialVendorId}` => {
  switch (frameworkId) {
    case 'claude-code':
      return 'official:anthropic'
    case 'codex':
      return 'official:openai'
    case 'opencode':
      return 'official:deepseek'
    case 'codebuddy':
      return 'official:minimax'
    default: {
      // The never assignment keeps the switch exhaustive at compile time. Persisted state could
      // still hold a stale value outside the union; this runs during render, so degrade to the
      // Claude Code vendor instead of throwing.
      const exhaustive: never = frameworkId
      void exhaustive
      return 'official:anthropic'
    }
  }
}

// Per-field validation errors. Custom needs base URL/model/key; official needs only a key (base URL
// and model come from the registry).
//
// Values are the English copy itself, which under natural-language keys is also its own catalog key:
// validation stays a locale-independent decision about the draft, and ProviderForm resolves each
// through t() at render time. The union (rather than `string`) makes a typo in the English a
// typecheck failure at every call site.
export type ProviderFormErrorKey =
  | 'Base URL is required.'
  | 'Model is required.'
  | 'API key is required.'
  | 'Context window must be a positive whole number of tokens.'
  | 'Maximum input tokens must be a positive whole number of tokens.'
  | 'Maximum output tokens must be a positive whole number of tokens.'

export type ProviderFormErrors = {
  baseUrl?: ProviderFormErrorKey
  contextWindow?: ProviderFormErrorKey
  key?: ProviderFormErrorKey
  maxInputTokens?: ProviderFormErrorKey
  maxOutputTokens?: ProviderFormErrorKey
  model?: ProviderFormErrorKey
}

const positiveWholeNumberError = (value: string): boolean => {
  if (!value.trim()) return false
  const number = Number(value)
  return !Number.isSafeInteger(number) || number <= 0
}

// Computes required-field errors for a draft. On edit, an already-stored key satisfies the key
// requirement, so the user can leave the key blank to keep it.
export const getProviderFormErrors = (
  value: ProviderFormValue,
  options: { hasStoredKey?: boolean } = {}
): ProviderFormErrors => {
  const errors: ProviderFormErrors = {}

  if (value.type === 'custom') {
    if (!value.baseUrl.trim()) errors.baseUrl = 'Base URL is required.'
    if (!value.model.trim()) errors.model = 'Model is required.'
    if (positiveWholeNumberError(value.contextWindow)) {
      errors.contextWindow = 'Context window must be a positive whole number of tokens.'
    }
    if (positiveWholeNumberError(value.maxInputTokens)) {
      errors.maxInputTokens = 'Maximum input tokens must be a positive whole number of tokens.'
    }
    if (positiveWholeNumberError(value.maxOutputTokens)) {
      errors.maxOutputTokens = 'Maximum output tokens must be a positive whole number of tokens.'
    }
    if (!value.key.trim() && !options.hasStoredKey) errors.key = 'API key is required.'
  } else if (value.type === 'official') {
    // No model is chosen at add time: the vendor catalog + the global model selection cover that.
    if (!value.key.trim() && !options.hasStoredKey) errors.key = 'API key is required.'
  } else if (value.type === 'claude-isolated') {
    // claude-isolated has no add-time fields: the type alone provisions the provider card, and the
    // token paste lives in a separate sign-in modal (loginIsolatedClaude). Rejecting here would
    // block the renderer from even creating the record, which contradicts the UX.
  }

  return errors
}

// True when a draft has at least one required-field error (blocks save/test).
export const hasProviderFormErrors = (errors: ProviderFormErrors): boolean =>
  Object.keys(errors).length > 0

// Grouping for the provider-type picker. 'codex' / 'claude' = each vendor's own subscription
// sign-in, surfaced as its own section (only one is shown at a time, gated on the active
// framework); 'api' = official vendors via their standard API key; 'other' = the custom gateway.
export type ProviderKindGroup = 'codex' | 'claude' | 'subscription' | 'api' | 'other'

export type ProviderKindGroupLabelKey =
  'Codex subscription' | 'Claude subscription' | 'Subscription' | 'Official API' | 'Other'

// A provider kind's one-line description, as English copy (its own catalog key). The `label` beside it stays a plain
// string: it is a vendor name from the registry (`Anthropic`, `Moonshot`) or a subscription identity,
// which the glossary keeps in English in every locale. Only the description is prose.
export type ProviderKindDescriptionKey =
  | 'Use an existing Codex profile or sign in with a separate Open Science profile.'
  | 'Use an existing Claude profile or sign in with a separate Open Science profile.'
  | 'Sign in to your xAI subscription with a browser device code.'
  | 'API key — models provided'
  | 'Base URL, key, and model for a Messages or Chat Completions endpoint'

// Group headers shown in the provider-type picker and dropdown, in display order. The two
// subscription groups mirror each other: only the one matching the active framework is rendered.
export const PROVIDER_KIND_GROUPS: {
  id: ProviderKindGroup
  labelKey: ProviderKindGroupLabelKey
}[] = [
  { id: 'codex', labelKey: 'Codex subscription' },
  { id: 'claude', labelKey: 'Claude subscription' },
  { id: 'subscription', labelKey: 'Subscription' },
  { id: 'api', labelKey: 'Official API' },
  { id: 'other', labelKey: 'Other' }
]

// A selectable option in the provider-type dropdown. Official vendors are keyed `official:<vendorId>`.
// A kind carries exactly one of `label` (a vendor / subscription proper noun, identical in every
// locale) or `labelKey` (translated prose — only the custom gateway). Modelled as a union so the form
// has to handle both and neither can be silently forgotten.
export type ProviderKind = {
  key: string
  descriptionKey: ProviderKindDescriptionKey
  group: ProviderKindGroup
} & ({ label: string; labelKey?: never } | { labelKey: 'Custom Gateway'; label?: never })

export const PROVIDER_KINDS: ProviderKind[] = [
  {
    key: 'xai-subscription',
    label: xaiSubscriptionProviderIdentity().name,
    descriptionKey: 'Sign in to your xAI subscription with a browser device code.',
    group: 'subscription'
  },
  {
    key: 'codex-subscription',
    label: codexSubscriptionProviderIdentity().name,
    descriptionKey:
      'Use an existing Codex profile or sign in with a separate Open Science profile.',
    group: 'codex'
  },
  {
    // Gets its own subscription section, mirroring the Codex subscription. Supports both shared
    // (browser OAuth via `claude auth login`, uses ~/.claude) and isolated (setup-token paste, uses
    // app-owned config dir). Surfaced only when Claude Code is the active framework.
    key: 'claude-subscription',
    label: claudeIsolatedProviderIdentity().name,
    descriptionKey:
      'Use an existing Claude profile or sign in with a separate Open Science profile.',
    group: 'claude'
  },
  ...OFFICIAL_VENDORS.map((vendor): ProviderKind => ({
    key: `official:${vendor.id}`,
    label: vendor.label,
    descriptionKey: 'API key — models provided',
    group: 'api'
  })),
  {
    key: 'custom',
    labelKey: 'Custom Gateway',
    descriptionKey: 'Base URL, key, and model for a Messages or Chat Completions endpoint',
    group: 'other'
  }
]

// The patch applied to the form value when a provider-kind is picked. Switching to an official vendor
// seeds its default region + model; switching to custom clears vendor-only fields and applies the
// active framework's preferred endpoint.
export const providerKindPatch = (
  key: string,
  customApiEndpoint: ChatApiEndpoint = 'anthropic'
): Partial<ProviderFormValue> => {
  if (key === 'codex-subscription') {
    const identity = codexSubscriptionProviderIdentity()
    return {
      type: 'codex-shared',
      name: identity.name,
      apiEndpoint: 'responses',
      baseUrl: '',
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: '',
      key: '',
      vendorId: undefined,
      region: undefined
    }
  }

  if (key === 'claude-subscription') {
    const identity = claudeIsolatedProviderIdentity()
    return {
      type: 'claude-shared',
      name: identity.name,
      apiEndpoint: 'anthropic',
      baseUrl: '',
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: '',
      key: '',
      vendorId: undefined,
      region: undefined
    }
  }

  if (key === 'xai-subscription') {
    const identity = xaiSubscriptionProviderIdentity()
    return {
      type: 'xai-subscription',
      name: identity.name,
      apiEndpoint: 'responses',
      baseUrl: '',
      model: 'grok-4.6',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: '',
      key: '',
      vendorId: undefined,
      region: undefined
    }
  }

  if (key.startsWith('official:')) {
    const vendorId = key.slice('official:'.length) as OfficialVendorId
    const vendor = getOfficialVendor(vendorId)

    // No per-provider model: the vendor catalog is fixed and the chosen model is the global selection.
    return {
      type: 'official',
      name: vendor?.label,
      vendorId,
      region: vendor?.regions?.[0]?.id,
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    }
  }

  return {
    type: 'custom',
    apiEndpoint: customApiEndpoint,
    vendorId: undefined,
    region: undefined,
    model: '',
    contextWindow: '',
    maxInputTokens: '',
    maxOutputTokens: ''
  }
}

// Maps the current form value back to its provider-kind key (the dropdown's selected value).
export const selectedKindKey = (value: ProviderFormValue): string => {
  if (value.type === 'custom') {
    return 'custom'
  }
  if (value.type === 'claude-shared' || value.type === 'claude-isolated') {
    return 'claude-subscription'
  }
  if (value.type === 'codex-shared' || value.type === 'codex-isolated') {
    return 'codex-subscription'
  }
  if (value.type === 'xai-subscription') return 'xai-subscription'

  return value.vendorId ? `official:${value.vendorId}` : 'custom'
}

// Maps a provider's type + vendor to its icon key ('custom' | 'official:<id>').
export const providerKindKey = (type: ProviderType, vendorId?: OfficialVendorId): string =>
  type === 'official' && vendorId
    ? `official:${vendorId}`
    : type === 'codex-shared' || type === 'codex-isolated'
      ? 'codex-subscription'
      : type === 'claude-shared' || type === 'claude-isolated'
        ? 'claude-subscription'
        : type === 'xai-subscription'
          ? 'xai-subscription'
          : type
