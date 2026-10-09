import { platform } from 'node:os'
import { credentialCipher } from './credential-identity/runtime'

interface SecureStorageCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

let selectedCipher: SecureStorageCipher | undefined

export function configureSecureStorageCipher(cipher: SecureStorageCipher): void {
  if (selectedCipher) throw new Error('Secure storage cipher is already configured.')
  selectedCipher = cipher
}

function hostCipher(): SecureStorageCipher {
  if (!selectedCipher) throw new Error('Secure storage must be configured by the host entry.')
  return credentialCipher(selectedCipher)
}

// All application secret operations share the bootstrap-selected process cipher.
const protectedSafeStorage: SecureStorageCipher = {
  isEncryptionAvailable: () => hostCipher().isEncryptionAvailable(),
  getSelectedStorageBackend: () => hostCipher().getSelectedStorageBackend?.() ?? 'unknown',
  encryptString: (value) => hostCipher().encryptString(value),
  decryptString: (value) => hostCipher().decryptString(value)
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
