import {
  providerValidationFailed,
  providerValidationSucceeded,
  type AgentFrameworkId,
  type ProviderValidationTarget,
  type ReadinessPreflight
} from '../../shared/settings'
import type { StoredProvider, StoredSettings } from './types'

// Pure computation of the startup gates from stored settings plus a couple of injected checks.
// Kept free of Electron so the gating matrix is unit-testable in isolation.

export type PreflightInput = {
  settings: StoredSettings
  // Whether the recorded claude executable still exists/executes (light re-check each launch).
  claudePathExists: boolean
  // Whether the recorded opencode executable still exists (same light re-check).
  opencodePathExists: boolean
  codebuddyPathExists: boolean
  // Whether the recorded codex-acp adapter still reports a version.
  codexPathExists: boolean
  // The selected framework, resolved (default applied) by the caller.
  agentFrameworkId: AgentFrameworkId
  // Whether a provider's current credentials are usable (subscription auth is checked by its owner;
  // custom credentials must still decrypt).
  isProviderKeyUsable: (provider: StoredProvider) => boolean
  // Whether the active provider can actually drive the selected framework (endpoint + provider-type
  // compatibility). Resolved by the caller, which has the vendor registry to derive official apiTypes.
  activeProviderCompatible: boolean
  activeProviderModelAvailable: boolean
  activeValidationTarget?: ProviderValidationTarget
}

// Applies the design's gating rules: the selected framework's binary must be present, and an active
// provider must exist, have validated at least once, and have usable credentials. Per-framework
// readiness re-checks the stored path each call, so a binary deleted after onboarding flips to unready.
const computePreflight = ({
  settings,
  claudePathExists,
  opencodePathExists,
  codebuddyPathExists,
  codexPathExists,
  agentFrameworkId,
  isProviderKeyUsable,
  activeProviderCompatible,
  activeProviderModelAvailable,
  activeValidationTarget
}: PreflightInput): ReadinessPreflight => {
  const claudeReady = Boolean(settings.claude?.resolvedPath) && claudePathExists
  const opencodeReady = Boolean(settings.opencodePath) && opencodePathExists
  const codebuddyReady = Boolean(settings.codebuddyPath) && codebuddyPathExists
  const codexReady = Boolean(settings.codex?.resolvedPath) && codexPathExists
  const readyByFramework: Record<AgentFrameworkId, boolean> = {
    'claude-code': claudeReady,
    opencode: opencodeReady,
    codex: codexReady,
    codebuddy: codebuddyReady
  }
  const agentReady = readyByFramework[agentFrameworkId]
  const runtimeConfiguredByFramework: Record<AgentFrameworkId, boolean> = {
    'claude-code': Boolean(settings.claude?.resolvedPath),
    opencode: Boolean(settings.opencodePath),
    codex: Boolean(settings.codex?.resolvedPath),
    codebuddy: Boolean(settings.codebuddyPath)
  }
  const runtimeReadiness = {
    status: agentReady
      ? ('ready' as const)
      : runtimeConfiguredByFramework[agentFrameworkId]
        ? ('not_ready' as const)
        : ('missing' as const)
  }

  const activeProvider = settings.activeProviderId
    ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
    : undefined

  // "Ready" also requires the active provider to be able to drive the selected framework, so an
  // incompatible pair (e.g. OpenCode + a Codex-only provider) is never marked ready.
  const activeProviderValidationFailed = Boolean(
    activeProvider && providerValidationFailed(activeProvider, activeValidationTarget)
  )
  const validationFailureCategory = activeProviderValidationFailed
    ? activeProvider?.lastValidationFailure?.category
    : undefined
  const validationFailureReason =
    validationFailureCategory === 'auth'
      ? ('credential_invalid' as const)
      : validationFailureCategory === 'ok'
        ? undefined
        : validationFailureCategory
  const activeProviderKeyUsable = Boolean(activeProvider && isProviderKeyUsable(activeProvider))
  const activeProviderReady = Boolean(
    activeProvider &&
    (activeValidationTarget
      ? providerValidationSucceeded(activeProvider, activeValidationTarget)
      : activeProvider.lastValidatedAt !== undefined &&
        !providerValidationFailed(activeProvider)) &&
    activeProviderKeyUsable &&
    activeProviderModelAvailable &&
    activeProviderCompatible
  )
  const providerReason =
    activeProvider && (validationFailureReason === 'credential_invalid' || !activeProviderKeyUsable)
      ? ('credential_invalid' as const)
      : activeProvider && validationFailureReason
        ? validationFailureReason
        : activeProvider && !activeProviderModelAvailable
          ? ('model-not-found' as const)
          : activeProvider && !activeProviderCompatible
            ? ('incompatible' as const)
            : undefined
  const providerReadiness = activeProviderReady
    ? ({ status: 'ready' } as const)
    : !activeProvider
      ? ({ status: 'missing' } as const)
      : ({ status: 'not_ready', ...(providerReason ? { reason: providerReason } : {}) } as const)

  return {
    claudeReady,
    opencodeReady,
    codebuddyReady,
    codexReady,
    agentFrameworkId,
    agentReady,
    activeProviderReady,
    runtimeReadiness,
    providerReadiness
  }
}

export { computePreflight }
