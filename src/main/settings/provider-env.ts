import { join } from 'node:path'
import { homedir } from 'node:os'

import type { ChatApiEndpoint, ProviderType } from '../../shared/settings'
import { normalizeAnthropicBaseUrl } from './base-url'

// Resolves an active provider into the environment overrides that the ACP agent (and the claude
// binary it spawns) read. Pure and free of Electron so the branch matrix stays unit-testable.

// A provider resolved for spawning: the plaintext key is already decrypted by the caller.
export type ResolvedProvider = {
  type: ProviderType
  // Anthropic /v1/messages base (also the sole base for a custom provider). Claude always uses this.
  baseUrl?: string
  // Distinct OpenAI /v1/chat/completions base for a dual-endpoint vendor (e.g. DeepSeek). Used only
  // when the chosen endpoint is openai; falls back to baseUrl when absent.
  openaiBaseUrl?: string
  model?: string
  // Context limit for the selected model. Framework adapters that register custom model ids (notably
  // OpenCode) must include this metadata or the framework cannot report context usage over ACP.
  contextWindow?: number
  key?: string
  // Which chat APIs the endpoint speaks; opencode uses this to pick anthropic vs openai-compatible.
  // Absent ⇒ ['anthropic'].
  apiEndpoints?: readonly ChatApiEndpoint[]
  // Whether the active model accepts image input. opencode strips image parts for a custom/registered
  // model whose config does not declare vision, so this is surfaced into its per-model capabilities.
  supportsImageInput?: boolean
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

// The user's default ~/.claude directory, used by claude-shared to satisfy the CLAUDE_CONFIG_DIR
// guard in agent-process.ts while still reading credentials from the standard location.
const getUserClaudeConfigDir = (): string => join(homedir(), '.claude')

// Builds spawn env overrides for one provider. All providers share the app-owned CLAUDE_CONFIG_DIR;
// a provider only supplies credentials (endpoint / token / model). Empty/omitted fields are simply
// not set so callers can merge this over process.env without erasing unrelated variables.
//
// Exception: claude-shared uses the default ~/.claude (no CLAUDE_CONFIG_DIR override), mirroring how
// codex-shared uses the default CODEX_HOME.
const buildProviderEnv = (
  provider: ResolvedProvider,
  { storageRoot, claudeExecutablePath }: ProviderEnvOptions
): Record<string, string> => {
  const env: Record<string, string> = {
    CLAUDE_CODE_EXECUTABLE: claudeExecutablePath
  }

  // agent-process.ts throws if CLAUDE_CONFIG_DIR is absent — it refuses to start outside a known
  // config dir to prevent silent credential leaks. For claude-shared we satisfy the guard with the
  // user's real ~/.claude, so the spawned agent reads the shared credentials already stored there.
  if (provider.type === 'claude-shared') {
    env.CLAUDE_CONFIG_DIR = getUserClaudeConfigDir()
  } else {
    env.CLAUDE_CONFIG_DIR = getAppClaudeConfigDir(storageRoot)
  }

  if (provider.model) env.ANTHROPIC_MODEL = provider.model

  if (provider.type === 'custom') {
    // The base URL is normalized so a user-supplied trailing `/v1` isn't doubled by the client's own
    // `/v1/messages` suffix (which would 404). Custom gateways authenticate with a bearer token.
    if (provider.baseUrl) {
      const baseUrl = normalizeAnthropicBaseUrl(provider.baseUrl)

      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl
    }

    if (provider.key) env.ANTHROPIC_AUTH_TOKEN = provider.key
  } else if (provider.type === 'claude-isolated') {
    // claude-isolated: a long-lived OAuth token (from `claude setup-token`) injected as the bearer
    // Claude Code reads under an explicit CLAUDE_CONFIG_DIR. The token is portable across config
    // dirs and platforms, so isolation comes from the app-owned config dir + this one env var — no
    // ~/.claude touch, no OS credential store.
    if (provider.key) env.CLAUDE_CODE_OAUTH_TOKEN = provider.key
  }
  // claude-shared: no explicit token injection; the ~/.claude profile (managed by `claude auth
  // login`) holds the credentials. Claude Code reads them from there.

  return env
}

export { buildProviderEnv, getAppClaudeConfigDir, getUserClaudeConfigDir }
