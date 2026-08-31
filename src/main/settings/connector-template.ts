import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import type {
  ConnectorTemplateDefinition,
  ConnectorTemplateDiagnostic,
  ConnectorTemplateExportFormat,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  CustomServerTransport
} from '../../shared/settings'
import { CONNECTOR_RESOURCE_LIMITS } from './connector-resource-limits'
import { CONNECTOR_TEMPLATE_MAX_BYTES } from '../../shared/settings'
import { isCustomConnectorName, toCustomConnectorName } from '../../shared/custom-connector'
import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import { isRecord } from '../value-guards'

export type ConnectorTemplateSource = {
  id: string
  name: string
  displayName: string
  description?: string
  transport: CustomServerTransport
  command?: string
  args?: string[]
  url?: string
  environmentNames?: string[]
  headerNames?: string[]
  oauth?: ConnectorTemplateDefinition['oauth']
  hasOAuthClientSecret?: boolean
}

type ConnectorTemplateExport = {
  preview: ConnectorTemplateExportPreview
  contents?: string
  mcpClientContents?: string
}

type ParseOptions = {
  existingNames?: readonly string[]
  bundledIds?: readonly string[]
}

const ROOT_FIELDS = new Set([
  'schema_version',
  'kind',
  'name',
  'display_name',
  'description',
  'transport',
  'command',
  'args',
  'url',
  'required_secrets',
  'oauth'
])
const SECRET_FIELDS = new Set(['environment', 'headers', 'oauth_client_secret'])
const OAUTH_FIELDS = new Set([
  'client_metadata_url',
  'authorization_server_url',
  'scopes',
  'client_id',
  'redirect_uri'
])
const TRANSPORTS = new Set<CustomServerTransport>(['stdio', 'streamable_http', 'sse'])
const SUSPICIOUS_QUERY_KEYS = new Set([
  'accesstoken',
  'apikey',
  'apitoken',
  'auth',
  'authtoken',
  'authorization',
  'bearertoken',
  'clientassertion',
  'clientsecret',
  'code',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'key',
  'passwd',
  'password',
  'privatekey',
  'refreshtoken',
  'securitytoken',
  'secret',
  'sessiontoken',
  'signature',
  'token',
  'tokenkey',
  'xapikey'
])
const JWT = /(?:^|[=:\s])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:$|\s)/
const SECRET_FLAG =
  /^--?(?:[a-z0-9]+[-_])*(?:access[-_]?(?:key|token)|api[-_]?(?:key|token)|auth(?:entication)?[-_]?(?:key|token)|authorization|bearer(?:[-_]?token)?|client[-_]?secret|cookie|credentials?|passphrase|passwd|password|pat|private[-_]?key|refresh[-_]?token|secret(?:[-_]?access[-_]?key)?|security[-_]?token|session[-_]?token|tokens?|user)(?:[-_]?(?:file|path))?(?:=|:|$)/i
const CREDENTIAL_USER_FLAG = /^-[uU](?:[=:]|[^-]*:)/
const CREDENTIAL_HEADER_NAME =
  /(?:^|[-_])(?:auth(?:entication|orization)?|bearer|cookie|credentials?|passphrase|passwd|password|pat|secret|signature|token|(?:access|api|client|private|refresh|security|session)[-_]?(?:key|secret|token))(?:$|[-_])/i
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const CONNECTOR_TEMPLATE_DIGEST_CACHE_LIMIT = 64

const hasSuspiciousQueryKey = (url: URL): boolean =>
  [...url.searchParams.keys()].some((key) =>
    SUSPICIOUS_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
  )

const urlContainsCredential = (value: string): boolean => {
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || hasSuspiciousQueryKey(url))
  } catch {
    return false
  }
}

const argumentUrlContainsCredential = (argument: string): boolean => {
  const trimmed = argument.trim()
  if (urlContainsCredential(trimmed)) return true

  const separator = trimmed.indexOf('=')
  return separator >= 0 && urlContainsCredential(trimmed.slice(separator + 1))
}

const headerArgumentValue = (argument: string): string => {
  const trimmed = argument.trim()
  const longOption = /^--header(?:=|\s+)(.+)$/i.exec(trimmed)
  if (longOption) return longOption[1].trim()

  const shortOption = /^-H(?:=|\s+)?(.+)$/i.exec(trimmed)
  return shortOption ? shortOption[1].trim() : trimmed
}

