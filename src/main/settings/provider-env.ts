import { join } from 'node:path'

import type { ProviderApiType, ProviderType } from '../../shared/settings'
import { normalizeAnthropicBaseUrl } from './base-url'

// Resolves an active provider into the environment overrides that the ACP agent (and the claude
// binary it spawns) read. Pure and free of Electron so the branch matrix stays unit-testable.

// A provider resolved for spawning: the plaintext key is already decrypted by the caller.
export type ResolvedProvider = {
  type: ProviderType
  baseUrl?: string
  model?: string
  key?: string
  // Which chat API the endpoint speaks; opencode uses it to pick the anthropic vs openai-compatible
  // provider. Absent ⇒ anthropic.
  apiType?: ProviderApiType
}

export type ProviderEnvOptions = {
  // App storage root; every provider runs under one app-owned CLAUDE_CONFIG_DIR beneath it.
  storageRoot: string
  // Absolute path to the detected claude executable.
  claudeExecutablePath: string
}

// The single app-owned config directory every provider uses. Stable across provider switches so claude
// keeps one session store, its skills/plugins/commands, and auth — instead of toggling between the
// user's ~/.claude and a per-provider isolated dir (which lost history and customizations on switch).
const getAppClaudeConfigDir = (storageRoot: string): string => join(storageRoot, 'claude')

// Builds spawn env overrides for one provider. All providers share the app-owned CLAUDE_CONFIG_DIR;
// a provider only supplies credentials (endpoint / token / model). The "local" (claude-default)
// provider supplies none here — it relies on the auth imported into the app dir. Empty/omitted fields
// are simply not set so callers can merge this over process.env without erasing unrelated variables.
const buildProviderEnv = (
  provider: ResolvedProvider,
  { storageRoot, claudeExecutablePath }: ProviderEnvOptions
): Record<string, string> => {
  const env: Record<string, string> = {
    CLAUDE_CODE_EXECUTABLE: claudeExecutablePath,
    CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot)
  }

  // Model applies to both types (required for custom, optional override for local).
  if (provider.model) env.ANTHROPIC_MODEL = provider.model

  if (provider.type === 'custom') {
    // The base URL is normalized so a user-supplied trailing `/v1` isn't doubled by the client's own
    // `/v1/messages` suffix (which would 404). Custom gateways authenticate with a bearer token.
    if (provider.baseUrl) {
      const baseUrl = normalizeAnthropicBaseUrl(provider.baseUrl)

      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
    }

    if (provider.key) env.ANTHROPIC_AUTH_TOKEN = provider.key
  }

  // claude-default (local): no endpoint/token injected here — it uses the auth stored in the app dir
  // (imported from ~/.claude, or written by an in-app `claude login`).

  return env
}

export { buildProviderEnv, getAppClaudeConfigDir }
