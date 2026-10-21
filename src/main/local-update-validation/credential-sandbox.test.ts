import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeSecureStorageCipher,
  selectStartupCredentialIdentity
} from './credential-sandbox'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): { root: string; profile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'update-cipher-test-')))
  roots.push(root)
  const directories = Object.fromEntries(
    ['homeRoot', 'configRoot', 'dataRoot', 'userDataRoot', 'updateCacheRoot'].map((key) => {
      const value = join(root, key)
      mkdirSync(value)
      return [key, value]
    })
  )
  const path = join(root, 'validation.json')
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      runId: root.split('/').at(-1),
      scenario: 'manual-local',
      runRoot: root,
      ...directories,
      keychainPath: join(root, 'unused.keychain-db'),
      credentialMode: 'sandbox',
      eventsPath: join(root, 'events.jsonl'),
      feedUrl: 'http://127.0.0.1:4567/',
      manifestUrl: 'http://127.0.0.1:4567/version.json',
      installBehavior: 'fail',
      targetArtifact: {
        version: '1.0.2',
        arch: 'arm64',
        size: 10,
        sha512: Buffer.alloc(64).toString('base64')
      }
    })
  )
  vi.stubEnv('OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG', path)
  return { root, profile: directories.userDataRoot }
}
it('retains synthetic credentials across a real runtime restart without OS secret access', () => {
  const { profile } = fixture()
  const identity = selectStartupCredentialIdentity()
  const first = createNodeSecureStorageCipher(identity, profile)
  const encrypted = first.encryptString('synthetic fixture credential')
  first.dispose()
  const recovered = createNodeSecureStorageCipher(identity, profile)
  expect(recovered.decryptString(encrypted)).toBe('synthetic fixture credential')
  expect(encrypted.includes(Buffer.from('synthetic fixture credential'))).toBe(false)
  expect(readFileSync(join(profile, 'local-update-credential-sandbox.key'))).toHaveLength(32)
  recovered.dispose()
})
it('rejects another run, foreign ciphertext, changed bytes and an unexpected profile', () => {
  const first = fixture()
  const identity = selectStartupCredentialIdentity()
  const cipher = createNodeSecureStorageCipher(identity, first.profile)
  const encrypted = cipher.encryptString('fixture')
  const second = fixture()
  const other = createNodeSecureStorageCipher(selectStartupCredentialIdentity(), second.profile)
  expect(() => other.decryptString(encrypted)).toThrow()
  expect(() => other.decryptString(Buffer.from('v10foreign'))).toThrow()
  expect(() => createNodeSecureStorageCipher(identity, first.profile)).toThrow()
  vi.stubEnv('OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG', join(first.root, 'validation.json'))
  encrypted[encrypted.length - 1] ^= 1
  expect(() => cipher.decryptString(encrypted)).toThrow()
  cipher.dispose()
  other.dispose()
})
