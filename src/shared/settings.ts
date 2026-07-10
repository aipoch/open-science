// Shared model-settings & onboarding types crossing the main <-> renderer IPC boundary.
//
// The main process owns settings.json and all secret material. The renderer only ever receives the
// masked provider view (never keyRef or plaintext keys) and sends drafts that carry a plaintext key
// only while the user is actively typing one in.

// Settings file schema version; bumped when the on-disk shape changes.
export const SETTINGS_FILE_VERSION = 1

// A provider either targets a custom Anthropic-compatible gateway or reuses the local claude auth.
export type ProviderType = 'custom' | 'claude-default'

// Detected claude executable metadata, persisted so later spawns skip re-detection.
export type ClaudeInfo = {
  resolvedPath?: string
  version?: string
}

// Result of probing the machine for a runnable claude executable.
export type ClaudeDetectResult = {
  found: boolean
  path?: string
  version?: string
}

// Renderer-facing provider view: masked and stripped of every secret field.
export type ProviderView = {
  id: string
  type: ProviderType
  name: string
  baseUrl?: string
  model?: string
  // A short, non-secret hint like "sk-…abcd" for display only.
  maskedKey?: string
  // True when a key is stored (custom providers). Lets the form show "leave blank to keep".
  hasKey: boolean
  // True when a stored key could not be decrypted and must be re-entered before use.
  needsKey: boolean
  lastValidatedAt?: number
}

// Full renderer snapshot of settings state.
export type SettingsSnapshot = {
  claude: ClaudeInfo
  activeProviderId?: string
  providers: ProviderView[]
}

// The two hard startup gates. Kept as plain booleans so the wizard can target the first unmet step.
export type Preflight = {
  claudeReady: boolean
  activeProviderReady: boolean
}

// A provider draft as entered in the renderer form. The plaintext `key` is present only when the user
// typed a new one; leaving it undefined on edit keeps the previously stored key.
export type ProviderDraft = {
  type: ProviderType
  name?: string
  baseUrl?: string
  model?: string
  key?: string
}

// Create/update request: an existing `id` edits in place, otherwise a new provider is created.
export type UpsertProviderRequest = ProviderDraft & {
  id?: string
}

export type DeleteProviderRequest = {
  id: string
}

export type SetActiveProviderRequest = {
  id: string
}

// Validation may target a saved provider (key resolved from storage) or an unsaved draft.
export type ValidateProviderRequest = {
  providerId?: string
  draft?: ProviderDraft
}

// Structured validation outcome so the renderer can render an actionable message per category.
export type ValidationCategory =
  'ok' | 'network' | 'auth' | 'model-not-found' | 'bad-url' | 'timeout' | 'unknown'

export type ValidateProviderResult = {
  ok: boolean
  category: ValidationCategory
  status?: number
  message?: string
}

// Selectable install sources for the one-click claude installer.
export type ClaudeInstallSource = 'npm-mirror' | 'official-script'

// Static, non-secret description of an install source shown in the UI (command is copyable).
export type ClaudeInstallSourceInfo = {
  id: ClaudeInstallSource
  label: string
  // Human-readable command shown in the UI and safe to copy/paste.
  displayCommand: string
  // Whether this source needs npm on PATH (drives default selection + disabled state).
  requiresNpm: boolean
}

// The ordered install sources; npm mirror is the mainland-friendly default.
export const CLAUDE_INSTALL_SOURCES: ClaudeInstallSourceInfo[] = [
  {
    id: 'npm-mirror',
    label: 'npm + China mirror',
    displayCommand: 'npm i -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com',
    requiresNpm: true
  },
  {
    id: 'official-script',
    label: 'Official install.sh',
    displayCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    requiresNpm: false
  }
]

export type InstallClaudeRequest = {
  source: ClaudeInstallSource
}

// One streamed line of installer output. `installId` groups a single install run.
export type ClaudeInstallLogEvent = {
  installId: string
  stream: 'stdout' | 'stderr' | 'system'
  chunk: string
}

// Final result of an install run; on success the caller re-detects claude.
export type ClaudeInstallResult = {
  installId: string
  ok: boolean
  exitCode?: number
  timedOut?: boolean
  error?: string
}

// Availability of npm on the host, used to gate the npm-mirror source.
export type NpmAvailability = {
  available: boolean
}
