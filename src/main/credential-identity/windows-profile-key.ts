import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { credentialSystemCode, type CredentialDiagnostic } from './diagnostic'
import { CredentialIdentityError } from './selection'

export type WindowsKeyValidation = {
  status: 'valid' | 'access-blocked' | 'error' | 'unsupported'
  diagnostic?: CredentialDiagnostic
}

// Only ciphertext crosses stdin; the helper clears plaintext and returns a fixed result.
export const validateWindowsKey = (ciphertext: Buffer): WindowsKeyValidation => {
  if (process.platform !== 'win32')
    return { status: 'unsupported', diagnostic: { code: 'validator-unsupported' } }
  let executable: string
  try {
    const { validatorExecutablePath } = createRequire(import.meta.url)(
      '@aipoch/credential-identity-probe-native'
    ) as { validatorExecutablePath: string }
    executable = validatorExecutablePath.replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1')
  } catch (error) {
    return {
      status: 'error',
      diagnostic: { code: 'validator-start-failed', systemCode: credentialSystemCode(error) }
    }
  }
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(executable, [], {
      input: ciphertext,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch (error) {
    return {
      status: 'error',
      diagnostic: { code: 'validator-start-failed', systemCode: credentialSystemCode(error) }
    }
  }
  if (result.error) {
    const systemCode = credentialSystemCode(result.error)
    return {
      status: 'error',
      diagnostic: {
        code: systemCode === 'ETIMEDOUT' ? 'validator-timeout' : 'validator-start-failed',
        systemCode
      }
    }
  }
  if (result.status !== 0 || result.signal)
    return {
      status: 'error',
      diagnostic: {
        code: 'validator-failed',
        ...(Number.isInteger(result.status) ? { exitCode: result.status! } : {})
      }
    }
  const invalid: WindowsKeyValidation = {
    status: 'error',
    diagnostic: { code: 'validator-invalid-response' }
  }
  try {
    const value: unknown = JSON.parse(String(result.stdout))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid
    const output = value as Record<string, unknown>
    if (output.schemaVersion !== 1 || output.platform !== 'win32') return invalid
    if (output.status === 'valid') return { status: 'valid' }
    if (!['access-blocked', 'error', 'unsupported'].includes(String(output.status))) return invalid
    const code: CredentialDiagnostic['code'] =
      output.reason === 'dpapi-unprotect-failed'
        ? 'dpapi-unprotect-failed'
        : output.reason === 'invalid-key-size'
          ? 'profile-key-invalid'
          : [
                'input-read-failed',
                'invalid-ciphertext-size',
                'binary-input-mode-unavailable'
              ].includes(String(output.reason))
            ? 'validator-input-failed'
            : output.status === 'unsupported'
              ? 'validator-unsupported'
              : 'validator-failed'
    const osStatus =
      code === 'dpapi-unprotect-failed' &&
      typeof output.errorCode === 'number' &&
      Number.isInteger(output.errorCode) &&
      output.errorCode > 0 &&
      output.errorCode <= 0xffffffff
        ? output.errorCode
        : undefined
    return {
      status: output.status as WindowsKeyValidation['status'],
      diagnostic: { code, ...(osStatus !== undefined ? { osStatus } : {}) }
    }
  } catch {
    return invalid
  }
}

// Stop before Electron can replace an unreadable Local State key. Never write the profile here.
export const validateWindowsProfileKey = (options: {
  profilePath: string
  hasCiphertexts: boolean
  validate?: (ciphertext: Buffer) => WindowsKeyValidation
}): void => {
  const path = join(options.profilePath, 'Local State')
  const fail = (diagnostic: CredentialDiagnostic): never => {
    throw new CredentialIdentityError('windows-profile-key-unavailable', undefined, diagnostic)
  }
  let original: Buffer
  try {
    if (statSync(path).size > 8 * 1024 * 1024) fail({ code: 'profile-too-large' })
    original = readFileSync(path)
  } catch (error) {
    if (error instanceof CredentialIdentityError) throw error
    const systemCode = credentialSystemCode(error)
    if (systemCode === 'ENOENT' && !options.hasCiphertexts) return
    return fail({ code: 'profile-read-failed', systemCode })
  }
  let value: unknown
  try {
    value = JSON.parse(original.toString('utf8'))
  } catch {
    return fail({ code: 'profile-invalid-json' })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail({ code: 'profile-invalid-shape' })
  const key = (value as { os_crypt?: { encrypted_key?: unknown } }).os_crypt?.encrypted_key
  if (key === undefined && !options.hasCiphertexts) return
  if (typeof key !== 'string') return fail({ code: 'profile-key-missing' })
  const bytes = Buffer.from(key, 'base64')
  if (
    bytes.toString('base64') !== key ||
    bytes.length <= 5 ||
    bytes.length > 65541 ||
    bytes.subarray(0, 5).toString('ascii') !== 'DPAPI'
  )
    return fail({ code: 'profile-key-invalid' })
  let validation: WindowsKeyValidation
  try {
    validation = (options.validate ?? validateWindowsKey)(bytes.subarray(5))
  } catch {
    return fail({ code: 'validator-failed' })
  }
  if (validation.status !== 'valid')
    return fail(validation.diagnostic ?? { code: 'validator-failed' })
  try {
    if (!readFileSync(path).equals(original)) fail({ code: 'profile-changed' })
  } catch (error) {
    if (error instanceof CredentialIdentityError) throw error
    fail({ code: 'profile-read-failed', systemCode: credentialSystemCode(error) })
  }
}