const headerArgumentContainsCredential = (argument: string): boolean => {
  const value = headerArgumentValue(argument)
  const separator = value.indexOf(':')
  return (
    separator > 0 &&
    CREDENTIAL_HEADER_NAME.test(value.slice(0, separator).trim()) &&
    /\S/.test(value.slice(separator + 1))
  )
}

const argumentContainsCredential = (argument: string): boolean =>
  JWT.test(argument) ||
  /^Bearer\s+/i.test(argument) ||
  SECRET_FLAG.test(argument) ||
  CREDENTIAL_USER_FLAG.test(argument) ||
  headerArgumentContainsCredential(argument) ||
  argumentUrlContainsCredential(argument)

const splitUserValueContainsCredential = (argument: string): boolean => {
  const value = argument.trim()
  if (/^[A-Za-z]:[\\/]/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  const separator = value.indexOf(':')
  return separator >= 0 && /\S/.test(value.replace(':', ''))
}

const argumentsContainCredential = (args: readonly string[]): boolean =>
  args.some(argumentContainsCredential) ||
  args.some(
    (argument, index) =>
      /^-[uU]$/.test(argument.trim()) && splitUserValueContainsCredential(args[index + 1] ?? '')
  ) ||
  args.some((argument, index) => {
    if (!/^(?:--header|-H)(?:=.+)?$/i.test(argument.trim())) return false
    return argumentContainsCredential(args.slice(index).join(' '))
  })

export const hasEmbeddedConnectorCredentials = (fields: {
  args?: readonly string[]
  url?: string
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    redirectUri?: string
  } | null
}): boolean => {
  if (fields.args && argumentsContainCredential(fields.args)) return true
  return [
    fields.url,
    fields.oauth?.clientMetadataUrl,
    fields.oauth?.authorizationServerUrl,
    fields.oauth?.redirectUri
  ].some((url) => Boolean(url && urlContainsCredential(url)))
}

// Keeps preview digests opaque to the renderer without persisting exported connector metadata.
const connectorTemplateDigests = new Map<string, string>()

const connectorTemplateDigest = (contents: string): string => {
  const existing = connectorTemplateDigests.get(contents)
  if (existing) {
    connectorTemplateDigests.delete(contents)
    connectorTemplateDigests.set(contents, existing)
    return existing
  }

  const digest = randomBytes(32).toString('hex')
  connectorTemplateDigests.set(contents, digest)
  if (connectorTemplateDigests.size > CONNECTOR_TEMPLATE_DIGEST_CACHE_LIMIT) {
    const oldest = connectorTemplateDigests.keys().next()
    if (!oldest.done) connectorTemplateDigests.delete(oldest.value)
  }
  return digest
}

const diagnostic = (
  diagnostics: ConnectorTemplateDiagnostic[],
  severity: ConnectorTemplateDiagnostic['severity'],
  code: string,
  message: string,
  path?: string
): void => {
  diagnostics.push({ severity, code, message, ...(path ? { path } : {}) })
}

const rejectUnknownFields = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  diagnostics: ConnectorTemplateDiagnostic[],
  prefix = ''
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.unknown-field',
        `Unknown field "${prefix}${key}".`,
        `${prefix}${key}`
      )
    }
  }
}

const readString = (
  value: unknown,
  diagnostics: ConnectorTemplateDiagnostic[],
  path: string,
  options: { required?: boolean; max: number }
): string | undefined => {
  if (value === undefined) {
    if (options.required) {
      diagnostic(diagnostics, 'error', 'connector-template.required', `Missing ${path}.`, path)
    }
    return undefined
  }
  if (typeof value !== 'string') {
    diagnostic(diagnostics, 'error', 'connector-template.type', `${path} must be a string.`, path)
    return undefined
  }
  const result = value.trim()
  if (!result) {
    diagnostic(diagnostics, 'error', 'connector-template.empty', `${path} cannot be empty.`, path)
    return undefined
  }
  if (result.length > options.max) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.too-long',
      `${path} exceeds ${options.max} characters.`,
      path
    )
    return undefined
  }
  return result
}

