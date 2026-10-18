import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { validateWindowsProfileKey } from './windows-profile-key'

it('retains the concrete parse failure without exposing profile contents', () => {
  const profilePath = fixture()
  writeFileSync(join(profilePath, 'Local State'), '{PRIVATE-PROFILE-CONTENTS')
  let failure: unknown
  try {
    validateWindowsProfileKey({ profilePath, hasCiphertexts: false })
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({
    reason: 'windows-profile-key-unavailable',
    diagnostic: { code: 'profile-invalid-json' }
  })
  expect(JSON.stringify(failure)).not.toContain('PRIVATE-PROFILE-CONTENTS')
  expect(readFileSync(join(profilePath, 'Local State'), 'utf8')).toBe('{PRIVATE-PROFILE-CONTENTS')
})

const roots: string[] = []
const fixture = (state?: unknown): string => {
  const profilePath = mkdtempSync(join(tmpdir(), 'windows-key-fixture-'))
  roots.push(profilePath)
  if (state !== undefined) writeFileSync(join(profilePath, 'Local State'), JSON.stringify(state))
  return profilePath
}
const encryptedKey = Buffer.concat([
  Buffer.from('DPAPI'),
  Buffer.from([0, 26, 13, 10, 255])
]).toString('base64')
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('leaves an entirely fresh Windows profile to its unchanged DPAPI initialization', () => {
  const validate = vi.fn()
  validateWindowsProfileKey({ profilePath: fixture(), hasCiphertexts: false, validate })
  expect(validate).not.toHaveBeenCalled()
})

it('retains the missing-file system code when encrypted data already exists', () => {
  expect(() => validateWindowsProfileKey({ profilePath: fixture(), hasCiphertexts: true })).toThrow(
    expect.objectContaining({ diagnostic: { code: 'profile-read-failed', systemCode: 'ENOENT' } })
  )
})

it.each([
  [[], 'profile-invalid-shape'],
  [{}, 'profile-key-missing'],
  [{ os_crypt: { encrypted_key: 'invalid' } }, 'profile-key-invalid']
])('classifies invalid profile input without writing it: %j', (state, code) => {
  const profilePath = fixture(state)
  const original = readFileSync(join(profilePath, 'Local State'))
  expect(() => validateWindowsProfileKey({ profilePath, hasCiphertexts: true })).toThrow(
    expect.objectContaining({ diagnostic: { code } })
  )
  expect(readFileSync(join(profilePath, 'Local State'))).toEqual(original)
})

it('carries the DPAPI error through the profile boundary without replacing the key', () => {
  const profilePath = fixture({ os_crypt: { encrypted_key: encryptedKey } })
  const original = readFileSync(join(profilePath, 'Local State'))
  expect(() =>
    validateWindowsProfileKey({
      profilePath,
      hasCiphertexts: true,
      validate: () => ({
        status: 'access-blocked',
        diagnostic: { code: 'dpapi-unprotect-failed', osStatus: 5 }
      })
    })
  ).toThrow(
    expect.objectContaining({ diagnostic: { code: 'dpapi-unprotect-failed', osStatus: 5 } })
  )
  expect(readFileSync(join(profilePath, 'Local State'))).toEqual(original)
})

it.each([undefined, {}, { os_crypt: {} }])(
  'blocks missing DPAPI key with existing ciphertext before Electron can replace it',
  (state) => {
    const validate = vi.fn()
    expect(() =>
      validateWindowsProfileKey({ profilePath: fixture(state), hasCiphertexts: true, validate })
    ).toThrow(/recovery/i)
    expect(validate).not.toHaveBeenCalled()
  }
)

it('validates the actual DPAPI key bytes without changing Local State', () => {
  const profilePath = fixture({ os_crypt: { encrypted_key: encryptedKey }, unrelated: 'preserved' })
  const original = readFileSync(join(profilePath, 'Local State'))
  const validate = vi.fn(() => ({ status: 'valid' as const }))
  validateWindowsProfileKey({ profilePath, hasCiphertexts: true, validate })
  expect(validate).toHaveBeenCalledWith(Buffer.from([0, 26, 13, 10, 255]))
  expect(readFileSync(join(profilePath, 'Local State'))).toEqual(original)
})

it.each(['access-blocked', 'error', 'unsupported'] as const)(
  'blocks existing profile on %s without clearing or replacing the key',
  (status) => {
    const profilePath = fixture({ os_crypt: { encrypted_key: encryptedKey } })
    const original = readFileSync(join(profilePath, 'Local State'))
    expect(() =>
      validateWindowsProfileKey({ profilePath, hasCiphertexts: true, validate: () => ({ status }) })
    ).toThrow(/recovery/i)
    expect(readFileSync(join(profilePath, 'Local State'))).toEqual(original)
  }
)

it('rejects malformed existing Local State and key encodings without a secret read', () => {
  const profilePath = fixture()
  const validate = vi.fn()
  for (const contents of [
    '{broken',
    JSON.stringify({ os_crypt: { encrypted_key: 'not-base64' } }),
    JSON.stringify({
      os_crypt: { encrypted_key: Buffer.from('wrong-provider').toString('base64') }
    })
  ]) {
    writeFileSync(join(profilePath, 'Local State'), contents)
    expect(() =>
      validateWindowsProfileKey({ profilePath, hasCiphertexts: true, validate })
    ).toThrow(/recovery/i)
    expect(readFileSync(join(profilePath, 'Local State'), 'utf8')).toBe(contents)
  }
  expect(validate).not.toHaveBeenCalled()
})

it('rejects a replaced Local State after native validation instead of trusting stale evidence', () => {
  const profilePath = fixture({ os_crypt: { encrypted_key: encryptedKey } })
  expect(() =>
    validateWindowsProfileKey({
      profilePath,
      hasCiphertexts: true,
      validate: () => {
        writeFileSync(join(profilePath, 'Local State'), '{"replaced":true}')
        return { status: 'valid' }
      }
    })
  ).toThrow(expect.objectContaining({ diagnostic: { code: 'profile-changed' } }))
})
