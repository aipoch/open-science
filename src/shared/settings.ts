// Shared model-settings & onboarding types crossing the main <-> renderer IPC boundary.
//
// The main process owns settings.json and all secret material. The renderer only ever receives the
// masked provider view (never keyRef or plaintext keys) and sends drafts that carry a plaintext key
// only while the user is actively typing one in.

import type { OfficialVendorId } from './provider-registry'
import type { PackageMirror } from './mirror'

// Settings file schema version; bumped when the on-disk shape changes. v2 adds official-vendor
// providers (vendorId/region) and a per-selection activeModel alongside activeProviderId.
export const SETTINGS_FILE_VERSION = 2

// A provider targets a custom Anthropic-compatible gateway, a built-in official vendor (base URL +
// model catalog from the registry), or reuses the local claude auth.
export type ProviderType = 'custom' | 'claude-default' | 'official'

// The chat API a model endpoint speaks: `anthropic` = /v1/messages, `openai` =
// /v1/chat/completions, and `responses` = /v1/responses. Keep the two OpenAI-shaped protocols
// distinct: Codex requires Responses and reaches a Chat Completions provider only through its bridge.
// A provider advertises the explicit set of endpoints it serves; a framework supports a set too.
export type ChatApiEndpoint = 'anthropic' | 'openai' | 'responses'

// The endpoints a provider offers. Absent/empty ⇒ treat as ['anthropic'] (every legacy provider, and
// the migration target for the removed 'both' apiType, which mapped to ['anthropic','openai']).
export const providerEndpoints = (provider: {
  apiEndpoints?: readonly ChatApiEndpoint[]
}): ChatApiEndpoint[] =>
  provider.apiEndpoints && provider.apiEndpoints.length > 0
    ? [...provider.apiEndpoints]
    : ['anthropic']

// A provider's endpoints are compatible with a framework only when they share at least one endpoint.
// Codex's Responses-compatible bridge is a separate local gateway: it does not change the provider's
// endpoints, but it makes Chat Completions providers usable through an explicit translation path.
export const isProviderCompatibleWith = (
  endpoints: readonly ChatApiEndpoint[],
  frameworkEndpoints: readonly ChatApiEndpoint[]
): boolean => endpoints.some((endpoint) => frameworkEndpoints.includes(endpoint))

// Whether a provider can actually drive a given framework. Two axes: endpoint compatibility (above),
// AND provider-type — a `claude-default` provider reuses the machine's own Claude login (Claude-specific
// OAuth/config), which no other framework can consume, so it is only usable by Claude Code regardless
// of endpoint. Enforced both in the renderer gates and main-side (preflight + spawn).
export const isProviderUsableByFramework = (
  provider: { apiEndpoints?: readonly ChatApiEndpoint[]; type: ProviderType },
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
): boolean => {
  if (provider.type === 'claude-default' && framework.id !== 'claude-code') return false

  const endpoints = providerEndpoints(provider)

  if (
    framework.id === 'codex' &&
    framework.supportedApiTypes.includes('responses') &&
    endpoints.includes('openai')
  ) {
    return true
  }

  return isProviderCompatibleWith(endpoints, framework.supportedApiTypes)
}

// The endpoint to actually use for a (provider, framework) pair. When both sides support OpenAI
// /v1/chat/completions it wins (per product decision); otherwise the shared Anthropic endpoint; else
// undefined when the pair is incompatible.
export const preferredEndpoint = (
  endpoints: readonly ChatApiEndpoint[],
  frameworkEndpoints: readonly ChatApiEndpoint[]
): ChatApiEndpoint | undefined => {
  const shared = endpoints.filter((endpoint) => frameworkEndpoints.includes(endpoint))

  if (shared.length === 0) return undefined

  if (shared.includes('responses')) return 'responses'
  return shared.includes('openai') ? 'openai' : 'anthropic'
}

// Detected claude executable metadata, persisted so later spawns skip re-detection.
export type ClaudeInfo = {
  resolvedPath?: string
  version?: string
}

// Detected opencode executable metadata (resolved path + reported version), persisted for the card.
export type OpencodeInfo = {
  resolvedPath?: string
  version?: string
}