const readStringList = (
  value: unknown,
  diagnostics: ConnectorTemplateDiagnostic[],
  path: string,
  options: { maxItems: number; maxLength: number; pattern?: RegExp }
): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'error', 'connector-template.type', `${path} must be an array.`, path)
    return undefined
  }
  if (value.length > options.maxItems) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.too-many',
      `${path} exceeds ${options.maxItems} entries.`,
      path
    )
    return undefined
  }
  const result: string[] = []
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const parsed = readString(item, diagnostics, itemPath, { max: options.maxLength })
    if (!parsed) continue
    if (options.pattern && !options.pattern.test(parsed)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.invalid-name',
        `${itemPath} contains unsupported characters.`,
        itemPath
      )
      continue
    }
    if (!result.includes(parsed)) result.push(parsed)
  }
  return result.length > 0 ? result : undefined
}

const readHttpUrl = (
  value: unknown,
  diagnostics: ConnectorTemplateDiagnostic[],
  path: string
): string | undefined => {
  const raw = readString(value, diagnostics, path, {
    max: CONNECTOR_RESOURCE_LIMITS.urlCharacters
  })
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    diagnostic(diagnostics, 'error', 'connector-template.url', `${path} must be a valid URL.`, path)
    return undefined
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.url-protocol',
      `${path} must use http or https.`,
      path
    )
  }
  if (url.username || url.password) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.url-credentials',
      `${path} cannot contain credentials.`,
      path
    )
  }
  if (hasSuspiciousQueryKey(url)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.url-secret',
      `${path} contains a credential-like query parameter.`,
      path
    )
  }
  return raw
}

const readOAuth = (
  value: unknown,
  diagnostics: ConnectorTemplateDiagnostic[]
): ConnectorTemplateDefinition['oauth'] | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'error', 'connector-template.type', 'oauth must be an object.', 'oauth')
    return undefined
  }
  rejectUnknownFields(value, OAUTH_FIELDS, diagnostics, 'oauth.')
  const clientMetadataUrl = readHttpUrl(
    value.client_metadata_url,
    diagnostics,
    'oauth.client_metadata_url'
  )
  const authorizationServerUrl = readHttpUrl(
    value.authorization_server_url,
    diagnostics,
    'oauth.authorization_server_url'
  )
  const scopes = readStringList(value.scopes, diagnostics, 'oauth.scopes', {
    maxItems: CONNECTOR_RESOURCE_LIMITS.oauthScopes,
    maxLength: CONNECTOR_RESOURCE_LIMITS.oauthScopeCharacters
  })
  const clientId = readString(value.client_id, diagnostics, 'oauth.client_id', {
    max: CONNECTOR_RESOURCE_LIMITS.urlCharacters
  })
  const rawRedirectUri = readHttpUrl(value.redirect_uri, diagnostics, 'oauth.redirect_uri')
  let redirectUri: string | undefined
  if (rawRedirectUri) {
    try {
      redirectUri = normalizeLoopbackOAuthRedirectUri(rawRedirectUri)
    } catch (error) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.oauth-redirect-uri',
        error instanceof Error ? error.message : 'Invalid OAuth redirect URI.',
        'oauth.redirect_uri'
      )
    }
  }
  return {
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    ...(authorizationServerUrl ? { authorizationServerUrl } : {}),
    ...(scopes ? { scopes } : {}),
    ...(clientId ? { clientId } : {}),
    ...(redirectUri ? { redirectUri } : {})
  }
}

const readRequiredSecrets = (
  value: unknown,
  diagnostics: ConnectorTemplateDiagnostic[]
): ConnectorTemplateDefinition['requiredSecrets'] | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.type',
      'required_secrets must be an object.',
      'required_secrets'
    )
    return undefined
  }
  rejectUnknownFields(value, SECRET_FIELDS, diagnostics, 'required_secrets.')
  const environment = readStringList(
    value.environment,
    diagnostics,
    'required_secrets.environment',
    {
      maxItems: CONNECTOR_RESOURCE_LIMITS.secretEntries,
      maxLength: CONNECTOR_RESOURCE_LIMITS.secretNameCharacters,
      pattern: SAFE_ENV_NAME
    }
  )
  const headers = readStringList(value.headers, diagnostics, 'required_secrets.headers', {
    maxItems: CONNECTOR_RESOURCE_LIMITS.secretEntries,
    maxLength: CONNECTOR_RESOURCE_LIMITS.secretNameCharacters,
    pattern: SAFE_HEADER_NAME
  })
  const oauthClientSecret = value.oauth_client_secret
  if (oauthClientSecret !== undefined && oauthClientSecret !== true) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.type',
      'required_secrets.oauth_client_secret must be true.',
      'required_secrets.oauth_client_secret'
    )
  }
  return {
    ...(environment ? { environment } : {}),
    ...(headers ? { headers } : {}),
    ...(oauthClientSecret === true ? { oauthClientSecret: true } : {})
  }
}

