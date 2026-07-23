import {
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
// and model come from the registry); claude-default has no required fields.
export type ProviderFormErrors = {
  baseUrl?: string
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
    if (!value.key.trim() && !options.hasStoredKey) errors.key = 'API key is required.'
  } else if (value.type === 'official') {
    // No model is chosen at add time: the vendor catalog + the global model selection cover that.
    if (!value.key.trim() && !options.hasStoredKey) errors.key = 'API key is required.'
  }

  return errors
}

// True when a draft has at least one required-field error (blocks save/test).
export const hasProviderFormErrors = (errors: ProviderFormErrors): boolean =>
  Object.keys(errors).length > 0

// Grouping for the provider-type picker. 'api' = official vendors via their standard API key;
// 'other' = the custom gateway and local Claude. ('coding' — subscription coding plans — is reserved
// for once those endpoints are wired up.)
export type ProviderKindGroup = 'coding' | 'api' | 'other'

// Group headers shown in the provider-type picker and dropdown, in display order. ('coding' is
// reserved for subscription coding-plan endpoints once those are wired up.)
export const PROVIDER_KIND_GROUPS: { id: ProviderKindGroup; label: string }[] = [
  { id: 'coding', label: 'Codex subscription' },
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
    group: 'coding'
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
  },
  {
    key: 'claude-default',
    label: 'Local Claude',
    description: "Reuse this machine's Claude login",
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
      key: '',
      vendorId: undefined,
      region: undefined
    }
  }

  if (key === 'claude-default') {
    return { type: 'claude-default', vendorId: undefined, region: undefined, model: '' }
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
      model: ''
    }
  }

  return { type: 'custom', vendorId: undefined, region: undefined, model: '' }
}

// Maps the current form value back to its provider-kind key (the dropdown's selected value).
export const selectedKindKey = (value: ProviderFormValue): string => {
  if (value.type === 'custom') {
    return 'custom'
  }
  if (value.type === 'claude-default') return 'claude-default'
  if (value.type === 'codex-shared' || value.type === 'codex-isolated') {
    return 'codex-subscription'
  }

  return value.vendorId ? `official:${value.vendorId}` : 'custom'
}

// Maps a provider's type + vendor to its icon key ('custom' | 'claude-default' | 'official:<id>').
export const providerKindKey = (type: ProviderType, vendorId?: OfficialVendorId): string =>
  type === 'official' && vendorId
    ? `official:${vendorId}`
    : type === 'codex-shared' || type === 'codex-isolated'
      ? 'codex-subscription'
      : type
