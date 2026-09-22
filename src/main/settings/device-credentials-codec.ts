import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import { assertSecureCustomMcpUrl } from '../connectors/custom-mcp'
import { hasEmbeddedConnectorCredentials } from './connector-template'
import {
  assertStoredDeviceCredentialLimits,
  assertDeviceCredentialDocumentCapacity,
  assertDeviceCredentialDocumentContentsLimits
} from './device-credential-resource-limits'
import type {
  StoredCustomMcpOAuthConfig,
  StoredDeviceCredential,
  StoredDeviceCredentialsDocument
} from './types'

const DOCUMENT_VERSION = 1 as const

export const canonicalizeResourceUri = (value: string): string => {
  const url = new URL(value.trim())
  if (hasEmbeddedConnectorCredentials({ url: value })) {
    throw new Error('OAuth resource URL cannot contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OAuth resource URL must use HTTP or HTTPS')
  }
  url.hash = ''
  return url.toString()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const decodeOAuthConfig = (value: unknown): StoredCustomMcpOAuthConfig => {
  if (!isRecord(value)) throw new Error('Invalid OAuth credential configuration')
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
    : undefined
  const oauth = {
    ...(optionalString(value.clientMetadataUrl)
      ? { clientMetadataUrl: String(value.clientMetadataUrl) }
      : {}),
    ...(optionalString(value.authorizationServerUrl)
      ? { authorizationServerUrl: String(value.authorizationServerUrl) }
      : {}),
    ...(scopes?.length ? { scopes } : {}),
    ...(optionalString(value.clientId) ? { clientId: String(value.clientId) } : {}),
    ...(optionalString(value.redirectUri)
      ? { redirectUri: normalizeLoopbackOAuthRedirectUri(String(value.redirectUri)) }
      : {})
  }
  if (hasEmbeddedConnectorCredentials({ oauth })) {
    throw new Error('OAuth URLs cannot contain credentials')
  }
  return oauth
}

const decodeCredential = (value: unknown): StoredDeviceCredential => {
  if (!isRecord(value)) throw new Error('Invalid credential record')
  const id = optionalString(value.id)
  const displayName = optionalString(value.displayName)
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : undefined
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : undefined
  if (!id || !displayName || createdAt === undefined || updatedAt === undefined) {
    throw new Error('Invalid credential record')
  }
  if (value.kind === 'api_key' || value.kind === 'token') {
    const secretRef = optionalString(value.secretRef)
    if (!secretRef) throw new Error('Invalid static credential record')
    const credential: StoredDeviceCredential = {
      id,
      displayName,
      kind: value.kind,
      secretRef,
      createdAt,
      updatedAt
    }
    assertStoredDeviceCredentialLimits(credential)
    return credential
  }
  if (value.kind === 'oauth') {
    const resourceUri = optionalString(value.resourceUri)
    if (!resourceUri || (value.transport !== 'streamable_http' && value.transport !== 'sse')) {
      throw new Error('Invalid OAuth credential record')
    }
    const normalizedResourceUri = canonicalizeResourceUri(resourceUri)
    assertSecureCustomMcpUrl(normalizedResourceUri)
    const credential: StoredDeviceCredential = {
      id,
      displayName,
      kind: 'oauth',
      resourceUri: normalizedResourceUri,
      transport: value.transport,
      oauth: decodeOAuthConfig(value.oauth),
      ...(optionalString(value.clientSecretRef)
        ? { clientSecretRef: String(value.clientSecretRef) }
        : {}),
      ...(optionalString(value.stateRef) ? { stateRef: String(value.stateRef) } : {}),
      createdAt,
      updatedAt
    }
    assertStoredDeviceCredentialLimits(credential)
    return credential
  }
  throw new Error('Unsupported credential kind')
}

export const decodeDeviceCredentialsDocument = (
  contents: string
): StoredDeviceCredentialsDocument => {
  assertDeviceCredentialDocumentContentsLimits(contents)
  const value: unknown = JSON.parse(contents)
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION || !Array.isArray(value.credentials)) {
    throw new Error('Unsupported credentials document')
  }
  assertDeviceCredentialDocumentCapacity(value.credentials.length)
  const credentials = value.credentials.map(decodeCredential)
  if (new Set(credentials.map(({ id }) => id)).size !== credentials.length) {
    throw new Error('Duplicate credential ID')
  }
  return { version: DOCUMENT_VERSION, credentials }
}
