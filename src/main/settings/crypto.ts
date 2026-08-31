import { safeStorage } from 'electron'

import { isSecureStorageAvailable } from '../secure-storage'

// Wraps Electron safeStorage for Settings credential material. Plaintext values exist only transiently in main
// memory (during validation and env assembly); at rest they are OS-encrypted ciphertext, and the
// renderer only ever sees the masked hint produced by maskKey().

// Stored ciphertext is base64 with this prefix so the on-disk shape is self-describing.
const KEY_REF_PREFIX = 'enc:'

// Legacy reduced-protection refs remain readable for migration, but new writes never create them.
const PLAIN_REF_PREFIX = 'plain:'

// Reports whether safeStorage is backed by an OS credential vault on this machine.
const isEncryptionAvailable = (): boolean => isSecureStorageAvailable()

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
  if (!isEncryptionAvailable()) {
    throw new Error(
      'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    )
  }

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

const FIXED_MASK_PREFIX = '••••'

// Reveals only a four-character suffix and never the original length for short credentials.
const maskKey = (plaintext: string): string => {
  const trimmed = plaintext.trim()
  const characters = Array.from(trimmed)

  if (characters.length === 0) return ''
  if (characters.length <= 8) return '•'.repeat(8)

  return `${FIXED_MASK_PREFIX}${characters.slice(-4).join('')}`
}

// Old settings may contain prefix-revealing masks. Harden them at the projection boundary without
// rewriting settings just because they were viewed.
const hardenKeyMask = (mask: string | undefined): string | undefined => {
  if (mask === undefined || mask === '') return mask
  if (/^•+$/u.test(mask)) return '•'.repeat(8)

  const ellipsis = mask.lastIndexOf('…')
  if (ellipsis >= 0)
    return `${FIXED_MASK_PREFIX}${Array.from(mask.slice(ellipsis + 1))
      .slice(-4)
      .join('')}`
  if (mask.startsWith(FIXED_MASK_PREFIX)) {
    return `${FIXED_MASK_PREFIX}${Array.from(mask.slice(FIXED_MASK_PREFIX.length)).slice(-4).join('')}`
  }

  return '•'.repeat(8)
}

export {
  KEY_REF_PREFIX,
  decryptKey,
  encryptKey,
  hardenKeyMask,
  isEncryptionAvailable,
  maskKey,
  tryDecryptKey
}
