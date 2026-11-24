import {
  codeBuddyAccounts,
  codeBuddySiteForId,
  type CodeBuddyAuthMode,
  type CodeBuddySite
} from '../../../../shared/codebuddy-subscription'
import {
  type CatalogSnapshot,
  type ModelProtocol,
  OFFICIAL_VENDORS,
  getOfficialVendor,
  resolveVendorModelApiEndpoints,
  type OfficialVendorId,
  type CustomReasoningEffortTransport
} from '@aipoch/providers'
import {
  defaultVendorModel,
  getOfficialVendorModelIds
} from '../../../../shared/provider-model-policy'
import {
  providerAllowsAnonymousAccess,
  getCustomProviderBaseUrlError,
  type CustomProviderBaseUrlError
} from '../../../../shared/provider-url-policy'
import { type ReasoningEffortPresetSetting } from '../../../../shared/reasoning-effort'

import type {
  AgentFrameworkId,
  CodexSubscriptionTransport,
  ProviderDraft,
  ProviderType
} from '../../../../shared/settings'
import {
  claudeIsolatedProviderIdentity,
  codexSubscriptionProviderIdentity,
  xaiSubscriptionProviderIdentity
} from '../../../../shared/settings-runtime'

// Editable value for the provider form, kept in its own module so the component file only exports a
// component (satisfying react-refresh) while the wizard and settings page share this shape/factory.
export type ProviderFormValue = {
  catalogParameters?: Record<string, string>
  type: ProviderType
  codeBuddySite?: CodeBuddySite
  codeBuddyAuthMode?: CodeBuddyAuthMode
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
  apiEndpoint: ModelProtocol
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
  apiEndpoint: 'messages',
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

// Quick-fill presets for local model servers. Every one serves OpenAI Chat Completions on a
// well-known loopback port and requires no API key, so applying a preset seeds the base URL and
// the Chat Completions API format. The model stays for the user to fill: local model ids depend
// on what they have pulled, so guessing one would be noise. Selecting a preset never blocks
// editing anything afterwards.
export type LocalModelPreset = Readonly<{
  id: string
  label: string
  baseUrl: string
}>

export const LOCAL_MODEL_PRESETS: readonly LocalModelPreset[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234' },
  { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://localhost:8080' },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000' }
]

// The form patch a preset applies — or, when the preset is already active, reverts. Tapping the
// active preset clears exactly what it filled: the base URL, the format it selected (back to the
// framework's default), and the name it seeded. Fields the user typed themselves — the model
// above all — are never touched in either direction.
export const localModelPresetPatch = (
  preset: LocalModelPreset,
  value: ProviderFormValue,
  defaultApiEndpoint: ProviderFormValue['apiEndpoint']
): Partial<ProviderFormValue> => {
  if (value.baseUrl.trim() === preset.baseUrl) {
    return {
      baseUrl: '',
      apiEndpoint: defaultApiEndpoint,
      ...(value.name.trim() === preset.label ? { name: '' } : {})
    }
  }

  return {
    baseUrl: preset.baseUrl,
    apiEndpoint: 'chat-completions',
    ...(value.name.trim() ? {} : { name: preset.label })
  }
}

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
  frameworkEndpoints: readonly ModelProtocol[]
): ModelProtocol => frameworkEndpoints[0] ?? 'messages'

// Built-in providers resolve the exact protocol for the selected/default model. `apiEndpoint` only
// represents the single format selected for a custom gateway and may be stale after switching
// provider kinds.
export const providerFormApiEndpoints = (value: ProviderFormValue): ModelProtocol[] => {
  if (value.type === 'official' && value.vendorId) {
    return resolveVendorModelApiEndpoints(
      value.vendorId,
      value.model.trim() || defaultVendorModel(value.vendorId, value.region)
    )
  }
  if (value.type === 'xai-subscription') return ['messages', 'chat-completions', 'responses']
  return [value.apiEndpoint]
}

// Before an official provider is saved, select the first model that speaks a protocol the active
// framework consumes directly. If none does, keep the vendor default so the normal compatibility
// gate can reject the pair (or allow Codex's Chat bridge).
export const providerFormModelForFramework = (
  value: ProviderFormValue,
  frameworkEndpoints: readonly ModelProtocol[]
): string | undefined => {
  const selectedModel = value.model.trim()
  if (selectedModel || value.type !== 'official' || !value.vendorId) {
    return selectedModel || undefined
  }

  const vendorId = value.vendorId
  return (
    getOfficialVendorModelIds(vendorId, value.region).find((id) =>
      resolveVendorModelApiEndpoints(vendorId, id).some((endpoint) =>
        frameworkEndpoints.includes(endpoint)
      )
    ) ?? defaultVendorModel(vendorId, value.region)
  )
}

// The provider kind pre-selected when the Add provider form opens, matched to the active agent
// framework's most common official vendor: Claude Code → Anthropic, Codex → OpenAI,
// OpenCode and Pi → DeepSeek, CodeBuddy → MiniMax. Exhaustive over AgentFrameworkId so a new framework
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
    case 'open-science-agent':
    case 'pi':
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
  | CustomProviderBaseUrlError
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
  options: { hasStoredKey?: boolean; modelCatalog?: CatalogSnapshot } = {}
): ProviderFormErrors => {
  const errors: ProviderFormErrors = {}

  if (value.type === 'custom') {
    if (!value.baseUrl.trim()) errors.baseUrl = 'Base URL is required.'
    else {
      const baseUrlError = getCustomProviderBaseUrlError(value.baseUrl.trim())
      if (baseUrlError) errors.baseUrl = baseUrlError
    }
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
  }
  if (
    (value.type === 'custom' || value.type === 'official') &&
    !value.key.trim() &&
    !options.hasStoredKey &&
    !providerAllowsAnonymousAccess({ ...value, modelCatalog: options.modelCatalog })
  ) {
    errors.key = 'API key is required.'
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
  | 'Use an existing Codex profile or sign in with a separate Open-Science profile.'
  | 'Use an existing Claude profile or sign in with a separate Open-Science profile.'
  | 'Sign in to your xAI subscription with a browser device code.'
  | 'API key — models provided'
  | 'Free models work without an API key.'
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
  descriptionKey?: ProviderKindDescriptionKey
  group: ProviderKindGroup
} & (
  | { label: string; labelKey?: never }
  | {
      labelKey: 'Custom Gateway' | (typeof codeBuddyAccounts)[CodeBuddySite]['name']
      label?: never
    }
)

export const PROVIDER_KINDS: ProviderKind[] = [
  ...Object.values(codeBuddyAccounts).map(({ id, name }): ProviderKind => ({
    key: id,
    labelKey: name,
    group: 'subscription'
  })),
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
      'Use an existing Codex profile or sign in with a separate Open-Science profile.',
    group: 'codex'
  },
  {
    // Gets its own subscription section, mirroring the Codex subscription. Supports both shared
    // (browser OAuth via `claude auth login`, uses ~/.claude) and isolated (setup-token paste, uses
    // app-owned config dir). Surfaced only when Claude Code is the active framework.
    key: 'claude-subscription',
    label: claudeIsolatedProviderIdentity().name,
    descriptionKey:
      'Use an existing Claude profile or sign in with a separate Open-Science profile.',
    group: 'claude'
  },
  ...OFFICIAL_VENDORS.map((vendor): ProviderKind => ({
    key: `official:${vendor.id}`,
    label: vendor.label,
    descriptionKey: vendor.supportsAnonymousAccess
      ? 'Free models work without an API key.'
      : 'API key — models provided',
    group: 'api'
  })),
  {
    key: 'custom',
    labelKey: 'Custom Gateway',
    descriptionKey: 'Base URL, key, and model for a Messages or Chat Completions endpoint',
    group: 'other'
  }
]

