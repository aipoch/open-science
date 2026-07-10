import { join } from 'node:path'

import type { ProviderType } from '../../shared/settings'
import { normalizeAnthropicBaseUrl } from './base-url'

// Resolves an active provider into the environment overrides that the ACP agent (and the claude
// binary it spawns) read. Pure and free of Electron so the branch matrix stays unit-testable.

// A provider resolved for spawning: the plaintext key is already decrypted by the caller.
export type ResolvedProvider = {
  type: ProviderType
  baseUrl?: string
  model?: string
  key?: string
}

export type ProviderEnvOptions = {
  // App storage root; custom providers get an isolated CLAUDE_CONFIG_DIR beneath it.
  storageRoot: string
  // Absolute path to the detected claude executable.
  claudeExecutablePath: string
}

// The private config directory a custom provider uses so app runs never touch (or inherit) the
// user's own ~/.claude auth. claude-default deliberately omits this to reuse the user's config.
const getIsolatedClaudeConfigDir = (storageRoot: string): string => join(storageRoot, 'claude')

// Builds spawn env overrides for one provider. Empty/omitted fields are simply not set so callers
// can merge this over process.env without erasing unrelated variables.
const buildProviderEnv = (
  provider: ResolvedProvider,
  { storageRoot, claudeExecutablePath }: ProviderEnvOptions
): Record<string, string> => {
  const env: Record<string, string> = {
    CLAUDE_CODE_EXECUTABLE: claudeExecutablePath
  }

  // claude-default reuses the user's own ~/.claude auth: only an optional model override applies.
  if (provider.type === 'claude-default') {
    if (provider.model) env.ANTHROPIC_MODEL = provider.model

    return env
  }

  // custom providers are fully isolated: gateway URL, key, model, and a private config directory.
  // The base URL is normalized so a user-supplied trailing `/v1` isn't doubled by the client's own
  // `/v1/messages` suffix (which would 404).
  if (provider.baseUrl) {
    const baseUrl = normalizeAnthropicBaseUrl(provider.baseUrl)

    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
  }

  // Custom gateways authenticate with a bearer token (ANTHROPIC_AUTH_TOKEN).
  if (provider.key) env.ANTHROPIC_AUTH_TOKEN = provider.key

  if (provider.model) env.ANTHROPIC_MODEL = provider.model

  env.CLAUDE_CONFIG_DIR = getIsolatedClaudeConfigDir(storageRoot)

  return env
}

export { buildProviderEnv, getIsolatedClaudeConfigDir }
