import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { CredentialIdentityError } from './selection'

export type WindowsKeyValidation = 'valid' | 'access-blocked' | 'error' | 'unsupported'

// This is a real key-read check after backend selection, never a metadata probe. Only ciphertext
// crosses stdin; the helper clears its decrypted buffer and returns a fixed result, not a key.
export const validateWindowsKey = (ciphertext: Buffer): WindowsKeyValidation => {
  if (process.platform !== 'win32') return 'unsupported'
  try {
    const { validatorExecutablePath } = createRequire(import.meta.url)(
      '@aipoch/credential-identity-probe-native'
    ) as { validatorExecutablePath: string }
    const executable = validatorExecutablePath.replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1')
    const result = spawnSync(executable, [], {
      input: ciphertext,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    if (result.error || result.status !== 0 || result.signal) return 'error'
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object') return 'error'
    const output = value as Record<string, unknown>
    if (output.schemaVersion !== 1 || output.platform !== 'win32') return 'error'
    return ['valid', 'access-blocked', 'error', 'unsupported'].includes(String(output.status))
      ? (output.status as WindowsKeyValidation)
      : 'error'
  } catch {
    return 'error'
  }
}

// Electron's Windows OSCrypt Init can replace an unreadable Local State key before ready. Stop
// first if its existing DPAPI envelope cannot be read by this user; never write Local State here.
export const validateWindowsProfileKey = (options: {
  profilePath: string
  hasCiphertexts: boolean
  validate?: (ciphertext: Buffer) => WindowsKeyValidation
}): void => {
  const path = join(options.profilePath, 'Local State')
  try {
    let original: Buffer
    try {
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Local State is too large')
      original = readFileSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !options.hasCiphertexts) return
      throw error
    }
    const value: unknown = JSON.parse(original.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid Local State')
    const key = (value as { os_crypt?: { encrypted_key?: unknown } }).os_crypt?.encrypted_key
    if (key === undefined && !options.hasCiphertexts) return
    if (typeof key !== 'string') throw new Error('Missing DPAPI key')
    const bytes = Buffer.from(key, 'base64')
    if (
      bytes.toString('base64') !== key ||
      bytes.length <= 5 ||
      bytes.length > 65541 ||
      bytes.subarray(0, 5).toString('ascii') !== 'DPAPI'
    )
      throw new Error('Invalid DPAPI key envelope')
    if ((options.validate ?? validateWindowsKey)(bytes.subarray(5)) !== 'valid')
      throw new Error('Existing DPAPI key cannot be verified')
    if (!readFileSync(path).equals(original))
      throw new Error('Local State changed during validation')
  } catch {
    throw new CredentialIdentityError('windows-profile-key-unavailable')
  }
}
