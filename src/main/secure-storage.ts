import { platform } from 'node:os'
import type { SecureStorageCipher } from './credential-identity/cipher-contract'
import { PROTECTED_STRING_PREFIX } from './credential-identity/protected-string-format'
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

export { PROTECTED_STRING_PREFIX }

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

const PROTECTED_JSON_MARKER = 'open-science:protected-json:v1'
export type ProtectedJsonContainer = 'object' | 'array'

export class OptionalSecureStorageStringProtection {
  private failed = false

  constructor(
    private readonly cipher: SecureStorageCipher = protectedSafeStorage,
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
    return revealProtectedString(value, this.cipher)
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
