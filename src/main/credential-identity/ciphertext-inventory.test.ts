import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCredentialCiphertexts, verifyCredentialCiphertexts } from './ciphertext-inventory'

const roots: string[] = []
const fixture = (): { configRoot: string; profilePath: string } => {
  const root = mkdtempSync(join(tmpdir(), 'credential-inventory-'))
  roots.push(root)
  const configRoot = join(root, 'config'),
    profilePath = join(root, 'profile')
  mkdirSync(configRoot)
  mkdirSync(profilePath)
  return { configRoot, profilePath }
}
const ref = (text: string): string => `enc:${Buffer.from(text).toString('base64')}`
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe('read-only ciphertext inventory', () => {
  it('finds refs in settings and the shared credentials document without rewriting either', () => {
    const paths = fixture()
    const settings = JSON.stringify({
      version: 2,
      providers: [{ keyRef: ref('old-provider') }],
      connectors: { customMcpServers: [{ envRefs: { TOKEN: ref('old-env') } }] }
    })
    const credentials = JSON.stringify({
      version: 1,
      credentials: [
        {
          id: 'oauth',
          displayName: 'OAuth',
          kind: 'oauth',
          resourceUri: 'https://example.com/mcp',
          transport: 'streamable_http',
          oauth: {},
          createdAt: 1,
          updatedAt: 1,
          stateRef: ref('old-oauth')
        }
      ]
    })
    writeFileSync(join(paths.configRoot, 'settings.json'), settings)
    writeFileSync(join(paths.configRoot, 'credentials.json'), credentials)
    expect(readCredentialCiphertexts(paths).map((b) => b.toString())).toEqual([
      'old-provider',
      'old-env',
      'old-oauth'
    ])
    expect(readFileSync(join(paths.configRoot, 'settings.json'), 'utf8')).toBe(settings)
    expect(readFileSync(join(paths.configRoot, 'credentials.json'), 'utf8')).toBe(credentials)
  })

  it('reads encrypted cookies from the default profile and persisted partitions without opening Chromium', () => {
    const paths = fixture()
    for (const relative of ['Network', 'Partitions/accounts/Network']) {
      const directory = join(paths.profilePath, relative)
      mkdirSync(directory, { recursive: true })
      const db = new DatabaseSync(join(directory, 'Cookies'))
      db.exec('CREATE TABLE cookies(encrypted_value BLOB)')
      db.prepare('INSERT INTO cookies VALUES (?)').run(Buffer.from(`v10:${relative}`))
      db.close()
    }
    expect(readCredentialCiphertexts(paths).map((b) => b.toString())).toEqual([
      'v10:Network',
      'v10:Partitions/accounts/Network'
    ])
  })

  it('finds compute passwords, protected job fields, and request fingerprint keys', () => {
    const paths = fixture()
    const db = new DatabaseSync(join(paths.configRoot, 'open-science.db'))
    db.exec(
      'CREATE TABLE ComputeCredential(ciphertext BLOB); CREATE TABLE ComputeJob(command TEXT, sensitiveDataEncrypted INTEGER); CREATE TABLE ComputeAuthOperation(requestFingerprint TEXT)'
    )
    db.prepare('INSERT INTO ComputeCredential VALUES (?)').run(Buffer.from('compute-password'))
    db.prepare('INSERT INTO ComputeJob VALUES (?, 1)').run(
      'open-science:protected:v1:' + Buffer.from('command').toString('base64')
    )
    db.prepare('INSERT INTO ComputeAuthOperation VALUES (?)').run(
      JSON.stringify([1, Buffer.from('fingerprint-key').toString('base64'), 'digest'])
    )
    db.close()
    expect(readCredentialCiphertexts(paths).map((b) => b.toString())).toEqual([
      'compute-password',
      'command',
      'fingerprint-key'
    ])
  })

  it('blocks unreadable or malformed existing documents instead of treating them as empty', () => {
    const paths = fixture()
    writeFileSync(join(paths.configRoot, 'credentials.json'), '{broken')
    expect(() => readCredentialCiphertexts(paths)).toThrow(/recovery/i)
    expect(readFileSync(join(paths.configRoot, 'credentials.json'), 'utf8')).toBe('{broken')
  })

  it('does not restore or promote pending credential documents while probing', () => {
    const paths = fixture()
    writeFileSync(
      join(paths.configRoot, 'credentials.json.123.tmp'),
      JSON.stringify({ secretRef: ref('pending') })
    )
    expect(() => readCredentialCiphertexts(paths)).toThrow(/recovery/i)
    expect(readdirSync(paths.configRoot)).toEqual(['credentials.json.123.tmp'])
  })

  it('verifies selected-key decryption without encrypting, clearing refs, or trying another name', () => {
    const ciphertext = Buffer.from('old-ciphertext')
    const decrypt = vi.fn(() => {
      throw new Error('wrong key')
    })
    expect(() => verifyCredentialCiphertexts([ciphertext], decrypt)).toThrow(/recovery/i)
    expect(decrypt).toHaveBeenCalledTimes(1)
    expect(ciphertext.toString()).toBe('old-ciphertext')
  })
})

