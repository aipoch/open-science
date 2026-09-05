import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  CreateDeviceCredentialRequest,
  DeviceCredentialView,
  UpdateDeviceCredentialRequest
} from '../../shared/settings'
import { normalizeLoopbackOAuthRedirectUri } from '../../shared/oauth-redirect'
import { assertSecureCustomMcpUrl } from '../connectors/custom-mcp-url'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'
import { hasEmbeddedConnectorCredentials } from './connector-template'
import { encryptKey, tryDecryptKey } from './crypto'
import {
  assertCreateDeviceCredentialLimits,
  assertDeviceCredentialCapacity,
  assertDeviceCredentialDiscriminants,
  assertDeviceCredentialDocumentCapacity,
  assertDeviceCredentialDocumentContentsLimits,
  assertDeviceCredentialOAuthStateLimits,
  assertStoredDeviceCredentialLimits,
  assertUpdateDeviceCredentialLimits
} from './device-credential-resource-limits'
import type {
  StoredCustomMcpOAuthConfig,
  StoredCustomMcpOAuthState,
  StoredDeviceCredential,
  StoredDeviceCredentialsDocument
} from './types'

const CREDENTIAL_REFERENCE_PREFIX = 'credential:'
const DOCUMENT_VERSION = 1 as const

const credentialReference = (id: string): string => `${CREDENTIAL_REFERENCE_PREFIX}${id}`
const parseCredentialReference = (reference: string | undefined): string | undefined => {
  if (!reference?.startsWith(CREDENTIAL_REFERENCE_PREFIX)) return undefined
  const id = reference.slice(CREDENTIAL_REFERENCE_PREFIX.length)
  return id || undefined
}

