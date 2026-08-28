import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  AddCustomServerRequest,
  ConnectorDetailView,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  ConnectorsSnapshot,
  ConnectorView,
  CustomServerView,
  NcbiCredentialsView,
  OpenAlexCredentialView,
  OpenAlexCredentialValidation,
  RemoveCustomServerRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetCustomServerEnabledRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  SetToolPermissionRequest,
  ToolPermission,
  UpdateCustomServerRequest,
  ValidateOpenAlexCredentialRequest
} from '../../shared/settings'
import { inferResourceId, validateResourceId } from '../../shared/resource-id'
import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import {
  customConnectorNameFromSkillName,
  isCustomConnectorName
} from '../../shared/custom-connector'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { isCustomMcpServerRouteSafe } from '../connectors/custom-mcp-bootstrap'
import { getConnectorTools } from '../connectors/registry'
import { encryptKey, isEncryptionAvailable, tryDecryptKey } from './crypto'
import { sanitizeCustomMcpServer, type SettingsRepository } from './repository'
import type { StoredConnectors, StoredCustomMcpOAuthState, StoredCustomMcpServer } from './types'
import { buildConnectorTemplateExport, parseConnectorTemplate } from './connector-template'
import { CustomServerIdConflictError } from './custom-server-identity'

type CustomServerSecurityChangeGuard = {
  commit(server: StoredCustomMcpServer): void
  rollback(): void
}

type CustomServerRuntimeProjectionProvider = {
  materializedSkillNames: () => readonly string[]
  availability: (id: string) => CustomServerView['availability']
  isRefreshing: (id: string) => boolean
}

const normalizeOAuthConfig = (
  oauth:
    | Exclude<AddCustomServerRequest['oauth'], null | undefined>
    | Exclude<UpdateCustomServerRequest['oauth'], null | undefined>
): NonNullable<StoredCustomMcpServer['oauth']> => ({
  ...(oauth.clientMetadataUrl?.trim() ? { clientMetadataUrl: oauth.clientMetadataUrl.trim() } : {}),
  ...(oauth.authorizationServerUrl?.trim()
    ? { authorizationServerUrl: oauth.authorizationServerUrl.trim() }
    : {}),
  ...(oauth.scopes?.length
    ? { scopes: [...new Set(oauth.scopes.map((scope) => scope.trim()).filter(Boolean))] }
    : {}),
  ...(oauth.clientId?.trim() ? { clientId: oauth.clientId.trim() } : {}),
  ...(oauth.redirectUri?.trim()
    ? { redirectUri: normalizeLoopbackOAuthRedirectUri(oauth.redirectUri.trim()) }
    : {})
})

const validateOAuthRegistration = (
  oauth: NonNullable<StoredCustomMcpServer['oauth']>,
  hasClientSecret: boolean
): void => {
  if (oauth.clientId && !oauth.authorizationServerUrl) {
    throw new Error('Authorization server URL is required for a pre-registered client.')
  }
  if (oauth.clientId && oauth.clientMetadataUrl) {
    throw new Error('Client metadata URL cannot be combined with a pre-registered client.')
  }
  if (oauth.redirectUri && !oauth.clientId) {
    throw new Error('OAuth redirect URI requires a pre-registered client ID.')
  }
  if (hasClientSecret && !oauth.clientId) {
    throw new Error('Client ID is required when a client secret is configured.')
  }
}

// Owns durable Connector policy, secret migration/projection, and custom-server mutation. Live MCP
// clients, approval decisions, Specialist bindings, and refresh workflows remain outside this module.
class ConnectorSettingsModule {
  private customServerRuntimeProjectionProvider: CustomServerRuntimeProjectionProvider = {
    materializedSkillNames: () => [],
    availability: () => undefined,
    isRefreshing: () => false
  }

  constructor(
    private readonly repository: SettingsRepository,
    private readonly openAlexFetch: typeof fetch = fetch
  ) {}

  setCustomServerRuntimeProjectionProvider(provider: CustomServerRuntimeProjectionProvider): void {
    this.customServerRuntimeProjectionProvider = provider
  }

