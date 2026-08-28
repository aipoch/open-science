import { isDeepStrictEqual } from 'node:util'
import type {
  AgentFrameworkId,
  AppIconVariant,
  ClaudeSubscriptionProviderId,
  ClaudeInfo,
  ProjectFilesFilterPreference,
  ReasoningEffort
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  claudeIsolatedProviderIdentity,
  isClaudeSubscriptionProvider,
  isClaudeSubscriptionProviderId
} from '../../shared/settings'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { PackageMirror } from '../../shared/mirror'
import {
  networkProxyValidationMessage,
  normalizeNetworkProxySettings,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { CloseActionPreference } from '../../shared/window-controls'
import type { LanguagePreference } from '../../shared/locale'
import {
  type StoredComputeGrant,
  type StoredConnectors,
  type StoredCodexInfo,
  type StoredCustomMcpServer,
  type StoredProvider,
  type StoredSettings
} from './types'
import { sanitizePackageMirror } from './record-codec'
import { sanitizeSettings } from './document-codec'
import { SettingsDocumentStore } from './document-store'
import {
  appendCustomServer,
  beginCustomServerDeletion,
  completeCustomServerDeletion
} from './custom-server-identity'
import {
  buildReviewerModelMutation,
  buildSessionDetailsModelMutation,
  buildSubagentModelMutation,
  buildVisionModelMutation
} from './subagent-model-settings'

type SkillMutationGuard = <T>(operation: () => Promise<T>) => Promise<T>
type Write = Promise<StoredSettings>
type DataRootUpdate = Readonly<{ dataRoot: string; onboardingCompletedAt?: number }>

// Stable mutation facade; the document store owns atomic IO, and secrets stay above this layer.
class SettingsRepository {
  private readonly store: SettingsDocumentStore

  constructor(
    storage: string | SettingsDocumentStore,
    private readonly guardSkillMutation?: SkillMutationGuard
  ) {
    this.store = typeof storage === 'string' ? new SettingsDocumentStore(storage) : storage
  }

  // Reads and sanitizes the settings document, returning empty settings when nothing is stored yet.
  async getSettings(): Promise<StoredSettings> {
    return this.store.read()
  }

  // Inserts or replaces a provider without reordering existing entries. existingId, when supplied,
  // is checked in the same mutation so stale edits cannot append a deleted provider.
  async upsertProvider(provider: StoredProvider, existingId?: string): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const index = settings.providers.findIndex((existing) => existing.id === provider.id)
      if (existingId && !settings.providers.some(({ id }) => id === existingId))
        throw new Error('Provider no longer exists.')
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

  async setClaudeInfo(claude: ClaudeInfo): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, claude }))
  }

  async setPackageMirror(mirror: PackageMirror): Promise<StoredSettings> {
    const sanitized = sanitizePackageMirror(mirror)

    return this.mutate((settings) => ({ ...settings, packageMirror: sanitized }))
  }

  async setNetworkProxy(value: NetworkProxySettings): Promise<StoredSettings> {
    const validationMessage = networkProxyValidationMessage(value)
    const networkProxy = normalizeNetworkProxySettings(value)
    if (validationMessage || !networkProxy) {
      throw new Error(validationMessage ?? 'The proxy configuration is invalid.')
    }

    return this.mutate((settings) => {
      if (networkProxy.mode !== 'system') return { ...settings, networkProxy }
      const next = { ...settings }
      delete next.networkProxy
      return next
    })
  }

  async setAgentFramework(id: AgentFrameworkId): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, agentFrameworkId: id }))
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, reasoningEffort: effort }))
  }
  async setSubagentModel(
    ...args: Parameters<typeof buildSubagentModelMutation>
  ): Promise<StoredSettings> {
    return this.mutate(buildSubagentModelMutation(...args))
  }
  async setReviewerModel(
    ...args: Parameters<typeof buildReviewerModelMutation>
  ): Promise<StoredSettings> {
    return this.mutate(buildReviewerModelMutation(...args))
  }
  async setSessionDetailsModel(
    ...args: Parameters<typeof buildSessionDetailsModelMutation>
  ): Promise<StoredSettings> {
    return this.mutate(buildSessionDetailsModelMutation(...args))
  }
  async setVisionModel(
    ...args: Parameters<typeof buildVisionModelMutation>
  ): Promise<StoredSettings> {
    return this.mutate(buildVisionModelMutation(...args))
  }
  async setNotificationsEnabled(enabled: boolean): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, notificationsEnabled: enabled }))
  }

  async setConversationSkillImportEnabled(enabled: boolean): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, conversationSkillImportEnabled: enabled }))
  }
  async setLocalePreference(preference: LanguagePreference): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, localePreference: preference }))
  }

  async setClosePreference(preference: CloseActionPreference | undefined): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, closePreference: preference }))
  }

  async setAppIconVariant(variant: AppIconVariant): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, appIconVariant: variant }))
  }

  async setDefaultPermissionProfile(profile: PermissionProfileId): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, defaultPermissionProfile: profile }))
  }

  async setProjectFilesFilter(
    filter: ProjectFilesFilterPreference | undefined
  ): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...settings, projectFilesFilter: filter }))
  }

  // Removes settings.grantedLocalRoots after its one-time import; production never writes it again.
  async clearGrantedLocalRoots(): Promise<void> {
    await this.mutate((settings) => {
      const next = { ...settings }
      delete next.grantedLocalRoots
      return next
    })
  }

  // Records the detected opencode executable path + version for later spawns + the settings status card.
  async setOpencodeInfo(resolvedPath: string, version?: string): Promise<StoredSettings> {
    return this.mutate((settings) => ({
      ...settings,
      opencodePath: resolvedPath,
      opencodeVersion: version
    }))
  }

  async setCodeBuddyInfo(resolvedPath: string, version?: string): Promise<StoredSettings> {
    return this.mutate((settings) => ({
      ...settings,
      codebuddyPath: resolvedPath,
      codebuddyVersion: version
    }))
  }

  async clearCodeBuddyInfo(): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const { codebuddyPath, codebuddyVersion, ...rest } = settings
      void codebuddyPath
      void codebuddyVersion
      return rest
    })
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

  // Persists the relocatable data root, optionally with the idempotent onboarding marker.
  async setDataRoot(update: DataRootUpdate): Promise<StoredSettings> {
    return this.mutate((settings) => ({ ...update, ...settings, dataRoot: update.dataRoot }))
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
    const sanitized =
      selection === null
        ? null
        : sanitizeSettings({ notebookRuntimes: { python: selection } }).notebookRuntimes?.python

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

  // Applies one RuntimeEnablement change to the latest persisted value inside the write queue.
  async setRuntimeEnablement(
    language: NotebookLanguage,
    update: (current: RuntimeEnablement) => RuntimeEnablement
  ): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const current = settings.notebookRuntimeEnablement?.[language]
      const enablement = update({
        enabled: { ...current?.enabled },
        installAuthorized: { ...current?.installAuthorized }
      })
      const sanitized = sanitizeSettings({ notebookRuntimeEnablement: { [language]: enablement } })
        .notebookRuntimeEnablement?.[language]
      const notebookRuntimeEnablement = { ...settings.notebookRuntimeEnablement }
      if (sanitized) notebookRuntimeEnablement[language] = sanitized
      else delete notebookRuntimeEnablement[language]
      return {
        ...settings,
        notebookRuntimeEnablement:
          Object.keys(notebookRuntimeEnablement).length > 0 ? notebookRuntimeEnablement : undefined
      }
    })
  }

  // Applies one catalog change to the latest persisted paths inside the write queue.
  async setManualInterpreters(
    language: NotebookLanguage,
    update: (current: string[]) => string[]
  ): Promise<StoredSettings> {
    return this.mutate((settings) => {
      const paths = update([...(settings.notebookManualInterpreters?.[language] ?? [])])
      const cleaned = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
      const notebookManualInterpreters = { ...settings.notebookManualInterpreters }
      if (cleaned.length > 0) notebookManualInterpreters[language] = cleaned
      else delete notebookManualInterpreters[language]
      return {
        ...settings,
        notebookManualInterpreters:
          Object.keys(notebookManualInterpreters).length > 0
            ? notebookManualInterpreters
            : undefined
      }
    })
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<StoredSettings> {
    return this.setSkillsEnabled([id], enabled)
  }

  async setSkillsEnabled(ids: string[], enabled: boolean): Promise<StoredSettings> {
    const update = (): Promise<StoredSettings> =>
      this.mutate((settings) => {
        const disabled = new Set(settings.disabledSkillIds ?? [])
        for (const id of ids) enabled ? disabled.delete(id) : disabled.add(id)
        return { ...settings, disabledSkillIds: disabled.size ? [...disabled] : undefined }
      })
    return this.guardSkillMutation ? this.guardSkillMutation(update) : update()
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

  async setGitHubToken(
    tokenRef: string | undefined,
    tokenMask: string | undefined
  ): Promise<StoredSettings> {
    return this.mutate((settings) => ({
      ...settings,
      githubTokenRef: tokenRef || undefined,
      githubTokenMask: tokenMask || undefined
    }))
  }

  // Appends a fully-formed custom MCP server record.
  async addCustomServer(server: StoredCustomMcpServer): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.customMcpServers = appendCustomServer(
        connectors.customMcpServers,
        server,
        connectors.pendingCustomServerDeletionIds
      )
    })
  }

  // Removes a custom MCP server and journals its id until permission cleanup is durable.
  async removeCustomServer(id: string): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => beginCustomServerDeletion(connectors, id))
  }

  async completeCustomServerDeletion(id: string): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => completeCustomServerDeletion(connectors, id))
  }

  // Enables or disables one custom MCP server by id.
  async setCustomServerEnabled(id: string, enabled: boolean): Promise<StoredSettings> {
    return this.mutateConnectors((connectors) => {
      connectors.customMcpServers = (connectors.customMcpServers ?? []).map((s) =>
        s.id === id ? { ...s, enabled } : s
      )
    })
  }

  // Replaces one custom MCP server record; background migrations may ignore a concurrently deleted id.
  async updateCustomServer(id: string, server: StoredCustomMcpServer, allowMissing = false): Write {
    return this.mutateConnectors((connectors) => {
      const servers = connectors.customMcpServers
      if (!servers?.some(({ id: existingId }) => existingId === id) && !allowMissing)
        throw new Error(`Unknown custom connector: ${id}`)
      connectors.customMcpServers = servers?.map((stored) => (stored.id === id ? server : stored))
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

  async listComputeGrants(): Promise<StoredComputeGrant[]> {
    return [...((await this.getSettings()).computeGrants ?? [])]
  }

  async clearComputeGrants(): Promise<void> {
    await this.mutate((settings) => {
      const next = { ...settings }
      delete next.computeGrants
      return next
    })
  }

  // Serializes a read-modify-write cycle so concurrent callers cannot clobber each other.
  private mutate(update: (settings: StoredSettings) => StoredSettings): Promise<StoredSettings> {
    return this.store.mutate(update)
  }
}

export { SettingsRepository, sanitizeSettings }
export { sanitizeConnectors, sanitizeCustomMcpServer, sanitizePackageMirror } from './record-codec'
