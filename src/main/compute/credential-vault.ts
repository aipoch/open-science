import { safeStorage } from 'electron'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { platform } from 'node:os'

import type { ComputePasswordCapability } from '../../shared/compute'
import { ComputeConnectionError } from './connection-broker'

const MAX_PASSWORD_BYTES = 16 * 1024

type StoredComputeCredential = Readonly<{ ciphertext: Buffer; revision?: number }>
interface ComputeCredentialReader {
  getCredential(computeHostId: string): Promise<StoredComputeCredential | null>
}
interface ComputeCredentialCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
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
    try {
      if (!this.cipher.isEncryptionAvailable()) return false
      return !(
        this.suppliedPlatform === 'linux' &&
        this.cipher.getSelectedStorageBackend?.() === 'basic_text'
      )
    } catch {
      return false
    }
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
export type {
  ComputeCredentialCipher,
  ComputeCredentialReader,
  CredentialPasswordLease,
  StoredComputeCredential
}
