import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  AddCustomServerRequest,
  ConnectorDetailView,
  CreateDeviceCredentialRequest,
  CreateDeviceCredentialResult,
  DeviceCredentialsSnapshot,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  ConnectorsSnapshot,
  ConnectorView,
  CustomServerView,
  NcbiCredentialsView,
  OpenAlexCredentialView,
  OpenAlexCredentialValidation,
  RemoveCustomServerRequest,
  RemoveDeviceCredentialRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetCustomServerEnabledRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  SetToolPermissionRequest,
  ToolPermission,
  UpdateDeviceCredentialRequest,
  UpdateCustomServerRequest,
  ValidateOpenAlexCredentialRequest
} from '../../shared/settings'
import { inferResourceId, validateResourceId } from '../../shared/resource-id'
import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import {
  assertAddCustomServerLimits,
  assertCustomServerCapacity,
  assertUpdateCustomServerLimits
} from './connector-resource-limits'
import {
  customConnectorNameFromSkillName,
  isCustomConnectorName
} from '../../shared/custom-connector'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import {
  hasUsableCustomMcpCredentials,
  isCustomMcpServerRouteSafe
} from '../connectors/custom-mcp-bootstrap'
import { hasAmbiguousCustomMcpCredentialNames } from '../connectors/custom-mcp-windows-credential-names'
import { getConnectorTools } from '../connectors/registry'
import { encryptKey, isEncryptionAvailable, tryDecryptKey } from './crypto'
import { sanitizeCustomMcpServer, type SettingsRepository } from './repository'
import type {
  StoredConnectors,
  StoredCustomMcpOAuthConfig,
  StoredCustomMcpOAuthState,
  StoredCustomMcpServer
} from './types'
import {
  canonicalizeResourceUri,
  credentialReference,
  type DeviceCredentialStore,
  type ResolvedOAuthDeviceCredential,
  parseCredentialReference
} from './device-credentials'
import {
  buildConnectorTemplateExport,
  hasEmbeddedConnectorCredentials,
  parseConnectorTemplate
} from './connector-template'
import {
  CustomServerIdConflictError,
  customServerSecurityFingerprint
} from './custom-server-identity'
import { assertSecureCustomMcpUrl } from '../connectors/custom-mcp-url'

type CustomServerSecurityChangeGuard = {
  commit(server: StoredCustomMcpServer): void
  rollback(): void
}

type DeviceCredentialConsumerMutation = (
  consumerIds: string[],
  mutation: () => Promise<DeviceCredentialsSnapshot>
) => Promise<DeviceCredentialsSnapshot>

type CustomServerRuntimeProjectionProvider = {
  materializedSkillNames: () => readonly string[]
  availability: (id: string) => CustomServerView['availability']
  isRefreshing: (id: string) => boolean
  isDegraded?: () => boolean
}

const sharedOAuthMatchesServer = (
  server: StoredCustomMcpServer,
  credential: ResolvedOAuthDeviceCredential
): boolean => {
  if (!server.url || server.transport !== credential.transport) return false
  try {
    return canonicalizeResourceUri(server.url) === credential.resourceUri
  } catch {
    return false
  }
}

const normalizeOAuthConfig = (
  oauth: Exclude<UpdateCustomServerRequest['oauth'], null | undefined>
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

const canonicalizeOptionalOAuthUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    return new URL(value).toString()
  } catch {
    return value
  }
}

const sharedOAuthSatisfiesRequirements = (
  actual: StoredCustomMcpOAuthConfig,
  required: StoredCustomMcpOAuthConfig
): boolean => {
  const urlFields = [
    'clientMetadataUrl',
    'authorizationServerUrl',
    'redirectUri'
  ] as const satisfies readonly (keyof StoredCustomMcpOAuthConfig)[]
  if (
    urlFields.some(
      (field) =>
        required[field] &&
        canonicalizeOptionalOAuthUrl(actual[field]) !==
          canonicalizeOptionalOAuthUrl(required[field])
    )
  ) {
    return false
  }
  if (required.clientId && actual.clientId !== required.clientId) return false
  const actualScopes = new Set(actual.scopes ?? [])
  return (required.scopes ?? []).every((scope) => actualScopes.has(scope))
}

const hasResolvedSecretRecord = (
  refs: Record<string, string> | undefined,
  values: Record<string, string> | undefined
): boolean => {
  const names = Object.keys(refs ?? values ?? {})
  return names.length > 0 && names.every((name) => Object.hasOwn(values ?? {}, name))
}

