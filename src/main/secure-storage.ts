import { safeStorage } from 'electron'
import { platform } from 'node:os'

interface SecureStorageCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const isSecureStorageAvailable = (
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

export { isSecureStorageAvailable }
export type { SecureStorageCipher }
