import { safeStorage } from 'electron'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { platform } from 'node:os'

import type { ComputePasswordCapability } from '../../shared/compute'
import { ComputeConnectionError } from './connection-broker'

const MAX_PASSWORD_BYTES = 16 * 1024
const PROTECTED_STRING_PREFIX = 'open-science:protected:v1:'
const PROTECTED_JSON_MARKER = 'open-science:protected-json:v1'

type StoredComputeCredential = Readonly<{ ciphertext: Buffer; revision?: number }>
interface ComputeCredentialReader {
  getCredential(computeHostId: string): Promise<StoredComputeCredential | null>
}
export interface SecureStorageCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export type ComputeCredentialCipher = SecureStorageCipher
export type ProtectedJsonContainer = 'object' | 'array'

export const isSecureStorageAvailable = (
  cipher: SecureStorageCipher = safeStorage,
  currentPlatform: NodeJS.Platform = platform()
): boolean => {
  try {
    if (!cipher.isEncryptionAvailable()) return false
    return !(currentPlatform === 'linux' && cipher.getSelectedStorageBackend?.() === 'basic_text')
  } catch {
    return false
  }
}

export class OptionalSecureStorageStringProtection {
  private failed = false

  constructor(
    private readonly cipher: SecureStorageCipher = safeStorage,
    private readonly currentPlatform: NodeJS.Platform = platform()
  ) {}

  isAvailable(): boolean {
    return !this.failed && isSecureStorageAvailable(this.cipher, this.currentPlatform)
  }

  protect(value: string): string {
    if (!this.isAvailable()) throw new Error('Compute Job data protection became unavailable.')
    try {
      return `${PROTECTED_STRING_PREFIX}${this.cipher.encryptString(value).toString('base64')}`
    } catch {
      this.failed = true
      throw new Error('Compute Job data protection became unavailable.')
    }
  }

  protectJson(value: string, container: ProtectedJsonContainer): string {
    const parsed: unknown = JSON.parse(value)
    const hasExpectedContainer =
      container === 'array'
        ? Array.isArray(parsed)
        : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    if (!hasExpectedContainer) throw new Error(`Expected a JSON ${container}.`)

    const protectedValue = this.protect(value)
    return JSON.stringify(
      container === 'object'
        ? { [PROTECTED_JSON_MARKER]: protectedValue }
        : [PROTECTED_JSON_MARKER, protectedValue]
    )
  }

  reveal(value: string): string {
    if (!value.startsWith(PROTECTED_STRING_PREFIX)) return value

    try {
      const ciphertext = Buffer.from(value.slice(PROTECTED_STRING_PREFIX.length), 'base64')
      return this.cipher.decryptString(ciphertext)
    } catch {
      throw new Error('Protected application data cannot be decrypted on this system.')
    }
  }

  revealJson(value: string, container: ProtectedJsonContainer): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return value
    }

    if (container === 'object') {
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1
      ) {
        return value
      }
      const protectedValue = (parsed as Record<string, unknown>)[PROTECTED_JSON_MARKER]
      return typeof protectedValue === 'string' ? this.reveal(protectedValue) : value
    }

    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed[0] === PROTECTED_JSON_MARKER &&
      typeof parsed[1] === 'string'
      ? this.reveal(parsed[1])
      : value
  }
}

interface CredentialPasswordLease {
  withPassword<Result>(operation: (password: string) => Promise<Result>): Promise<Result>
}

const validateComputePassword = (password: string): void => {
  const bytes = Buffer.byteLength(password, 'utf8')
  if (bytes === 0) throw new ComputeConnectionError('credential_required')
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new ComputeConnectionError(
      'unsupported_auth_configuration',
      `Password must be ${MAX_PASSWORD_BYTES} bytes or fewer.`
    )
  }
}

class CredentialVault {
  constructor(
    private readonly credentials: ComputeCredentialReader,
    private readonly suppliedCipher?: ComputeCredentialCipher,
    private readonly suppliedPlatform: NodeJS.Platform = platform()
  ) {}

  private get cipher(): ComputeCredentialCipher {
    return this.suppliedCipher ?? safeStorage
  }

  isAvailable(): boolean {
    return isSecureStorageAvailable(this.cipher, this.suppliedPlatform)
  }

