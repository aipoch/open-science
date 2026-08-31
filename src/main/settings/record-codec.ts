import type {
  ChatApiEndpoint,
  ClaudeInfo,
  ProviderType,
  ProviderValidationFailure,
  ValidationCategory
} from '../../shared/settings'
import { isCodexSubscriptionProvider } from '../../shared/settings'
import { isCustomConnectorName, toCustomConnectorName } from '../../shared/custom-connector'
import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import type { PackageMirror } from '../../shared/mirror'
import { isOfficialVendorId } from '../../shared/provider-registry'
import {
  isCustomReasoningEffortTransport,
  isReasoningEffortPresetSetting
} from '../../shared/reasoning-effort'
import { createLogger } from '../logger'
import { isPositiveWholeTokenLimit } from './provider-token-limits'
import type {
  StoredComputeGrant,
  StoredConnectors,
  StoredCodexInfo,
  StoredCustomMcpServer,
  StoredProvider
} from './types'
import { isRecord } from '../value-guards'

const log = createLogger('settings.repository')

const PROVIDER_TYPES = new Set<ProviderType>([
  'custom',
  'claude-shared',
  'claude-isolated',
  'official',
  'codex-shared',
  'codex-isolated',
  'xai-subscription'
])

const VALIDATION_CATEGORIES = new Set<ValidationCategory>([
  'ok',
  'network',
  'auth',
  'model-not-found',
  'bad-url',
  'timeout',
  'incompatible',
  'server-error',
  'unknown'
])

const CUSTOM_MCP_TRANSPORTS = new Set<StoredCustomMcpServer['transport']>([
  'stdio',
  'streamable_http',
  'sse'
])

// Treat only plain JSON objects as records before rebuilding durable values.
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

// Drop non-string values so environment and header maps cannot retain untrusted shapes.
const asStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

// Rebuild runtime metadata from allowed fields only.
export const sanitizeClaudeInfo = (value: unknown): ClaudeInfo | undefined => {
  if (!isRecord(value)) return undefined
  const info: ClaudeInfo = {}
  const resolvedPath = asString(value.resolvedPath)
  const version = asString(value.version)
  if (resolvedPath) info.resolvedPath = resolvedPath
  if (version) info.version = version
  return Object.keys(info).length > 0 ? info : undefined
}