// Detected codex-acp adapter metadata. App-managed installs also report the paired native Codex
// version; its executable path stays main-process-only.
export type CodexInfo = {
  resolvedPath?: string
  version?: string
  nativeVersion?: string
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
  // Which chat APIs this provider's endpoint speaks; drives per-framework availability. Absent ⇒
  // treat as ['anthropic'] (every legacy provider).
  apiEndpoints?: ChatApiEndpoint[]
  baseUrl?: string
  model?: string
  supportsImageInput: boolean
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
  // Timestamp of the last successful connectivity/key check (a single ping on the provider's first
  // model). Codex per-model bridge compatibility is NOT a runtime probe — it's a static registry mark.
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

// The agent backends the app can drive over ACP. Persisted settings and the UI reference these ids;
// the main-process AgentFramework registry is keyed by the same union.
export type AgentFrameworkId = 'claude-code' | 'opencode' | 'codex'

// Renderer-facing descriptor for one selectable agent framework (built from the main registry).
export type AgentFrameworkView = {
  id: AgentFrameworkId
  // Chat endpoints this framework can drive; a provider is selectable only if it shares one. Absent ⇒
  // treat as ['anthropic'].
  supportedApiTypes?: ChatApiEndpoint[]
  displayName: string
  // Whether this framework materializes app skills; the renderer hides the skills UI when false.
  supportsSkills: boolean
}

// Full renderer snapshot of settings state.
export type SettingsSnapshot = {
  claude: ClaudeInfo
  // Detected opencode executable, for the framework-aware detection card.
  opencode: OpencodeInfo
  // Detected codex-acp adapter and its paired native Codex runtime.
  codex: CodexInfo
  activeProviderId?: string
  // The active model within the active provider. For custom/claude-default this mirrors the provider's
  // own model; for official providers it's the chosen catalog entry. Undefined until a provider exists.
  activeModel?: string
  providers: ProviderView[]
  // The selected agent backend, and the frameworks available to choose from.
  agentFrameworkId: AgentFrameworkId
  agentFrameworks: AgentFrameworkView[]
  // Whether each framework's detected runtime is the app-managed install (binary in the app's data
  // dir), which is the only case an in-app uninstall is offered — a PATH/npm binary we didn't install
  // is never removed. Derived each read from the resolved path, never persisted.
  claudeManaged: boolean
  opencodeManaged: boolean
  codexManaged: boolean
  // Timestamp of first-run onboarding completion; undefined until it finishes at least once.
  onboardingCompletedAt?: number
  // Non-secret package-mirror overrides (conda/pypi/cran). Absent means public hosts.
  packageMirror?: PackageMirror
}

// Request to set (or clear, via omitted fields) the package-mirror configuration.
export type SetPackageMirrorRequest = PackageMirror

export type SetAgentFrameworkRequest = {
  id: AgentFrameworkId
}

// The hard startup gates. Kept as plain booleans so the wizard can target the first unmet step.
// Per-framework readiness is exposed alongside `agentReady`, which reflects the currently-selected
// framework — the gate a session actually depends on.
export type Preflight = {
  claudeReady: boolean
  opencodeReady: boolean
  codexReady: boolean
  // Readiness of the selected agent framework, plus which one it is.
  agentFrameworkId: AgentFrameworkId
  agentReady: boolean
  activeProviderReady: boolean
}

// A provider draft as entered in the renderer form. The plaintext `key` is present only when the user
// typed a new one; leaving it undefined on edit keeps the previously stored key.
export type ProviderDraft = {
  type: ProviderType
  name?: string
  baseUrl?: string
  model?: string
  supportsImageInput?: boolean
  // Which chat APIs a custom gateway speaks (form selector). Official providers take it from the
  // registry; omitted defaults to ['anthropic'].
  apiEndpoints?: ChatApiEndpoint[]
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

// Selectable install sources for the one-click claude installer. `managed` is the app-driven download
// (no user Node/npm needed) and is the default; the other two are manual/advanced fallbacks.
export type ClaudeInstallSource = 'managed' | 'npm' | 'official-script'

// Trusted registries supported by the app-managed installer. The renderer can select one only from
// this fixed allow-list; arbitrary download origins never cross the IPC boundary.
export type ManagedClaudeRegistry = 'npmjs' | 'npmmirror'

// Static, non-secret description of an install source shown in the UI (command is copyable).
export type ClaudeInstallSourceInfo = {
  id: ClaudeInstallSource
  label: string
  // Human-readable command shown in the UI and safe to copy/paste. Empty for the app-managed source,
  // which has no shell command (the app performs the install itself).
  displayCommand: string
  // Whether this source needs npm on PATH (drives default selection + disabled state).
  requiresNpm: boolean
  // Optional one-line explanation shown under the picker (used by the app-managed source).
  description?: string
}

// The ordered install sources for a given host platform. The app-managed download is the default and
// recommended path (self-contained binary, no user Node/npm). npm and the official installer follow as
// manual fallbacks: the npm command is identical everywhere, while the official installer differs —
// Windows uses install.ps1, other platforms install.sh. Pass the host platform (e.g.
// `window.api.platform`) so the copyable command matches what runs.
export const getClaudeInstallSources = (platform: string = 'linux'): ClaudeInstallSourceInfo[] => {
  const isWindows = platform === 'win32'

  return [
    {
      id: 'managed',
      label: 'App-managed download (recommended)',
      displayCommand: '',
      requiresNpm: false,
      description: 'Downloads a self-contained Claude — no Node.js or npm required.'
    },
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
  // Optional trusted-source preference for an explicit install request. Automatic setup omits this
  // field and lets the installer try the official registry and China-friendly mirror in order.
  managedRegistry?: ManagedClaudeRegistry
}

// Install request for OpenCode. Reuses the same three source kinds as Claude; the app-managed download
// is the recommended default and the only cross-platform-guaranteed path (no user Node/npm needed).
export type InstallOpencodeRequest = {
  source: ClaudeInstallSource
}

export type CodexInstallSource = Exclude<ClaudeInstallSource, 'official-script'>

// Codex supports only an app-managed bundle or the upstream npm-global adapter. Authentication is
// always provider API-key based; ChatGPT/local Codex login is intentionally absent.
export type InstallCodexRequest = {
  source: CodexInstallSource
}

export const getCodexInstallSources = (): ClaudeInstallSourceInfo[] => [
  {
    id: 'managed',
    label: 'App-managed download (recommended)',
    displayCommand: '',
    requiresNpm: false,
    description: 'Downloads a self-contained Codex ACP runtime — no Node.js or npm required.'
  },
  {
    id: 'npm',
    label: 'npm (global install)',
    displayCommand: 'npm i -g @agentclientprotocol/codex-acp',
    requiresNpm: true
  }
]

// The ordered OpenCode install sources for a host platform, mirroring getClaudeInstallSources. The
// app-managed native-binary download leads (works on every OS, including native Windows). npm follows
// (`npm i -g opencode-ai`). The shell installer (`curl … | bash`) is offered only off Windows —
// OpenCode ships no official Windows PowerShell installer, so Windows users take managed or npm.
export const getOpencodeInstallSources = (
  platform: string = 'linux'
): ClaudeInstallSourceInfo[] => {
  const isWindows = platform === 'win32'

  const sources: ClaudeInstallSourceInfo[] = [
    {
      id: 'managed',
      label: 'App-managed download (recommended)',
      displayCommand: '',
      requiresNpm: false,
      description: 'Downloads a self-contained OpenCode — no Node.js or npm required.'
    },
    {
      id: 'npm',
      label: 'npm (global install)',
      displayCommand: 'npm i -g opencode-ai',
      requiresNpm: true
    }
  ]

  if (!isWindows) {
    sources.push({
      id: 'official-script',
      label: 'Official install script',
      displayCommand: 'curl -fsSL https://opencode.ai/install | bash',
      requiresNpm: false
    })
  }

  return sources
}

// One streamed line of installer output. `installId` groups a single install run.
export type ClaudeInstallLogEvent = {
  kind: 'log'
  installId: string
  stream: 'stdout' | 'stderr' | 'system'
  chunk: string
}

// Coarse stage of an install run, used to label the progress bar.
export type ClaudeInstallPhase = 'resolving' | 'downloading' | 'extracting' | 'installing'

// One progress tick driving the install progress bar. `receivedBytes`/`totalBytes` are present only
// for a determinate download (the app-managed source, when the server reports a content length); their
// absence marks an indeterminate phase (npm/official-script, or an unknown download size).
export type ClaudeInstallProgressEvent = {
  kind: 'progress'
  installId: string
  phase: ClaudeInstallPhase
  receivedBytes?: number
  totalBytes?: number
}

// The single install-event stream: discrete log lines and progress ticks share one ordered channel,
// discriminated by `kind`. The renderer routes by kind (progress → the bar, log → the log pane).
export type ClaudeInstallEvent = ClaudeInstallLogEvent | ClaudeInstallProgressEvent

// Final result of an install run; on success the caller re-detects claude.
export type ClaudeInstallResult = {
  installId: string
  ok: boolean
  exitCode?: number
  timedOut?: boolean
  error?: string
  // The official installer returned a region-block HTML page instead of the script (common in
  // regions where claude.ai is unavailable); the installer auto-falls-back to npm when it can.
  regionBlocked?: boolean
}

// Availability of npm on the host, used to gate the npm source.
export type NpmAvailability = {
  available: boolean
}

// Automatic first-run environment inspection. Warnings are non-blocking; failures identify setup
// requirements that prevent a supported configuration, such as unavailable secure credential storage.
export type EnvironmentCheckId =
  | 'system'
  | 'storage'
  | 'secure-storage'
  | 'install-network'
  | 'python'
  // The selected agent runtime (Claude or OpenCode); label/summary are framework-specific.
  | 'agent'

export type EnvironmentCheckStatus = 'passed' | 'warning' | 'failed'

export type EnvironmentCheckItem = {
  id: EnvironmentCheckId
  label: string
  status: EnvironmentCheckStatus
  summary: string
  detail?: string
}

export type EnvironmentCheckResult = {
  checkedAt: number
  platform: string
  architecture: string
  checks: EnvironmentCheckItem[]
  // True when no required check failed. A warning does not block the next onboarding step.
  ready: boolean
  // True when the managed runtime can be attempted using a reachable trusted source and app-owned
  // data directory. More detailed operational errors are reported by the install log.
  canAutoInstall: boolean
  recommendedRegistry?: ManagedClaudeRegistry
  // The framework this check inspected, and its runtime detection result.
  agentFrameworkId: AgentFrameworkId
  runtime: ClaudeDetectResult
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

// A skill view plus its SKILL.md body (frontmatter stripped) and the names of any files under its
// `references/` directory, for the detail/edit view.
export type SkillDetailView = SkillView & {
  body: string
  references: SkillReferenceInfo[]
}

// A reference file's name (basename under `references/`), without its content.
export type SkillReferenceInfo = {
  path: string
}

export type SetSkillEnabledRequest = {
  id: string
  enabled: boolean
}

// A supporting file bundled under the skill's `references/` directory. `dataBase64` carries new file
// content; when omitted (on edit), it means "keep the existing file with this path unchanged".
export type SkillReference = {
  path: string
  dataBase64?: string
}

// Create a personal (user-authored) skill from the in-app editor. `slug` is the user-chosen Skill ID
// (without the `personal-` prefix); when omitted, it is derived from the name.
export type CreateSkillRequest = {
  name: string
  description: string
  body: string
  slug?: string
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

// Import a skill from an uploaded .zip / .skill bundle (base64-encoded archive bytes). When
// `replaceId` is set, the bundle overwrites that already-imported skill in place instead of being
// imported as a new (possibly suffixed) skill.
export type ImportSkillZipRequest = {
  dataBase64: string
  filename?: string
  replaceId?: string
  subPath?: string
}

// Parse an uploaded .zip / .skill bundle without importing it, for a confirm-before-import preview.
export type PreviewSkillZipRequest = {
  dataBase64: string
}

// Import several skills from ONE uploaded bundle in a single call, so a bundle holding many skills is
// unpacked once instead of re-decoded per skill. Each item selects a skill root by subPath (and may
// target an existing imported skill to replace).
export type ImportSkillZipBatchRequest = {
  dataBase64: string
  items: { subPath: string; replaceId?: string }[]
}

// Per-item outcome of a batch import: the same status as a single import on success, or an error
// message on failure, keyed by the requested subPath. The refreshed skill list is returned once.
// Per-item outcome: on success `status` (+ `id`) is set and `error` is absent; on failure `error` is
// set and `status`/`id` are absent. The two are mutually exclusive, so a caller keys off `error`.
export type ImportSkillZipBatchItemResult =
  | { subPath: string; status: 'imported' | 'unchanged' | 'updated'; id: string; error?: undefined }
  | { subPath: string; status?: undefined; id?: undefined; error: string }

export type ImportSkillZipBatchResult = {
  results: ImportSkillZipBatchItemResult[]
  skills: SkillView[]
}

// The parsed contents of a bundle: the skill's name/description, the files it contains, whether an
// identical bundle was already imported (same content signature), and — when the name collides with
// exactly one existing imported skill of different content — the id of that skill, offered as a
// replace target.
export type SkillBundlePreview = {
  subPath: string
  name: string
  description: string
  files: string[]
  alreadyImported: boolean
  replaceableId?: string
}

// One skill the bundle contained but that couldn't be imported (too large, no SKILL.md, no name, an
// unreadable nested archive, ...). `source` identifies it within the bundle (the nested archive name
// or subPath); `reason` is a plain-English explanation shown to the user. Surfaced so a partial import
// tells the user exactly what was left out instead of failing the whole bundle.
export type SkippedSkill = {
  source: string
  reason: string
}

// Result of previewing a bundle: the importable skills, plus any that were skipped and why. A bundle
// with a mix of good and bad skills yields previews for the good ones and a skipped entry per bad one.
export type SkillBundlePreviewResult = {
  previews: SkillBundlePreview[]
  skipped: SkippedSkill[]
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

// --- Connectors ---------------------------------------------------------------------------------

// Per-tool permission. 'ask' is reserved for the future per-call approval flow and is not yet
// functional — the UI renders it disabled and only 'allow'/'block' persist (to blockedToolIds).
export type ToolPermission = 'allow' | 'ask' | 'block'

// One tool within a connector, with its current permission (derived: 'block' if blocklisted).
export type ConnectorToolView = {
  id: string // "<connector>/<method>"
  method: string
  description: string
  permission: ToolPermission
}

// Which section a bundled connector belongs to in the settings list.
export type ConnectorGroup = 'featured' | 'directory'

// Renderer-safe view of one bundled connector (no tool schemas).
export type ConnectorView = {
  id: string
  displayName: string
  description: string
  sources: string[]
  requiresNcbi: boolean
  enabled: boolean // !disabledConnectorIds.includes(id)
  autoAllow: boolean // autoAllowIds.includes(id) — "Skip approvals"
  group: ConnectorGroup
}

// A connector view plus its tools and metadata, for the detail page.
export type ConnectorDetailView = ConnectorView & {
  useWhen: string
  termsUrl?: string
  tools: ConnectorToolView[]
}

// NCBI / research-service credential state surfaced to the renderer (never the plaintext key).
export type NcbiCredentialsView = { contactEmail?: string; hasApiKey: boolean }

// Transport for a user-added custom MCP server: stdio (local command) or a remote HTTP variant.
export type CustomServerTransport = 'stdio' | 'streamable_http' | 'sse'

// Renderer-safe view of one user-added custom MCP server (no secret env/header values).
export type CustomServerView = {
  id: string
  name: string
  description?: string
  transport: CustomServerTransport
  enabled: boolean
  // Display-only config summary (the command that runs, its args, or the remote URL). env/headers
  // are intentionally omitted — they may hold secrets and stay write-only from the UI.
  command?: string
  args?: string[]
  url?: string
}

// The connectors list plus custom servers and shared credential state, returned by list/mutation calls.
export type ConnectorsSnapshot = {
  connectors: ConnectorView[]
  customServers: CustomServerView[]
  ncbi: NcbiCredentialsView
}

export type SetConnectorEnabledRequest = { id: string; enabled: boolean }
export type SetConnectorAutoAllowRequest = { id: string; autoAllow: boolean }
export type SetToolPermissionRequest = { toolId: string; permission: ToolPermission }
export type SetNcbiCredentialsRequest = { contactEmail?: string; apiKey?: string }

// Add a custom MCP server. stdio requires `command`; the remote transports require `url`.
export type AddCustomServerRequest = {
  name: string
  description?: string
  transport: CustomServerTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
export type SetCustomServerEnabledRequest = { id: string; enabled: boolean }
export type RemoveCustomServerRequest = { id: string }

// Edit an existing custom MCP server. The name is immutable (it is the server's identity — host.mcp
// routing, skill-doc name, and per-tool policy keys all depend on it). Omitted env/headers keep the
// stored values; providing them replaces the set.
export type UpdateCustomServerRequest = {
  id: string
  description?: string
  transport: CustomServerTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

// A per-call approval request for a connector tool invocation (external data-egress gate). Sent from
// main to the renderer, which shows an approval card and responds with a decision.
export type ConnectorApprovalRequest = {
  id: string
  connector: string // bundled connector id or custom server name
  method: string
  argsPreview: string // truncated JSON preview of the call arguments
}
export type ApprovalDecision = 'allow' | 'deny'
export type RespondApprovalRequest = { id: string; decision: ApprovalDecision }

// Minimal settings slice the remote-file-browser bookmark helpers depend on. Declared here in
// src/shared (not src/main) so src/shared/remote-fs.ts stays within the shared layer — the full
// StoredSettings in src/main structurally satisfies this shape.
export type ComputeBookmarkStore = { computeBookmarks?: Record<string, string[]> }
