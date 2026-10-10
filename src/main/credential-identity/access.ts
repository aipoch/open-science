import type { SecureStorageCipher } from '../secure-storage'
import {
  CredentialIdentityError,
  type CredentialIdentity,
  type IdentityProbeResult
} from './selection'

export interface CredentialAccess extends SecureStorageCipher {
  assertAccessAllowed(): void
  assertReadAllowed(): void
}

// Electron owns key retrieval, creation, encryption, and authorization. This guard never changes
// the selected name or retries under another identity after a secret-operation failure.
export const createCredentialAccess = (options: {
  identity: CredentialIdentity
  cipher: SecureStorageCipher
  probe: (appName: string) => IdentityProbeResult
  recover: (error: CredentialIdentityError) => void
}): CredentialAccess => {
  let checked = false
  let written = false
  let failure: CredentialIdentityError | undefined
  const fail = (reason: string, probe?: IdentityProbeResult): never => {
    if (!failure) {
      failure = new CredentialIdentityError(
        reason,
        options.identity.backend === 'mac-keychain' && probe
          ? {
              appName: options.identity.appName,
              status: probe.status,
              ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
              ...(probe.osStatus !== undefined ? { osStatus: probe.osStatus } : {})
            }
          : undefined
      )
      options.recover(failure)
    }
    throw failure
  }
  const check = (reading: boolean): void => {
    if (failure) throw failure
    if (reading && 'exists' in options.identity && !options.identity.exists && !written)
      return fail('read-before-key-created')
    if (
      options.identity.backend === 'linux-secret-service' ||
      options.identity.backend === 'linux-kwallet'
    ) {
      const expectedBackend =
        options.identity.backend === 'linux-kwallet'
          ? options.identity.passwordStore
          : 'gnome_libsecret'
      try {
        if (options.cipher.getSelectedStorageBackend?.() !== expectedBackend)
          return fail('linux-backend-unavailable-or-changed')
      } catch {
        return fail('linux-backend-unavailable-or-changed')
      }
    }
    if (checked) return
    if ('exists' in options.identity) {
      let result: IdentityProbeResult
      try {
        result = options.probe(options.identity.appName)
      } catch {
        return fail('access-probe-error')
      }
      if (
        result.status !== 'exists' &&
        !(result.status === 'not-found' && !options.identity.exists && !reading)
      )
        return fail(`access-${result.status}`, result)
    }
  }
  return {
    assertAccessAllowed() {
      if (failure) throw failure
    },
    assertReadAllowed() {
      check(true)
    },
    isEncryptionAvailable() {
      if (failure || options.identity.backend === 'file') return false
      check(false)
      try {
        if (!options.cipher.isEncryptionAvailable()) return fail('credential-access-unavailable')
        // OSCrypt derives and caches the process key here, so later metadata probes cannot change
        // the key in use; repeating them only turns a transient keyring error into a fatal one.
        checked = true
        return true
      } catch {
        return fail('credential-access-unavailable')
      }
    },
    getSelectedStorageBackend: () => options.cipher.getSelectedStorageBackend?.() ?? 'unknown',
    encryptString(value) {
      check(false)
      if (options.identity.backend === 'file') return fail('os-access-in-file-mode')
      try {
        const encrypted = options.cipher.encryptString(value)
        written = true
        checked = true
        return encrypted
      } catch {
        return fail('credential-write-failed')
      }
    },
    decryptString(value) {
      check(true)
      try {
        if (options.identity.backend === 'file') return fail('os-access-in-file-mode')
        const plaintext = options.cipher.decryptString(value)
        checked = true
        return plaintext
      } catch {
        return fail('decryption-failed')
      }
    }
  }
}
