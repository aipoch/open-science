import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'

import { encryptKey, tryDecryptKey } from './crypto'
import { LAB_RESOURCE_LIMITS } from './lab-resource-limits'

// Encrypted-at-rest storage for the optional Lab enterprise connection. The document lives next to
// the existing credentials.json in the app config root. Only the token payload is encrypted (OS
// safeStorage or the explicit Linux headless file backend); the server address and the stable
// installation id are non-secret identity metadata and stay readable so a locked keychain cannot
// lose the device quota key or the configured address.
//
// The plaintext token pair never leaves main: the renderer only receives LabView.

export const LAB_CREDENTIALS_FILE = 'lab-credentials.json'

export type LabStoredSession = Readonly<{
  accessToken: string
  refreshToken: string
  tokenExpiresAt: number
  sessionExpiresAt?: string
}>

export type LabPreviousSelection = Readonly<{ providerId: string; model?: string }>

export type LabCredentialDocument = Readonly<{
  version: 1
  serverUrl?: string
  installationId?: string
  previousSelection?: LabPreviousSelection
  credentialRef?: string
  updatedAt: number
}>

const EMPTY_DOCUMENT: LabCredentialDocument = { version: 1, updatedAt: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeDocument = (contents: string): LabCredentialDocument => {
  const value: unknown = JSON.parse(contents)
  if (!isRecord(value) || value.version !== 1)
    throw new Error('Lab credential document is corrupt.')
  const previous = value.previousSelection
  return Object.freeze({
    version: 1,
    ...(typeof value.serverUrl === 'string' && value.serverUrl
      ? { serverUrl: value.serverUrl }
      : {}),
    ...(typeof value.installationId === 'string' && value.installationId
      ? { installationId: value.installationId }
      : {}),
    ...(isRecord(previous) && typeof previous.providerId === 'string' && previous.providerId
      ? {
          previousSelection: Object.freeze({
            providerId: previous.providerId,
            ...(typeof previous.model === 'string' && previous.model
              ? { model: previous.model }
              : {})
          })
        }
      : {}),
    ...(typeof value.credentialRef === 'string' && value.credentialRef
      ? { credentialRef: value.credentialRef }
      : {}),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
  })
}

const decodeSession = (plaintext: string): LabStoredSession | undefined => {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { accessToken, refreshToken, tokenExpiresAt, sessionExpiresAt } = value
  if (typeof accessToken !== 'string' || !accessToken) return undefined
  if (typeof refreshToken !== 'string' || !refreshToken) return undefined
  if (typeof tokenExpiresAt !== 'number' || !Number.isFinite(tokenExpiresAt)) return undefined
  return Object.freeze({
    accessToken,
    refreshToken,
    tokenExpiresAt,
    ...(typeof sessionExpiresAt === 'string' && sessionExpiresAt ? { sessionExpiresAt } : {})
  })
}

export class LabCredentialStore {
  private readonly filePath: string
  private readonly now: () => number
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(configRoot: string, options: { now?: () => number } = {}) {
    this.filePath = join(configRoot, LAB_CREDENTIALS_FILE)
    this.now = options.now ?? Date.now
  }

  async readDocument(): Promise<LabCredentialDocument> {
    const result = await readDurableJsonFile(this.filePath, decodeDocument, undefined, {
      maxBytes: LAB_RESOURCE_LIMITS.documentBytes
    })
    return result.status === 'found' ? result.value : EMPTY_DOCUMENT
  }

  // Address and token are returned from one read so callers cannot combine a freshly switched
  // address with a credential that belonged to the previous institution.
  async readCredentialSnapshot(): Promise<{
    serverUrl?: string
    session?: LabStoredSession
  }> {
    let document: LabCredentialDocument
    try {
      document = await this.readDocument()
    } catch {
      return {}
    }
    if (!document.credentialRef)
      return { ...(document.serverUrl ? { serverUrl: document.serverUrl } : {}) }
    const plaintext = tryDecryptKey(document.credentialRef)
    const session = plaintext ? decodeSession(plaintext) : undefined
    return {
      ...(document.serverUrl ? { serverUrl: document.serverUrl } : {}),
      ...(session ? { session } : {})
    }
  }

  // The persisted token payload. `undefined` means "no stored session"; a stored but undecryptable
  // ref also reads as undefined and callers treat that as a required re-login.
  async readSession(): Promise<LabStoredSession | undefined> {
    return (await this.readCredentialSnapshot()).session
  }

  async hasStoredCredentials(): Promise<boolean> {
    try {
      return (await this.readDocument()).credentialRef !== undefined
    } catch {
      return false
    }
  }

  async saveServerUrl(serverUrl: string): Promise<void> {
    await this.mutate((document) => ({ ...document, serverUrl }))
  }

  // Atomically switches the configured server and drops the previous server's token pair. A reader
  // can never observe the new address with the old institution's credentials.
  async replaceServer(serverUrl: string): Promise<void> {
    await this.mutate((document) => {
      const next = { ...document, serverUrl }
      delete next.credentialRef
      return next
    })
  }

  // One stable id per OS installation, used by the Lab server for device de-duplication and quota.
  async ensureInstallationId(): Promise<string> {
    const document = await this.readDocument()
    if (document.installationId) return document.installationId
    const installationId = randomBytes(24).toString('base64url')
    await this.mutate((current) =>
      current.installationId ? current : { ...current, installationId }
    )
    return (await this.readDocument()).installationId ?? installationId
  }

  async saveSession(session: LabStoredSession, expectedServerUrl?: string): Promise<void> {
    const credentialRef = encryptKey(JSON.stringify(session))
    await this.mutate((document) => {
      if (expectedServerUrl && document.serverUrl !== expectedServerUrl) {
        throw new Error('The Lab connection changed before the sign-in completed.')
      }
      return { ...document, credentialRef }
    })
  }

  async clearSession(): Promise<void> {
    await this.mutate((document) => {
      const next = { ...document }
      delete next.credentialRef
      return next
    })
  }

  async readPreviousSelection(): Promise<LabPreviousSelection | undefined> {
    return (await this.readDocument()).previousSelection
  }

  async savePreviousSelection(selection: LabPreviousSelection): Promise<void> {
    await this.mutate((document) => ({ ...document, previousSelection: selection }))
  }

  async clearPreviousSelection(): Promise<void> {
    await this.mutate((document) => {
      const next = { ...document }
      delete next.previousSelection
      return next
    })
  }

  private async mutate(
    update: (document: LabCredentialDocument) => LabCredentialDocument
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const document = await this.readDocument()
      const next = update(document)
      await writeDurableJsonFile(
        this.filePath,
        JSON.stringify({ ...next, version: 1, updatedAt: this.now() })
      )
    })
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
