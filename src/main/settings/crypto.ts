import { safeStorage } from 'electron'

// Wraps Electron safeStorage for API-key material. Plaintext keys exist only transiently in main
// memory (during validation and env assembly); at rest they are OS-encrypted ciphertext, and the
// renderer only ever sees the masked hint produced by maskKey().

// Stored ciphertext is base64 with this prefix so the on-disk shape is self-describing.
const KEY_REF_PREFIX = 'enc:'

// Reports whether the OS keychain backing safeStorage is usable on this machine.
const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable()

// Encrypts a plaintext key into a prefixed base64 keyRef for storage.
const encryptKey = (plaintext: string): string => {
  const ciphertext = safeStorage.encryptString(plaintext)

  return `${KEY_REF_PREFIX}${ciphertext.toString('base64')}`
}

// Decrypts a stored keyRef back to plaintext. Throws when the ref is malformed or undecryptable
// (e.g. the keychain changed), which the service maps to a "needs re-entry" provider state.
const decryptKey = (keyRef: string): string => {
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