it('keeps the precise settings recovery path when JSON is malformed before Electron starts', () => {
  const paths = fixture()
  const path = join(paths.configRoot, 'settings.json')
  writeFileSync(path, '{broken')
  let error: unknown
  try {
    readCredentialCiphertexts(paths)
  } catch (failure) {
    error = failure
  }
  expect(error).toMatchObject({ name: 'SettingsDocumentReadError' })
  expect(String(error)).toContain(path)
  expect(String(error)).toMatch(/Invalid JSON.*Restore this file/s)
  expect(readFileSync(path, 'utf8')).toBe('{broken')
})

it('supports databases from before compute credentials were introduced without migrating them', () => {
  const paths = fixture()
  const db = new DatabaseSync(join(paths.configRoot, 'open-science.db'))
  db.exec('CREATE TABLE Session(id TEXT); CREATE TABLE ComputeJob(command TEXT)')
  db.prepare('INSERT INTO ComputeJob VALUES (?)').run('echo scientific-output')
  db.close()
  const before = readFileSync(join(paths.configRoot, 'open-science.db'))
  expect(readCredentialCiphertexts(paths)).toEqual([])
  expect(readFileSync(join(paths.configRoot, 'open-science.db'))).toEqual(before)
})

it('does not interpret ordinary names, prompts, command output, or legacy opaque fingerprints as ciphertext', () => {
  const paths = fixture()
  writeFileSync(
    join(paths.configRoot, 'settings.json'),
    JSON.stringify({
      version: 2,
      providers: [{ name: 'enc:normal label', keyRef: ref('real-key') }],
      customPrompt: 'literal open-science:protected:v1:example',
      connectors: { customMcpServers: [{ name: 'enc:label', args: ['enc:argument'] }] }
    })
  )
  writeFileSync(
    join(paths.configRoot, 'credentials.json'),
    JSON.stringify({
      version: 1,
      credentials: [
        {
          id: 'key',
          kind: 'api_key',
          displayName: 'enc:name',
          secretRef: ref('real-device-key'),
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
  )
  const db = new DatabaseSync(join(paths.configRoot, 'open-science.db'))
  db.exec(
    'CREATE TABLE ComputeJob(command TEXT, sensitiveDataEncrypted INTEGER); CREATE TABLE ComputeAuthOperation(requestFingerprint TEXT)'
  )
  db.prepare('INSERT INTO ComputeJob VALUES (?, 0)').run(
    'echo open-science:protected:v1:user-output'
  )
  db.prepare('INSERT INTO ComputeAuthOperation VALUES (?)').run('legacy-opaque-fingerprint')
  db.close()
  expect(readCredentialCiphertexts(paths).map((b) => b.toString())).toEqual([
    'real-key',
    'real-device-key'
  ])
})

it.each([
  null,
  [],
  {},
  { version: 2, credentials: [] },
  { version: 1 },
  { version: 1, credentials: [{}] },
  {
    version: 1,
    credentials: [
      { id: 'x', displayName: 'Missing kind', secretRef: ref('old'), createdAt: 1, updatedAt: 1 }
    ]
  }
])('rejects unsupported credentials document shape without replacing it: %j', (value) => {
  const paths = fixture()
  const path = join(paths.configRoot, 'credentials.json')
  const contents = JSON.stringify(value)
  writeFileSync(path, contents)
  expect(() => readCredentialCiphertexts(paths)).toThrow(/recovery/i)
  expect(readFileSync(path, 'utf8')).toBe(contents)
})

it.each([null, [], {}, { version: 999 }, { version: 2, dataRoot: 'relative' }])(
  'preserves precise settings errors for invalid shape: %j',
  (value) => {
    const paths = fixture()
    const path = join(paths.configRoot, 'settings.json')
    const contents = JSON.stringify(value)
    writeFileSync(path, contents)
    expect(() => readCredentialCiphertexts(paths)).toThrow(path)
    expect(readFileSync(path, 'utf8')).toBe(contents)
  }
)

it('accepts historical settings version 1 without migration or rewriting', () => {
  const paths = fixture()
  const path = join(paths.configRoot, 'settings.json')
  const contents = JSON.stringify({ version: 1, providers: [{ keyRef: ref('legacy') }] })
  writeFileSync(path, contents)
  expect(readCredentialCiphertexts(paths).map((value) => value.toString())).toEqual(['legacy'])
  expect(readFileSync(path, 'utf8')).toBe(contents)
})