export type ProviderKindAvailability = {
  // Desktop CodeBuddy accounts; undefined hides them. Listed ids are already added and stay disabled.
  codeBuddyProviders?: readonly string[]
  showCodexSubscriptions?: boolean
  showClaudeIsolated?: boolean
}

// Whether a provider kind is offered for the active framework. The type dropdown and the Add provider
// picker share this so both surfaces list the same kinds.
export const isProviderKindAvailable = (
  kind: ProviderKind,
  { codeBuddyProviders, showCodexSubscriptions, showClaudeIsolated }: ProviderKindAvailability
): boolean => {
  if (codeBuddySiteForId(kind.key) && !codeBuddyProviders) return false
  // Codex and the built-in Agent share the app-owned subscription sign-in.
  if (kind.group === 'codex' && !showCodexSubscriptions) return false
  // The Claude subscription section mirrors it: gate on Claude Code being active, the only
  // framework that speaks the app-owned bearer token.
  if (kind.group === 'claude' && !showClaudeIsolated) return false
  return true
}

// Local model presets are offered as their own provider kinds in the Add provider picker. Each one
// opens a custom gateway seeded with that preset.
export const LOCAL_MODEL_KIND_PREFIX = 'local:'

export const localModelPresetForKindKey = (key: string): LocalModelPreset | undefined =>
  key.startsWith(LOCAL_MODEL_KIND_PREFIX)
    ? LOCAL_MODEL_PRESETS.find((preset) => preset.id === key.slice(LOCAL_MODEL_KIND_PREFIX.length))
    : undefined

