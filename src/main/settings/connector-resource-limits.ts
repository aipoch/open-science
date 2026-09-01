import type {
  AddCustomServerRequest,
  DeviceOAuthRegistration,
  UpdateCustomServerRequest
} from '../../shared/settings'
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
  secretRecordBytes: 256 * 1024,
  credentialIdCharacters: 128,
  credentialBindingRecordBytes: 16 * 1024
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

const assertCredentialBindingRecord = (
  values: Record<string, string> | undefined,
  label: string
): void => {
  if (!values) return
  const entries = Object.entries(values)
  if (entries.length > CONNECTOR_RESOURCE_LIMITS.secretEntries) {
    throw new Error(`${label} must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretEntries} entries.`)
  }
  for (const [name, credentialId] of entries) {
    assertCharacterLimit(name, CONNECTOR_RESOURCE_LIMITS.secretNameCharacters, `${label} name`)
    assertCharacterLimit(
      credentialId,
      CONNECTOR_RESOURCE_LIMITS.credentialIdCharacters,
      `${label} credential ID`
    )
  }
  if (
    Buffer.byteLength(JSON.stringify(values), 'utf8') >
    CONNECTOR_RESOURCE_LIMITS.credentialBindingRecordBytes
  ) {
    throw new Error(
      `${label} must not exceed ${CONNECTOR_RESOURCE_LIMITS.credentialBindingRecordBytes} serialized bytes.`
    )
  }
}

const retainedSecretRecordBytes = (
  values: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  label: string
): number => {
  if (values !== undefined) return assertSecretRecord(values, label)
  return Object.entries(refs ?? {}).reduce(
    (total, [name, ref]) =>
      total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(ref, 'utf8'),
    0
  )
}

const assertSecretValue = (value: string | undefined, label: string): number => {
  if (value === undefined) return 0
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > CONNECTOR_RESOURCE_LIMITS.secretValueBytes) {
    throw new Error(`${label} must not exceed ${CONNECTOR_RESOURCE_LIMITS.secretValueBytes} bytes.`)
  }
  return bytes
}

const assertOAuth = (
  oauth: DeviceOAuthRegistration & { clientSecret?: string | null },
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
  return assertSecretValue(
    typeof oauth.clientSecret === 'string' ? oauth.clientSecret : undefined,
    'OAuth client secret'
  )
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
  assertCredentialBindingRecord(
    request.envCredentialIds,
    'Connector environment credential bindings'
  )
  assertCredentialBindingRecord(request.headerCredentialIds, 'Connector header credential bindings')
  assertCharacterLimit(
    request.oauthCredentialId,
    CONNECTOR_RESOURCE_LIMITS.credentialIdCharacters,
    'OAuth credential ID'
  )
  if (request.oauthRequirements) assertOAuth(request.oauthRequirements)
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
  if (request.oauth) assertOAuth(request.oauth, existing.oauth)
  assertCredentialBindingRecord(
    request.envCredentialIds,
    'Connector environment credential bindings'
  )
  assertCredentialBindingRecord(request.headerCredentialIds, 'Connector header credential bindings')
  assertCharacterLimit(
    request.oauthCredentialId,
    CONNECTOR_RESOURCE_LIMITS.credentialIdCharacters,
    'OAuth credential ID'
  )

  const changesSecretState =
    request.env !== undefined ||
    request.envCredentialIds !== undefined ||
    request.headers !== undefined ||
    request.headerCredentialIds !== undefined ||
    request.oauth !== undefined ||
    request.oauthCredentialId !== undefined
  if (!changesSecretState) return

  const requestedOAuth = request.oauth
  const nextOAuth =
    request.transport === 'stdio' && requestedOAuth === undefined
      ? undefined
      : requestedOAuth === null
        ? undefined
        : requestedOAuth === undefined
          ? existing.oauth
          : requestedOAuth
  const nextClientId =
    requestedOAuth && requestedOAuth !== null
      ? requestedOAuth.clientId?.trim() || undefined
      : nextOAuth?.clientId
  const nextAuthorizationServerUrl =
    requestedOAuth && requestedOAuth !== null
      ? requestedOAuth.authorizationServerUrl?.trim() || undefined
      : nextOAuth?.authorizationServerUrl
  const requestedClientSecret =
    requestedOAuth && requestedOAuth !== null ? requestedOAuth.clientSecret : undefined
  const oauthIdentityChanged =
    nextClientId !== existing.oauth?.clientId ||
    nextAuthorizationServerUrl !== existing.oauth?.authorizationServerUrl
  const effectiveOAuthClientSecret = !nextOAuth
    ? undefined
    : typeof requestedClientSecret === 'string' && requestedClientSecret.trim()
      ? requestedClientSecret.trim()
      : requestedClientSecret === null || oauthIdentityChanged
        ? undefined
        : existing.oauthClientSecret
  const retainedOAuthRef =
    effectiveOAuthClientSecret === undefined &&
    nextOAuth &&
    requestedClientSecret !== null &&
    !oauthIdentityChanged
      ? existing.oauthClientSecretRef
      : undefined
  const environmentBytes =
    request.env !== undefined
      ? assertSecretRecord(request.env, 'Connector environment variables')
      : request.envCredentialIds !== undefined
        ? Buffer.byteLength(JSON.stringify(request.envCredentialIds), 'utf8')
        : retainedSecretRecordBytes(
            existing.env,
            existing.envRefs,
            'Connector environment variables'
          )
  const headerBytes = nextOAuth
    ? 0
    : request.headers !== undefined
      ? assertSecretRecord(request.headers, 'Connector headers')
      : request.headerCredentialIds !== undefined
        ? Buffer.byteLength(JSON.stringify(request.headerCredentialIds), 'utf8')
        : retainedSecretRecordBytes(existing.headers, existing.headerRefs, 'Connector headers')
  const oauthBytes =
    assertSecretValue(effectiveOAuthClientSecret, 'OAuth client secret') +
    (retainedOAuthRef ? Buffer.byteLength(retainedOAuthRef, 'utf8') : 0)
  assertSecretTotal(environmentBytes + headerBytes + oauthBytes)
}

export {
  CONNECTOR_RESOURCE_LIMITS,
  assertAddCustomServerLimits,
  assertCustomServerCapacity,
  assertUpdateCustomServerLimits
}
