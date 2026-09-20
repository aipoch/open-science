import { decodeDeviceCredentialsDocument } from '../settings/device-credentials-codec'
import { validateSettingsDocumentShape } from '../settings/document-shape'
import { settingsDocumentReadError } from '../settings/document-read-error'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withReadOnlySqliteSnapshot as database } from './sqlite-snapshot'
import { CredentialIdentityError } from './selection'

const PROTECTED_PREFIX = 'open-science:protected:v1:'
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

// Read the original documents directly: the normal durable store may promote crash-recovery temps
// or sanitize fields. Neither action is allowed before the selected key proves it can read them.
export const readCredentialCiphertexts = (options: {
  configRoot: string
  profilePath: string
}): Buffer[] => {
  const values: Buffer[] = []
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const collectRef = (value: unknown, prefix = 'enc:'): void => {
    if (typeof value !== 'string' || !value.startsWith(prefix)) return
    const encoded = value.slice(prefix.length)
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length || bytes.toString('base64') !== encoded)
      throw new Error('Invalid ciphertext reference')
    values.push(bytes)
  }
  const collectDocument = (contents: string, name: string): void => {
    const value: unknown =
      name === 'credentials.json' ? decodeDeviceCredentialsDocument(contents) : JSON.parse(contents)
    if (name === 'settings.json') validateSettingsDocumentShape(value)
    const document = record(value)
    if (name === 'credentials.json') {
      for (const item of list(document.credentials)) {
        const credential = record(item)
        if (credential.kind === 'api_key' || credential.kind === 'token')
          collectRef(credential.secretRef)
        if (credential.kind === 'oauth') {
          collectRef(credential.clientSecretRef)
          collectRef(credential.stateRef)
        }
      }
      return
    }
    collectRef(document.githubTokenRef)
    for (const provider of list(document.providers)) collectRef(record(provider).keyRef)
    for (const service of list(record(document.classification).services))
      collectRef(record(service).keyRef)
    const connectors = record(document.connectors)
    collectRef(connectors.ncbiApiKeyRef)
    collectRef(connectors.openAlexApiKeyRef)
    for (const item of list(connectors.customMcpServers)) {
      const server = record(item)
      for (const ref of Object.values(record(server.envRefs))) collectRef(ref)
      for (const ref of Object.values(record(server.headerRefs))) collectRef(ref)
      collectRef(server.oauthClientSecretRef)
      collectRef(server.oauthRef)
    }
  }
  const collectJob = (row: Record<string, unknown>): void => {
    if (row.sensitiveDataEncrypted !== 1) return
    for (const field of [
      'intent',
      'command',
      'environment',
      'remoteWorkdir',
      'stdoutTail',
      'stderrTail',
      'lastPollError',
      'harvestError'
    ])
      collectRef(row[field], PROTECTED_PREFIX)
    for (const field of [
      'resourceRequest',
      'inputManifest',
      'outputManifest',
      'harvestConfig',
      'remoteHandle',
      'leftOnRemote'
    ]) {
      const value = row[field]
      if (typeof value !== 'string') continue
      const container: unknown = JSON.parse(value)
      if (Array.isArray(container)) {
        if (container.length === 2 && container[0] === 'open-science:protected-json:v1')
          collectRef(container[1], PROTECTED_PREFIX)
      } else {
        const object = record(container)
        if (Object.keys(object).length === 1)
          collectRef(object['open-science:protected-json:v1'], PROTECTED_PREFIX)
      }
    }
  }
  try {
    if (existsSync(options.configRoot)) {
      const entries = readdirSync(options.configRoot)
      for (const name of ['settings.json', 'credentials.json']) {
        if (entries.some((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.tmp')))
          throw new Error('Pending credential document requires recovery')
        const path = join(options.configRoot, name)
        if (!existsSync(path)) continue
        try {
          if (statSync(path).size > MAX_DOCUMENT_BYTES)
            throw new Error('Credential document is too large')
          collectDocument(readFileSync(path, 'utf8'), name)
        } catch (cause) {
          if (name === 'settings.json')
            throw settingsDocumentReadError(
              path,
              cause instanceof SyntaxError ? new Error('Invalid JSON.') : cause
            )
          throw cause
        }
      }
    }
    database(join(options.configRoot, 'open-science.db'), (db) => {
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name)
      )
      if (tables.has('ComputeCredential')) {
        for (const row of db.prepare('SELECT ciphertext FROM ComputeCredential').iterate()) {
          if (!(row.ciphertext instanceof Uint8Array)) throw new Error('Invalid compute ciphertext')
          values.push(Buffer.from(row.ciphertext))
        }
      }
      if (tables.has('ComputeJob')) {
        for (const row of db.prepare('SELECT * FROM ComputeJob').iterate()) collectJob(row)
      }
      if (tables.has('ComputeAuthOperation')) {
        for (const row of db
          .prepare('SELECT requestFingerprint FROM ComputeAuthOperation')
          .iterate()) {
          // Older bookkeeping may contain an opaque fingerprint, with no protected key envelope.
          // Preserve it unchanged; only the versioned encrypted form contains an OSCrypt value.
          if (typeof row.requestFingerprint !== 'string' || !row.requestFingerprint.startsWith('['))
            continue
          const fingerprint: unknown = JSON.parse(row.requestFingerprint)
          if (
            !Array.isArray(fingerprint) ||
            fingerprint[0] !== 1 ||
            typeof fingerprint[1] !== 'string'
          )
            throw new Error('Invalid compute credential fingerprint')
          collectRef(`enc:${fingerprint[1]}`)
        }
      }
    })
    // Electron stores persistent partitions alongside its default profile. Opening either in
    // Chromium before this check can discard cookies which the newly selected key cannot decrypt.
    const profiles = [options.profilePath]
    const partitions = join(options.profilePath, 'Partitions')
    if (existsSync(partitions)) {
      for (const entry of readdirSync(partitions, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Unverifiable profile partition')
        if (entry.isDirectory()) profiles.push(join(partitions, entry.name))
      }
    }
    for (const profile of profiles) {
      for (const relative of ['Cookies', 'Network/Cookies']) {
        database(join(profile, relative), (db) => {
          for (const row of db
            .prepare('SELECT encrypted_value FROM cookies WHERE length(encrypted_value) > 0')
            .iterate()) {
            if (!(row.encrypted_value instanceof Uint8Array))
              throw new Error('Invalid encrypted cookie')
            values.push(Buffer.from(row.encrypted_value))
          }
        })
      }
    }
    return values
  } catch (error) {
    if (error instanceof Error && error.name === 'SettingsDocumentReadError') throw error
    throw new CredentialIdentityError('ciphertext-inventory-unavailable')
  }
}

// This is a real secret-read phase, deliberately separate from metadata probing. The caller runs
// it only after Electron has bound OSCrypt to the selected identity, before any app/profile writer.
export const verifyCredentialCiphertexts = (
  ciphertexts: readonly Buffer[],
  decrypt: (value: Buffer) => string
): void => {
  try {
    for (const value of ciphertexts) decrypt(value)
  } catch {
    throw new CredentialIdentityError('decryption-failed')
  }
}
