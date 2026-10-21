// This module is substituted for the credential bootstrap/cipher ONLY by an explicit validation
// build. It encrypts synthetic fixture secrets with a run-owned key; no native credential helper is
// loaded. This is not acceptance of Keychain compatibility or production credential recovery.
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { SecureStorageCipher } from '../credential-identity/cipher-contract'
import type { CredentialIdentity } from '../credential-identity/selection'
import { installCredentialAccess } from '../credential-identity/runtime'
import { readLocalUpdateValidationConfig } from './config'

function configuration(): ReturnType<typeof readLocalUpdateValidationConfig> {
  const path = process.env.OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG
  if (!path) throw new Error('Credential sandbox requires a validation configuration.')
  const config = readLocalUpdateValidationConfig(path)
  if (config.credentialMode !== 'sandbox') throw new Error('Credential sandbox was not selected.')
  return config
}

export function selectStartupCredentialIdentity(): CredentialIdentity {
  const config = configuration()
  return {
    backend: 'mac-keychain',
    appName: `Open-Science Validation ${config.runId}`,
    exists: true
  }
}

export function prepareCredentialValidation(
  _identity: CredentialIdentity,
  paths: { configRoot: string; profilePath: string }
): (cipher: SecureStorageCipher) => void {
  const config = configuration()
  if (paths.configRoot !== config.configRoot || paths.profilePath !== config.userDataRoot)
    throw new Error('Credential sandbox roots do not match this run.')
  return (cipher) =>
    installCredentialAccess({
      identity: selectStartupCredentialIdentity(),
      cipher,
      probe: () => ({ status: 'exists' }),
      recover: (error) => {
        throw error
      }
    })
}

export function createNodeSecureStorageCipher(
  _identity: CredentialIdentity,
  profilePath: string
): SecureStorageCipher & { dispose(): void } {
  const config = configuration()
  if (profilePath !== config.userDataRoot) throw new Error('Unexpected credential sandbox profile.')
  const path = join(profilePath, 'local-update-credential-sandbox.key')
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let key: Buffer
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.size !== 32 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('Invalid credential sandbox key.')
    key = readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  let disposed = false
  const assertOpen = (): void => {
    if (disposed) throw new Error('Credential sandbox closed.')
  }
  return {
    isEncryptionAvailable: () => !disposed,
    getSelectedStorageBackend: () => 'local-update-credential-sandbox',
    encryptString(value) {
      assertOpen()
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from('luv1'), nonce, cipher.getAuthTag(), encrypted])
    },
    decryptString(value) {
      assertOpen()
      if (value.length < 32 || value.subarray(0, 4).toString() !== 'luv1')
        throw new Error('Not a credential sandbox ciphertext.')
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(4, 16))
      cipher.setAuthTag(value.subarray(16, 32))
      return Buffer.concat([cipher.update(value.subarray(32)), cipher.final()]).toString('utf8')
    },
    dispose() {
      disposed = true
      key.fill(0)
    }
  }
}

export function initializeNodeWindowsProfileKey(): never {
  throw new Error('Local credential simulation is limited to macOS validation builds.')
}
