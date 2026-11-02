import { platform } from 'node:os'
import type { SecureStorageCipher } from './credential-identity/cipher-contract'
import { credentialCipher } from './credential-identity/runtime'

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

export const PROTECTED_STRING_PREFIX = 'open-science:protected:v1:'

export function revealProtectedString(
  value: string,
  cipher: SecureStorageCipher = protectedSafeStorage
): string {
  if (!value.startsWith(PROTECTED_STRING_PREFIX)) return value
  try {
    return cipher.decryptString(Buffer.from(value.slice(PROTECTED_STRING_PREFIX.length), 'base64'))
  } catch {
    throw new Error('Protected application data cannot be decrypted on this system.')
  }
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
