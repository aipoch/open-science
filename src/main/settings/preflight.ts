import {
  providerValidationFailed,
  type AgentFrameworkId,
  type Preflight
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
  // Whether the recorded codex-acp adapter still reports a version.
  codexPathExists: boolean
  // The selected framework, resolved (default applied) by the caller.
  agentFrameworkId: AgentFrameworkId
  // Whether a provider's credentials are usable (claude-default is always true; custom must decrypt).
  isProviderKeyUsable: (provider: StoredProvider) => boolean
  // Whether the active provider can actually drive the selected framework (endpoint + provider-type
  // compatibility). Resolved by the caller, which has the vendor registry to derive official apiTypes.
  activeProviderCompatible: boolean
}

// Applies the design's gating rules: the selected framework's binary must be present, and an active
// provider must exist, have validated at least once, and have usable credentials. Per-framework
// readiness re-checks the stored path each call, so a binary deleted after onboarding flips to unready.
const computePreflight = ({
  settings,
  claudePathExists,
  opencodePathExists,
  codexPathExists,
  agentFrameworkId,
  isProviderKeyUsable,
  activeProviderCompatible
}: PreflightInput): Preflight => {
  const claudeReady = Boolean(settings.claude?.resolvedPath) && claudePathExists
  const opencodeReady = Boolean(settings.opencodePath) && opencodePathExists
  const codexReady = Boolean(settings.codex?.resolvedPath) && codexPathExists
  const readyByFramework: Record<AgentFrameworkId, boolean> = {
    'claude-code': claudeReady,
    opencode: opencodeReady,
    codex: codexReady
  }
  const agentReady = readyByFramework[agentFrameworkId]

  const activeProvider = settings.activeProviderId
    ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
    : undefined

  // "Ready" also requires the active provider to be able to drive the selected framework, so an
  // incompatible pair (e.g. OpenCode + a Local Claude provider) is never marked ready.
  const activeProviderReady = Boolean(
    activeProvider &&
    activeProvider.lastValidatedAt !== undefined &&
    !providerValidationFailed(activeProvider) &&
    isProviderKeyUsable(activeProvider) &&
    activeProviderCompatible
  )

  return {
    claudeReady,
    opencodeReady,
    codexReady,
    agentFrameworkId,
    agentReady,
    activeProviderReady
  }
}

export { computePreflight }