const hasErrors = (diagnostics: ConnectorTemplateDiagnostic[]): boolean =>
  diagnostics.some((item) => item.severity === 'error')

const isLocalPath = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('~') ||
  /^[A-Za-z]:[\\/]/.test(value) ||
  value.startsWith('\\\\')

const validatePortableCommand = (
  command: string | undefined,
  diagnostics: ConnectorTemplateDiagnostic[]
): void => {
  if (command && isLocalPath(command)) {
    diagnostic(
      diagnostics,
      'warning',
      'connector-template.local-command',
      'command uses a local path and may need to be changed on another computer.',
      'command'
    )
  }
}

const validateArgs = (
  args: string[] | undefined,
  diagnostics: ConnectorTemplateDiagnostic[]
): void => {
  let credentialReported = false
  for (const [index, arg] of (args ?? []).entries()) {
    if (isLocalPath(arg)) {
      diagnostic(
        diagnostics,
        'warning',
        'connector-template.local-argument',
        `args[${index}] uses a local path and may need to be changed on another computer.`,
        `args[${index}]`
      )
    }
    if (/[\r\n]/.test(arg)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.argument-line-break',
        `args[${index}] cannot contain a line break.`,
        `args[${index}]`
      )
    }
    if (argumentContainsCredential(arg)) {
      credentialReported = true
      diagnostic(
        diagnostics,
        'error',
        'connector-template.argument-secret',
        `args[${index}] appears to contain a credential.`,
        `args[${index}]`
      )
    }
  }
  if (args && !credentialReported && argumentsContainCredential(args)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.argument-secret',
      'args appears to contain a credential.',
      'args'
    )
  }
}