// Rebuild runtime metadata from allowed fields only.
export const sanitizeCodexInfo = (value: unknown): StoredCodexInfo | undefined => {
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

// A recorded failure is valid only with a timestamp and known category.
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

// Rebuild one provider from known fields and durable credential references only.
export const sanitizeProvider = (value: unknown): StoredProvider | undefined => {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const type = asString(value.type) as ProviderType | undefined
  const name = asString(value.name)
  if (!id || !type || name === undefined) return undefined
  if (!PROVIDER_TYPES.has(type)) {
    log.warn('dropping stored provider with unknown type', { id, type })
    return undefined
  }
  // Official providers require a known catalog owner and cannot run without one.
  const vendorId = isOfficialVendorId(value.vendorId) ? value.vendorId : undefined
  if (type === 'official' && !vendorId) return undefined

  const provider: StoredProvider = { id, type, name }
  const baseUrl = asString(value.baseUrl)
  const model = asString(value.model)
  const positiveWholeNumber = (candidate: unknown): number | undefined => {
    const number = asNumber(candidate)
    return isPositiveWholeTokenLimit(number) ? number : undefined
  }
  const contextWindow = positiveWholeNumber(value.contextWindow)
  const maxInputTokens = positiveWholeNumber(value.maxInputTokens)
  const maxOutputTokens = positiveWholeNumber(value.maxOutputTokens)
  const supportsImageInput = asBoolean(value.supportsImageInput)
  const reasoningEffortPreset = isReasoningEffortPresetSetting(value.reasoningEffortPreset)
    ? value.reasoningEffortPreset
    : undefined
  const reasoningEffortTransport = isCustomReasoningEffortTransport(value.reasoningEffortTransport)
    ? value.reasoningEffortTransport
    : undefined
  const region = asString(value.region)
  const keyRef = asString(value.keyRef)
  const keyMask = asString(value.keyMask)
  const accountEmail = asString(value.accountEmail)
  const lastValidatedAt = asNumber(value.lastValidatedAt)
  const lastValidationFailure = sanitizeValidationFailure(value.lastValidationFailure)
  const expiresAt = asNumber(value.expiresAt)
  const disconnectedAt = asNumber(value.disconnectedAt)
  const codexAuthMode = asString(value.codexAuthMode)
  const codexTransport = asString(value.codexTransport)
  const codexAutoUseHttps = asBoolean(value.codexAutoUseHttps)
  // Keep only non-empty model ids from persisted discovery results.
  const fetchedModels = Array.isArray(value.fetchedModels)
    ? value.fetchedModels.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
    : undefined

  // Migrate the removed scalar apiType to the explicit endpoint array.
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
  if (type === 'custom') {
    if (contextWindow !== undefined) provider.contextWindow = contextWindow
    if (maxInputTokens !== undefined) provider.maxInputTokens = maxInputTokens
    if (maxOutputTokens !== undefined) provider.maxOutputTokens = maxOutputTokens
  }
  if (supportsImageInput !== undefined) provider.supportsImageInput = supportsImageInput
  if (reasoningEffortPreset !== undefined && type === 'custom') {
    provider.reasoningEffortPreset = reasoningEffortPreset
  }
  if (reasoningEffortTransport !== undefined && type === 'custom') {
    provider.reasoningEffortTransport = reasoningEffortTransport
  }
  if (apiEndpoints.length > 0) provider.apiEndpoints = apiEndpoints
  if (vendorId) provider.vendorId = vendorId
  if (region) provider.region = region
  if (fetchedModels && fetchedModels.length > 0) provider.fetchedModels = fetchedModels
  if (keyRef) provider.keyRef = keyRef
  if (keyMask) provider.keyMask = keyMask
  if (accountEmail && type === 'xai-subscription') provider.accountEmail = accountEmail
  if (lastValidatedAt !== undefined) provider.lastValidatedAt = lastValidatedAt
  if (lastValidationFailure) provider.lastValidationFailure = lastValidationFailure
  if (expiresAt !== undefined) provider.expiresAt = expiresAt
  if (disconnectedAt !== undefined && type === 'claude-shared') {
    provider.disconnectedAt = disconnectedAt
  }
  if (
    isCodexSubscriptionProvider(type) &&
    (codexAuthMode === 'imported' || codexAuthMode === 'isolated')
  ) {
    provider.codexAuthMode = codexAuthMode
  }
  if (
    isCodexSubscriptionProvider(type) &&
    (codexTransport === 'auto' || codexTransport === 'https' || codexTransport === 'websocket')
  ) {
    provider.codexTransport = codexTransport
  }
  if (isCodexSubscriptionProvider(type) && codexAutoUseHttps !== undefined) {
    provider.codexAutoUseHttps = codexAutoUseHttps
  }
  return provider
}

// Rebuild one custom MCP server, enforcing the transport-specific command/url requirement.
export const sanitizeCustomMcpServer = (value: unknown): StoredCustomMcpServer | undefined => {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const storedName = asString(value.name)
  const storedDisplayName = asString(value.displayName)
  const legacySlug = asString(value.slug)
  const name = storedDisplayName
    ? storedName
    : legacySlug && isCustomConnectorName(legacySlug)
      ? legacySlug
      : storedName
        ? toCustomConnectorName(storedName)
        : undefined
  const displayName = storedDisplayName ?? storedName
  const transport = asString(value.transport) as StoredCustomMcpServer['transport'] | undefined
  const enabled = asBoolean(value.enabled)
  if (
    !id ||
    !name ||
    !displayName ||
    !isCustomConnectorName(name) ||
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

  const server: StoredCustomMcpServer = { id, name, displayName, transport, enabled }
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
  if (transport !== 'stdio' && isRecord(value.oauth)) {
    const oauth: NonNullable<StoredCustomMcpServer['oauth']> = {}
    const clientMetadataUrl = asString(value.oauth.clientMetadataUrl)
    const authorizationServerUrl = asString(value.oauth.authorizationServerUrl)
    const clientId = asString(value.oauth.clientId)
    const redirectUri = asString(value.oauth.redirectUri)
    const scopes = asStringArray(value.oauth.scopes)
      .map((scope) => scope.trim())
      .filter(Boolean)
    if (clientMetadataUrl) oauth.clientMetadataUrl = clientMetadataUrl
    if (authorizationServerUrl) oauth.authorizationServerUrl = authorizationServerUrl
    if (scopes.length) oauth.scopes = [...new Set(scopes)]
    if (clientId) oauth.clientId = clientId
    if (redirectUri) {
      try {
        oauth.redirectUri = normalizeLoopbackOAuthRedirectUri(redirectUri)
      } catch {
        // Ignore invalid persisted values at the settings trust boundary.
      }
    }
    server.oauth = oauth
  }
  const oauthRef = asString(value.oauthRef)
  const oauthClientSecretRef = asString(value.oauthClientSecretRef)
  const sharedOAuthReference =
    transport !== 'stdio' && oauthRef?.startsWith('credential:') ? oauthRef : undefined
  if (server.oauth || sharedOAuthReference) {
    delete server.headers
    delete server.headerRefs
    if (oauthRef) server.oauthRef = oauthRef
    if (server.oauth && oauthClientSecretRef) server.oauthClientSecretRef = oauthClientSecretRef
  }
  const trustedAt = asNumber(value.trustedAt)
  if (trustedAt !== undefined) server.trustedAt = trustedAt
  const description = asString(value.description)
  if (description) server.description = description
  return server
}

// Drop compute grants without all three identity fields.
export const sanitizeComputeGrant = (value: unknown): StoredComputeGrant | undefined => {
  if (!isRecord(value)) return undefined
  const projectId = asString(value.projectId)
  const operation = asString(value.operation)
  const providerId = asString(value.providerId)
  if (!projectId || !operation || !providerId) return undefined
  return { projectId, operation, providerId }
}

// Rebuild the connector policy block and its nested custom MCP records.
export const sanitizeConnectors = (value: unknown): StoredConnectors | undefined => {
  if (!isRecord(value)) return undefined
  const connectors: StoredConnectors = {
    enabledIds: asStringArray(value.enabledIds),
    autoAllowIds: asStringArray(value.autoAllowIds)
  }
  const contactEmail = asString(value.contactEmail)
  const ncbiApiKeyRef = asString(value.ncbiApiKeyRef)
  const openAlexApiKeyRef = asString(value.openAlexApiKeyRef)
  if (contactEmail) connectors.contactEmail = contactEmail
  if (ncbiApiKeyRef) connectors.ncbiApiKeyRef = ncbiApiKeyRef
  if (openAlexApiKeyRef) connectors.openAlexApiKeyRef = openAlexApiKeyRef
  const blockedToolIds = asStringArray(value.blockedToolIds)
  if (blockedToolIds.length) connectors.blockedToolIds = blockedToolIds
  const askToolIds = asStringArray(value.askToolIds)
  if (askToolIds.length) connectors.askToolIds = askToolIds
  const disabledConnectorIds = asStringArray(value.disabledConnectorIds)
  if (disabledConnectorIds.length) {
    connectors.disabledConnectorIds = [...new Set(disabledConnectorIds)]
  }
  const customMcpServers = Array.isArray(value.customMcpServers)
    ? value.customMcpServers
        .map(sanitizeCustomMcpServer)
        .filter((server): server is StoredCustomMcpServer => !!server)
    : []
  if (customMcpServers.length) {
    connectors.customMcpServers = customMcpServers
  }
  const pendingCustomServerDeletionIds = [
    ...new Set(asStringArray(value.pendingCustomServerDeletionIds).filter(Boolean))
  ]
  if (pendingCustomServerDeletionIds.length) {
    connectors.pendingCustomServerDeletionIds = pendingCustomServerDeletionIds
  }
  return connectors
}

// An absent or empty mirror means the public-host defaults remain active.
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
