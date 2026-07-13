import { safeStorage } from 'electron'

// Wraps Electron safeStorage for API-key material. Plaintext keys exist only transiently in main
// memory (during validation and env assembly); at rest they are OS-encrypted ciphertext, and the
// renderer only ever sees the masked hint produced by maskKey().

// Stored ciphertext is base64 with this prefix so the on-disk shape is self-describing.
const KEY_REF_PREFIX = 'enc:'

// Reduced-protection fallback used only when the OS keychain is unavailable (safeStorage reports
// not-available, e.g. a locked/denied keychain). The key is base64-encoded, NOT encrypted — the
// onboarding and settings UI warn the user that storage is degraded in this case. Without this the
// app would hard-fail on save despite promising a fallback, leaving keyless machines unable to add a
// provider. The prefix keeps the on-disk shape self-describing so decoding never depends on the
// keychain state at read time (a key saved while degraded stays readable once the keychain returns).
const PLAIN_REF_PREFIX = 'plain:'

// Reports whether the OS keychain backing safeStorage is usable on this machine.
const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable()

// Turns a plaintext key into a stored keyRef. Uses OS encryption when the keychain is available;
// otherwise falls back to a base64 "reduced protection" ref (see PLAIN_REF_PREFIX) so key storage
// still works instead of throwing.
const encryptKey = (plaintext: string): string => {
  if (!isEncryptionAvailable()) {
    return `${PLAIN_REF_PREFIX}${Buffer.from(plaintext, 'utf8').toString('base64')}`
  }

  const ciphertext = safeStorage.encryptString(plaintext)

  return `${KEY_REF_PREFIX}${ciphertext.toString('base64')}`
}

// Decrypts a stored keyRef back to plaintext. A reduced-protection (plain:) ref is base64-decoded
// directly; an encrypted (enc:) ref goes through safeStorage and throws when the ref is malformed or
// undecryptable (e.g. the keychain changed), which the service maps to a "needs re-entry" state.
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