export const parseConnectorTemplate = (
  contents: string,
  options: ParseOptions = {}
): ConnectorTemplatePreview => {
  const diagnostics: ConnectorTemplateDiagnostic[] = []
  if (Buffer.byteLength(contents, 'utf8') > CONNECTOR_TEMPLATE_MAX_BYTES) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.too-large',
      'Connector configuration files must be 256 KiB or smaller.'
    )
    return { diagnostics, ready: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.invalid-json',
      'The selected file is not valid JSON.'
    )
    return { diagnostics, ready: false }
  }
  if (!isRecord(parsed)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.root',
      'The Connector configuration must be a JSON object.'
    )
    return { diagnostics, ready: false }
  }

  if (isRecord(parsed.mcpServers)) {
    const definitions: ConnectorTemplateDefinition[] = []
    const usedNames = new Set<string>()
    for (const [serverName, rawServer] of Object.entries(parsed.mcpServers)) {
      const path = `mcpServers.${serverName}`
      if (!isRecord(rawServer)) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.type',
          'MCP server configuration must be an object.',
          path
        )
        continue
      }
      const explicitType = asString(rawServer.type)?.toLowerCase()
      const hasCommand = typeof rawServer.command === 'string'
      const hasUrl = typeof rawServer.url === 'string'
      const transport =
        explicitType === 'stdio'
          ? 'stdio'
          : explicitType === 'sse'
            ? 'sse'
            : explicitType === 'http' ||
                explicitType === 'streamable-http' ||
                explicitType === 'streamable_http'
              ? 'streamable_http'
              : hasCommand
                ? 'stdio'
                : hasUrl
                  ? 'streamable_http'
                  : undefined
      const supportedType =
        explicitType === undefined ||
        ['stdio', 'http', 'streamable-http', 'streamable_http', 'sse'].includes(explicitType)
      if (!supportedType) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.transport',
          'Unsupported MCP transport.',
          `${path}.type`
        )
        continue
      }
      if (!transport) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.transport',
          'MCP server must define either command or url.',
          path
        )
        continue
      }
      if (
        hasCommand === hasUrl ||
        (transport === 'stdio' && !hasCommand) ||
        (transport !== 'stdio' && !hasUrl)
      ) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.transport-fields',
          'MCP server transport does not match its connection fields.',
          path
        )
        continue
      }
      const name = isCustomConnectorName(serverName)
        ? serverName
        : toCustomConnectorName(serverName)
      if (usedNames.has(name)) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.duplicate-name',
          'MCP server names must remain unique after normalization.',
          path
        )
        continue
      }
      usedNames.add(name)
      if (name !== serverName) {
        diagnostic(
          diagnostics,
          'warning',
          'connector-template.normalized-name',
          'MCP server name was normalized for Open Science.',
          path
        )
      }
      if (rawServer.env !== undefined && !isRecord(rawServer.env)) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.type',
          'MCP server environment variables must be an object.',
          `${path}.env`
        )
        continue
      }
      if (rawServer.headers !== undefined && !isRecord(rawServer.headers)) {
        diagnostic(
          diagnostics,
          'error',
          'connector-template.type',
          'MCP server headers must be an object.',
          `${path}.headers`
        )
        continue
      }
      const environment = isRecord(rawServer.env) ? Object.keys(rawServer.env) : []
      const headers = isRecord(rawServer.headers) ? Object.keys(rawServer.headers) : []
      if (environment.length || headers.length) {
        diagnostic(
          diagnostics,
          'warning',
          'connector-template.secret-values-excluded',
          'Credential values were excluded and must be entered locally.',
          path
        )
      }
      const candidate = parseConnectorTemplate(
        JSON.stringify({
          schema_version: 1,
          kind: 'open-science.connector',
          name,
          display_name: serverName,
          transport,
          ...(transport === 'stdio'
            ? { command: rawServer.command, args: rawServer.args }
            : { url: rawServer.url }),
          ...(environment.length || headers.length
            ? {
                required_secrets: {
                  ...(environment.length ? { environment } : {}),
                  ...(headers.length ? { headers } : {})
                }
              }
            : {})
        }),
        options
      )
      diagnostics.push(
        ...candidate.diagnostics.map((item) => ({
          ...item,
          path: item.path ? `${path}.${item.path}` : path
        }))
      )
      if (candidate.ready && candidate.definition) definitions.push(candidate.definition)
    }
    if (definitions.length === 0 && diagnostics.length === 0) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.empty-mcp-servers',
        'The MCP client configuration must contain at least one server.',
        'mcpServers'
      )
    }
    return {
      ...(definitions[0] ? { definition: definitions[0] } : {}),
      ...(definitions.length > 1 ? { definitions } : {}),
      sourceFormat: 'mcp-client',
      diagnostics,
      ready: definitions.length > 0
    }
  }

  if (
    Array.isArray(parsed.packages) ||
    Array.isArray(parsed.remotes) ||
    (typeof parsed.$schema === 'string' && parsed.$schema.includes('/server.schema.json'))
  ) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.registry-manifest',
      'MCP Registry server.json manifests cannot be imported as installed MCP client configurations.',
      '$schema'
    )
    return { sourceFormat: 'mcp-registry', diagnostics, ready: false }
  }

  rejectUnknownFields(parsed, ROOT_FIELDS, diagnostics)
  const schemaVersion = parsed.schema_version === 1 ? parsed.schema_version : undefined
  if (!schemaVersion) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.schema-version',
      'schema_version must be 1.',
      'schema_version'
    )
  }
  if (parsed.kind !== 'open-science.connector') {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.kind',
      'kind must be "open-science.connector".',
      'kind'
    )
  }

  const name = readString(parsed.name, diagnostics, 'name', {
    required: true,
    max: CONNECTOR_RESOURCE_LIMITS.nameCharacters
  })
  const displayName = readString(parsed.display_name, diagnostics, 'display_name', {
    required: true,
    max: CONNECTOR_RESOURCE_LIMITS.displayNameCharacters
  })
  if (name && !isCustomConnectorName(name)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.name',
      'name must use only lowercase letters, numbers, and hyphens.',
      'name'
    )
  }
  const description = readString(parsed.description, diagnostics, 'description', {
    max: CONNECTOR_RESOURCE_LIMITS.descriptionCharacters
  })
  const transport = TRANSPORTS.has(parsed.transport as CustomServerTransport)
    ? (parsed.transport as CustomServerTransport)
    : undefined
  if (!transport) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.transport',
      'transport must be stdio, streamable_http, or sse.',
      'transport'
    )
  }
  const command = readString(parsed.command, diagnostics, 'command', {
    max: CONNECTOR_RESOURCE_LIMITS.commandCharacters
  })
  const args = readStringList(parsed.args, diagnostics, 'args', {
    maxItems: CONNECTOR_RESOURCE_LIMITS.arguments,
    maxLength: CONNECTOR_RESOURCE_LIMITS.argumentCharacters
  })
  const url = parsed.url === undefined ? undefined : readHttpUrl(parsed.url, diagnostics, 'url')
  const requiredSecrets = readRequiredSecrets(parsed.required_secrets, diagnostics)
  const oauth = readOAuth(parsed.oauth, diagnostics)

  if (transport === 'stdio' && !command) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.command',
      'stdio requires command.',
      'command'
    )
  }
  if (transport && transport !== 'stdio' && !url) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.url-required',
      'Remote transports require url.',
      'url'
    )
  }
  if (transport === 'stdio' && (url || oauth)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.stdio-remote-fields',
      'stdio cannot include url or oauth.'
    )
  }
  if (transport === 'stdio' && requiredSecrets?.headers?.length) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.stdio-headers',
      'stdio cannot include required header secrets.'
    )
  }
  if (transport !== 'stdio' && command) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.remote-command',
      'Remote transports cannot include command.',
      'command'
    )
  }
  if (transport && transport !== 'stdio' && requiredSecrets?.environment?.length) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.remote-environment',
      'Remote transports cannot include required environment secrets.'
    )
  }
  if (oauth && requiredSecrets?.headers?.length) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.oauth-headers',
      'OAuth and required header secrets cannot be configured together.'
    )
  }
  if (oauth?.clientId && !oauth.authorizationServerUrl) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.oauth-issuer',
      'A pre-registered OAuth client requires authorization_server_url.',
      'oauth.authorization_server_url'
    )
  }
  if (oauth?.clientId && oauth.clientMetadataUrl) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.oauth-registration',
      'client_id cannot be combined with client_metadata_url.',
      'oauth.client_id'
    )
  }
  if (oauth?.redirectUri && !oauth.clientId) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.oauth-redirect-uri-client',
      'OAuth redirect URI requires a pre-registered client ID.',
      'oauth.redirect_uri'
    )
  }
  if (requiredSecrets?.oauthClientSecret && !oauth?.clientId) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.oauth-client-secret',
      'An OAuth client secret requires oauth.client_id.',
      'required_secrets.oauth_client_secret'
    )
  }
  validatePortableCommand(command, diagnostics)
  validateArgs(args, diagnostics)

  if (name) {
    if (options.bundledIds?.includes(name)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.reserved-name',
        `Connector ID "${name}" is reserved by a built-in connector.`,
        'name'
      )
    }
    if (options.existingNames?.includes(name)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.duplicate-name',
        `A custom Connector with ID "${name}" is already installed.`,
        'name'
      )
    }
  }

  if (hasErrors(diagnostics) || !schemaVersion || !name || !displayName || !transport) {
    return { diagnostics, ready: false }
  }
  const definition: ConnectorTemplateDefinition = {
    schemaVersion,
    kind: 'open-science.connector',
    name,
    displayName,
    transport,
    ...(description ? { description } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    ...(requiredSecrets && Object.keys(requiredSecrets).length ? { requiredSecrets } : {}),
    ...(oauth ? { oauth } : {})
  }
  return { definition, diagnostics, ready: true }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const templateJson = (definition: ConnectorTemplateDefinition): string =>
  `${JSON.stringify(
    {
      schema_version: definition.schemaVersion,
      kind: definition.kind,
      name: definition.name,
      display_name: definition.displayName,
      transport: definition.transport,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.command ? { command: definition.command } : {}),
      ...(definition.args ? { args: definition.args } : {}),
      ...(definition.url ? { url: definition.url } : {}),
      ...(definition.requiredSecrets
        ? {
            required_secrets: {
              ...(definition.requiredSecrets.environment
                ? { environment: definition.requiredSecrets.environment }
                : {}),
              ...(definition.requiredSecrets.headers
                ? { headers: definition.requiredSecrets.headers }
                : {}),
              ...(definition.requiredSecrets.oauthClientSecret ? { oauth_client_secret: true } : {})
            }
          }
        : {}),
      ...(definition.oauth
        ? {
            oauth: {
              ...(definition.oauth.clientMetadataUrl
                ? { client_metadata_url: definition.oauth.clientMetadataUrl }
                : {}),
              ...(definition.oauth.authorizationServerUrl
                ? { authorization_server_url: definition.oauth.authorizationServerUrl }
                : {}),
              ...(definition.oauth.scopes ? { scopes: definition.oauth.scopes } : {}),
              ...(definition.oauth.clientId ? { client_id: definition.oauth.clientId } : {}),
              ...(definition.oauth.redirectUri
                ? { redirect_uri: definition.oauth.redirectUri }
                : {})
            }
          }
        : {})
    },
    null,
    2
  )}\n`

const secretPlaceholders = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `\${${name}}`]))

