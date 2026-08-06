import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import type {
  ConnectorTemplateDefinition,
  ConnectorTemplateDiagnostic,
  ConnectorTemplateExportPreview,
  ConnectorTemplatePreview,
  CustomServerTransport
} from '../../shared/settings'
import { CONNECTOR_TEMPLATE_MAX_BYTES } from '../../shared/settings'
import { isCustomConnectorSlug, toCustomConnectorSlug } from '../../shared/custom-connector'

export type ConnectorTemplateSource = {
  id: string
  slug: string
  name: string
  description?: string
  transport: CustomServerTransport
  command?: string
  args?: string[]
  url?: string
  environmentNames?: string[]
  headerNames?: string[]
  oauth?: ConnectorTemplateDefinition['oauth']
}

type ParseOptions = {
  existingIds?: readonly string[]
  existingNames?: readonly string[]
  existingSlugs?: readonly string[]
  bundledIds?: readonly string[]
}

const ROOT_FIELDS = new Set([
  'schemaVersion',
  'kind',
  'name',
  'slug',
  'description',
  'transport',
  'command',
  'args',
  'url',
  'requiredSecrets',
  'oauth'
])
const SECRET_FIELDS = new Set(['environment', 'headers'])
const OAUTH_FIELDS = new Set(['clientMetadataUrl', 'authorizationServerUrl', 'scopes'])
const TRANSPORTS = new Set<CustomServerTransport>(['stdio', 'streamable_http', 'sse'])
const SUSPICIOUS_QUERY_KEYS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
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
  'refreshtoken',
  'secret',
  'token',
  'tokenkey'
])
const JWT = /(?:^|[=:\s])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:$|\s)/
const SECRET_FLAG = /^--?(?:api[-_]?key|token|secret|password|credential|authorization)(?:=|$)/i
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  const raw = readString(value, diagnostics, path, { max: 2_048 })
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
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (SUSPICIOUS_QUERY_KEYS.has(normalizedKey)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.url-secret',
        `${path} contains a credential-like query parameter.`,
        path
      )
      break
    }
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
    value.clientMetadataUrl,
    diagnostics,
    'oauth.clientMetadataUrl'
  )
  const authorizationServerUrl = readHttpUrl(
    value.authorizationServerUrl,
    diagnostics,
    'oauth.authorizationServerUrl'
  )
  const scopes = readStringList(value.scopes, diagnostics, 'oauth.scopes', {
    maxItems: 32,
    maxLength: 128
  })
  return {
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    ...(authorizationServerUrl ? { authorizationServerUrl } : {}),
    ...(scopes ? { scopes } : {})
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
      'requiredSecrets must be an object.',
      'requiredSecrets'
    )
    return undefined
  }
  rejectUnknownFields(value, SECRET_FIELDS, diagnostics, 'requiredSecrets.')
  const environment = readStringList(
    value.environment,
    diagnostics,
    'requiredSecrets.environment',
    { maxItems: 64, maxLength: 128, pattern: SAFE_ENV_NAME }
  )
  const headers = readStringList(value.headers, diagnostics, 'requiredSecrets.headers', {
    maxItems: 64,
    maxLength: 128,
    pattern: SAFE_HEADER_NAME
  })
  return {
    ...(environment ? { environment } : {}),
    ...(headers ? { headers } : {})
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
    if (JWT.test(arg) || /^Bearer\s+/i.test(arg) || SECRET_FLAG.test(arg)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.argument-secret',
        `args[${index}] appears to contain a credential.`,
        `args[${index}]`
      )
    }
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

  rejectUnknownFields(parsed, ROOT_FIELDS, diagnostics)
  if (parsed.schemaVersion !== 1) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.schema-version',
      'schemaVersion must be 1.',
      'schemaVersion'
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

  const name = readString(parsed.name, diagnostics, 'name', { required: true, max: 128 })
  const requestedSlug = readString(parsed.slug, diagnostics, 'slug', { max: 64 })
  const slug = requestedSlug ?? (name ? toCustomConnectorSlug(name) : undefined)
  if (requestedSlug && !isCustomConnectorSlug(requestedSlug)) {
    diagnostic(
      diagnostics,
      'error',
      'connector-template.slug',
      'slug must use only lowercase letters, numbers, and hyphens.',
      'slug'
    )
  }
  const description = readString(parsed.description, diagnostics, 'description', { max: 2_000 })
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
  const command = readString(parsed.command, diagnostics, 'command', { max: 1_024 })
  const args = readStringList(parsed.args, diagnostics, 'args', { maxItems: 128, maxLength: 2_048 })
  const url = parsed.url === undefined ? undefined : readHttpUrl(parsed.url, diagnostics, 'url')
  const requiredSecrets = readRequiredSecrets(parsed.requiredSecrets, diagnostics)
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
  validatePortableCommand(command, diagnostics)
  validateArgs(args, diagnostics)

  if (name) {
    const normalizedName = name.toLowerCase()
    if (options.bundledIds?.some((id) => id.toLowerCase() === normalizedName)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.reserved-name',
        `Connector name "${name}" is reserved by a built-in connector.`,
        'name'
      )
    }
    if (options.existingNames?.some((item) => item.toLowerCase() === normalizedName)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.duplicate-name',
        `A custom Connector named "${name}" is already installed.`,
        'name'
      )
    } else if (
      [...(options.existingSlugs ?? []), ...(options.existingIds ?? [])].some(
        (item) => item.toLowerCase() === normalizedName
      )
    ) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.identity-conflict',
        `Connector name "${name}" conflicts with an installed Connector identity.`,
        'name'
      )
    }
  }
  if (slug) {
    if (options.bundledIds?.includes(slug)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.reserved-slug',
        `Connector ID "${slug}" is reserved by a built-in connector.`,
        'slug'
      )
    }
    if (options.existingSlugs?.includes(slug)) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.duplicate-slug',
        `A custom Connector with ID "${slug}" is already installed.`,
        'slug'
      )
    } else if (
      [...(options.existingNames ?? []), ...(options.existingIds ?? [])].some(
        (item) => item.toLowerCase() === slug
      )
    ) {
      diagnostic(
        diagnostics,
        'error',
        'connector-template.identity-conflict',
        `Connector ID "${slug}" conflicts with an installed Connector alias.`,
        'slug'
      )
    }
  }

  if (hasErrors(diagnostics) || !name || !slug || !transport) return { diagnostics, ready: false }
  const definition: ConnectorTemplateDefinition = {
    schemaVersion: 1,
    kind: 'open-science.connector',
    name,
    slug,
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

const templateJson = (definition: ConnectorTemplateDefinition): string =>
  `${JSON.stringify(definition, null, 2)}\n`

export const buildConnectorTemplateExport = (
  source: ConnectorTemplateSource
): { preview: ConnectorTemplateExportPreview; contents?: string } => {
  const definition: ConnectorTemplateDefinition = {
    schemaVersion: 1,
    kind: 'open-science.connector',
    name: source.name,
    slug: source.slug,
    transport: source.transport,
    ...(source.description ? { description: source.description } : {}),
    ...(source.command ? { command: source.command } : {}),
    ...(source.args?.length ? { args: [...source.args] } : {}),
    ...(source.url ? { url: source.url } : {}),
    ...(source.environmentNames?.length || source.headerNames?.length
      ? {
          requiredSecrets: {
            ...(source.environmentNames?.length
              ? { environment: [...new Set(source.environmentNames)] }
              : {}),
            ...(source.headerNames?.length ? { headers: [...new Set(source.headerNames)] } : {})
          }
        }
      : {}),
    ...(source.oauth ? { oauth: source.oauth } : {})
  }
  const contents = templateJson(definition)
  const parsed = parseConnectorTemplate(contents)
  const digest = parsed.ready ? createHash('sha256').update(contents).digest('hex') : undefined
  return {
    preview: {
      ...parsed,
      connectorId: source.id,
      ...(digest ? { digest, suggestedFileName: `open-science-connector-${source.slug}.json` } : {})
    },
    ...(parsed.ready ? { contents } : {})
  }
}

export const selectedConnectorTemplateFileName = (filePath: string): string => basename(filePath)
