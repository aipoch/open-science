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
  // Timestamp of first-run onboarding completion; undefined until it finishes at least once.
  onboardingCompletedAt?: number
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
export type ClaudeInstallSource = 'npm' | 'official-script'

// Static, non-secret description of an install source shown in the UI (command is copyable).
export type ClaudeInstallSourceInfo = {
  id: ClaudeInstallSource
  label: string
  // Human-readable command shown in the UI and safe to copy/paste.
  displayCommand: string
  // Whether this source needs npm on PATH (drives default selection + disabled state).
  requiresNpm: boolean
}

// The ordered install sources for a given host platform; a plain global npm install is the default
// when npm is available. The npm command is identical everywhere, but the official installer differs:
// Windows uses the PowerShell script (install.ps1), other platforms use the shell script (install.sh).
// Pass the host platform (e.g. `window.api.platform`) so the copyable command matches what runs.
export const getClaudeInstallSources = (platform: string = 'linux'): ClaudeInstallSourceInfo[] => {
  const isWindows = platform === 'win32'

  return [
    {
      id: 'npm',
      label: 'npm (global install)',
      displayCommand: 'npm i -g @anthropic-ai/claude-code',
      requiresNpm: true
    },
    {
      id: 'official-script',
      label: isWindows ? 'Official install.ps1' : 'Official install.sh',
      displayCommand: isWindows
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash',
      requiresNpm: false
    }
  ]
}

// Guidance for installing Node.js (which bundles npm) when the npm install source is unavailable.
// The npm path to install claude needs Node present first; a non-developer often won't have it.
export type NodeInstallHint = {
  // Copyable one-line install command for this platform, when a reliable one exists.
  command?: string
  // Official download page for a manual (GUI) installer — always available as a fallback.
  url: string
}

// Returns how to install Node.js on the given host platform. Windows uses winget (built into Windows
// 10/11); macOS suggests Homebrew; Linux is too distro-specific for a single command, so only the
// download page is offered. The installer bundles npm in every case.
export const getNodeInstallHint = (platform: string = 'linux'): NodeInstallHint => {
  if (platform === 'win32') {
    return { command: 'winget install OpenJS.NodeJS.LTS', url: 'https://nodejs.org/en/download' }
  }

  if (platform === 'darwin') {
    return { command: 'brew install node', url: 'https://nodejs.org/en/download' }
  }

  return { url: 'https://nodejs.org/en/download' }
}

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

// Availability of npm on the host, used to gate the npm source.
export type NpmAvailability = {
  available: boolean
}