  capability(): ComputePasswordCapability {
    return this.isAvailable()
      ? { available: true }
      : {
          available: false,
          reason: 'secure_storage_unavailable'
        }
  }

  async credentialStatus(computeHostId: string): Promise<'configured' | 'missing' | 'unavailable'> {
    if (!this.isAvailable()) return 'unavailable'
    const credential = await this.credentials.getCredential(computeHostId)
    if (!credential) return 'missing'
    try {
      validateComputePassword(this.cipher.decryptString(Buffer.from(credential.ciphertext)))
      return 'configured'
    } catch {
      return 'unavailable'
    }
  }

  encrypt(password: string): Buffer {
    validateComputePassword(password)
    if (!this.isAvailable()) throw new ComputeConnectionError('secure_storage_unavailable')
    try {
      return Buffer.from(this.cipher.encryptString(password))
    } catch {
      throw new ComputeConnectionError('secure_storage_unavailable')
    }
  }

  bindOperationIntent(intent: string, existingFingerprint?: string): string {
    if (!this.isAvailable()) throw new ComputeConnectionError('secure_storage_unavailable')
    let key: Buffer | undefined
    try {
      let protectedKey: string
      let expectedDigest: string | undefined
      if (existingFingerprint) {
        const parsed = JSON.parse(existingFingerprint) as unknown
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed[0] !== 1 ||
          typeof parsed[1] !== 'string' ||
          typeof parsed[2] !== 'string'
        ) {
          throw new ComputeConnectionError('credential_conflict')
        }
        protectedKey = parsed[1]
        expectedDigest = parsed[2]
        key = Buffer.from(this.cipher.decryptString(Buffer.from(protectedKey, 'base64')), 'base64')
        if (key.length !== 32) throw new ComputeConnectionError('credential_conflict')
      } else {
        key = randomBytes(32)
        protectedKey = Buffer.from(this.cipher.encryptString(key.toString('base64'))).toString(
          'base64'
        )
      }
      const digest = createHmac('sha256', key).update(intent, 'utf8').digest('hex')
      if (expectedDigest) {
        const actual = Buffer.from(digest, 'hex')
        const expected = Buffer.from(expectedDigest, 'hex')
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          throw new ComputeConnectionError('credential_conflict')
        }
      }
      return JSON.stringify([1, protectedKey, digest])
    } catch (error) {
      if (error instanceof ComputeConnectionError) throw error
      throw new ComputeConnectionError('credential_conflict')
    } finally {
      key?.fill(0)
    }
  }

  async withPassword<Result>(
    computeHostId: string,
    operation: (password: string) => Promise<Result>
  ): Promise<Result> {
    const lease = await this.acquirePasswordLease(computeHostId)
    return lease.withPassword(operation)
  }

  async acquirePasswordLease(
    computeHostId: string,
    expectedRevision?: number
  ): Promise<CredentialPasswordLease> {
    if (!this.isAvailable()) throw new ComputeConnectionError('secure_storage_unavailable')
    const credential = await this.credentials.getCredential(computeHostId)
    if (!credential) throw new ComputeConnectionError('credential_required')
    if (expectedRevision !== undefined && credential.revision !== undefined) {
      if (credential.revision !== expectedRevision) {
        throw new ComputeConnectionError('credential_conflict')
      }
    }
    const ciphertext = Buffer.from(credential.ciphertext)
    try {
      validateComputePassword(this.cipher.decryptString(ciphertext))
    } catch (error) {
      if (error instanceof ComputeConnectionError) throw error
      throw new ComputeConnectionError('credential_unavailable')
    }
    return Object.freeze({
      withPassword: async <Result>(
        operation: (password: string) => Promise<Result>
      ): Promise<Result> => {
        const lease = { plaintext: '' }
        try {
          lease.plaintext = this.cipher.decryptString(ciphertext)
          validateComputePassword(lease.plaintext)
        } catch (error) {
          lease.plaintext = ''
          if (error instanceof ComputeConnectionError) throw error
          throw new ComputeConnectionError('credential_unavailable')
        }
        try {
          return await operation(lease.plaintext)
        } finally {
          lease.plaintext = ''
        }
      }
    })
  }
}

export { CredentialVault, MAX_PASSWORD_BYTES, validateComputePassword }
export type { ComputeCredentialReader, CredentialPasswordLease, StoredComputeCredential }
