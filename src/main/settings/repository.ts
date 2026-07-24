import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, parse } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  AgentFrameworkId,
  ChatApiEndpoint,
  ClaudeSubscriptionProviderId,
  ClaudeInfo,
  ProviderType,
  ProviderValidationFailure,
  ReasoningEffort,
  ValidationCategory
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  SETTINGS_FILE_VERSION,
  claudeIsolatedProviderIdentity,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProvider,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  isReasoningEffort
} from '../../shared/settings'
import { isOfficialVendorId } from '../../shared/provider-registry'
import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { CloseActionPreference } from '../../shared/window-controls'
import { createLogger } from '../logger'
import {
  createEmptySettings,
  type StoredComputeGrant,
  type StoredConnectors,
  type StoredCodexInfo,
  type StoredCustomMcpServer,
  type StoredProvider,
  type StoredSettings
} from './types'

const SETTINGS_FILE = 'settings.json'

const log = createLogger('settings.repository')

const PROVIDER_TYPES = new Set<ProviderType>([
  'custom',
  'claude-shared',
  'claude-isolated',
  'official',
  'codex-shared',
  'codex-isolated'
])

const VALIDATION_CATEGORIES = new Set<ValidationCategory>([
  'ok',
  'network',
  'auth',
  'model-not-found',
  'bad-url',
  'timeout',
  'incompatible',
  'unknown'
])

// Checks for plain JSON objects so untrusted settings payloads can be sanitized safely.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

// Rebuilds a record<string,string>, dropping any key whose value isn't a string. Returns undefined
// for a non-record input or when nothing survives.
const asStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

// Rebuilds a record<string,boolean>, dropping any key whose value isn't a boolean. Returns an empty
// record (never undefined) for a non-record input so callers get a stable, always-mergeable map.
const asBooleanRecord = (value: unknown): Record<string, boolean> => {
  if (!isRecord(value)) return {}

  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
  )

  return Object.fromEntries(entries)
}

const CUSTOM_MCP_TRANSPORTS = new Set<StoredCustomMcpServer['transport']>([
  'stdio',
  'streamable_http',
  'sse'
])

// Rebuilds claude metadata from allowed fields only.
const sanitizeClaudeInfo = (value: unknown): ClaudeInfo | undefined => {
  if (!isRecord(value)) return undefined

  const info: ClaudeInfo = {}
  const resolvedPath = asString(value.resolvedPath)
  const version = asString(value.version)

  if (resolvedPath) info.resolvedPath = resolvedPath
  if (version) info.version = version

  return Object.keys(info).length > 0 ? info : undefined
}

const sanitizeCodexInfo = (value: unknown): StoredCodexInfo | undefined => {
  if (!isRecord(value)) return undefined

  const info: StoredCodexInfo = {}
  const resolvedPath = asString(value.resolvedPath)
  const version = asString(value.version)
  const nativePath = asString(value.nativePath)
  const nativeVersion = asString(value.nativeVersion)

  if (resolvedPath) info.resolvedPath = resolvedPath
  if (version) info.version = version
  if (nativePath) info.nativePath = nativePath
  if (nativeVersion) info.nativeVersion = nativeVersion

  return Object.keys(info).length > 0 ? info : undefined
}

// Rebuilds a recorded validation failure, dropping it unless it has a numeric timestamp and a known
// category (status/message are optional). Without this the field would be stripped on every read.
const sanitizeValidationFailure = (value: unknown): ProviderValidationFailure | undefined => {
  if (!isRecord(value)) return undefined

  const at = asNumber(value.at)
  const category = asString(value.category) as ValidationCategory | undefined

  if (at === undefined || !category || !VALIDATION_CATEGORIES.has(category)) return undefined

  const failure: ProviderValidationFailure = { at, category }
  const status = asNumber(value.status)
  const message = asString(value.message)

  if (status !== undefined) failure.status = status
  if (message) failure.message = message

  return failure
}

