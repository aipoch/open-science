import {
  claudeIsolatedProviderIdentity,
  codexSubscriptionProviderIdentity,
  type AgentFrameworkId,
  type ChatApiEndpoint,
  type ProviderType
} from '../../../../shared/settings'
import {
  OFFICIAL_VENDORS,
  getOfficialVendor,
  type OfficialVendorId
} from '../../../../shared/provider-registry'

// Editable value for the provider form, kept in its own module so the component file only exports a
// component (satisfying react-refresh) while the wizard and settings page share this shape/factory.
export type ProviderFormValue = {
  type: ProviderType
  name: string
  baseUrl: string
  model: string
  // Kept as text so an empty optional numeric input remains distinct from the 200k runtime default.
  contextWindow: string
  // Which chat API a custom gateway speaks; drives which agent frameworks can use it. Defaults to
  // 'anthropic'. A custom provider serves exactly one endpoint (official providers take theirs from
  // the registry); it is stored as the single-entry apiEndpoints array.
  apiEndpoint: ChatApiEndpoint
  supportsImageInput: boolean
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
  name: '',
  baseUrl: '',
  model: '',
  contextWindow: '',
  apiEndpoint: 'anthropic',
  supportsImageInput: false,
  key: '',
  ...overrides
})

// The provider kind pre-selected when the Add provider form opens, matched to the active agent
// framework's most common official vendor: Claude Code → Anthropic, Codex → OpenAI,
// OpenCode → DeepSeek. Exhaustive over AgentFrameworkId so a new framework forces a deliberate
// choice, and keyed off OfficialVendorId so a registry rename fails at compile time.
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
export type ProviderFormErrors = {
  baseUrl?: string
  contextWindow?: string
  key?: string
  model?: string
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
    if (value.contextWindow.trim()) {
      const contextWindow = Number(value.contextWindow)
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
        errors.contextWindow = 'Context window must be a positive whole number of tokens.'
      }
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
export type ProviderKindGroup = 'codex' | 'claude' | 'api' | 'other'

// Group headers shown in the provider-type picker and dropdown, in display order. The two
// subscription groups mirror each other: only the one matching the active framework is rendered.
export const PROVIDER_KIND_GROUPS: { id: ProviderKindGroup; label: string }[] = [
  { id: 'codex', label: 'Codex subscription' },
  { id: 'claude', label: 'Claude subscription' },
  { id: 'api', label: 'Official API' },
  { id: 'other', label: 'Other' }
]

// A selectable option in the provider-type dropdown. Official vendors are keyed `official:<vendorId>`.
export type ProviderKind = {
  key: string
  label: string
  description: string
  group: ProviderKindGroup
}

export const PROVIDER_KINDS: ProviderKind[] = [
  {
    key: 'codex-subscription',
    label: codexSubscriptionProviderIdentity().name,
    description: 'Use an existing Codex profile or sign in with a separate Open Science profile.',
    group: 'codex'
  },
  {
    // Gets its own subscription section, mirroring the Codex subscription. Supports both shared
    // (browser OAuth via `claude auth login`, uses ~/.claude) and isolated (setup-token paste, uses
    // app-owned config dir). Surfaced only when Claude Code is the active framework.
    key: 'claude-subscription',
    label: claudeIsolatedProviderIdentity().name,
    description: 'Use an existing Claude profile or sign in with a separate Open Science profile.',
    group: 'claude'
  },
  ...OFFICIAL_VENDORS.map((vendor): ProviderKind => ({
    key: `official:${vendor.id}`,
    label: vendor.label,
    description: 'API key — models provided',
    group: 'api'
  })),
  {
    key: 'custom',
    label: 'Custom Gateway',
    description: 'Base URL, key, and model for a Messages or Chat Completions endpoint',
    group: 'other'
  }
]

// The patch applied to the form value when a provider-kind is picked. Switching to an official vendor
// seeds its default region + model; switching away clears vendor-only fields.
export const providerKindPatch = (key: string): Partial<ProviderFormValue> => {
  if (key === 'codex-subscription') {
    const identity = codexSubscriptionProviderIdentity()
    return {
      type: 'codex-shared',
      name: identity.name,
      apiEndpoint: 'responses',
      baseUrl: '',
      model: '',
      contextWindow: '',
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
      contextWindow: ''
    }
  }

  return { type: 'custom', vendorId: undefined, region: undefined, model: '', contextWindow: '' }
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
        : type
