import { safeStorage } from 'electron'

// Wraps Electron safeStorage for API-key material. Plaintext keys exist only transiently in main
// memory (during validation and env assembly); at rest they are OS-encrypted ciphertext, and the
// renderer only ever sees the masked hint produced by maskKey().

// Stored ciphertext is base64 with this prefix so the on-disk shape is self-describing.
const KEY_REF_PREFIX = 'enc:'

// Legacy reduced-protection refs remain readable for migration, but new writes never create them.
const PLAIN_REF_PREFIX = 'plain:'

// Reports whether the OS keychain backing safeStorage is usable on this machine.
const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable()

// Turns plaintext into an OS-protected keyRef. Saving secrets fails closed when safeStorage is absent.
const encryptKey = (plaintext: string): string => {
  if (!isEncryptionAvailable()) {
    throw new Error(
      'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    )
  }

  const ciphertext = safeStorage.encryptString(plaintext)

  return `${KEY_REF_PREFIX}${ciphertext.toString('base64')}`
}

// Decrypts a stored keyRef. `plain:` is accepted only for backwards-compatible migration.
const decryptKey = (keyRef: string): string => {
  if (keyRef.startsWith(PLAIN_REF_PREFIX)) {
    return Buffer.from(keyRef.slice(PLAIN_REF_PREFIX.length), 'base64').toString('utf8')
  }

  if (!keyRef.startsWith(KEY_REF_PREFIX)) {
    throw new Error('Malformed key reference.')
  }

  const ciphertext = Buffer.from(keyRef.slice(KEY_REF_PREFIX.length), 'base64')

  return safeStorage.decryptString(ciphertext)
}

// Best-effort decrypt used where a missing key should degrade gracefully instead of throwing.
const tryDecryptKey = (keyRef: string | undefined): string | undefined => {
  if (!keyRef) return undefined

  try {
    return decryptKey(keyRef)
  } catch {
    return undefined
  }
}

// Builds a non-secret display hint like "sk-a…wxyz". Short keys are collapsed to bullets so the
// full value can never be reconstructed from the mask.
const maskKey = (plaintext: string): string => {
  const trimmed = plaintext.trim()

  if (trimmed.length === 0) return ''
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length)

  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

export { KEY_REF_PREFIX, decryptKey, encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey }
