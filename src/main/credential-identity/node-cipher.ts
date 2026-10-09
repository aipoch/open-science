import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import type { SecureStorageCipher } from '../secure-storage'
import { CredentialIdentityError, type CredentialIdentity } from './selection'

// Electron 43.7.5's pinned OSCrypt sync format; no new ciphertext envelope is persisted.
// https://github.com/electron/electron/blob/v43.7.5/patches/chromium/revert_oscrypt_remove_sync_backend.patch
const iv = Buffer.alloc(16, 0x20)
export type NodeSecretOperations = {
  readPassword(identity: CredentialIdentity, create: boolean): Buffer
  unprotect(value: Buffer): Buffer
}

const nativeSecret = (
  operation: string,
  args: string[],
  input: Buffer = Buffer.alloc(0)
): Buffer => {
  const { secretExecutablePath } = createRequire(import.meta.url)(
    '@aipoch/credential-identity-probe-native'
  ) as { secretExecutablePath: string }
  const executable = secretExecutablePath.replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1')
  const result = spawnSync(executable, [operation, ...args], {
    input,
    timeout: 30_000,
    maxBuffer: 65536,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  if (result.error || result.status !== 0 || result.signal || result.stdout.length === 0) {
    result.stdout?.fill(0)
    throw new CredentialIdentityError('native-secret-operation-failed')
  }
  return result.stdout
}

const secretOperations: NodeSecretOperations = {
  readPassword(identity, create) {
    if (identity.backend === 'file' || identity.backend === 'windows-dpapi')
      throw new CredentialIdentityError('node-secret-backend-unavailable')
    const args = [identity.appName]
    if (identity.backend === 'linux-secret-service') args.push('gnome_libsecret')
    else if (identity.backend === 'linux-kwallet')
      args.push(identity.passwordStore, identity.wallet)
    const candidate = create ? Buffer.from(randomBytes(16).toString('base64')) : Buffer.alloc(0)
    try {
      return nativeSecret(create ? 'create-key' : 'read-key', args, candidate)
    } finally {
      candidate.fill(0)
    }
  },
  unprotect: (value) => nativeSecret('unprotect', [], value)
}

export function createNodeSecureStorageCipher(
  identity: CredentialIdentity,
  profilePath: string,
  operations: NodeSecretOperations = secretOperations
): SecureStorageCipher & { dispose(): void } {
  let key: Buffer | undefined
  let disposed = false
  const derive = (create: boolean): Buffer => {
    if (disposed) throw new CredentialIdentityError('cipher-disposed')
    if (key) return key
    if (identity.backend === 'file') throw new CredentialIdentityError('os-access-in-file-mode')
    if (identity.backend === 'windows-dpapi') {
      // Preflight owns absence/recovery decisions. Never replace an unreadable profile key.
      const state = JSON.parse(readFileSync(join(profilePath, 'Local State'), 'utf8')) as {
        os_crypt?: { encrypted_key?: string }
      }
      const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64')
      if (wrapped.subarray(0, 5).toString() !== 'DPAPI')
        throw new CredentialIdentityError('windows-profile-key-unavailable')
      const value = operations.unprotect(wrapped.subarray(5))
      if (value.length !== 32) {
        value.fill(0)
        throw new CredentialIdentityError('windows-profile-key-unavailable')
      }
      key = value
    } else {
      const password = operations.readPassword(
        identity,
        create && 'exists' in identity && !identity.exists
      )
      try {
        key = pbkdf2Sync(
          password,
          'saltysalt',
          identity.backend === 'mac-keychain' ? 1003 : 1,
          16,
          'sha1'
        )
      } finally {
        password.fill(0)
      }
    }
    return key
  }
  const prefix =
    identity.backend === 'mac-keychain' || identity.backend === 'windows-dpapi' ? 'v10' : 'v11'
  return {
    isEncryptionAvailable() {
      if (identity.backend === 'file') return false
      // For a proven-new identity, availability is determined by the existing metadata guard;
      // key creation is permitted only after that guard proved it safe.
      derive('exists' in identity && !identity.exists)
      return true
    },
    getSelectedStorageBackend: () =>
      identity.backend === 'linux-kwallet'
        ? identity.passwordStore
        : identity.backend === 'linux-secret-service'
          ? 'gnome_libsecret'
          : identity.backend,
    encryptString(value) {
      const secret = derive(true)
      if (identity.backend === 'windows-dpapi') {
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', secret, nonce)
        return Buffer.concat([
          Buffer.from('v10'),
          nonce,
          cipher.update(value, 'utf8'),
          cipher.final(),
          cipher.getAuthTag()
        ])
      }
      if (!value) return Buffer.alloc(0)
      const cipher = createCipheriv('aes-128-cbc', secret, iv)
      return Buffer.concat([Buffer.from(prefix), cipher.update(value, 'utf8'), cipher.final()])
    },
    decryptString(value) {
      if (identity.backend === 'windows-dpapi') {
        if (value.subarray(0, 3).toString() !== 'v10') {
          const plaintext = operations.unprotect(value)
          try {
            return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
          } finally {
            plaintext.fill(0)
          }
        }
        if (value.length < 31) throw new CredentialIdentityError('invalid-ciphertext')
        const decipher = createDecipheriv('aes-256-gcm', derive(false), value.subarray(3, 15))
        decipher.setAuthTag(value.subarray(-16))
        const plaintext = Buffer.concat([
          decipher.update(value.subarray(15, -16)),
          decipher.final()
        ])
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
        } finally {
          plaintext.fill(0)
        }
      }
      if (!value.length) return ''
      const version = value.subarray(0, 3).toString()
      const linux =
        identity.backend === 'linux-secret-service' || identity.backend === 'linux-kwallet'
      if (version !== prefix && !(linux && version === 'v10'))
        throw new CredentialIdentityError('unsupported-ciphertext-version')
      const secureKey = derive(false)
      const decrypt = (secret: Buffer): string => {
        const decipher = createDecipheriv('aes-128-cbc', secret, iv)
        const plaintext = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()])
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
        } finally {
          plaintext.fill(0)
        }
      }
      // Read-only compatibility with Chromium's historical Linux v10 and empty-password records.
      // The OS-vault access guard still applies, and every new Linux write uses its selected v11 key.
      const legacyKey =
        linux && version === 'v10' ? pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1') : undefined
      try {
        return decrypt(legacyKey ?? secureKey)
      } catch (error) {
        if (!linux) throw error
        const emptyKey = pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1')
        try {
          return decrypt(emptyKey)
        } finally {
          emptyKey.fill(0)
        }
      } finally {
        legacyKey?.fill(0)
      }
    },
    dispose() {
      disposed = true
      key?.fill(0)
      key = undefined
    }
  }
}

// Called only under configuration/profile ownership, after ciphertext preflight proved that a
// missing key has no dependent ciphertext. Preserve every unrelated Chromium profile field.
export function initializeNodeWindowsProfileKey(profilePath: string): void {
  const path = join(profilePath, 'Local State')
  let state: Record<string, unknown>
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    state = {}
  }
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new CredentialIdentityError('windows-profile-key-unavailable')
  const crypt = state.os_crypt as Record<string, unknown> | undefined
  if (crypt?.encrypted_key !== undefined) return
  if (crypt !== undefined && (!crypt || typeof crypt !== 'object' || Array.isArray(crypt)))
    throw new CredentialIdentityError('windows-profile-key-unavailable')
  const key = randomBytes(32)
  try {
    const wrapped = Buffer.concat([Buffer.from('DPAPI'), nativeSecret('protect', [], key)])
    // Electron must finish this under the shared credential bootstrap lock before yielding to
    // Chromium profile initialization. Node uses the exact same initializer and existing format.
    mkdirSync(profilePath, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            ...state,
            os_crypt: { ...crypt, encrypted_key: wrapped.toString('base64') }
          })
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  } finally {
    key.fill(0)
  }
}
