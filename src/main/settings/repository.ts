import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, parse } from 'node:path'

import type {
  AgentFrameworkId,
  ClaudeInfo,
  ProviderType,
  ProviderValidationFailure,
  ValidationCategory
} from '../../shared/settings'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { isOfficialVendorId } from '../../shared/provider-registry'
import {
  createEmptySettings,
  type StoredConnectors,
  type StoredCustomMcpServer,
  type StoredProvider,
  type StoredSettings
} from './types'

const SETTINGS_FILE = 'settings.json'

const PROVIDER_TYPES = new Set<ProviderType>(['custom', 'claude-default', 'official'])

const VALIDATION_CATEGORIES = new Set<ValidationCategory>([
  'ok',
  'network',
  'auth',
  'model-not-found',
  'bad-url',
  'timeout',
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
const sanitizeProvider = (value: unknown): StoredProvider | undefined => {
  if (!isRecord(value)) return undefined

  const id = asString(value.id)
  const type = asString(value.type) as ProviderType | undefined
  const name = asString(value.name)

  if (!id || !type || !PROVIDER_TYPES.has(type) || name === undefined) return undefined

  // An official provider without a recognizable vendor is unusable (no base URL/catalog to resolve),
  // so drop the corrupt record rather than keep a provider that can never spawn or validate.
  const vendorId = isOfficialVendorId(value.vendorId) ? value.vendorId : undefined

  if (type === 'official' && !vendorId) return undefined

  const provider: StoredProvider = { id, type, name }
  const baseUrl = asString(value.baseUrl)
  const model = asString(value.model)
  const region = asString(value.region)
  const keyRef = asString(value.keyRef)
  const keyMask = asString(value.keyMask)
  const lastValidatedAt = asNumber(value.lastValidatedAt)
  const lastValidationFailure = sanitizeValidationFailure(value.lastValidationFailure)
  // Keep only a clean list of non-empty string model ids.
  const fetchedModels = Array.isArray(value.fetchedModels)
    ? value.fetchedModels.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
    : undefined

  // Preserve the provider's chat-API type through the read; only known values survive.
  const apiType = asString(value.apiType)

  if (baseUrl) provider.baseUrl = baseUrl
  if (model) provider.model = model
  if (apiType === 'anthropic' || apiType === 'openai' || apiType === 'both') {
    provider.apiType = apiType
  }
  if (vendorId) provider.vendorId = vendorId
  if (region) provider.region = region
  if (fetchedModels && fetchedModels.length > 0) provider.fetchedModels = fetchedModels
  if (keyRef) provider.keyRef = keyRef
  if (keyMask) provider.keyMask = keyMask
  if (lastValidatedAt !== undefined) provider.lastValidatedAt = lastValidatedAt
  if (lastValidationFailure) provider.lastValidationFailure = lastValidationFailure

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
  if (url) server.url = url
  const headers = asStringRecord(value.headers)
  if (headers) server.headers = headers
  const trustedAt = asNumber(value.trustedAt)
  if (trustedAt !== undefined) server.trustedAt = trustedAt
  const description = asString(value.description)
  if (description) server.description = description

  return server
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

// Rebuilds the whole settings document, keeping activeProviderId only when it points at a provider.
const sanitizeSettings = (value: unknown): StoredSettings => {
  if (!isRecord(value)) return createEmptySettings()

  const providers = Array.isArray(value.providers)
    ? value.providers
        .map(sanitizeProvider)
        .filter((provider): provider is StoredProvider => !!provider)
    : []
  const settings: StoredSettings = {
    version: SETTINGS_FILE_VERSION,
    providers
  }
  const claude = sanitizeClaudeInfo(value.claude)
  const activeProviderId = asString(value.activeProviderId)

  if (claude) settings.claude = claude
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

  if (agentFrameworkId === 'claude-code' || agentFrameworkId === 'opencode') {
    settings.agentFrameworkId = agentFrameworkId
  }

  const opencodePath = asString(value.opencodePath)

  if (opencodePath) {
    settings.opencodePath = opencodePath
  }

  return settings
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

      return { ...settings, providers }
    })
  }

  // Removes a provider and clears the active pointer (and model) when it referenced the removed one.
  async deleteProvider(id: string): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const providers = settings.providers.filter((provider) => provider.id !== id)
      const clearedActive = settings.activeProviderId === id
      const activeProviderId = clearedActive ? undefined : settings.activeProviderId
      const activeModel = clearedActive ? undefined : settings.activeModel

      return { ...settings, providers, activeProviderId, activeModel }
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
        activeModel: id === undefined ? undefined : model
      }
    })
  }

  // Records the detected claude executable metadata for later spawns.
  async setClaudeInfo(claude: ClaudeInfo): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, claude }))
  }

  // Persists the selected agent backend; applied on the next reconnect.
  async setAgentFramework(id: AgentFrameworkId): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, agentFrameworkId: id }))
  }

  // Records the detected opencode executable path for later spawns + the settings status card.
  async setOpencodePath(path: string): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, opencodePath: path }))
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