// Rebuilds one provider record, dropping unknown fields and records missing required identity.
// An unknown `type` is dropped at load time and logged at WARN — usually a stale provider kind from a
// prior version (e.g. the removed 'claude-default'). A bad value must never reach the active snapshot.
const sanitizeProvider = (value: unknown): StoredProvider | undefined => {
  if (!isRecord(value)) return undefined

  const id = asString(value.id)
  const type = asString(value.type) as ProviderType | undefined
  const name = asString(value.name)

  if (!id || !type || name === undefined) return undefined

  if (!PROVIDER_TYPES.has(type)) {
    log.warn('dropping stored provider with unknown type', { id, type })

    return undefined
  }

  // An official provider without a recognizable vendor is unusable (no base URL/catalog to resolve),
  // so drop the corrupt record rather than keep a provider that can never spawn or validate.
  const vendorId = isOfficialVendorId(value.vendorId) ? value.vendorId : undefined

  if (type === 'official' && !vendorId) return undefined

  const provider: StoredProvider = { id, type, name }
  const baseUrl = asString(value.baseUrl)
  const model = asString(value.model)
  const rawContextWindow = asNumber(value.contextWindow)
  const contextWindow =
    rawContextWindow !== undefined && Number.isSafeInteger(rawContextWindow) && rawContextWindow > 0
      ? rawContextWindow
      : undefined
  const supportsImageInput = asBoolean(value.supportsImageInput)
  const region = asString(value.region)
  const keyRef = asString(value.keyRef)
  const keyMask = asString(value.keyMask)
  const lastValidatedAt = asNumber(value.lastValidatedAt)
  const lastValidationFailure = sanitizeValidationFailure(value.lastValidationFailure)
  const expiresAt = asNumber(value.expiresAt)
  const disconnectedAt = asNumber(value.disconnectedAt)
  // Keep only a clean list of non-empty string model ids.
  const fetchedModels = Array.isArray(value.fetchedModels)
    ? value.fetchedModels.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
    : undefined

  // Resolve the provider's chat endpoints, migrating the removed scalar `apiType` on legacy records
  // ('both' meant anthropic+openai) to the explicit array. Only known endpoint values survive.
  const rawEndpoints = Array.isArray(value.apiEndpoints) ? value.apiEndpoints : []
  const knownEndpoints = rawEndpoints.filter(
    (entry): entry is ChatApiEndpoint =>
      entry === 'anthropic' || entry === 'openai' || entry === 'responses'
  )
  const legacyApiType = asString(value.apiType)
  const apiEndpoints: ChatApiEndpoint[] =
    knownEndpoints.length > 0
      ? [...new Set(knownEndpoints)]
      : legacyApiType === 'both'
        ? ['anthropic', 'openai']
        : legacyApiType === 'anthropic' ||
            legacyApiType === 'openai' ||
            legacyApiType === 'responses'
          ? [legacyApiType]
          : []

  if (baseUrl) provider.baseUrl = baseUrl
  if (model) provider.model = model
  if (contextWindow !== undefined) provider.contextWindow = contextWindow
  if (supportsImageInput !== undefined) provider.supportsImageInput = supportsImageInput
  if (apiEndpoints.length > 0) provider.apiEndpoints = apiEndpoints
  if (vendorId) provider.vendorId = vendorId
  if (region) provider.region = region
  if (fetchedModels && fetchedModels.length > 0) provider.fetchedModels = fetchedModels
  if (keyRef) provider.keyRef = keyRef
  if (keyMask) provider.keyMask = keyMask
  if (lastValidatedAt !== undefined) provider.lastValidatedAt = lastValidatedAt
  if (lastValidationFailure) provider.lastValidationFailure = lastValidationFailure
  if (expiresAt !== undefined) provider.expiresAt = expiresAt
  if (disconnectedAt !== undefined && type === 'claude-shared') {
    provider.disconnectedAt = disconnectedAt
  }

  return provider
}

// Rebuilds one custom MCP server, dropping unknown fields and records missing required identity.
// Phase 1 only wires up the stdio transport end-to-end, so stdio additionally requires a non-empty
// `command`; `url` is accepted (for the remote transports) but not yet validated further.
export const sanitizeCustomMcpServer = (value: unknown): StoredCustomMcpServer | undefined => {
  if (!isRecord(value)) return undefined

  const id = asString(value.id)
  const name = asString(value.name)
  const transport = asString(value.transport) as StoredCustomMcpServer['transport'] | undefined
  const enabled = asBoolean(value.enabled)

  if (
    !id ||
    !name ||
    !transport ||
    !CUSTOM_MCP_TRANSPORTS.has(transport) ||
    enabled === undefined
  ) {
    return undefined
  }

  const command = asString(value.command)
  const url = asString(value.url)

  if (transport === 'stdio' && !command) return undefined
  if ((transport === 'streamable_http' || transport === 'sse') && !url) return undefined

  const server: StoredCustomMcpServer = { id, name, transport, enabled }

  if (command) server.command = command
  const args = asStringArray(value.args)
  if (args.length) server.args = args
  const env = asStringRecord(value.env)
  if (env) server.env = env
  const envRefs = asStringRecord(value.envRefs)
  if (envRefs) server.envRefs = envRefs
  if (url) server.url = url
  const headers = asStringRecord(value.headers)
  if (headers) server.headers = headers
  const headerRefs = asStringRecord(value.headerRefs)
  if (headerRefs) server.headerRefs = headerRefs
  const trustedAt = asNumber(value.trustedAt)
  if (trustedAt !== undefined) server.trustedAt = trustedAt
  const description = asString(value.description)
  if (description) server.description = description

  return server
}

// Rebuilds one compute grant, dropping records with missing required string fields.
const sanitizeComputeGrant = (value: unknown): StoredComputeGrant | undefined => {
  if (!isRecord(value)) return undefined
  const projectId = asString(value.projectId)
  const operation = asString(value.operation)
  const providerId = asString(value.providerId)
  if (!projectId || !operation || !providerId) return undefined
  return { projectId, operation, providerId }
}

// Rebuilds the connectors block from allowed fields only.
export const sanitizeConnectors = (value: unknown): StoredConnectors | undefined => {
  if (!isRecord(value)) return undefined
  const connectors: StoredConnectors = {
    enabledIds: asStringArray(value.enabledIds),
    autoAllowIds: asStringArray(value.autoAllowIds)
  }
  const contactEmail = asString(value.contactEmail)
  const ncbiApiKeyRef = asString(value.ncbiApiKeyRef)
  if (contactEmail) connectors.contactEmail = contactEmail
  if (ncbiApiKeyRef) connectors.ncbiApiKeyRef = ncbiApiKeyRef
  const blockedToolIds = asStringArray(value.blockedToolIds)
  if (blockedToolIds.length) connectors.blockedToolIds = blockedToolIds
  const askToolIds = asStringArray(value.askToolIds)
  if (askToolIds.length) connectors.askToolIds = askToolIds
  const disabledConnectorIds = asStringArray(value.disabledConnectorIds)
  if (disabledConnectorIds.length)
    connectors.disabledConnectorIds = [...new Set(disabledConnectorIds)]
  const customMcpServers = Array.isArray(value.customMcpServers)
    ? value.customMcpServers
        .map(sanitizeCustomMcpServer)
        .filter((server): server is StoredCustomMcpServer => !!server)
    : []
  if (customMcpServers.length) connectors.customMcpServers = customMcpServers
  return connectors
}