  // Bundled connectors are default-on. Keep this projection on the durable owner so runtime
  // configuration, Skill provisioning, and renderer views all apply the same opt-out rule.
  enabledConnectorIds(connectors: StoredConnectors | undefined): string[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => meta.id).filter((id) => !disabled.has(id))
  }

  materializedCustomSkillNames(): string[] {
    const bundled = new Set(CONNECTOR_CATALOG.map((connector) => connector.id))
    return [
      ...new Set(
        this.customServerRuntimeProjectionProvider.materializedSkillNames().filter((skillName) => {
          const name = customConnectorNameFromSkillName(skillName)
          return name !== undefined && !bundled.has(name)
        })
      )
    ]
  }

  connectorSkillNames(connectors: StoredConnectors | undefined): string[] {
    const bundled = this.enabledConnectorIds(connectors).map((id) => `mcp-${id}`)
    return [...new Set([...bundled, ...this.materializedCustomSkillNames()])]
  }

  connectorSkillCatalogEntries(connectors: StoredConnectors | undefined): Array<{
    directory: string
    name: string
    description?: string
    source: 'connector'
  }> {
    const bundled = this.enabledConnectorIds(connectors).map((id) => {
      const connector = CONNECTOR_CATALOG.find((candidate) => candidate.id === id)!
      return {
        directory: `mcp-${id}`,
        name: `mcp-${id}`,
        description: connector.useWhen,
        source: 'connector' as const
      }
    })
    const custom = this.materializedCustomSkillNames().map((name) => ({
      directory: name,
      name,
      source: 'connector' as const
    }))
    return [...bundled, ...custom]
  }

  // Called from SettingsService's existing whole-settings migration path so the trigger timing and
  // provider-before-Connector ordering stay unchanged while Connector migration has one owner.
  async migrateLegacyNcbiKeyRef(connectors: StoredConnectors | undefined): Promise<boolean> {
    const ref = connectors?.ncbiApiKeyRef
    if (!ref?.startsWith('plain:')) return false
    const key = tryDecryptKey(ref)
    if (!key) return false

    await this.repository.setNcbiCredentials(connectors?.contactEmail, encryptKey(key))

    return true
  }

  // Main-process-only read used by live Connector and runtime consumers. Renderer-facing methods
  // below project secret-free views instead of exposing decrypted env/header values.
  async getConnectors(): Promise<StoredConnectors | undefined> {
    const settings = await this.repository.getSettings()
    const connectors = settings.connectors
    if (!connectors?.customMcpServers) return connectors

    const resolvedServers: StoredCustomMcpServer[] = []
    for (const stored of connectors.customMcpServers) {
      let secured = stored
      // Migrate pre-encryption settings on first read. The renderer never receives resolved secrets.
      if ((stored.env || stored.headers) && isEncryptionAvailable()) {
        secured = {
          ...stored,
          ...(stored.env ? { envRefs: this.encryptSecretRecord(stored.env) } : {}),
          ...(stored.headers ? { headerRefs: this.encryptSecretRecord(stored.headers) } : {}),
          env: undefined,
          headers: undefined
        }
        await this.repository.updateCustomServer(stored.id, secured, true)
      }

      resolvedServers.push({
        ...secured,
        env: secured.envRefs ? this.decryptSecretRecord(secured.envRefs) : secured.env,
        headers: secured.headerRefs
          ? this.decryptSecretRecord(secured.headerRefs)
          : secured.headers,
        ...(secured.oauthClientSecretRef
          ? { oauthClientSecret: tryDecryptKey(secured.oauthClientSecretRef) }
          : {}),
        ...(secured.oauthRef ? { oauthState: this.decryptOAuthState(secured.oauthRef) } : {})
      })
    }

    return { ...connectors, customMcpServers: resolvedServers }
  }

  async provisionedConnectorSkillNames(): Promise<string[]> {
    const connectors = await this.getConnectors()
    return this.connectorSkillNames(connectors)
  }

  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.connectorsSnapshot()
  }

  async buildCustomServerTemplateExport(id: string): Promise<{
    preview: ConnectorTemplateExportPreview
    contents?: string
  }> {
    const server = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (candidate) => candidate.id === id
    )
    if (!server) throw new Error(`Unknown custom connector: ${id}`)

    return buildConnectorTemplateExport({
      id: server.id,
      name: server.name,
      displayName: server.displayName,
      transport: server.transport,
      ...(server.description ? { description: server.description } : {}),
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.envRefs || server.env
        ? { environmentNames: Object.keys(server.envRefs ?? server.env ?? {}) }
        : {}),
      ...(server.headerRefs || server.headers
        ? { headerNames: Object.keys(server.headerRefs ?? server.headers ?? {}) }
        : {}),
      ...(server.oauth ? { oauth: server.oauth } : {}),
      ...(server.oauthClientSecretRef ? { hasOAuthClientSecret: true } : {})
    })
  }

  async previewCustomServerTemplateImport(contents: string): Promise<ConnectorTemplatePreview> {
    const customServers = (await this.repository.getSettings()).connectors?.customMcpServers ?? []
    return parseConnectorTemplate(contents, {
      existingNames: customServers.map((server) => server.name),
      bundledIds: CONNECTOR_CATALOG.map((connector) => connector.id)
    })
  }

  async getConnectorDetail(id: string): Promise<ConnectorDetailView> {
    const meta = CONNECTOR_CATALOG.find((entry) => entry.id === id)

    if (!meta) throw new Error(`Unknown connector: ${id}`)

    const connectors = await this.getConnectors()
    const view = this.toConnectorViews(connectors).find((entry) => entry.id === id)
    const blocked = new Set(connectors?.blockedToolIds ?? [])
    const ask = new Set(connectors?.askToolIds ?? [])
    const tools = getConnectorTools(id).map((tool) => {
      const toolId = `${id}/${tool.id}`
      // Precedence: block > ask > allow (the default; tools run without a prompt unless opted in).
      const permission: ToolPermission = blocked.has(toolId)
        ? 'block'
        : ask.has(toolId)
          ? 'ask'
          : 'allow'

      return { id: toolId, method: tool.id, description: tool.description, permission }
    })

    return { ...view!, useWhen: meta.useWhen, termsUrl: meta.termsUrl, tools }
  }

  async setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorDisabled(request.id, !request.enabled)

    return this.connectorsSnapshot()
  }

  async setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorAutoAllow(request.id, request.autoAllow)

    return this.connectorsSnapshot()
  }

  async setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView> {
    await this.repository.setToolPolicy(
      request.toolId,
      request.permission === 'ask',
      request.permission === 'block'
    )
    const connectorId = request.toolId.split('/')[0]

    return this.getConnectorDetail(connectorId)
  }

  async setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot> {
    const existing = await this.getConnectors()
    // An omitted apiKey leaves the stored key unchanged; an empty string clears it.
    const apiKeyRef =
      request.apiKey === undefined
        ? existing?.ncbiApiKeyRef
        : request.apiKey === ''
          ? undefined
          : encryptKey(request.apiKey)

    await this.repository.setNcbiCredentials(request.contactEmail?.trim() || undefined, apiKeyRef)

    return this.connectorsSnapshot()
  }

  async setOpenAlexCredential(request: SetOpenAlexCredentialRequest): Promise<ConnectorsSnapshot> {
    const apiKey = request.apiKey.trim()
    await this.repository.setOpenAlexCredential(apiKey ? encryptKey(apiKey) : undefined)
    return this.connectorsSnapshot()
  }

  async validateOpenAlexCredential(
    request: ValidateOpenAlexCredentialRequest
  ): Promise<OpenAlexCredentialValidation> {
    const apiKey = request.apiKey.trim()
    if (!apiKey || /\s/u.test(apiKey)) return { valid: false, reason: 'invalid-format' }

    try {
      const url = new URL('https://api.openalex.org/rate-limit')
      url.searchParams.set('api_key', apiKey)
      const response = await this.openAlexFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (response.ok) return { valid: true }
      if (response.status === 401 || response.status === 403) {
        return { valid: false, reason: 'rejected' }
      }
      return { valid: false, reason: 'unavailable' }
    } catch {
      return { valid: false, reason: 'unavailable' }
    }
  }

  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    const name = request.name.trim()
    const displayName = request.displayName.trim()
    const connectors = (await this.repository.getSettings()).connectors
    const existingServers = connectors?.customMcpServers ?? []
    if (!displayName) throw new Error('Display name is required')
    if (!isCustomConnectorName(name)) {
      throw new Error('Connector name must use only lowercase letters, numbers, and hyphens')
    }
    if (CONNECTOR_CATALOG.some((connector) => connector.id === name)) {
      throw new Error(`Connector name "${name}" is reserved by a built-in connector`)
    }
    if (existingServers.some((server) => server.name === name)) {
      throw new Error(`A custom connector named "${name}" already exists`)
    }
    if (request.transport === 'stdio' && request.oauth) {
      throw new Error('OAuth is only supported for remote custom connectors')
    }
    if (request.oauth && request.headers && Object.keys(request.headers).length > 0) {
      throw new Error('OAuth and static headers cannot be configured together')
    }
    const oauth =
      request.oauth && request.transport !== 'stdio'
        ? normalizeOAuthConfig(request.oauth)
        : undefined
    const clientSecret = request.oauth?.clientSecret?.trim() || undefined
    if (oauth) validateOAuthRegistration(oauth, Boolean(clientSecret))
    const inferredId = inferResourceId(name)
    const usedIds = new Set([
      ...CONNECTOR_CATALOG.map((connector) => connector.id),
      ...existingServers.flatMap((server) => [server.id, server.name]),
      ...(connectors?.pendingCustomServerDeletionIds ?? [])
    ])
    const requestedId = request.id?.trim() || undefined
    const idError = requestedId ? validateResourceId(requestedId) : undefined
    if (idError) throw new Error(idError)
    if (requestedId && usedIds.has(requestedId)) throw new Error('ID is already in use.')
    const candidate: StoredCustomMcpServer = {
      id: requestedId ?? (inferredId && !usedIds.has(inferredId) ? inferredId : randomUUID()),
      name,
      displayName,
      transport: request.transport,
      enabled: !request.oauth,
      trustedAt: Date.now(),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(request.env && Object.keys(request.env).length > 0
        ? { envRefs: this.encryptSecretRecord(request.env) }
        : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(request.headers && Object.keys(request.headers).length > 0
        ? { headerRefs: this.encryptSecretRecord(request.headers) }
        : {}),
      ...(oauth ? { oauth } : {}),
      ...(clientSecret ? { oauthClientSecretRef: encryptKey(clientSecret) } : {})
    }
    let server = sanitizeCustomMcpServer(candidate)

    if (!server) throw new Error('Invalid custom connector configuration')

    try {
      await this.repository.addCustomServer(server)
    } catch (error) {
      if (requestedId || !(error instanceof CustomServerIdConflictError)) {
        throw error
      }
      server = { ...server, id: randomUUID() }
      await this.repository.addCustomServer(server)
    }

    return this.connectorsSnapshot()
  }

  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    if (request.enabled) {
      const server = (await this.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === request.id
      )
      if (!server) throw new Error(`Unknown custom connector: ${request.id}`)
      if (server.oauth && !server.oauthState?.tokens?.access_token) {
        throw new Error(`Sign in to "${server.displayName}" before enabling it`)
      }
    }
    await this.repository.setCustomServerEnabled(request.id, request.enabled)

    return this.connectorsSnapshot()
  }

  async removeCustomServer(
    request: RemoveCustomServerRequest,
    afterPersistedRemoval: (serverId: string) => Promise<void>
  ): Promise<ConnectorsSnapshot> {
    const connectors = (await this.repository.getSettings()).connectors
    const existing = connectors?.customMcpServers?.find((server) => server.id === request.id)
    const pending = connectors?.pendingCustomServerDeletionIds?.includes(request.id) ?? false
    await this.repository.removeCustomServer(request.id)
    if (existing || pending) {
      await afterPersistedRemoval(request.id)
      await this.repository.completeCustomServerDeletion(request.id)
    }

    return this.connectorsSnapshot()
  }

  // Omitted env/headers retain their stored values. Security-sensitive changes acquire a guard
  // before persistence, commit it after the durable write, and roll it back if that write fails.
  async updateCustomServer(
    request: UpdateCustomServerRequest,
    beforeSecuritySensitiveUpdate?: (
      serverId: string
    ) => Promise<CustomServerSecurityChangeGuard | void>
  ): Promise<ConnectorsSnapshot> {
    const existing = (await this.getConnectors())?.customMcpServers?.find(
      (server) => server.id === request.id
    )

    if (!existing) throw new Error(`Unknown custom connector: ${request.id}`)
    const displayName = request.displayName?.trim() ?? existing.displayName
    if (!displayName) throw new Error('Display name is required')

    const envRefs = request.env ? this.encryptSecretRecord(request.env) : existing.envRefs
    // Preserve legacy plaintext only when the caller leaves it untouched and safeStorage is still
    // unavailable. A later getConnectors() call migrates it as soon as encryption becomes available.
    const legacyEnv = request.env === undefined ? existing.env : undefined
    const nextOAuth =
      request.transport === 'stdio' && request.oauth === undefined
        ? undefined
        : request.oauth === null
          ? undefined
          : request.oauth === undefined
            ? existing.oauth
            : normalizeOAuthConfig(request.oauth)
    if (request.transport === 'stdio' && nextOAuth) {
      throw new Error('OAuth is only supported for remote custom connectors')
    }
    if (nextOAuth && request.headers && Object.keys(request.headers).length > 0) {
      throw new Error('OAuth and static headers cannot be configured together')
    }
    const requestedClientSecret = request.oauth === null ? null : request.oauth?.clientSecret
    const clientIdChanged = existing.oauth?.clientId !== nextOAuth?.clientId
    const issuerChanged =
      existing.oauth?.authorizationServerUrl !== nextOAuth?.authorizationServerUrl
    const oauthClientSecretRef = !nextOAuth
      ? undefined
      : typeof requestedClientSecret === 'string' && requestedClientSecret.trim()
        ? encryptKey(requestedClientSecret.trim())
        : requestedClientSecret === null || clientIdChanged || issuerChanged
          ? undefined
          : existing.oauthClientSecretRef
    validateOAuthRegistration(nextOAuth ?? {}, Boolean(oauthClientSecretRef))
    const headerRefs = nextOAuth
      ? undefined
      : request.headers
        ? this.encryptSecretRecord(request.headers)
        : existing.headerRefs
    const legacyHeaders = nextOAuth
      ? undefined
      : request.headers === undefined
        ? existing.headers
        : undefined
    const oauthChanged = !isDeepStrictEqual(existing.oauth ?? undefined, nextOAuth ?? undefined)
    const oauthClientSecretChanged = existing.oauthClientSecretRef !== oauthClientSecretRef
    const oauthCredentialsChanged =
      oauthChanged ||
      oauthClientSecretChanged ||
      existing.transport !== request.transport ||
      existing.url !== request.url?.trim()
    const merged: StoredCustomMcpServer = {
      id: existing.id,
      name: existing.name,
      displayName,
      transport: request.transport,
      enabled: nextOAuth && oauthCredentialsChanged ? false : existing.enabled,
      ...(existing.trustedAt !== undefined ? { trustedAt: existing.trustedAt } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(envRefs && Object.keys(envRefs).length > 0 ? { envRefs } : {}),
      ...(legacyEnv && Object.keys(legacyEnv).length > 0 ? { env: legacyEnv } : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(headerRefs && Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
      ...(legacyHeaders && Object.keys(legacyHeaders).length > 0 ? { headers: legacyHeaders } : {}),
      ...(nextOAuth && request.transport !== 'stdio' ? { oauth: nextOAuth } : {}),
      ...(oauthClientSecretRef ? { oauthClientSecretRef } : {}),
      ...(!oauthCredentialsChanged && existing.oauthRef ? { oauthRef: existing.oauthRef } : {})
    }
    const server = sanitizeCustomMcpServer(merged)

    if (!server) throw new Error('Invalid custom connector configuration')

    const securitySensitiveConfigChanged =
      existing.transport !== server.transport ||
      existing.command !== server.command ||
      !isDeepStrictEqual(existing.args ?? [], server.args ?? []) ||
      existing.url !== server.url ||
      request.env !== undefined ||
      request.headers !== undefined ||
      oauthChanged ||
      oauthClientSecretChanged

    const securityChangeGuard = securitySensitiveConfigChanged
      ? await beforeSecuritySensitiveUpdate?.(request.id)
      : undefined

    try {
      await this.repository.updateCustomServer(request.id, server)
      securityChangeGuard?.commit(server)
    } catch (error) {
      securityChangeGuard?.rollback()
      throw error
    }

    return this.connectorsSnapshot()
  }

  private encryptSecretRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, encryptKey(value)])
    )
  }

  private decryptSecretRecord(
    refs: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if (!refs) return undefined
    const values = Object.entries(refs).flatMap(([name, ref]) => {
      const value = tryDecryptKey(ref)
      return value === undefined ? [] : [[name, value] as const]
    })

    return values.length > 0 ? Object.fromEntries(values) : undefined
  }

  async saveCustomServerOAuthState(
    serverId: string,
    state: StoredCustomMcpOAuthState | undefined
  ): Promise<void> {
    const stored = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (server) => server.id === serverId
    )
    if (!stored) throw new Error(`Unknown custom connector: ${serverId}`)
    if (!stored.oauth) throw new Error(`Custom connector "${serverId}" is not configured for OAuth`)

    await this.repository.updateCustomServer(serverId, {
      ...stored,
      ...(state ? { oauthRef: encryptKey(JSON.stringify(state)) } : { oauthRef: undefined })
    })
  }

  private decryptOAuthState(ref: string): StoredCustomMcpOAuthState | undefined {
    const value = tryDecryptKey(ref)
    if (!value) return undefined
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object'
        ? (parsed as StoredCustomMcpOAuthState)
        : undefined
    } catch {
      return undefined
    }
  }

  private toConnectorViews(connectors: StoredConnectors | undefined): ConnectorView[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])
    const autoAllow = new Set(connectors?.autoAllowIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => ({
      id: meta.id,
      name: meta.id,
      displayName: meta.displayName,
      description: meta.description,
      sources: meta.sources,
      requiresNcbi: meta.requiresNcbi,
      enabled: !disabled.has(meta.id),
      autoAllow: autoAllow.has(meta.id),
      group: meta.group ?? 'featured'
    })).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private ncbiView(connectors: StoredConnectors | undefined): NcbiCredentialsView {
    return { contactEmail: connectors?.contactEmail, hasApiKey: !!connectors?.ncbiApiKeyRef }
  }

  private openAlexView(connectors: StoredConnectors | undefined): OpenAlexCredentialView {
    return { hasApiKey: Boolean(connectors?.openAlexApiKeyRef) }
  }

  private toCustomServerViews(connectors: StoredConnectors | undefined): CustomServerView[] {
    const customServers = connectors?.customMcpServers ?? []
    return customServers
      .map((server) => {
        const routeUnavailable = !isCustomMcpServerRouteSafe(server, customServers)
        const unavailable =
          routeUnavailable ||
          (server.transport === 'stdio' && !server.command) ||
          (server.transport !== 'stdio' && !server.url)
        const unauthenticated = Boolean(server.oauth && !server.oauthState?.tokens?.access_token)
        const configurationAvailability = unavailable
          ? ('unavailable' as const)
          : unauthenticated
            ? ('unauthenticated' as const)
            : undefined
        const runtimeAvailability = server.enabled
          ? this.customServerRuntimeProjectionProvider.availability(server.id)
          : undefined
        const availability = configurationAvailability ?? runtimeAvailability
        const checking = Boolean(
          server.enabled &&
          !configurationAvailability &&
          !runtimeAvailability &&
          this.customServerRuntimeProjectionProvider.isRefreshing(server.id)
        )
        return {
          id: server.id,
          name: server.name,
          displayName: server.displayName,
          description: server.description,
          transport: server.transport,
          enabled: server.enabled && !unavailable && !unauthenticated,
          command: server.command,
          args: server.args,
          url: server.url,
          ...(server.transport !== 'stdio'
            ? {
                hasHeaders: Boolean(Object.keys(server.headerRefs ?? server.headers ?? {}).length)
              }
            : {}),
          ...(server.transport === 'stdio'
            ? { hasEnv: Boolean(Object.keys(server.envRefs ?? server.env ?? {}).length) }
            : {}),
          ...(server.oauth
            ? {
                oauth: {
                  ...(server.oauth.clientMetadataUrl
                    ? { clientMetadataUrl: server.oauth.clientMetadataUrl }
                    : {}),
                  ...(server.oauth.authorizationServerUrl
                    ? { authorizationServerUrl: server.oauth.authorizationServerUrl }
                    : {}),
                  ...(server.oauth.scopes ? { scopes: server.oauth.scopes } : {}),
                  ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
                  ...(server.oauth.redirectUri ? { redirectUri: server.oauth.redirectUri } : {}),
                  hasTokens: Boolean(server.oauthState?.tokens?.access_token),
                  hasClientSecret: Boolean(server.oauthClientSecretRef)
                }
              }
            : {}),
          ...(availability ? { availability } : {}),
          ...(checking ? { checking: true } : {})
        }
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private async connectorsSnapshot(): Promise<ConnectorsSnapshot> {
    const connectors = await this.getConnectors()

    return {
      connectors: this.toConnectorViews(connectors),
      customServers: this.toCustomServerViews(connectors),
      reservedCustomServerIds: connectors?.pendingCustomServerDeletionIds ?? [],
      ncbi: this.ncbiView(connectors),
      openAlex: this.openAlexView(connectors)
    }
  }
}

export { ConnectorSettingsModule }
export type { CustomServerRuntimeProjectionProvider, CustomServerSecurityChangeGuard }