const mcpClientJson = (definition: ConnectorTemplateDefinition): string =>
  `${JSON.stringify(
    {
      mcpServers: {
        [definition.name]:
          definition.transport === 'stdio'
            ? {
                command: definition.command,
                ...(definition.args?.length ? { args: definition.args } : {}),
                ...(definition.requiredSecrets?.environment?.length
                  ? { env: secretPlaceholders(definition.requiredSecrets.environment) }
                  : {})
              }
            : {
                type: definition.transport === 'sse' ? 'sse' : 'http',
                url: definition.url,
                ...(definition.requiredSecrets?.headers?.length
                  ? { headers: secretPlaceholders(definition.requiredSecrets.headers) }
                  : {})
              }
      }
    },
    null,
    2
  )}\n`

export const connectorTemplateExportSelection = (
  result: ConnectorTemplateExport,
  format: ConnectorTemplateExportFormat
): { digest?: string; suggestedFileName?: string; contents?: string } =>
  format === 'mcp-client'
    ? {
        digest: result.preview.mcpClientDigest,
        suggestedFileName: result.preview.mcpClientSuggestedFileName,
        contents: result.mcpClientContents
      }
    : {
        digest: result.preview.digest,
        suggestedFileName: result.preview.suggestedFileName,
        contents: result.contents
      }

