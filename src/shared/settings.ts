// Shared model-settings & onboarding types crossing the main <-> renderer IPC boundary.
//
// The main process owns settings.json and all secret material. The renderer only ever receives the
// masked provider view (never keyRef or plaintext keys) and sends drafts that carry a plaintext key
// only while the user is actively typing one in.

import type { OfficialVendorId } from './provider-registry'

// Settings file schema version; bumped when the on-disk shape changes. v2 adds official-vendor
// providers (vendorId/region) and a per-selection activeModel alongside activeProviderId.
export const SETTINGS_FILE_VERSION = 2

// A provider targets a custom Anthropic-compatible gateway, a built-in official vendor (base URL +
// model catalog from the registry), or reuses the local claude auth.
export type ProviderType = 'custom' | 'claude-default' | 'official'

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

// A recorded failed validation, kept so the list can flag a provider as unverified and say why
// (e.g. "auth failed"). Cleared whenever a later validation of the same credentials succeeds.
export type ProviderValidationFailure = {
  at: number
  category: ValidationCategory
  status?: number
  message?: string
}

// Renderer-facing provider view: masked and stripped of every secret field.
export type ProviderView = {
  id: string
  type: ProviderType
  name: string
  baseUrl?: string
  model?: string
  // Set for official-vendor providers: which vendor and (where applicable) which regional endpoint.
  vendorId?: OfficialVendorId
  region?: string
  // Models selectable for this provider in the composer: the vendor catalog for official providers,
  // or the single configured model for custom/claude-default. Derived from the registry in main.
  models: string[]
  // A short, non-secret hint like "sk-…abcd" for display only.
  maskedKey?: string
  // True when a key is stored (custom/official providers). Lets the form show "leave blank to keep".
  hasKey: boolean
  // True when a stored key could not be decrypted and must be re-entered before use.
  needsKey: boolean
  lastValidatedAt?: number
  // Present when the most recent validation failed and no later one has succeeded. Drives the
  // "unverified" warning in the provider list.
  lastValidationFailure?: ProviderValidationFailure
}

// True when a provider's most recent validation failed (and no later one succeeded). A failed
// provider is flagged in the settings list and excluded from the model pickers, so it can't be
// picked as a model source until it passes a test. Shared by main and renderer for one rule.
export const providerValidationFailed = (provider: {
  lastValidatedAt?: number
  lastValidationFailure?: ProviderValidationFailure
}): boolean =>
  provider.lastValidationFailure !== undefined &&
  (provider.lastValidatedAt === undefined ||
    provider.lastValidationFailure.at >= provider.lastValidatedAt)

// Full renderer snapshot of settings state.
export type SettingsSnapshot = {
  claude: ClaudeInfo
  activeProviderId?: string
  // The active model within the active provider. For custom/claude-default this mirrors the provider's
  // own model; for official providers it's the chosen catalog entry. Undefined until a provider exists.
  activeModel?: string
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
  // Set when type is 'official': the chosen vendor and (where applicable) region. Base URL and model
  // catalog then come from the registry rather than the draft's baseUrl.
  vendorId?: OfficialVendorId
  region?: string
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
  // Optional model to activate within the provider. Omitted (e.g. selecting a provider without a
  // specific model) falls back to the provider's default: its stored model or the vendor's first
  // catalog entry.
  model?: string
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

// Request to refresh a saved provider's model list from the vendor's live API (fills the bundled
// catalog with the account's current models).
export type RefreshProviderModelsRequest = {
  providerId: string
}

// Outcome of a model-list refresh. On success `models` is the fetched list (also persisted on the
// provider); on failure the caller keeps the bundled catalog and can surface `message`.
export type RefreshProviderModelsResult = {
  ok: boolean
  models?: string[]
  category: ValidationCategory
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

// A bundled skill's source category: app-bundled, imported from GitHub, or user-authored.
export type SkillSource = 'featured' | 'imported' | 'personal'

// Renderer-safe view of one bundled skill (no file contents).
export type SkillView = {
  id: string
  name: string
  description: string
  source: SkillSource
  updatedAt: string
  enabled: boolean
  // From the SKILL.md frontmatter; shown in the detail view's "Details" section when present.
  author?: string
  license?: string
  thirdParty?: string
}

// A skill view plus its SKILL.md body (frontmatter stripped), for the detail view.
export type SkillDetailView = SkillView & {
  body: string
}

export type SetSkillEnabledRequest = {
  id: string
  enabled: boolean
}

// A supporting file bundled under the skill's `references/` directory (base64-encoded for transport).
export type SkillReference = {
  path: string
  dataBase64: string
}

// Create a personal (user-authored) skill from the in-app editor.
export type CreateSkillRequest = {
  name: string
  description: string
  body: string
  references?: SkillReference[]
}

// Update an existing personal skill in place.
export type UpdateSkillRequest = {
  id: string
  name: string
  description: string
  body: string
  references?: SkillReference[]
}

export type DeleteSkillRequest = {
  id: string
}

// Import a single skill from a public GitHub URL.
export type ImportSkillRequest = {
  url: string
}

// Import a skill from an uploaded .zip / .skill bundle (base64-encoded archive bytes).
export type ImportSkillZipRequest = {
  dataBase64: string
  filename?: string
}

// Parse an uploaded .zip / .skill bundle without importing it, for a confirm-before-import preview.
export type PreviewSkillZipRequest = {
  dataBase64: string
}

// The parsed contents of a bundle: the skill's name/description, the files it contains, and whether an
// identical bundle was already imported (same content signature).
export type SkillBundlePreview = {
  name: string
  description: string
  files: string[]
  alreadyImported: boolean
}

// Scan a GitHub repo (owner/repo, owner/repo@ref, or a URL) for skill directories.
export type ScanRepoRequest = {
  repo: string
}

// One skill directory found by a repo scan, with an importable URL and whether it's already imported.
export type ScannedSkillView = {
  name: string
  path: string
  url: string
  alreadyImported: boolean
}

export type ScanRepoResult = {
  skills: ScannedSkillView[]
}

// Outcome of an import: newly imported, refreshed from upstream, or an already-imported no-op. The
// refreshed skill list is included so the renderer can update in one round-trip.
export type ImportSkillResult = {
  status: 'imported' | 'unchanged' | 'updated'
  id: string
  skills: SkillView[]
}