const canonicalizeResourceUri = (value: string): string => {
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

const decodeDocument = (contents: string): StoredDeviceCredentialsDocument => {
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

const normalizeOAuthConfig = (
  request: Extract<CreateDeviceCredentialRequest, { kind: 'oauth' }>['oauth']
): StoredCustomMcpOAuthConfig => {
  const oauth: StoredCustomMcpOAuthConfig = {
    ...(request.clientMetadataUrl?.trim()
      ? { clientMetadataUrl: request.clientMetadataUrl.trim() }
      : {}),
    ...(request.authorizationServerUrl?.trim()
      ? { authorizationServerUrl: request.authorizationServerUrl.trim() }
      : {}),
    ...(request.scopes?.map((scope) => scope.trim()).filter(Boolean).length
      ? { scopes: [...new Set(request.scopes.map((scope) => scope.trim()).filter(Boolean))] }
      : {}),
    ...(request.clientId?.trim() ? { clientId: request.clientId.trim() } : {}),
    ...(request.redirectUri?.trim()
      ? { redirectUri: normalizeLoopbackOAuthRedirectUri(request.redirectUri.trim()) }
      : {})
  }
  if (hasEmbeddedConnectorCredentials({ oauth })) {
    throw new Error('OAuth URLs cannot contain credentials')
  }
  return oauth
}

const validateOAuthRegistration = (
  oauth: StoredCustomMcpOAuthConfig,
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

export type ResolvedOAuthDeviceCredential = {
  id: string
  resourceUri: string
  transport: 'streamable_http' | 'sse'
  oauth: StoredCustomMcpOAuthConfig
  hasClientSecret: boolean
  clientSecret?: string
  state?: StoredCustomMcpOAuthState
}

export class DeviceCredentialStore {
  private readonly filePath: string
  private operation = Promise.resolve()

  constructor(configRoot: string) {
    this.filePath = join(configRoot, 'credentials.json')
  }

  async list(): Promise<StoredDeviceCredential[]> {
    return this.run(async () => [...(await this.read()).credentials])
  }

  async create(request: CreateDeviceCredentialRequest): Promise<StoredDeviceCredential> {
    return this.run(async () => {
      assertDeviceCredentialDiscriminants(request)
      assertCreateDeviceCredentialLimits(request)
      const displayName = request.displayName.trim()
      if (!displayName) throw new Error('Credential name is required')
      if (request.kind !== 'oauth' && !request.secret.trim()) {
        throw new Error('Credential value is required')
      }
      const document = await this.read()
      assertDeviceCredentialCapacity(document.credentials.length)
      const now = Date.now()
      const id = randomUUID()
      const credential: StoredDeviceCredential =
        request.kind === 'oauth'
          ? (() => {
              const oauth = normalizeOAuthConfig(request.oauth)
              validateOAuthRegistration(oauth, Boolean(request.oauth.clientSecret?.trim()))
              const resourceUri = canonicalizeResourceUri(request.resourceUri)
              assertSecureCustomMcpUrl(resourceUri)
              return {
                id,
                displayName,
                kind: 'oauth',
                resourceUri,
                transport: request.transport,
                oauth,
                ...(request.oauth.clientSecret?.trim()
                  ? { clientSecretRef: encryptKey(request.oauth.clientSecret.trim()) }
                  : {}),
                createdAt: now,
                updatedAt: now
              }
            })()
          : {
              id,
              displayName,
              kind: request.kind,
              secretRef: encryptKey(request.secret.trim()),
              createdAt: now,
              updatedAt: now
            }
      await this.write({ ...document, credentials: [...document.credentials, credential] })
      return credential
    })
  }

  async update(request: UpdateDeviceCredentialRequest): Promise<StoredDeviceCredential> {
    return this.run(async () => {
      assertUpdateDeviceCredentialLimits(request)
      const document = await this.read()
      const existing = document.credentials.find(({ id }) => id === request.id)
      if (!existing) throw new Error(`Unknown credential: ${request.id}`)
      if (request.secret !== undefined && existing.kind === 'oauth') {
        throw new Error('OAuth credentials are replaced by signing in again')
      }
      const displayName = request.displayName?.trim() ?? existing.displayName
      if (!displayName) throw new Error('Credential name is required')
      if (request.secret !== undefined && !request.secret.trim()) {
        throw new Error('Credential value is required')
      }
      const updated: StoredDeviceCredential = {
        ...existing,
        displayName,
        ...(existing.kind !== 'oauth' && request.secret !== undefined
          ? { secretRef: encryptKey(request.secret.trim()) }
          : {}),
        updatedAt: Date.now()
      }
      await this.write({
        ...document,
        credentials: document.credentials.map((credential) =>
          credential.id === request.id ? updated : credential
        )
      })
      return updated
    })
  }

  async remove(id: string): Promise<void> {
    return this.run(async () => {
      const document = await this.read()
      if (!document.credentials.some((credential) => credential.id === id)) return
      await this.write({
        ...document,
        credentials: document.credentials.filter((credential) => credential.id !== id)
      })
    })
  }

  async resolveStatic(
    id: string,
    target: { kind: 'env' | 'header'; name: string }
  ): Promise<string> {
    const credential = (await this.list()).find((candidate) => candidate.id === id)
    if (!credential || credential.kind === 'oauth') {
      throw new Error(`Static credential is unavailable: ${id}`)
    }
    const value = tryDecryptKey(credential.secretRef)
    if (value === undefined) throw new Error(`Static credential is unavailable: ${id}`)
    return credential.kind === 'token' &&
      target.kind === 'header' &&
      /^authorization$/iu.test(target.name)
      ? `Bearer ${value}`
      : value
  }

  async resolveOAuth(id: string): Promise<ResolvedOAuthDeviceCredential | undefined> {
    const credential = (await this.list()).find((candidate) => candidate.id === id)
    if (!credential || credential.kind !== 'oauth') return undefined
    return {
      id,
      resourceUri: credential.resourceUri,
      transport: credential.transport,
      oauth: credential.oauth,
      hasClientSecret: credential.clientSecretRef !== undefined,
      ...(credential.clientSecretRef
        ? { clientSecret: tryDecryptKey(credential.clientSecretRef) }
        : {}),
      ...(credential.stateRef ? { state: this.decryptState(credential.stateRef) } : {})
    }
  }

  async saveOAuthState(id: string, state: StoredCustomMcpOAuthState | undefined): Promise<void> {
    return this.run(async () => {
      if (state) assertDeviceCredentialOAuthStateLimits(state)
      const document = await this.read()
      const existing = document.credentials.find((credential) => credential.id === id)
      if (!existing || existing.kind !== 'oauth') throw new Error(`Unknown OAuth credential: ${id}`)
      const updated: StoredDeviceCredential = {
        ...existing,
        ...(state ? { stateRef: encryptKey(JSON.stringify(state)) } : { stateRef: undefined }),
        updatedAt: Date.now()
      }
      await this.write({
        ...document,
        credentials: document.credentials.map((credential) =>
          credential.id === id ? updated : credential
        )
      })
    })
  }

  view(
    credential: StoredDeviceCredential,
    consumers: readonly string[] = []
  ): DeviceCredentialView {
    const oauthState =
      credential.kind === 'oauth' ? this.decryptState(credential.stateRef) : undefined
    const needsSecret =
      credential.kind === 'oauth'
        ? (credential.clientSecretRef !== undefined &&
            tryDecryptKey(credential.clientSecretRef) === undefined) ||
          (credential.stateRef !== undefined && oauthState === undefined)
        : tryDecryptKey(credential.secretRef) === undefined
    return {
      id: credential.id,
      displayName: credential.displayName,
      kind: credential.kind,
      status:
        credential.kind === 'oauth'
          ? oauthState?.tokens?.access_token
            ? 'connected'
            : 'disconnected'
          : 'stored',
      needsSecret,
      ...(credential.kind === 'oauth'
        ? {
            resourceUri: credential.resourceUri,
            transport: credential.transport,
            oauth: credential.oauth,
            hasClientSecret: credential.clientSecretRef !== undefined
          }
        : {}),
      consumerCount: consumers.length,
      consumerNames: [...consumers].sort((left, right) => left.localeCompare(right)),
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt
    }
  }

  private decryptState(ref: string | undefined): StoredCustomMcpOAuthState | undefined {
    const value = tryDecryptKey(ref)
    if (!value) return undefined
    try {
      const parsed: unknown = JSON.parse(value)
      if (
        !isRecord(parsed) ||
        (parsed.tokens !== undefined && !isRecord(parsed.tokens)) ||
        (parsed.clientInformation !== undefined && !isRecord(parsed.clientInformation)) ||
        (parsed.discoveryState !== undefined && !isRecord(parsed.discoveryState))
      ) {
        return undefined
      }
      assertDeviceCredentialOAuthStateLimits(parsed)
      return parsed as StoredCustomMcpOAuthState
    } catch {
      return undefined
    }
  }

  private async read(): Promise<StoredDeviceCredentialsDocument> {
    const result = await readDurableJsonFile(this.filePath, decodeDocument)
    return result.status === 'found' ? result.value : { version: DOCUMENT_VERSION, credentials: [] }
  }

  private write(document: StoredDeviceCredentialsDocument): Promise<void> {
    for (const credential of document.credentials) {
      assertStoredDeviceCredentialLimits(credential)
    }
    const contents = `${JSON.stringify(document, null, 2)}\n`
    assertDeviceCredentialDocumentContentsLimits(contents)
    return writeDurableJsonFile(this.filePath, contents)
  }

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.operation
    let release = (): void => undefined
    this.operation = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export { canonicalizeResourceUri, credentialReference, parseCredentialReference }
