import type { Preflight } from '../../shared/settings'
import type { StoredProvider, StoredSettings } from './types'

// Pure computation of the two startup gates from stored settings plus a couple of injected checks.
// Kept free of Electron so the gating matrix is unit-testable in isolation.

export type PreflightInput = {
  settings: StoredSettings
  // Whether the recorded claude executable still exists/executes (light re-check each launch).
  claudePathExists: boolean
  // Whether a provider's credentials are usable (claude-default is always true; custom must decrypt).
  isProviderKeyUsable: (provider: StoredProvider) => boolean
}

// Applies the design's gating rules: claude must be present, and an active provider must exist,
// have validated at least once, and have usable credentials.
const computePreflight = ({
  settings,
  claudePathExists,
  isProviderKeyUsable
}: PreflightInput): Preflight => {
  const claudeReady = Boolean(settings.claude?.resolvedPath) && claudePathExists

  const activeProvider = settings.activeProviderId
    ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
    : undefined

  const activeProviderReady = Boolean(
    activeProvider &&
    activeProvider.lastValidatedAt !== undefined &&
    isProviderKeyUsable(activeProvider)
  )

  return { claudeReady, activeProviderReady }
}

export { computePreflight }
