import { safeStorage } from 'electron'
import { platform } from 'node:os'
import { credentialCipher } from './credential-identity/runtime'

interface SecureStorageCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

// All application secret operations share the bootstrap-selected process cipher.
const protectedSafeStorage: SecureStorageCipher = {
  isEncryptionAvailable: () => credentialCipher(safeStorage).isEncryptionAvailable(),
  getSelectedStorageBackend: () =>
    credentialCipher(safeStorage).getSelectedStorageBackend?.() ?? 'unknown',
  encryptString: (value) => credentialCipher(safeStorage).encryptString(value),
  decryptString: (value) => credentialCipher(safeStorage).decryptString(value)
}

const isSecureStorageAvailable = (
  cipher: SecureStorageCipher = protectedSafeStorage,
  currentPlatform: NodeJS.Platform = platform()
): boolean => {
  try {
    if (!cipher.isEncryptionAvailable()) return false
    return !(currentPlatform === 'linux' && cipher.getSelectedStorageBackend?.() === 'basic_text')
  } catch {
    return false
  }
}

export { isSecureStorageAvailable, protectedSafeStorage }
export type { SecureStorageCipher }