const assertCredentialFieldsAreEncrypted = (fields: {
  args?: readonly string[]
  url?: string
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    redirectUri?: string
  } | null
}): void => {
  if (hasEmbeddedConnectorCredentials(fields)) {
    throw new Error(
      'Credentials in arguments or URLs are not allowed. Use encrypted environment or header fields instead.'
    )
  }
}

// Owns durable Connector policy, secret migration/projection, and custom-server mutation. Live MCP
// clients, approval decisions, Specialist bindings, and refresh workflows remain outside this module.
class ConnectorSettingsModule {
  private customServerRuntimeProjectionProvider: CustomServerRuntimeProjectionProvider = {
    materializedSkillNames: () => [],
    availability: () => undefined,
    isRefreshing: () => false,
    isDegraded: () => false
  }
  private credentialBindingMutation = Promise.resolve()

  constructor(
    private readonly repository: SettingsRepository,
    private readonly openAlexFetch: typeof fetch = fetch,
    private readonly deviceCredentials?: DeviceCredentialStore
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

      const sharedOAuthCredentialId = parseCredentialReference(secured.oauthRef)
      const resolvedSharedOAuth = sharedOAuthCredentialId
        ? await this.deviceCredentials?.resolveOAuth(sharedOAuthCredentialId)
        : undefined
      // Revalidate persisted bindings at the runtime projection boundary. Add/update validation is
      // not sufficient when settings are stale, downgraded, or modified outside this process.
      const sharedOAuth =
        resolvedSharedOAuth && sharedOAuthMatchesServer(secured, resolvedSharedOAuth)
          ? resolvedSharedOAuth
          : undefined
      const sharedOAuthUnavailable =
        sharedOAuthCredentialId !== undefined &&
        (!sharedOAuth || (sharedOAuth.hasClientSecret && sharedOAuth.clientSecret === undefined))
      resolvedServers.push({
        ...secured,
        env: secured.envRefs ? await this.resolveSecretRecord(secured.envRefs, 'env') : secured.env,
        headers: secured.headerRefs
          ? await this.resolveSecretRecord(secured.headerRefs, 'header')
          : secured.headers,
        ...(sharedOAuth
          ? {
              oauth: sharedOAuth.oauth,
              oauthClientSecret: sharedOAuth.clientSecret,
              oauthState: sharedOAuth.state
            }
          : !sharedOAuthCredentialId && secured.oauthClientSecretRef
            ? { oauthClientSecret: tryDecryptKey(secured.oauthClientSecretRef) }
            : {}),
        ...(sharedOAuthUnavailable ? { oauthCredentialUnavailable: true as const } : {}),
        ...(!sharedOAuthCredentialId && secured.oauthRef
          ? { oauthState: this.decryptOAuthState(secured.oauthRef) }
          : {})
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

  async listDeviceCredentials(): Promise<DeviceCredentialsSnapshot> {
    const credentials = await this.deviceCredentials?.list()
    if (!credentials) return { credentials: [] }
    const servers = (await this.repository.getSettings()).connectors?.customMcpServers ?? []
    return {
      credentials: credentials
        .map((credential) =>
          this.deviceCredentials!.view(credential, this.credentialConsumers(credential.id, servers))
        )
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
    }
  }

  async deviceCredentialConsumerIds(id: string): Promise<string[]> {
    const servers = (await this.repository.getSettings()).connectors?.customMcpServers ?? []
    const reference = credentialReference(id)
    return servers
      .filter(
        (server) =>
          server.oauthRef === reference ||
          Object.values(server.envRefs ?? {}).includes(reference) ||
          Object.values(server.headerRefs ?? {}).includes(reference)
      )
      .map((server) => server.id)
  }

  async deviceCredentialIdForServer(serverId: string): Promise<string | undefined> {
    const server = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      ({ id }) => id === serverId
    )
    return parseCredentialReference(server?.oauthRef)
  }

  async resolveDeviceOAuthCredential(
    id: string
  ): Promise<ResolvedOAuthDeviceCredential | undefined> {
    return this.deviceCredentials?.resolveOAuth(id)
  }

  async disconnectDeviceCredential(
    id: string,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<DeviceCredentialsSnapshot> {
    return this.runCredentialBindingMutation(async () => {
      const consumers = await this.deviceCredentialConsumerIds(id)
      const mutation = (): Promise<DeviceCredentialsSnapshot> =>
        this.disconnectDeviceCredentialSerialized(id, consumers)
      return withConsumersBlocked ? withConsumersBlocked(consumers, mutation) : mutation()
    })
  }

  private async disconnectDeviceCredentialSerialized(
    id: string,
    consumers: string[]
  ): Promise<DeviceCredentialsSnapshot> {
    if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
    const credential = await this.deviceCredentials.resolveOAuth(id)
    if (!credential) throw new Error(`Unknown OAuth credential: ${id}`)
    await this.repository.setCustomServersEnabled(consumers, false)
    await this.deviceCredentials.saveOAuthState(id, undefined)
    return this.listDeviceCredentials()
  }

  async createDeviceCredential(
    request: CreateDeviceCredentialRequest
  ): Promise<CreateDeviceCredentialResult> {
    if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
    const created = await this.deviceCredentials.create(request)
    const snapshot = await this.listDeviceCredentials()
    const createdCredential = snapshot.credentials.find(({ id }) => id === created.id)
    if (!createdCredential)
      throw new Error('Created credential is missing from the settings response')
    return { ...snapshot, createdCredential }
  }

  async updateDeviceCredential(
    request: UpdateDeviceCredentialRequest,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<DeviceCredentialsSnapshot> {
    const deviceCredentials = this.deviceCredentials
    if (!deviceCredentials) throw new Error('Device credentials are unavailable')
    const mutation = async (): Promise<DeviceCredentialsSnapshot> => {
      await deviceCredentials.update(request)
      return this.listDeviceCredentials()
    }
    if (request.secret === undefined) return mutation()
    return this.runCredentialBindingMutation(async () => {
      const consumers = await this.deviceCredentialConsumerIds(request.id)
      return withConsumersBlocked ? withConsumersBlocked(consumers, mutation) : mutation()
    })
  }

  async removeDeviceCredential(
    request: RemoveDeviceCredentialRequest
  ): Promise<DeviceCredentialsSnapshot> {
    return this.runCredentialBindingMutation(() => this.removeDeviceCredentialSerialized(request))
  }

  private async removeDeviceCredentialSerialized(
    request: RemoveDeviceCredentialRequest
  ): Promise<DeviceCredentialsSnapshot> {
    if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
    const servers = (await this.repository.getSettings()).connectors?.customMcpServers ?? []
    const consumers = this.credentialConsumers(request.id, servers)
    if (consumers.length > 0) {
      throw new Error(`Credential is used by: ${consumers.join(', ')}`)
    }
    await this.deviceCredentials.remove(request.id)
    return this.listDeviceCredentials()
  }

  async buildCustomServerTemplateExport(id: string): Promise<{
    preview: ConnectorTemplateExportPreview
    contents?: string
  }> {
    const server = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (candidate) => candidate.id === id
    )
    if (!server) throw new Error(`Unknown custom connector: ${id}`)
    const sharedOAuthCredentialId = parseCredentialReference(server.oauthRef)
    const sharedOAuth = sharedOAuthCredentialId
      ? await this.deviceCredentials?.resolveOAuth(sharedOAuthCredentialId)
      : undefined
    if (sharedOAuthCredentialId && !sharedOAuth) {
      throw new Error(`OAuth credential is unavailable: ${sharedOAuthCredentialId}`)
    }
    const oauth = sharedOAuth?.oauth ?? server.oauth

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
      ...(oauth ? { oauth } : {}),
      ...(sharedOAuth?.hasClientSecret || server.oauthClientSecretRef
        ? { hasOAuthClientSecret: true }
        : {})
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
    const separator = request.toolId.indexOf('/')
    const connectorId = separator > 0 ? request.toolId.slice(0, separator) : ''
    const method = separator > 0 ? request.toolId.slice(separator + 1) : ''
    const connector = CONNECTOR_CATALOG.find((candidate) => candidate.id === connectorId)
    if (
      !connector ||
      !method ||
      !getConnectorTools(connectorId).some((tool) => tool.id === method)
    ) {
      throw new Error(`Unknown connector tool: ${request.toolId}`)
    }

    await this.repository.setToolPolicy(
      request.toolId,
      request.permission === 'ask',
      request.permission === 'block'
    )
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
      if (response.ok || response.status === 429) return { valid: true }
      if (response.status === 401 || response.status === 403) {
        return { valid: false, reason: 'rejected' }
      }
      return { valid: false, reason: 'unavailable' }
    } catch {
      return { valid: false, reason: 'unavailable' }
    }
  }

  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.runCredentialBindingMutation(() => this.addCustomServerSerialized(request))
  }

  private async addCustomServerSerialized(
    request: AddCustomServerRequest
  ): Promise<ConnectorsSnapshot> {
    const untrustedRequest = request as AddCustomServerRequest & {
      env?: Record<string, string>
      headers?: Record<string, string>
      oauth?: unknown
    }
    if (
      untrustedRequest.env !== undefined ||
      untrustedRequest.headers !== undefined ||
      untrustedRequest.oauth !== undefined
    ) {
      throw new Error('New Connectors must use shared Credentials')
    }
    assertCredentialFieldsAreEncrypted(request)
    if (
      hasAmbiguousCustomMcpCredentialNames({
        ...request,
        ...(request.envCredentialIds ? { envRefs: request.envCredentialIds } : {}),
        ...(request.headerCredentialIds ? { headerRefs: request.headerCredentialIds } : {})
      })
    ) {
      throw new Error('Duplicate credential names are not allowed on this platform.')
    }
    if (request.transport !== 'stdio' && request.url) {
      assertSecureCustomMcpUrl(request.url.trim())
    }
    const name = request.name.trim()
    const displayName = request.displayName.trim()
    const connectors = (await this.repository.getSettings()).connectors
    const existingServers = connectors?.customMcpServers ?? []
    assertCustomServerCapacity(existingServers.length)
    assertAddCustomServerLimits(request)
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
    if (request.transport !== 'stdio' && request.envCredentialIds) {
      throw new Error('Environment credentials are only supported for local custom connectors')
    }
    if (
      request.transport === 'stdio' &&
      (request.headerCredentialIds || request.oauthCredentialId)
    ) {
      throw new Error(
        'Header and OAuth credentials are only supported for remote custom connectors'
      )
    }
    if (request.oauthCredentialId && request.headerCredentialIds) {
      throw new Error('OAuth and static headers cannot be configured together')
    }
    const sharedOAuth = request.oauthCredentialId
      ? await this.deviceCredentials?.resolveOAuth(request.oauthCredentialId)
      : undefined
    if (request.oauthCredentialId && !sharedOAuth) {
      throw new Error(`OAuth credential is unavailable: ${request.oauthCredentialId}`)
    }
    if (request.requiresOAuthClientSecret && !sharedOAuth?.hasClientSecret) {
      throw new Error('The selected OAuth credential requires a client secret')
    }
    if (sharedOAuth && canonicalizeResourceUri(request.url ?? '') !== sharedOAuth.resourceUri) {
      throw new Error('OAuth credential resource does not match the Connector URL')
    }
    if (sharedOAuth && request.transport !== sharedOAuth.transport) {
      throw new Error('OAuth credential transport does not match the Connector transport')
    }
    if (sharedOAuth && request.oauthRequirements) {
      const requirements = normalizeOAuthConfig(request.oauthRequirements)
      validateOAuthRegistration(requirements, false)
      if (!sharedOAuthSatisfiesRequirements(sharedOAuth.oauth, requirements)) {
        throw new Error('OAuth credential registration does not match the Connector requirements')
      }
    }
    await this.validateStaticCredentialBindings(request.envCredentialIds, 'env')
    await this.validateStaticCredentialBindings(request.headerCredentialIds, 'header')
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
      enabled: !sharedOAuth || Boolean(sharedOAuth.state?.tokens?.access_token),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(request.envCredentialIds && Object.keys(request.envCredentialIds).length > 0
        ? { envRefs: this.credentialRefRecord(request.envCredentialIds) }
        : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(request.headerCredentialIds && Object.keys(request.headerCredentialIds).length > 0
        ? { headerRefs: this.credentialRefRecord(request.headerCredentialIds) }
        : {}),
      ...(sharedOAuth ? { oauthRef: credentialReference(sharedOAuth.id) } : {})
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

  private async runCredentialBindingMutation<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.credentialBindingMutation
    let release = (): void => undefined
    this.credentialBindingMutation = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    if (request.enabled) {
      const server = (await this.getConnectors())?.customMcpServers?.find(
        (candidate) => candidate.id === request.id
      )
      if (!server) throw new Error(`Unknown custom connector: ${request.id}`)
      if (!hasUsableCustomMcpCredentials(server)) {
        throw new Error(
          `credential_unavailable: Re-enter credentials for "${server.displayName}" before enabling it`
        )
      }
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
    return this.runCredentialBindingMutation(() =>
      this.updateCustomServerSerialized(request, beforeSecuritySensitiveUpdate)
    )
  }

  private async updateCustomServerSerialized(
    request: UpdateCustomServerRequest,
    beforeSecuritySensitiveUpdate?: (
      serverId: string
    ) => Promise<CustomServerSecurityChangeGuard | void>
  ): Promise<ConnectorsSnapshot> {
    assertCredentialFieldsAreEncrypted(request)
    if (request.env !== undefined && request.envCredentialIds !== undefined) {
      throw new Error('Environment values and credential bindings cannot be combined')
    }
    if (request.headers !== undefined && request.headerCredentialIds !== undefined) {
      throw new Error('Header values and credential bindings cannot be combined')
    }
    if (
      hasAmbiguousCustomMcpCredentialNames({
        ...request,
        ...(request.envCredentialIds ? { envRefs: request.envCredentialIds } : {}),
        ...(request.headerCredentialIds ? { headerRefs: request.headerCredentialIds } : {})
      })
    ) {
      throw new Error('Duplicate credential names are not allowed on this platform.')
    }
    if (request.transport !== 'stdio' && request.url) {
      assertSecureCustomMcpUrl(request.url.trim())
    }
    const storedExisting = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (server) => server.id === request.id
    )
    if (request.env && Object.keys(request.env).length > 0) {
      throw new Error('Environment values must use shared Credentials')
    }
    if (request.headers && Object.keys(request.headers).length > 0) {
      throw new Error('Header values must use shared Credentials')
    }
    const existing = (await this.getConnectors())?.customMcpServers?.find(
      (server) => server.id === request.id
    )

    if (!existing) throw new Error(`Unknown custom connector: ${request.id}`)
    assertUpdateCustomServerLimits(request, existing)
    await this.validateStaticCredentialBindings(request.envCredentialIds, 'env')
    await this.validateStaticCredentialBindings(request.headerCredentialIds, 'header')
    const existingSharedOAuthCredentialId = parseCredentialReference(storedExisting?.oauthRef)
    if (request.oauth && !storedExisting?.oauth && !existingSharedOAuthCredentialId) {
      throw new Error('OAuth settings must use a shared Credential')
    }
    if (request.oauthCredentialId && request.oauth !== undefined) {
      throw new Error('Shared OAuth credentials and Connector OAuth settings cannot be combined')
    }
    const nextSharedOAuthCredentialId =
      request.transport === 'stdio' || request.oauth === null
        ? undefined
        : (request.oauthCredentialId ?? existingSharedOAuthCredentialId)
    const sharedOAuth = nextSharedOAuthCredentialId
      ? await this.deviceCredentials?.resolveOAuth(nextSharedOAuthCredentialId)
      : undefined
    const requestedSharedOAuth = request.oauth === null ? undefined : request.oauth
    const retainsSharedOAuth =
      nextSharedOAuthCredentialId !== undefined &&
      request.oauth !== null &&
      request.transport !== 'stdio'
    if (retainsSharedOAuth) {
      if (!sharedOAuth)
        throw new Error(`OAuth credential is unavailable: ${nextSharedOAuthCredentialId}`)
      if (canonicalizeResourceUri(request.url ?? '') !== sharedOAuth.resourceUri) {
        throw new Error('OAuth credential resource does not match the Connector URL')
      }
      if (request.transport !== sharedOAuth.transport) {
        throw new Error('OAuth credential transport does not match the Connector transport')
      }
      if (
        requestedSharedOAuth !== undefined &&
        (requestedSharedOAuth.clientSecret !== undefined ||
          !isDeepStrictEqual(normalizeOAuthConfig(requestedSharedOAuth), sharedOAuth.oauth))
      ) {
        throw new Error('Shared OAuth settings must be edited in Credentials')
      }
    }
    const displayName = request.displayName?.trim() ?? existing.displayName
    if (!displayName) throw new Error('Display name is required')

    const envRefs =
      request.transport === 'stdio'
        ? request.env
          ? this.encryptSecretRecord(request.env)
          : request.envCredentialIds
            ? this.credentialRefRecord(request.envCredentialIds)
            : existing.envRefs
        : undefined
    // Preserve legacy plaintext only when the caller leaves it untouched and safeStorage is still
    // unavailable. A later getConnectors() call migrates it as soon as encryption becomes available.
    const legacyEnv =
      request.transport === 'stdio' &&
      request.env === undefined &&
      request.envCredentialIds === undefined
        ? existing.env
        : undefined
    const nextOAuth = sharedOAuth
      ? sharedOAuth.oauth
      : request.transport === 'stdio' && request.oauth === undefined
        ? undefined
        : request.oauth === null
          ? undefined
          : request.oauth === undefined
            ? existing.oauth
            : normalizeOAuthConfig(request.oauth)
    if (request.transport === 'stdio' && nextOAuth) {
      throw new Error('OAuth is only supported for remote custom connectors')
    }
    if (
      nextOAuth &&
      ((request.headers && Object.keys(request.headers).length > 0) ||
        (request.headerCredentialIds && Object.keys(request.headerCredentialIds).length > 0))
    ) {
      throw new Error('OAuth and static headers cannot be configured together')
    }
    const requestedClientSecret = request.oauth === null ? null : request.oauth?.clientSecret
    const clientIdChanged = existing.oauth?.clientId !== nextOAuth?.clientId
    const issuerChanged =
      existing.oauth?.authorizationServerUrl !== nextOAuth?.authorizationServerUrl
    const oauthClientSecretRef = nextSharedOAuthCredentialId
      ? undefined
      : !nextOAuth
        ? undefined
        : typeof requestedClientSecret === 'string' && requestedClientSecret.trim()
          ? encryptKey(requestedClientSecret.trim())
          : requestedClientSecret === null || clientIdChanged || issuerChanged
            ? undefined
            : existing.oauthClientSecretRef
    validateOAuthRegistration(nextOAuth ?? {}, Boolean(oauthClientSecretRef))
    const headerRefs =
      request.transport !== 'stdio' && !nextOAuth
        ? request.headers
          ? this.encryptSecretRecord(request.headers)
          : request.headerCredentialIds
            ? this.credentialRefRecord(request.headerCredentialIds)
            : existing.headerRefs
        : undefined
    const legacyHeaders =
      request.transport !== 'stdio' &&
      !nextOAuth &&
      request.headers === undefined &&
      request.headerCredentialIds === undefined
        ? existing.headers
        : undefined
    const oauthChanged = !isDeepStrictEqual(existing.oauth ?? undefined, nextOAuth ?? undefined)
    const oauthClientSecretChanged = existing.oauthClientSecretRef !== oauthClientSecretRef
    const oauthCredentialsChanged =
      oauthChanged ||
      oauthClientSecretChanged ||
      existingSharedOAuthCredentialId !== nextSharedOAuthCredentialId ||
      existing.transport !== request.transport ||
      existing.url !== request.url?.trim()
    const sharedOAuthConnected = Boolean(sharedOAuth?.state?.tokens?.access_token)
    const sharedOAuthBindingChanged =
      existingSharedOAuthCredentialId !== nextSharedOAuthCredentialId
    const merged: StoredCustomMcpServer = {
      id: existing.id,
      name: existing.name,
      displayName,
      transport: request.transport,
      enabled:
        nextOAuth && oauthCredentialsChanged
          ? sharedOAuthBindingChanged && sharedOAuthConnected
            ? existing.enabled
            : false
          : existing.enabled,
      ...(existing.trustedAt !== undefined ? { trustedAt: existing.trustedAt } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(envRefs && Object.keys(envRefs).length > 0 ? { envRefs } : {}),
      ...(legacyEnv && Object.keys(legacyEnv).length > 0 ? { env: legacyEnv } : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(headerRefs && Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
      ...(legacyHeaders && Object.keys(legacyHeaders).length > 0 ? { headers: legacyHeaders } : {}),
      ...(!nextSharedOAuthCredentialId && nextOAuth && request.transport !== 'stdio'
        ? { oauth: nextOAuth }
        : {}),
      ...(oauthClientSecretRef ? { oauthClientSecretRef } : {}),
      ...(nextSharedOAuthCredentialId
        ? { oauthRef: credentialReference(nextSharedOAuthCredentialId) }
        : request.oauth !== null && !oauthCredentialsChanged && existing.oauthRef
          ? { oauthRef: existing.oauthRef }
          : {})
    }
    const server = sanitizeCustomMcpServer(merged)

    if (!server) throw new Error('Invalid custom connector configuration')

    const securitySensitiveConfigChanged =
      existing.transport !== server.transport ||
      existing.command !== server.command ||
      !isDeepStrictEqual(existing.args ?? [], server.args ?? []) ||
      existing.url !== server.url ||
      request.env !== undefined ||
      request.envCredentialIds !== undefined ||
      request.headers !== undefined ||
      request.headerCredentialIds !== undefined ||
      oauthChanged ||
      oauthClientSecretChanged ||
      existingSharedOAuthCredentialId !== nextSharedOAuthCredentialId

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

  private credentialRefRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([name, credentialId]) => [
        name,
        credentialReference(credentialId)
      ])
    )
  }

  private async validateStaticCredentialBindings(
    bindings: Record<string, string> | undefined,
    kind: 'env' | 'header'
  ): Promise<void> {
    if (!bindings) return
    if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
    await Promise.all(
      Object.entries(bindings).map(([name, credentialId]) =>
        this.deviceCredentials!.resolveStatic(credentialId, { kind, name })
      )
    )
  }

  private credentialConsumers(
    credentialId: string,
    servers: readonly StoredCustomMcpServer[]
  ): string[] {
    const reference = credentialReference(credentialId)
    return servers.flatMap((server) => {
      const used =
        server.oauthRef === reference ||
        Object.values(server.envRefs ?? {}).includes(reference) ||
        Object.values(server.headerRefs ?? {}).includes(reference)
      return used ? [server.displayName] : []
    })
  }

  private async resolveSecretRecord(
    refs: Record<string, string> | undefined,
    kind: 'env' | 'header'
  ): Promise<Record<string, string> | undefined> {
    if (!refs) return undefined
    const values = (
      await Promise.all(
        Object.entries(refs).map(async ([name, ref]) => {
          const credentialId = parseCredentialReference(ref)
          let value: string | undefined
          if (credentialId) {
            try {
              value = await this.deviceCredentials?.resolveStatic(credentialId, { kind, name })
            } catch {
              value = undefined
            }
          } else {
            value = tryDecryptKey(ref)
          }
          return value === undefined ? undefined : ([name, value] as const)
        })
      )
    ).filter((entry): entry is readonly [string, string] => entry !== undefined)

    return values.length > 0 ? Object.fromEntries(values) : undefined
  }

  async saveCustomServerOAuthState(
    serverId: string,
    state: StoredCustomMcpOAuthState | undefined,
    expectedConfigurationFingerprint?: string,
    expectedOAuthClientSecretRef?: string
  ): Promise<void> {
    const directCredentialId = parseCredentialReference(serverId)
    if (directCredentialId) {
      if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
      await this.deviceCredentials.saveOAuthState(directCredentialId, state)
      return
    }
    const stored = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (server) => server.id === serverId
    )
    if (!stored) throw new Error(`Unknown custom connector: ${serverId}`)
    const credentialId = parseCredentialReference(stored.oauthRef)
    if (credentialId) {
      if (!this.deviceCredentials) throw new Error('Device credentials are unavailable')
      await this.deviceCredentials.saveOAuthState(credentialId, state)
      return
    }
    if (!stored.oauth) throw new Error(`Custom connector "${serverId}" is not configured for OAuth`)

    await this.repository.updateCustomServerOAuthState(
      serverId,
      expectedConfigurationFingerprint ?? customServerSecurityFingerprint(stored),
      expectedConfigurationFingerprint === undefined
        ? stored.oauthClientSecretRef
        : expectedOAuthClientSecretRef,
      state ? encryptKey(JSON.stringify(state)) : undefined
    )
  }

  async disconnectCustomServer(
    serverId: string,
    withConsumersBlocked?: DeviceCredentialConsumerMutation
  ): Promise<ConnectorsSnapshot> {
    const stored = (await this.repository.getSettings()).connectors?.customMcpServers?.find(
      (server) => server.id === serverId
    )
    if (!stored) throw new Error(`Unknown custom connector: ${serverId}`)
    const credentialId = parseCredentialReference(stored.oauthRef)
    if (credentialId) {
      await this.disconnectDeviceCredential(credentialId, withConsumersBlocked)
      return this.connectorsSnapshot()
    }
    if (!stored.oauth) throw new Error(`Custom connector "${serverId}" is not configured for OAuth`)

    await this.repository.updateCustomServer(serverId, {
      ...stored,
      enabled: false,
      oauthRef: undefined
    })
    return this.connectorsSnapshot()
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
    return {
      contactEmail: connectors?.contactEmail,
      hasApiKey: tryDecryptKey(connectors?.ncbiApiKeyRef) !== undefined
    }
  }

  private openAlexView(connectors: StoredConnectors | undefined): OpenAlexCredentialView {
    return { hasApiKey: tryDecryptKey(connectors?.openAlexApiKeyRef) !== undefined }
  }

  private toCustomServerViews(connectors: StoredConnectors | undefined): CustomServerView[] {
    const customServers = connectors?.customMcpServers ?? []
    return customServers
      .map((server) => {
        const oauthCredentialId = parseCredentialReference(server.oauthRef)
        const routeUnavailable = !isCustomMcpServerRouteSafe(server, customServers)
        const argsContainCredentials = hasEmbeddedConnectorCredentials({ args: server.args })
        const urlContainsCredentials = hasEmbeddedConnectorCredentials({ url: server.url })
        const clientMetadataUrlContainsCredentials = hasEmbeddedConnectorCredentials({
          url: server.oauth?.clientMetadataUrl
        })
        const authorizationServerUrlContainsCredentials = hasEmbeddedConnectorCredentials({
          url: server.oauth?.authorizationServerUrl
        })
        const redirectUriContainsCredentials = hasEmbeddedConnectorCredentials({
          url: server.oauth?.redirectUri
        })
        const credentialUnavailable = !hasUsableCustomMcpCredentials(server)
        const unavailable =
          routeUnavailable ||
          (server.transport === 'stdio' && !server.command) ||
          (server.transport !== 'stdio' && !server.url)
        const unauthenticated = Boolean(server.oauth && !server.oauthState?.tokens?.access_token)
        const configurationAvailability = unavailable
          ? ('unavailable' as const)
          : credentialUnavailable
            ? ('credential_unavailable' as const)
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
          enabled: server.enabled,
          command: server.command,
          args: argsContainCredentials ? undefined : server.args,
          url: urlContainsCredentials ? undefined : server.url,
          ...(oauthCredentialId ? { oauthCredentialId } : {}),
          ...(server.transport !== 'stdio'
            ? {
                hasHeaders: hasResolvedSecretRecord(server.headerRefs, server.headers),
                headerNames: Object.keys(server.headerRefs ?? server.headers ?? {}).sort()
              }
            : {}),
          ...(server.transport === 'stdio'
            ? {
                hasEnv: hasResolvedSecretRecord(server.envRefs, server.env),
                environmentNames: Object.keys(server.envRefs ?? server.env ?? {}).sort()
              }
            : {}),
          ...(server.oauth
            ? {
                oauth: {
                  ...(server.oauth.clientMetadataUrl && !clientMetadataUrlContainsCredentials
                    ? { clientMetadataUrl: server.oauth.clientMetadataUrl }
                    : {}),
                  ...(server.oauth.authorizationServerUrl &&
                  !authorizationServerUrlContainsCredentials
                    ? { authorizationServerUrl: server.oauth.authorizationServerUrl }
                    : {}),
                  ...(server.oauth.scopes ? { scopes: server.oauth.scopes } : {}),
                  ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
                  ...(server.oauth.redirectUri && !redirectUriContainsCredentials
                    ? { redirectUri: server.oauth.redirectUri }
                    : {}),
                  hasTokens: Boolean(server.oauthState?.tokens?.access_token),
                  hasClientSecret: server.oauthClientSecret !== undefined,
                  ...(oauthCredentialId ? { sharedCredential: true } : {})
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
      ...(this.customServerRuntimeProjectionProvider.isDegraded?.()
        ? { skillProjectionStatus: 'degraded' as const }
        : {}),
      reservedCustomServerIds: connectors?.pendingCustomServerDeletionIds ?? [],
      ncbi: this.ncbiView(connectors),
      openAlex: this.openAlexView(connectors)
    }
  }
}

export { ConnectorSettingsModule }
export type {
  CustomServerRuntimeProjectionProvider,
  CustomServerSecurityChangeGuard,
  DeviceCredentialConsumerMutation
}
