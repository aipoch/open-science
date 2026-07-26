import { resolveVendorModelReasoningEffort, type OfficialVendorId } from './provider-registry'
import {
  resolveReasoningEffortProfile,
  type ReasoningEffortPresetSetting,
  type ReasoningEffortProfile
} from './reasoning-effort'
import type { ProviderType } from './settings'

export type ProviderReasoningEffortSource = {
  type: ProviderType
  vendorId?: OfficialVendorId
  reasoningEffortPreset?: ReasoningEffortPresetSetting
}

// Keeps a safe runtime fallback for malformed persisted data while making a newly-added ProviderType
// fail type checking until its effort-profile behavior is explicitly defined below.
const unsupportedProviderType = (providerType: never): ReasoningEffortProfile => {
  void providerType
  return { supported: false }
}

// Resolves the static effort capability shared by settings execution and renderer controls. The
// selected model owns the visible vocabulary; subscriptions alias their vendor catalogs, while an
// unpinned Codex subscription stays unknown until the runtime model is explicit.
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
      return resolveVendorModelReasoningEffort('anthropic', model)
    case 'custom':
      return resolveReasoningEffortProfile(provider.reasoningEffortPreset)
  }

  return unsupportedProviderType(providerType)
}