export const buildConnectorTemplateExport = (
  source: ConnectorTemplateSource
): ConnectorTemplateExport => {
  const definition: ConnectorTemplateDefinition = {
    schemaVersion: 1,
    kind: 'open-science.connector',
    name: source.name,
    displayName: source.displayName,
    transport: source.transport,
    ...(source.description ? { description: source.description } : {}),
    ...(source.command ? { command: source.command } : {}),
    ...(source.args?.length ? { args: [...source.args] } : {}),
    ...(source.url ? { url: source.url } : {}),
    ...(source.environmentNames?.length || source.headerNames?.length || source.hasOAuthClientSecret
      ? {
          requiredSecrets: {
            ...(source.environmentNames?.length
              ? { environment: [...new Set(source.environmentNames)] }
              : {}),
            ...(source.headerNames?.length ? { headers: [...new Set(source.headerNames)] } : {}),
            ...(source.hasOAuthClientSecret ? { oauthClientSecret: true } : {})
          }
        }
      : {}),
    ...(source.oauth ? { oauth: source.oauth } : {})
  }
  const contents = templateJson(definition)
  const parsed = parseConnectorTemplate(contents)
  if (!parsed.ready) {
    return {
      preview: {
        ...parsed,
        connectorId: source.id
      }
    }
  }

  const digest = connectorTemplateDigest(contents)
  const mcpClientContents = mcpClientJson(definition)
  const mcpClientDigest = connectorTemplateDigest(mcpClientContents)
  const mcpClientDiagnostics: ConnectorTemplateDiagnostic[] = source.oauth
    ? [
        {
          severity: 'warning',
          code: 'connector-template.mcp-oauth-excluded',
          message:
            'OAuth registration and OAuth tokens were excluded from the MCP client configuration.'
        }
      ]
    : []
  return {
    preview: {
      ...parsed,
      connectorId: source.id,
      digest,
      suggestedFileName: `open-science-connector-${source.name}.json`,
      mcpClientDigest,
      mcpClientSuggestedFileName: `mcp-${source.name}.json`,
      ...(mcpClientDiagnostics.length ? { mcpClientDiagnostics } : {})
    },
    contents,
    mcpClientContents
  }
}

export const selectedConnectorTemplateFileName = (filePath: string): string => basename(filePath)
