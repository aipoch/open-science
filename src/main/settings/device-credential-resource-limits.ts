import type {
  CreateDeviceCredentialRequest,
  DeviceOAuthRegistration,
  UpdateDeviceCredentialRequest
} from '../../shared/settings'
import type { StoredDeviceCredential } from './types'
import { SETTINGS_RESOURCE_LIMITS, assertCharacterLimit } from './settings-resource-limits'

const DEVICE_CREDENTIAL_RESOURCE_LIMITS = Object.freeze({
  credentials: 128,
  idCharacters: 128,
  displayNameCharacters: 128,
  resourceUrlCharacters: 2_048,
  oauthUrlCharacters: 2_048,
  oauthClientIdCharacters: 2_048,
  oauthScopes: 32,
  oauthScopeCharacters: 128,
  secretBytes: SETTINGS_RESOURCE_LIMITS.credentialBytes,
  recordBytes: 64 * 1024,
  storedRecordBytes: 512 * 1024,
  oauthStateBytes: 256 * 1024,
  documentBytes: 16 * 1024 * 1024
})

const assertByteLimit = (value: string | undefined, limit: number, label: string): void => {
  if (value !== undefined && Buffer.byteLength(value, 'utf8') > limit) {
    throw new Error(`${label} must not exceed ${limit} bytes.`)
  }
}

const assertOAuthFields = (oauth: DeviceOAuthRegistration & { clientSecret?: string }): void => {
  assertCharacterLimit(
    oauth.clientMetadataUrl,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthUrlCharacters,
    'OAuth client metadata URL'
  )
  assertCharacterLimit(
    oauth.authorizationServerUrl,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthUrlCharacters,
    'OAuth authorization server URL'
  )
  assertCharacterLimit(
    oauth.redirectUri,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthUrlCharacters,
    'OAuth redirect URI'
  )
  assertCharacterLimit(
    oauth.clientId,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthClientIdCharacters,
    'OAuth client ID'
  )
  if ((oauth.scopes?.length ?? 0) > DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthScopes) {
    throw new Error(
      `OAuth scopes must not exceed ${DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthScopes} entries.`
    )
  }
  for (const scope of oauth.scopes ?? []) {
    assertCharacterLimit(
      scope,
      DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthScopeCharacters,
      'OAuth scope'
    )
  }
  assertByteLimit(
    oauth.clientSecret,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.secretBytes,
    'OAuth client secret'
  )
}

const assertSerializedByteLimit = (value: unknown, limit: number, label: string): void => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) {
    throw new Error(`${label} must not exceed ${limit} serialized bytes.`)
  }
}

const assertDeviceCredentialDiscriminants = (credential: {
  kind?: unknown
  transport?: unknown
}): void => {
  if (credential.kind !== 'api_key' && credential.kind !== 'token' && credential.kind !== 'oauth') {
    throw new Error('Unsupported credential kind')
  }
  if (
    credential.kind === 'oauth' &&
    credential.transport !== 'streamable_http' &&
    credential.transport !== 'sse'
  ) {
    throw new Error('Unsupported OAuth transport')
  }
}

const assertCreateDeviceCredentialLimits = (request: CreateDeviceCredentialRequest): void => {
  assertCharacterLimit(
    request.displayName,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.displayNameCharacters,
    'Credential name'
  )
  if (request.kind === 'oauth') {
    assertCharacterLimit(
      request.resourceUri,
      DEVICE_CREDENTIAL_RESOURCE_LIMITS.resourceUrlCharacters,
      'OAuth resource URL'
    )
    assertOAuthFields(request.oauth)
  } else {
    assertByteLimit(
      request.secret,
      DEVICE_CREDENTIAL_RESOURCE_LIMITS.secretBytes,
      'Credential value'
    )
  }
  assertSerializedByteLimit(
    request,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.recordBytes,
    'Device credential'
  )
}

const assertUpdateDeviceCredentialLimits = (request: UpdateDeviceCredentialRequest): void => {
  assertCharacterLimit(request.id, DEVICE_CREDENTIAL_RESOURCE_LIMITS.idCharacters, 'Credential ID')
  assertCharacterLimit(
    request.displayName,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.displayNameCharacters,
    'Credential name'
  )
  assertByteLimit(request.secret, DEVICE_CREDENTIAL_RESOURCE_LIMITS.secretBytes, 'Credential value')
  assertSerializedByteLimit(
    request,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.recordBytes,
    'Device credential update'
  )
}

const assertStoredDeviceCredentialLimits = (credential: StoredDeviceCredential): void => {
  assertDeviceCredentialDiscriminants(credential)
  assertCharacterLimit(
    credential.id,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.idCharacters,
    'Credential ID'
  )
  assertCharacterLimit(
    credential.displayName,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.displayNameCharacters,
    'Credential name'
  )
  if (credential.kind === 'oauth') {
    assertCharacterLimit(
      credential.resourceUri,
      DEVICE_CREDENTIAL_RESOURCE_LIMITS.resourceUrlCharacters,
      'OAuth resource URL'
    )
    assertOAuthFields(credential.oauth)
  }
  assertSerializedByteLimit(
    credential,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.storedRecordBytes,
    'Stored device credential'
  )
}

const assertDeviceCredentialCapacity = (count: number): void => {
  if (count >= DEVICE_CREDENTIAL_RESOURCE_LIMITS.credentials) {
    throw new Error(
      `Device credential limit of ${DEVICE_CREDENTIAL_RESOURCE_LIMITS.credentials} reached.`
    )
  }
}

const assertDeviceCredentialDocumentCapacity = (count: number): void => {
  if (count > DEVICE_CREDENTIAL_RESOURCE_LIMITS.credentials) {
    throw new Error(
      `Device credential document must not exceed ${DEVICE_CREDENTIAL_RESOURCE_LIMITS.credentials} records.`
    )
  }
}

const assertDeviceCredentialOAuthStateLimits = (state: unknown): void =>
  assertSerializedByteLimit(
    state,
    DEVICE_CREDENTIAL_RESOURCE_LIMITS.oauthStateBytes,
    'OAuth credential state'
  )

const assertDeviceCredentialDocumentContentsLimits = (contents: string): void => {
  if (Buffer.byteLength(contents, 'utf8') > DEVICE_CREDENTIAL_RESOURCE_LIMITS.documentBytes) {
    throw new Error(
      `Device credential document must not exceed ${DEVICE_CREDENTIAL_RESOURCE_LIMITS.documentBytes} bytes.`
    )
  }
}

export {
  DEVICE_CREDENTIAL_RESOURCE_LIMITS,
  assertCreateDeviceCredentialLimits,
  assertDeviceCredentialDiscriminants,
  assertDeviceCredentialCapacity,
  assertDeviceCredentialDocumentCapacity,
  assertDeviceCredentialDocumentContentsLimits,
  assertDeviceCredentialOAuthStateLimits,
  assertStoredDeviceCredentialLimits,
  assertUpdateDeviceCredentialLimits
}