// The patch applied to the form value when a provider-kind is picked. Switching to an official vendor
// seeds its default region + model; switching to custom clears vendor-only fields and applies the
// active framework's preferred endpoint.
export const providerKindPatch = (
  key: string,
  customApiEndpoint: ModelProtocol = 'messages'
): Partial<ProviderFormValue> => {
  const reset = {
    codeBuddySite: undefined,
    codeBuddyAuthMode: undefined,
    key: '',
    catalogParameters: undefined,
    vendorId: undefined,
    region: undefined,
    model: '',
    contextWindow: '',
    maxInputTokens: '',
    maxOutputTokens: ''
  }
  const site = codeBuddySiteForId(key)
  if (site)
    return createEmptyProviderFormValue({
      ...reset,
      type: 'codebuddy-subscription',
      codeBuddySite: site,
      name: codeBuddyAccounts[site].name
    })
  if (key === 'codex-subscription') {
    const identity = codexSubscriptionProviderIdentity()
    return {
      ...reset,
      type: 'codex-shared',
      name: identity.name,
      apiEndpoint: 'responses',
      baseUrl: ''
    }
  }

  if (key === 'claude-subscription') {
    const identity = claudeIsolatedProviderIdentity()
    return {
      ...reset,
      type: 'claude-shared',
      name: identity.name,
      apiEndpoint: 'messages',
      baseUrl: ''
    }
  }

  if (key === 'xai-subscription') {
    const identity = xaiSubscriptionProviderIdentity()
    return {
      ...reset,
      type: 'xai-subscription',
      name: identity.name,
      apiEndpoint: 'responses',
      baseUrl: '',
      model: defaultVendorModel('xai') ?? ''
    }
  }

  if (key.startsWith('official:')) {
    const vendorId = key.slice('official:'.length) as OfficialVendorId
    const vendor = getOfficialVendor(vendorId)

    return {
      ...reset,
      type: 'official',
      name: vendor?.label,
      vendorId,
      region: vendor?.regions?.[0]?.id
    }
  }

  const localPreset = localModelPresetForKindKey(key)
  if (localPreset) {
    return {
      ...reset,
      type: 'custom',
      name: localPreset.label,
      baseUrl: localPreset.baseUrl,
      apiEndpoint: 'chat-completions'
    }
  }

  return {
    ...reset,
    type: 'custom',
    apiEndpoint: customApiEndpoint
  }
}

// Maps the current form value back to its provider-kind key (the dropdown's selected value).
export const selectedKindKey = (value: ProviderFormValue): string => {
  if (value.type === 'codebuddy-subscription' && value.codeBuddySite)
    return codeBuddyAccounts[value.codeBuddySite].id
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
