import { resolveVendorModelReasoningEffort, type OfficialVendorId } from './provider-registry'
import {
  resolveReasoningEffortProfile,
  type ReasoningEffortPresetSetting,
  type ReasoningEffortProfile
} from './reasoning-effort'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  type ProviderType
} from './settings'

export type ProviderReasoningEffortSource = {
  type: ProviderType
  vendorId?: OfficialVendorId
  model?: string
  models?: readonly string[]
  reasoningEffortPreset?: ReasoningEffortPresetSetting
}

// Resolves the effective selection with the same rules in main and renderer. Subscription runtimes
// keep an omitted selection unknown because the account/CLI owns its default model. A saved Claude
// override remains explicit; other providers fall back through their saved default and catalog.
export const resolveProviderEffectiveModel = (
  provider: ProviderReasoningEffortSource | undefined,
  requestedModel: string | undefined
): string | undefined => {
  if (!provider) return undefined

  const availableModels = provider.models ?? []
  if (
    requestedModel &&
    (availableModels.length === 0 || availableModels.includes(requestedModel))
  ) {
    return requestedModel
  }
  if (isCodexSubscriptionProvider(provider.type)) return undefined
  if (
    provider.model &&
    (availableModels.length === 0 || availableModels.includes(provider.model))
  ) {
    return provider.model
  }
  if (isClaudeSubscriptionProvider(provider.type)) return undefined

  return availableModels[0] ?? provider.model
}

// Keeps a safe runtime fallback for malformed persisted data while making a newly-added ProviderType
// fail type checking until its effort-profile behavior is explicitly defined below.
const unsupportedProviderType = (providerType: never): ReasoningEffortProfile => {
  void providerType
  return { supported: false }
}

// Resolves the static effort capability shared by settings execution and renderer controls. The
// selected model owns the visible vocabulary; subscriptions alias their vendor catalogs only after
// a model is pinned, while an account/CLI-owned default stays unknown.
export const resolveProviderReasoningEffortProfile = (
  provider: ProviderReasoningEffortSource | undefined,
  model: string | undefined
): ReasoningEffortProfile => {
  // The settings control stays useful before a provider is configured, matching the custom-model
  // compatibility default. Main-side execution still returns `default` before calling this resolver
  // when no active provider exists.
  if (!provider) return resolveReasoningEffortProfile(undefined)

  const providerType = provider.type

  switch (providerType) {
    case 'official':
      return provider.vendorId
        ? resolveVendorModelReasoningEffort(provider.vendorId, model)
        : { supported: false }
    case 'codex-shared':
    case 'codex-isolated':
      return model ? resolveVendorModelReasoningEffort('openai', model) : { supported: false }
    case 'claude-shared':
    case 'claude-isolated':
      return model ? resolveVendorModelReasoningEffort('anthropic', model) : { supported: false }
    case 'custom':
      return resolveReasoningEffortProfile(provider.reasoningEffortPreset)
  }

  return unsupportedProviderType(providerType)
}