// Rebuilds a PackageMirror from untrusted JSON, keeping only string url/path fields. Returns
// undefined when nothing valid remains (absent == public hosts default).
export const sanitizePackageMirror = (value: unknown): PackageMirror | undefined => {
  if (!isRecord(value)) return undefined

  const condaChannel = asString(value.condaChannel)
  const pypiIndex = asString(value.pypiIndex)
  const cranMirror = asString(value.cranMirror)
  const caBundle = asString(value.caBundle)
  const result: PackageMirror = {}

  if (condaChannel) result.condaChannel = condaChannel
  if (pypiIndex) result.pypiIndex = pypiIndex
  if (cranMirror) result.cranMirror = cranMirror
  if (caBundle) result.caBundle = caBundle

  return Object.keys(result).length > 0 ? result : undefined
}

// Rebuilds the whole settings document, keeping activeProviderId only when it points at a provider.
const sanitizeSettings = (value: unknown): StoredSettings => {
  if (!isRecord(value)) return createEmptySettings()

  const sanitizedProviders = Array.isArray(value.providers)
    ? value.providers
        .map(sanitizeProvider)
        .filter((provider): provider is StoredProvider => !!provider)
    : []
  const legacyActiveProviderId = asString(value.activeProviderId)
  const codexProviders = sanitizedProviders.filter((provider) =>
    isCodexSubscriptionProvider(provider.type)
  )
  const activeCodexProvider = codexProviders.find(
    (provider) => provider.id === legacyActiveProviderId
  )
  const selectedCodexProvider = activeCodexProvider ?? codexProviders[0]
  const providers = [
    ...sanitizedProviders.filter((provider) => !isCodexSubscriptionProvider(provider.type)),
    ...(selectedCodexProvider
      ? [
          {
            ...selectedCodexProvider,
            id: CODEX_SUBSCRIPTION_PROVIDER_ID,
            name: codexSubscriptionProviderIdentity().name
          }
        ]
      : [])
  ]
  const settings: StoredSettings = {
    version: SETTINGS_FILE_VERSION,
    providers
  }
  const claudeSubscriptionProviderId = asString(value.claudeSubscriptionProviderId)

  if (
    claudeSubscriptionProviderId &&
    isClaudeSubscriptionProviderId(claudeSubscriptionProviderId) &&
    providers.some(
      (provider) =>
        provider.id === claudeSubscriptionProviderId && isClaudeSubscriptionProvider(provider.type)
    )
  ) {
    settings.claudeSubscriptionProviderId = claudeSubscriptionProviderId
  }
  const claude = sanitizeClaudeInfo(value.claude)
  const codex = sanitizeCodexInfo(value.codex)
  const activeProviderId =
    legacyActiveProviderId && isCodexSubscriptionProviderId(legacyActiveProviderId)
      ? CODEX_SUBSCRIPTION_PROVIDER_ID
      : legacyActiveProviderId

  if (claude) settings.claude = claude
  if (codex) settings.codex = codex
  if (activeProviderId && providers.some((provider) => provider.id === activeProviderId)) {
    settings.activeProviderId = activeProviderId

    // activeModel migration: v2 stores it explicitly; a pre-v2 file has none, so backfill from the
    // active provider's own model (which was the only model it could run).
    const activeProvider = providers.find((provider) => provider.id === activeProviderId)
    const activeModel = asString(value.activeModel) ?? activeProvider?.model

    if (activeModel) settings.activeModel = activeModel
  }

  const onboardingCompletedAt = asNumber(value.onboardingCompletedAt)

  if (onboardingCompletedAt !== undefined) {
    settings.onboardingCompletedAt = onboardingCompletedAt
  }

  const disabledSkillIds = Array.isArray(value.disabledSkillIds)
    ? [
        ...new Set(
          value.disabledSkillIds.filter(
            (entry): entry is string => typeof entry === 'string' && entry !== ''
          )
        )
      ]
    : []

  if (disabledSkillIds.length > 0) {
    settings.disabledSkillIds = disabledSkillIds
  }

  const connectors = sanitizeConnectors(value.connectors)

  if (connectors) settings.connectors = connectors

  const packageMirror = sanitizePackageMirror(value.packageMirror)

  if (packageMirror) settings.packageMirror = packageMirror

  const pathsNormalizedAt = asNumber(value.pathsNormalizedAt)

  if (pathsNormalizedAt !== undefined) {
    settings.pathsNormalizedAt = pathsNormalizedAt
  }

  const legacyDataMovePromptDismissedAt = asNumber(value.legacyDataMovePromptDismissedAt)

  if (legacyDataMovePromptDismissedAt !== undefined) {
    settings.legacyDataMovePromptDismissedAt = legacyDataMovePromptDismissedAt
  }

  // Only accept an absolute, normalized dataRoot. A relative path (corrupt or hand-edited
  // settings.json) would make the entire data tree resolve against process.cwd(); drop it so
  // initDataRoot falls back to the default. Mirrors the OPEN_SCIENCE_STORAGE_ROOT absolute contract.
  const dataRoot = asString(value.dataRoot)?.trim()

  if (dataRoot && isAbsolute(dataRoot)) {
    // normalize collapses redundant separators; strip any trailing separator so the stored form
    // matches dataRootForPicked's canonical (no-trailing-slash) output — samePath() compares exact
    // strings, so a stray trailing slash would wrongly fail the "is default" check. Never strip past a
    // filesystem root, though: turning "C:\" into "C:" would make an absolute path drive-relative.
    const normalized = normalize(dataRoot)
    const { root } = parse(normalized)
    settings.dataRoot =
      normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
  }

  // Selected agent backend; only the known ids survive so a bad value can't leak through.
  const agentFrameworkId = asString(value.agentFrameworkId)

  if (
    agentFrameworkId === 'claude-code' ||
    agentFrameworkId === 'opencode' ||
    agentFrameworkId === 'codex'
  ) {
    settings.agentFrameworkId = agentFrameworkId
  }

  // Reasoning-effort preference; only the known levels survive so a bad value can't leak through.
  const reasoningEffort = asString(value.reasoningEffort)

  if (isReasoningEffort(reasoningEffort)) {
    settings.reasoningEffort = reasoningEffort
  }

  // Desktop-notification preference; only a real boolean survives.
  const notificationsEnabled = asBoolean(value.notificationsEnabled)

  if (notificationsEnabled !== undefined) {
    settings.notificationsEnabled = notificationsEnabled
  }

  const closePreference = asString(value.closePreference)

  if (closePreference === 'minimize' || closePreference === 'quit') {
    settings.closePreference = closePreference
  }

  const opencodePath = asString(value.opencodePath)

  if (opencodePath) {
    settings.opencodePath = opencodePath

    const opencodeVersion = asString(value.opencodeVersion)
    if (opencodeVersion) settings.opencodeVersion = opencodeVersion
  }

  const notebookRuntimes = sanitizeNotebookRuntimes(value.notebookRuntimes)

  if (notebookRuntimes) {
    settings.notebookRuntimes = notebookRuntimes
  }

  const notebookRuntimeEnablement = sanitizeRuntimeEnablement(value.notebookRuntimeEnablement)

  if (notebookRuntimeEnablement) {
    settings.notebookRuntimeEnablement = notebookRuntimeEnablement
  }

  const notebookManualInterpreters = sanitizeManualInterpreters(value.notebookManualInterpreters)

  if (notebookManualInterpreters) {
    settings.notebookManualInterpreters = notebookManualInterpreters
  }

  // Persist project-scope compute grants. Unknown/corrupt entries are dropped; well-formed ones
  // are preserved. Empty array is omitted (same as absent).
  const computeGrants = Array.isArray(value.computeGrants)
    ? value.computeGrants
        .map(sanitizeComputeGrant)
        .filter((g): g is StoredComputeGrant => g !== undefined)
    : undefined

  if (computeGrants && computeGrants.length > 0) {
    settings.computeGrants = computeGrants
  }

  return settings
}

