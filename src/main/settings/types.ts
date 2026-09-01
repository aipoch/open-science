import type {
  AppIconVariant,
  ChatApiEndpoint,
  ClaudeSubscriptionProviderId,
  ClaudeInfo,
  CodexSubscriptionAuthMode,
  CodexSubscriptionTransport,
  CodexInfo,
  ProjectFilesFilterPreference,
  ProviderType,
  ProviderValidationFailure,
  ReasoningEffort,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../shared/settings'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { NotebookNetworkSettings } from '../../shared/notebook-network'
import type {
  CustomReasoningEffortTransport,
  ReasoningEffortPresetSetting
} from '../../shared/reasoning-effort'
import type { PackageMirror } from '../../shared/mirror'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { CloseActionPreference } from '../../shared/window-controls'
import type { LanguagePreference } from '../../shared/locale'
import type { AgentFrameworkId } from '../agent-framework'
import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'

// Main-process-only stored shapes for settings.json. These carry the encrypted key reference and a
// non-secret masked hint; the plaintext key never lives here (only transiently in service memory).

// A single stored provider record. `keyRef` is a safeStorage ciphertext (see crypto.ts); `keyMask`
// is a non-secret display hint recomputed whenever the key changes. For official providers the base
// URL and model catalog come from the registry (via vendorId/region), so `baseUrl` stays unset.
export type StoredProvider = {
  id: string
  type: ProviderType
  // Records whether the app-owned Codex profile came from an import or an in-app sign-in. Runtime
  // behavior still keys on the normalized codex-isolated provider type.
  codexAuthMode?: CodexSubscriptionAuthMode
  // Transport preference for the app-owned Codex subscription profile. Absence is Auto.
  codexTransport?: CodexSubscriptionTransport
  // Main-only learned Auto fallback. Never projected to ProviderView or renderer drafts.
  codexAutoUseHttps?: boolean
  name: string
  // Which chat APIs a custom gateway speaks. Official providers derive it from the registry; absent
  // means ['anthropic'] (all pre-existing providers). Legacy records may carry the removed scalar
  // `apiType` on disk; the repository migrates it to this field on read.
  apiEndpoints?: ChatApiEndpoint[]
  baseUrl?: string
  model?: string
  // Optional custom-model token limits. Context is the shared request/response budget; input/output
  // are independent provider-reported caps and stay absent when unknown.
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsImageInput?: boolean
  // Custom-model effort capability. Absence resolves to the standard five-level preset.
  reasoningEffortPreset?: ReasoningEffortPresetSetting
  // Custom-gateway request shape. Absence resolves to the literal `reasoning_effort` field.
  reasoningEffortTransport?: CustomReasoningEffortTransport
  // Set for official-vendor providers only.
  vendorId?: OfficialVendorId
  region?: string
  // Model ids fetched live from the vendor (via "refresh from vendor"). When present, these take
  // precedence over the bundled registry catalog for this provider.
  fetchedModels?: string[]
  // Non-secret identity returned by xAI after device authorization.
  accountEmail?: string
  keyRef?: string
  keyMask?: string
  // Timestamp of the last successful connectivity/key check on the provider's first model.
  lastValidatedAt?: number
  // Estimated expiry of a stored credential, used to surface "expires <date>" on the Settings card.
  // Only set for credential types that have a known bounded lifetime: today that is the Claude
  // `claude setup-token` (Anthropic documents a one-year lifetime) and a codex subscription sign-in
  // (whose expiry Anthropic / OpenAI surface on the auth status). Stored in epoch ms.
  expiresAt?: number
  // Recorded when a validation fails; cleared on the next success or a credential change. Kept so the
  // "unverified" warning survives a restart.
  lastValidationFailure?: ProviderValidationFailure
  // claude-shared credentials live in the user's global profile and cannot be removed safely by the
  // app. This timestamp records an app-local disconnect so Open Science stops using that profile
  // until the user explicitly signs in again.
  disconnectedAt?: number
}

export type StoredCustomMcpOAuthConfig = {
  clientMetadataUrl?: string
  authorizationServerUrl?: string
  scopes?: string[]
  clientId?: string
  redirectUri?: string
}

// The OAuth state is serialized into one encrypted safeStorage value. `oauthState` is a transient
// main-process projection populated by ConnectorSettingsModule; it is never written to settings.json
// and never sent to the renderer.
export type StoredCustomMcpOAuthState = {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  discoveryState?: OAuthDiscoveryState
}

export type StoredDeviceCredential =
  | {
      id: string
      displayName: string
      kind: 'api_key' | 'token'
      secretRef: string
      createdAt: number
      updatedAt: number
    }
  | {
      id: string
      displayName: string
      kind: 'oauth'
      resourceUri: string
      transport: 'streamable_http' | 'sse'
      oauth: StoredCustomMcpOAuthConfig
      clientSecretRef?: string
      stateRef?: string
      createdAt: number
      updatedAt: number
    }

export type StoredDeviceCredentialsDocument = {
  version: 1
  credentials: StoredDeviceCredential[]
}

// A user-added custom MCP server. Secret values are stored as safeStorage refs and decrypted only in
// the main process when constructing the MCP transport.
export type StoredCustomMcpServer = {
  // Immutable local identity. New records infer it from `name` when safe and otherwise use a UUID.
  id: string
  // Immutable public invocation name used by host.mcp, Specialists, policy, and generated Skills.
  name: string
  // Presentation-only label. It may enter context but never participates in identity resolution.
  displayName: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  command?: string
  args?: string[]
  // Legacy plaintext fields are read only for one-time migration; new writes use the ref maps below.
  env?: Record<string, string>
  envRefs?: Record<string, string>
  url?: string
  // Static auth headers (e.g. Authorization) sent with every request on remote transports.
  headers?: Record<string, string>
  headerRefs?: Record<string, string>
  oauth?: StoredCustomMcpOAuthConfig
  // The pre-registered client secret follows the same safeStorage-ref convention as env/headers.
  oauthClientSecretRef?: string
  // New Connectors may point at a device-global OAuth credential. Legacy records keep encrypted
  // OAuth state in this field; the `credential:` prefix distinguishes the new reference shape.
  oauthRef?: string
  // Main-process-only projections populated by ConnectorSettingsModule. These fields are not
  // persisted to settings.json or sent to the renderer.
  oauthClientSecret?: string
  oauthState?: StoredCustomMcpOAuthState
  oauthCredentialUnavailable?: true
  enabled: boolean
  // Timestamp of the user's explicit add-time trust confirmation (see plan §3.5).
  trustedAt?: number
  description?: string
}

// Connector enablement and non-secret settings. `ncbiApiKeyRef` is a safeStorage ciphertext
// reference, like `StoredProvider.keyRef`; the plaintext key never lives here.
export type StoredConnectors = {
  enabledIds: string[]
  autoAllowIds: string[]
  contactEmail?: string
  ncbiApiKeyRef?: string
  // OpenAlex is consumed by a subset of the bundled Literature Connector tools. Keep its secret
  // beside the other Connector-owned credentials so dispatch can resolve it immediately before use.
  openAlexApiKeyRef?: string
  // Fully-qualified "<connector>/<method>" ids denied by policy; allow by default otherwise.
  blockedToolIds?: string[]
  // Fully-qualified "<connector>/<method>" ids that require per-call approval (opt-in). Tools default
  // to allow (no prompt); this is the set the user switched to "Require approval".
  askToolIds?: string[]
  // Ids of bundled connectors the user turned OFF. Absent/empty means every bundled connector is
  // enabled (default-on), mirroring disabledSkillIds. This is the authoritative bundled gate.
  disabledConnectorIds?: string[]
  customMcpServers?: StoredCustomMcpServer[]
  // Durable tombstones for Connector deletions that still need their permission grants pruned.
  pendingCustomServerDeletionIds?: string[]
}

export type StoredCodexInfo = CodexInfo & {
  // App-managed bundles pin the native Codex executable paired with codex-acp.
  nativePath?: string
}

// The whole settings.json document.
export type StoredSettings = {
  version: typeof SETTINGS_FILE_VERSION
  claude?: ClaudeInfo
  // Selected agent backend. Absent means the default (Claude Code). Switching needs a reconnect.
  agentFrameworkId?: AgentFrameworkId
  // Reasoning-effort preference. Absent (or 'default') means the agent keeps its own default.
  reasoningEffort?: ReasoningEffort
  // Global direct-Subagent model routing. Absence in older documents means dynamic inheritance.
  subagentModel?: SubagentModelConfiguration
  // Global Reviewer model routing. Absence in older documents means follow the Active model.
  reviewerModel?: ReviewerModelConfiguration
  // Automatic Session title/description generation. Absence means inherit + Low effort.
  sessionDetailsModel?: SessionDetailsModelConfiguration
  // Optional visual relay target. Absence in older documents and new installs means disabled.
  visionModel?: VisionModelConfiguration
  // Desktop-notification preference for finished/failed agent tasks. Absent means enabled.
  notificationsEnabled?: boolean
  // Native notification detail is privacy-sensitive. Absent means generic copy only.
  showNotificationContent?: boolean
  // Conversation-driven Skill package import. Absent means enabled.
  conversationSkillImportEnabled?: boolean
  // Interface language preference shared by desktop renderer and native surfaces. Absent means the
  // renderer may import the historical localStorage value once; otherwise the default is 'system'.
  localePreference?: LanguagePreference
  // Windows titlebar-close behavior. Absent means ask every time.
  closePreference?: CloseActionPreference
  // Last Files-tab source filter (artifact collection, this computer, or a granted folder).
  // Absent means the default ("All artifacts").
  projectFilesFilter?: ProjectFilesFilterPreference
  // Selected built-in app-icon look. Absent means the default ('light').
  appIconVariant?: AppIconVariant
  // Default approval profile for new conversations. Absent means the safe 'ask' default.
  defaultPermissionProfile?: PermissionProfileId
  // Detected opencode executable path + reported version (for the status card). Absent = detect on PATH.
  opencodePath?: string
  opencodeVersion?: string
  // Detected CodeBuddy CLI path + version. The first integration uses the upstream npm CLI.
  codebuddyPath?: string
  codebuddyVersion?: string
  // codex-acp adapter plus the native Codex runtime it launches.
  codex?: StoredCodexInfo
  activeProviderId?: string
  // Last explicitly configured Claude subscription mode. Kept separately from activeProviderId so
  // switching to a custom provider does not make the collapsed Claude card fall back to list order.
  claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
  // Active model within the active provider; backfilled from the provider's own model on load when a
  // pre-v2 settings file (which had no per-model selection) is read.
  activeModel?: string
  providers: StoredProvider[]
  // Set once the first-run onboarding wizard has been completed (or auto-completed for an
  // already-configured install). Absent means onboarding has never finished.
  onboardingCompletedAt?: number
  // Ids of bundled skills the user turned OFF. Absent/empty means every bundled skill is enabled
  // (default-on), so new bundled skills are enabled automatically.
  disabledSkillIds?: string[]
  // OS-encrypted GitHub token used only for GitHub Skill discovery/import requests. The mask is
  // display-only; plaintext never reaches settings.json or a renderer snapshot.
  githubTokenRef?: string
  githubTokenMask?: string
  connectors?: StoredConnectors
  // Non-secret package-mirror overrides (conda/pypi/cran). Absent means public hosts.
  packageMirror?: PackageMirror
  // Application-wide proxy preference. Absent in historical documents means follow the system.
  networkProxy?: NetworkProxySettings
  // Application-wide egress policy for Notebook REPL and Notebook Bash processes.
  notebookNetwork?: NotebookNetworkSettings
  // Absolute path of the relocatable data root (artifacts/notebooks/runtime/uploads). Absent means
  // "use the config root" (default). Only written after a successful migration; a change needs a restart.
  dataRoot?: string
  // Set once the one-time legacy-absolute-path-to-$DATA normalization pass has completed successfully.
  // Absent means it still needs to run (or a previous attempt failed and should retry).
  pathsNormalizedAt?: number
  // Set once the user has answered the one-time "move your legacy .open-science data into the
  // visible OpenScience folder" prompt (by moving, choosing another folder, or declining). Absent
  // means it has never been answered, so an eligible legacy install may still be offered the prompt.
  legacyDataMovePromptDismissedAt?: number
  // Per-language notebook runtime choice: the app-managed conda env, or the user's own interpreter
  // (BYO). Absent for a language means "not chosen yet" -> resolves to the managed default. See
  // RuntimeSelection (shared/notebook-runtime.ts). R is managed-only in v1.
  notebookRuntimes?: Partial<Record<NotebookLanguage, RuntimeSelection>>
  // Per-language v4 environment enablement: an explicit per-env enabled override map plus the separate
  // per-env package-install authorization, both keyed by envId (interpreter real path). Absent means
  // "use the provenance default" (app-managed/agent-created ON, user-own OFF). See RuntimeEnablement.
  notebookRuntimeEnablement?: Partial<Record<NotebookLanguage, RuntimeEnablement>>
  // Per-language catalog of interpreter paths the user added manually via "Add interpreter…". These
  // are merged into environment discovery (probed + classified user-own) so a manually-picked
  // interpreter shows up as an enable-able runtime card even when it is not on PATH / in a conda root.
  notebookManualInterpreters?: Partial<Record<NotebookLanguage, string[]>>
  // Pinned bookmark folders for the remote file browser, keyed by provider_id.
  // Each value is an ordered array of absolute paths the user has pinned via Go-to.
  computeBookmarks?: Record<string, string[]>
  // Legacy settings-persisted granted local roots ("Grant folder access"), read only for one-time
  // migration into the GrantedLocalRoot SQLite table (see local-fs/granted-roots-repository.ts).
  // Production never appends to this field; it is removed after a successful import.
  grantedLocalRoots?: GrantedLocalRoot[]
  // Legacy project-scope compute grants, read only for one-time migration into PermissionGrant.
  // Production authorization never appends to this field; it is removed after a successful import.
  computeGrants?: StoredComputeGrant[]
}

// Legacy settings.json shape retained only so existing installations can migrate without data loss.
export type StoredComputeGrant = {
  projectId: string
  operation: string
  providerId: string
}

// Canonical empty settings used for a first run or an unreadable file.
export const createEmptySettings = (): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: []
})
