import type { AddCustomServerRequest, UpdateCustomServerRequest } from '../../shared/settings'
import type { StoredCustomMcpServer } from './types'
import { SETTINGS_RESOURCE_LIMITS, assertCharacterLimit } from './settings-resource-limits'

const CONNECTOR_RESOURCE_LIMITS = Object.freeze({
  customServers: 64,
  nameCharacters: 64,
  displayNameCharacters: 128,
  descriptionCharacters: 2_000,
  commandCharacters: 1_024,
  urlCharacters: 2_048,
  arguments: 128,
  argumentCharacters: 2_048,
  oauthScopes: 32,
  oauthScopeCharacters: 128,
  secretEntries: 64,
  secretNameCharacters: 128,
  secretValueBytes: SETTINGS_RESOURCE_LIMITS.credentialBytes,
  secretRecordBytes: 256 * 1024
})

const assertStringList = (
  values: string[] | undefined,
  maxItems: number,
  maxCharacters: number,
  listLabel: string,
  itemLabel: string
): void => {
  if (!values) return
  if (values.length > maxItems) throw new Error(`${listLabel} must not exceed ${maxItems} entries.`)
  for (const value of values) assertCharacterLimit(value, maxCharacters, itemLabel)
}

const assertSecretRecord = (values: Record<string, string> | undefined, label: string): number => {
  if (!values) return 0
  const entries = Object.entries(values)
  if (entries.length > CONNECTOR_RESOURCE_LIMITS.secretEntries) {
    throw new Error(`${label} must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretEntries} entries.`)
  }
  let totalBytes = 0
  for (const [name, value] of entries) {
    assertCharacterLimit(name, CONNECTOR_RESOURCE_LIMITS.secretNameCharacters, `${label} name`)
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > CONNECTOR_RESOURCE_LIMITS.secretValueBytes) {
      throw new Error(
        `${label} value must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretValueBytes} bytes.`
      )
    }
    totalBytes += Buffer.byteLength(name, 'utf8') + bytes
  }
  return totalBytes
}

const assertOAuth = (
  oauth:
    NonNullable<AddCustomServerRequest['oauth']> | NonNullable<UpdateCustomServerRequest['oauth']>,
  existing?: StoredCustomMcpServer['oauth']
): number => {
  const assertChanged = (
    value: string | undefined,
    previous: string | undefined,
    label: string
  ): void => {
    if (value !== previous)
      assertCharacterLimit(value, CONNECTOR_RESOURCE_LIMITS.urlCharacters, label)
  }
  assertChanged(oauth.clientMetadataUrl, existing?.clientMetadataUrl, 'OAuth client metadata URL')
  assertChanged(
    oauth.authorizationServerUrl,
    existing?.authorizationServerUrl,
    'OAuth authorization server URL'
  )
  assertChanged(oauth.clientId, existing?.clientId, 'OAuth client ID')
  assertChanged(oauth.redirectUri, existing?.redirectUri, 'OAuth redirect URI')
  if (oauth.scopes && JSON.stringify(oauth.scopes) !== JSON.stringify(existing?.scopes)) {
    assertStringList(
      oauth.scopes,
      CONNECTOR_RESOURCE_LIMITS.oauthScopes,
      CONNECTOR_RESOURCE_LIMITS.oauthScopeCharacters,
      'OAuth scopes',
      'OAuth scope'
    )
  }
  if (typeof oauth.clientSecret !== 'string') return 0
  const bytes = Buffer.byteLength(oauth.clientSecret, 'utf8')
  if (bytes > CONNECTOR_RESOURCE_LIMITS.secretValueBytes) {
    throw new Error(
      `OAuth client secret must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretValueBytes} bytes.`
    )
  }
  return bytes
}

const assertSecretTotal = (bytes: number): void => {
  if (bytes > CONNECTOR_RESOURCE_LIMITS.secretRecordBytes) {
    throw new Error(
      `Connector secret data must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretRecordBytes} bytes.`
    )
  }
}

const assertCustomServerCapacity = (count: number): void => {
  if (count >= CONNECTOR_RESOURCE_LIMITS.customServers) {
    throw new Error(`Custom Connector limit of ${CONNECTOR_RESOURCE_LIMITS.customServers} reached.`)
  }
}

const assertAddCustomServerLimits = (request: AddCustomServerRequest): void => {
  assertCharacterLimit(request.name, CONNECTOR_RESOURCE_LIMITS.nameCharacters, 'Connector name')
  assertCharacterLimit(
    request.displayName,
    CONNECTOR_RESOURCE_LIMITS.displayNameCharacters,
    'Connector display name'
  )
  assertCharacterLimit(
    request.description,
    CONNECTOR_RESOURCE_LIMITS.descriptionCharacters,
    'Connector description'
  )
  assertCharacterLimit(
    request.command,
    CONNECTOR_RESOURCE_LIMITS.commandCharacters,
    'Connector command'
  )
  assertCharacterLimit(request.url, CONNECTOR_RESOURCE_LIMITS.urlCharacters, 'Connector URL')
  assertStringList(
    request.args,
    CONNECTOR_RESOURCE_LIMITS.arguments,
    CONNECTOR_RESOURCE_LIMITS.argumentCharacters,
    'Connector arguments',
    'Connector argument'
  )
  const secretBytes =
    assertSecretRecord(request.env, 'Connector environment variables') +
    assertSecretRecord(request.headers, 'Connector headers') +
    (request.oauth ? assertOAuth(request.oauth) : 0)
  assertSecretTotal(secretBytes)
}

const assertUpdateCustomServerLimits = (
  request: UpdateCustomServerRequest,
  existing: StoredCustomMcpServer
): void => {
  const changed = (value: unknown, previous: unknown): boolean =>
    JSON.stringify(value) !== JSON.stringify(previous)
  if (request.displayName !== undefined && request.displayName !== existing.displayName) {
    assertCharacterLimit(
      request.displayName,
      CONNECTOR_RESOURCE_LIMITS.displayNameCharacters,
      'Connector display name'
    )
  }
  if (request.description !== existing.description) {
    assertCharacterLimit(
      request.description,
      CONNECTOR_RESOURCE_LIMITS.descriptionCharacters,
      'Connector description'
    )
  }
  if (request.command !== existing.command) {
    assertCharacterLimit(
      request.command,
      CONNECTOR_RESOURCE_LIMITS.commandCharacters,
      'Connector command'
    )
  }
  if (request.url !== existing.url) {
    assertCharacterLimit(request.url, CONNECTOR_RESOURCE_LIMITS.urlCharacters, 'Connector URL')
  }
  if (request.args !== undefined && changed(request.args, existing.args)) {
    assertStringList(
      request.args,
      CONNECTOR_RESOURCE_LIMITS.arguments,
      CONNECTOR_RESOURCE_LIMITS.argumentCharacters,
      'Connector arguments',
      'Connector argument'
    )
  }
  const secretBytes =
    assertSecretRecord(request.env, 'Connector environment variables') +
    assertSecretRecord(request.headers, 'Connector headers') +
    (request.oauth ? assertOAuth(request.oauth, existing.oauth) : 0)
  assertSecretTotal(secretBytes)
}

export {
  CONNECTOR_RESOURCE_LIMITS,
  assertAddCustomServerLimits,
  assertCustomServerCapacity,
  assertUpdateCustomServerLimits
}