// Validates the per-language manual-interpreter catalog: a map of language -> array of non-empty,
// de-duplicated absolute-ish path strings. Non-string / empty entries are dropped; an empty result for
// a language is omitted, and an empty overall map returns undefined (so it is not persisted).
const sanitizeManualInterpreters = (
  value: unknown
): Partial<Record<NotebookLanguage, string[]>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, string[]>> = {}
  for (const language of ['python', 'r'] as const) {
    const paths = asStringArray(value[language])
    const cleaned = [...new Set((paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0))]
    if (cleaned.length > 0) result[language] = cleaned
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Validates one persisted RuntimeSelection. 'managed' carries no extra fields; 'external' requires a
// non-empty interpreter path and coerces the two boolean flags (default false — a persisted external
// env is read-only and not an app overlay unless explicitly recorded). Anything else -> undefined
// (dropped), so a corrupt entry can never grant unexpected package-write authority.
const sanitizeRuntimeSelection = (value: unknown): RuntimeSelection | undefined => {
  if (!isRecord(value)) return undefined
  if (value.source === 'managed') return { source: 'managed' }
  if (value.source === 'external') {
    const interpreterPath = asString(value.interpreterPath)
    if (!interpreterPath) return undefined
    const interpreterArgs = asStringArray(value.interpreterArgs)
    return {
      source: 'external',
      interpreterPath,
      ...(interpreterArgs.length > 0 ? { interpreterArgs } : {}),
      appOwnedOverlay: value.appOwnedOverlay === true,
      packageInstallAuthorized: value.packageInstallAuthorized === true
    }
  }
  return undefined
}

// Per-language runtime selections; only the known languages are kept, invalid entries dropped. Returns
// undefined when nothing valid is present so the field stays absent (== "use the managed default").
const sanitizeNotebookRuntimes = (
  value: unknown
): Partial<Record<NotebookLanguage, RuntimeSelection>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, RuntimeSelection>> = {}
  for (const language of ['python', 'r'] as const) {
    const selection = sanitizeRuntimeSelection(value[language])
    // R is managed-only in v1 (the external resolver + overlay are Python-specific), so an external R
    // selection is rejected here rather than reaching a broken code path from a hand-edited file.
    if (!selection) continue
    if (language === 'r' && selection.source === 'external') continue
    result[language] = selection
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Rebuilds one language's RuntimeEnablement, keeping only string->boolean entries in both maps and
// dropping any non-object input. A hand-edited or corrupt entry can therefore never grant unexpected
// enablement or package-write authority (a bad value simply falls back to the provenance default).
const sanitizeRuntimeEnablementEntry = (value: unknown): RuntimeEnablement => ({
  enabled: asBooleanRecord(isRecord(value) ? value.enabled : undefined),
  installAuthorized: asBooleanRecord(isRecord(value) ? value.installAuthorized : undefined)
})

// Per-language v4 enablement; only the known languages are kept, empty entries dropped. Returns
// undefined when nothing valid is present so the field stays absent (== "use the provenance default").
const sanitizeRuntimeEnablement = (
  value: unknown
): Partial<Record<NotebookLanguage, RuntimeEnablement>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, RuntimeEnablement>> = {}
  for (const language of ['python', 'r'] as const) {
    const entry = sanitizeRuntimeEnablementEntry(value[language])
    if (
      Object.keys(entry.enabled).length === 0 &&
      Object.keys(entry.installAuthorized).length === 0
    ) {
      continue
    }
    result[language] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Owns durable reads/writes of the single settings.json document. Writes are serialized through a
// queue and made atomic (temp + rename); an unreadable file falls back to empty settings so the app
// still boots into onboarding. All secret handling lives above this layer (crypto.ts / service.ts);
// the repository only persists whatever records it is given.
class SettingsRepository {
  private saveQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0

  constructor(private readonly storageDir: string) {}

  private get settingsPath(): string {
    return join(this.storageDir, SETTINGS_FILE)
  }

  // Reads and sanitizes the settings document, returning empty settings when nothing is stored yet.
  async getSettings(): Promise<StoredSettings> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')

      return sanitizeSettings(JSON.parse(raw) as unknown)
    } catch {
      return createEmptySettings()
    }
  }

  // Inserts or replaces a provider by id, then returns the persisted document. An existing provider is
  // replaced in place so the list keeps its creation order (editing or re-testing must not reorder it);
  // a new provider is appended.
  async upsertProvider(provider: StoredProvider): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const index = settings.providers.findIndex((existing) => existing.id === provider.id)
      const providers = [...settings.providers]

      if (index >= 0) providers[index] = provider
      else providers.push(provider)

      return {
        ...settings,
        providers,
        ...(isClaudeSubscriptionProvider(provider.type) &&
        isClaudeSubscriptionProviderId(provider.id)
          ? { claudeSubscriptionProviderId: provider.id }
          : {})
      }
    })
  }

  // Updates the single claude-isolated provider record (id is fixed at builtin-claude-isolated).
  // The patch carries only the key-bearing fields the controller writes — model/lastValidatedAt/etc
  // stay on whatever the renderer/service previously set, so a paste does not stomp the validated-at
  // timestamp the validation flow recorded. When the record does not exist yet (a fresh install's
  // first paste) it is created with the fixed id/name, mirroring codex's single subscription record.
  async upsertClaudeIsolatedProvider(
    patch: Partial<
      Pick<StoredProvider, 'keyRef' | 'keyMask' | 'lastValidatedAt' | 'lastValidationFailure'>
    >
  ): Promise<StoredSettings> {
    const identity = claudeIsolatedProviderIdentity()

    return this.mutate((settings) => {
      const index = settings.providers.findIndex(
        (existing) => existing.id === CLAUDE_ISOLATED_PROVIDER_ID
      )

      if (index >= 0) {
        const providers = [...settings.providers]

        providers[index] = { ...providers[index], ...patch }
        return { ...settings, providers }
      }

      const created: StoredProvider = {
        id: identity.id,
        type: 'claude-isolated',
        name: identity.name
      }

      return { ...settings, providers: [...settings.providers, { ...created, ...patch }] }
    })
  }

  async updateClaudeIsolatedCredentialsIfExists(
    patch: Pick<StoredProvider, 'keyRef' | 'keyMask'>
  ): Promise<boolean> {
    let applied = false

    await this.mutate((settings) => {
      const index = settings.providers.findIndex(
        (provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID
      )
      if (index < 0) return settings

      const providers = [...settings.providers]
      providers[index] = { ...providers[index], ...patch }
      applied = true

      return { ...settings, providers }
    })

    return applied
  }

  // Records a probe result only while the credential that was probed is still current. Login probes
  // run a subprocess and can overlap logout, deletion, edits, or a second paste; comparing inside the
  // serialized mutation prevents a stale result from restoring an old provider snapshot or marking a
  // replacement token as verified.
  async updateClaudeIsolatedValidationIfKeyMatches(
    expectedKeyRef: string | undefined,
    patch: Pick<StoredProvider, 'expiresAt' | 'lastValidatedAt' | 'lastValidationFailure'>
  ): Promise<boolean> {
    let applied = false

    await this.mutate((settings) => {
      const index = settings.providers.findIndex(
        (provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID
      )
      if (index < 0 || settings.providers[index].keyRef !== expectedKeyRef) return settings

      const providers = [...settings.providers]
      providers[index] = { ...providers[index], ...patch }
      applied = true

      return { ...settings, providers }
    })

    return applied
  }

  async updateClaudeSharedValidationIfUnchanged(
    expectedProvider: StoredProvider,
    expectedPreferredMode: ClaudeSubscriptionProviderId | undefined,
    expectedResolvedModel: string | undefined,
    patch: Pick<StoredProvider, 'disconnectedAt' | 'lastValidatedAt' | 'lastValidationFailure'>
  ): Promise<boolean> {
    let applied = false

    await this.mutate((settings) => {
      const index = settings.providers.findIndex(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )
      if (index < 0) return settings

      const currentProvider = settings.providers[index]
      // Only the effective shared-Claude target belongs in this CAS. Models selected on unrelated
      // active providers do not change what the completed shared probe actually verified.
      const currentResolvedModel =
        settings.activeProviderId === CLAUDE_SHARED_PROVIDER_ID
          ? (settings.activeModel ?? currentProvider?.model)
          : currentProvider?.model
      if (
        settings.claudeSubscriptionProviderId !== expectedPreferredMode ||
        currentResolvedModel !== expectedResolvedModel ||
        !isDeepStrictEqual(currentProvider, expectedProvider)
      ) {
        return settings
      }

      const providers = [...settings.providers]
      providers[index] = { ...providers[index], ...patch }
      applied = true

      return { ...settings, providers }
    })

    return applied
  }

  // Removes a provider and clears the active pointer (and model) when it referenced the removed one.
  // Claude's two fixed records are one collapsed provider in the UI, so deleting either id removes
  // the whole subscription group atomically, including its persisted display preference.
  async deleteProvider(id: string): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const deletingClaudeSubscription = isClaudeSubscriptionProviderId(id)
      const removedIds = new Set(
        settings.providers
          .filter(
            (provider) =>
              provider.id === id ||
              (deletingClaudeSubscription && isClaudeSubscriptionProvider(provider.type))
          )
          .map((provider) => provider.id)
      )
      const providers = settings.providers.filter((provider) => !removedIds.has(provider.id))
      const clearedActive =
        settings.activeProviderId !== undefined && removedIds.has(settings.activeProviderId)
      const activeProviderId = clearedActive ? undefined : settings.activeProviderId
      const activeModel = clearedActive ? undefined : settings.activeModel

      return {
        ...settings,
        providers,
        activeProviderId,
        activeModel,
        ...(deletingClaudeSubscription ? { claudeSubscriptionProviderId: undefined } : {})
      }
    })
  }

  // Sets (or clears) the active provider pointer and its model, ignoring ids that do not exist. The
  // caller (service) resolves the concrete model, so an undefined model here clears it.
  async setActiveProvider(id: string | undefined, model?: string): Promise<StoredSettings> {
    return this.mutate((settings) => {
      if (id !== undefined && !settings.providers.some((provider) => provider.id === id)) {
        return settings
      }

      return {
        ...settings,
        activeProviderId: id,
        activeModel: id === undefined ? undefined : model,
        ...(id !== undefined && isClaudeSubscriptionProviderId(id)
          ? { claudeSubscriptionProviderId: id }
          : {})
      }
    })
  }

  // Records the detected claude executable metadata for later spawns.
  async setClaudeInfo(claude: ClaudeInfo): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, claude }))
  }

  // Sets (or clears back to public hosts when empty) the package-mirror configuration.
  async setPackageMirror(mirror: PackageMirror): Promise<StoredSettings> {
    const sanitized = sanitizePackageMirror(mirror)

    return this.mutate((settings) => ({ ...settings, packageMirror: sanitized }))
  }

  // Persists the selected agent backend; applied on the next reconnect.
  async setAgentFramework(id: AgentFrameworkId): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, agentFrameworkId: id }))
  }

  // Persists the reasoning-effort preference; applied to sessions created after the next reconnect.
  async setReasoningEffort(effort: ReasoningEffort): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, reasoningEffort: effort }))
  }

  // Persists the desktop-notification preference; read fresh at notification time so it applies
  // immediately, without a restart.
  async setNotificationsEnabled(enabled: boolean): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, notificationsEnabled: enabled }))
  }

  // Persists the Windows titlebar-close behavior; undefined restores the confirmation dialog.
  async setClosePreference(preference: CloseActionPreference | undefined): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, closePreference: preference }))
  }

  // Records the detected opencode executable path + version for later spawns + the settings status card.
  async setOpencodeInfo(resolvedPath: string, version?: string): Promise<StoredSettings> {
    return this.mutate((settings) => ({
      ...settings,
      opencodePath: resolvedPath,
      opencodeVersion: version
    }))
  }

  async setCodexInfo(codex: StoredCodexInfo): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, codex }))
  }

  async clearCodexInfo(): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const { codex, ...rest } = settings

      void codex
      return rest
    })
  }

  // Forgets the recorded opencode executable so the status card and gates reflect an uninstall. Called
  // when a re-detect finds nothing; otherwise a stale path lingers and a spawn against the gone binary
  // fails with EPIPE.
  async clearOpencodeInfo(): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const { opencodePath, opencodeVersion, ...rest } = settings

      void opencodePath
      void opencodeVersion

      return rest
    })
  }

  // Stamps the onboarding-completed time exactly once; later calls leave the first value intact.
  async markOnboardingComplete(timestamp: number): Promise<StoredSettings> {
    return this.mutate((settings) =>
      settings.onboardingCompletedAt === undefined
        ? { ...settings, onboardingCompletedAt: timestamp }
        : settings
    )
  }

  // Stamps the legacy-path-normalization completion time exactly once; later calls leave the first
  // value intact, so a caller can safely call this every launch once the pass has succeeded.
  async markPathsNormalized(timestamp: number): Promise<StoredSettings> {
    return this.mutate((settings) =>
      settings.pathsNormalizedAt === undefined
        ? { ...settings, pathsNormalizedAt: timestamp }
        : settings
    )
  }

  // Stamps the legacy-data-move prompt as answered exactly once (moved, relocated, or declined);
  // later calls leave the first value intact, so the prompt is never shown again.
  async markLegacyDataMovePromptDismissed(timestamp: number): Promise<StoredSettings> {
    return this.mutate((settings) =>
      settings.legacyDataMovePromptDismissedAt === undefined
        ? { ...settings, legacyDataMovePromptDismissedAt: timestamp }
        : settings
    )
  }

  // Persists the new data-root path after a successful migration (see storage/migration-service.ts).
  // Unlike the marker fields above this is not idempotent-once: each call overwrites the prior value.
  async setDataRoot(path: string): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, dataRoot: path }))
  }

  // Sets (or clears, when `selection` is null) the persisted runtime choice for one language. The
  // value is run through the SAME sanitizer used on read, so a bad selection can never be persisted;
  // external R is rejected here too (managed-only in v1, mirroring sanitizeNotebookRuntimes). Clearing
  // deletes the language's entry and drops the whole `notebookRuntimes` map when it becomes empty, so
  // an absent map keeps meaning "use the managed default".
  async setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<StoredSettings> {
    const sanitized = selection === null ? null : sanitizeRuntimeSelection(selection)

    if (selection !== null && !sanitized) {
      throw new Error('Invalid runtime selection.')
    }
    if (sanitized && language === 'r' && sanitized.source === 'external') {
      throw new Error('R only supports the managed runtime.')
    }

    return this.mutate((settings) => {
      const current: Partial<Record<NotebookLanguage, RuntimeSelection>> = {
        ...settings.notebookRuntimes
      }

      if (sanitized === null) delete current[language]
      else current[language] = sanitized

      const notebookRuntimes = Object.keys(current).length > 0 ? current : undefined

      return { ...settings, notebookRuntimes }
    })
  }

  // Replaces one language's v4 RuntimeEnablement (the explicit enabled-override + install-auth maps).
  // The value is run through the SAME sanitizer used on read, so a corrupt entry can never be
  // persisted. An entry that sanitizes to empty (both maps empty) deletes the language's entry, and
  // the whole `notebookRuntimeEnablement` map is dropped once it becomes empty, so an absent map keeps
  // meaning "use the provenance default".
  async setRuntimeEnablement(
    language: NotebookLanguage,
    enablement: RuntimeEnablement
  ): Promise<StoredSettings> {
    const sanitized = sanitizeRuntimeEnablementEntry(enablement)
    const isEmpty =
      Object.keys(sanitized.enabled).length === 0 &&
      Object.keys(sanitized.installAuthorized).length === 0

    return this.mutate((settings) => {
      const current: Partial<Record<NotebookLanguage, RuntimeEnablement>> = {
        ...settings.notebookRuntimeEnablement
      }

      if (isEmpty) delete current[language]
      else current[language] = sanitized

      const notebookRuntimeEnablement = Object.keys(current).length > 0 ? current : undefined

      return { ...settings, notebookRuntimeEnablement }
    })
  }

  // Replaces one language's manual-interpreter catalog (the paths the user added via "Add interpreter…").
  // Sanitized like on read (trim + dedupe + drop empties); an empty list deletes the language's entry,
  // and the whole map is dropped once empty, so an absent map keeps meaning "no manual interpreters".
  async setManualInterpreters(
    language: NotebookLanguage,
    paths: string[]
  ): Promise<StoredSettings> {
    const cleaned = [...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0))]

    return this.mutate((settings) => {
      const current: Partial<Record<NotebookLanguage, string[]>> = {
        ...settings.notebookManualInterpreters
      }

      if (cleaned.length === 0) delete current[language]
      else current[language] = cleaned

      const notebookManualInterpreters = Object.keys(current).length > 0 ? current : undefined

      return { ...settings, notebookManualInterpreters }
    })
  }

  // Adds or removes a skill id from the disabled set (default-on model), returning the new document.
  async setSkillEnabled(id: string, enabled: boolean): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const current = new Set(settings.disabledSkillIds ?? [])

      if (enabled) current.delete(id)
      else current.add(id)

      const disabledSkillIds = [...current]

      return disabledSkillIds.length > 0
        ? { ...settings, disabledSkillIds }
        : { ...settings, disabledSkillIds: undefined }
    })
  }

  // Adds or removes a bundled connector id from the disabled set (default-on model).
  async setConnectorDisabled(id: string, disabled: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      const set = new Set(connectors.disabledConnectorIds ?? [])
      if (disabled) set.add(id)
      else set.delete(id)
      connectors.disabledConnectorIds = set.size > 0 ? [...set] : undefined
    })
  }

  // Adds or removes a connector id from the "skip approvals" auto-allow set.
  async setConnectorAutoAllow(id: string, autoAllow: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      const set = new Set(connectors.autoAllowIds ?? [])
      if (autoAllow) set.add(id)
      else set.delete(id)
      connectors.autoAllowIds = [...set]
    })
  }

  // Adds or removes a "<connector>/<method>" id from the per-tool blocklist.
  async setToolBlocked(toolId: string, blocked: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      const set = new Set(connectors.blockedToolIds ?? [])
      if (blocked) set.add(toolId)
      else set.delete(toolId)
      connectors.blockedToolIds = set.size > 0 ? [...set] : undefined
    })
  }

  // Sets a tool's full policy (ask / blocked) in one write. A tool is never in both sets; a tool in
  // neither is at the default (allow, no prompt).
  async setToolPolicy(toolId: string, ask: boolean, blocked: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      const askSet = new Set(connectors.askToolIds ?? [])
      const block = new Set(connectors.blockedToolIds ?? [])
      if (ask) askSet.add(toolId)
      else askSet.delete(toolId)
      if (blocked) block.add(toolId)
      else block.delete(toolId)
      connectors.askToolIds = askSet.size > 0 ? [...askSet] : undefined
      connectors.blockedToolIds = block.size > 0 ? [...block] : undefined
    })
  }

  // Sets or clears the shared research-service contact email and the NCBI API key reference.
  async setNcbiCredentials(
    contactEmail: string | undefined,
    apiKeyRef: string | undefined
  ): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.contactEmail = contactEmail || undefined
      connectors.ncbiApiKeyRef = apiKeyRef || undefined
    })
  }

  // Appends a fully-formed custom MCP server record.
  async addCustomServer(server: StoredCustomMcpServer): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.customMcpServers = [...(connectors.customMcpServers ?? []), server]
    })
  }

  // Removes a custom MCP server by id (and any stale per-tool blocks under its name).
  async removeCustomServer(id: string): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      const removed = (connectors.customMcpServers ?? []).find((s) => s.id === id)
      connectors.customMcpServers = (connectors.customMcpServers ?? []).filter((s) => s.id !== id)
      if (removed && connectors.blockedToolIds) {
        const prefix = `${removed.name}/`
        const kept = connectors.blockedToolIds.filter((t) => !t.startsWith(prefix))
        connectors.blockedToolIds = kept.length > 0 ? kept : undefined
      }
    })
  }

  // Enables or disables one custom MCP server by id.
  async setCustomServerEnabled(id: string, enabled: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.customMcpServers = (connectors.customMcpServers ?? []).map((s) =>
        s.id === id ? { ...s, enabled } : s
      )
    })
  }

  // Replaces one custom MCP server record (identity fields must be preserved by the caller).
  async updateCustomServer(id: string, server: StoredCustomMcpServer): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.customMcpServers = (connectors.customMcpServers ?? []).map((s) =>
        s.id === id ? server : s
      )
    })
  }

  // Sets the bookmark folders for a provider_id in settings.computeBookmarks. Replaces the full
  // array for that provider; pass [] to clear. Used by the remote file browser Go-to/Pin feature.
  async setComputeBookmarks(providerId: string, folders: string[]): Promise<StoredSettings> {
    return this.mutate((settings) => ({
      ...settings,
      computeBookmarks: {
        ...(settings.computeBookmarks ?? {}),
        [providerId]: folders
      }
    }))
  }

  // Read-modify-write over the connectors block, seeding an empty block on first mutation.
  private mutateConnectors(fn: (connectors: StoredConnectors) => void): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const connectors: StoredConnectors = {
        enabledIds: [],
        autoAllowIds: [],
        ...settings.connectors
      }
      fn(connectors)
      return { ...settings, connectors }
    })
  }

  // Adds a project-scope compute grant if one with the same key does not already exist.
  // Deduplicates so repeated calls are idempotent. Grant key = (projectId, operation, providerId).
  async addComputeGrant(grant: StoredComputeGrant): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const existing = settings.computeGrants ?? []
      const alreadyPresent = existing.some(
        (g) =>
          g.projectId === grant.projectId &&
          g.operation === grant.operation &&
          g.providerId === grant.providerId
      )
      if (alreadyPresent) return settings
      return { ...settings, computeGrants: [...existing, grant] }
    })
  }

  // Returns true when a project-scope grant matching (projectId, operation, providerId) exists.
  async hasComputeGrant(grant: StoredComputeGrant): Promise<boolean> {
    const settings = await this.getSettings()
    return (settings.computeGrants ?? []).some(
      (g) =>
        g.projectId === grant.projectId &&
        g.operation === grant.operation &&
        g.providerId === grant.providerId
    )
  }

  // Serializes a read-modify-write cycle so concurrent callers cannot clobber each other.
  private mutate(update: (settings: StoredSettings) => StoredSettings): Promise<StoredSettings> {
    const run = this.saveQueue.then(async () => {
      const current = await this.getSettings()
      const next = update(current)

      await this.writeSettings(next)

      return next
    })

    // Keep the queue chained even when a write rejects so later mutations still run.
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  // Writes through a unique temp file, then atomically replaces settings.json.
  private async writeSettings(settings: StoredSettings): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })

    this.writeSequence += 1
    const temporaryPath = `${this.settingsPath}.${Date.now()}-${this.writeSequence}.tmp`

    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.settingsPath)
  }
}

export { SettingsRepository, sanitizeSettings }
