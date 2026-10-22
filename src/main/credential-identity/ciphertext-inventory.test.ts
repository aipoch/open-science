import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCredentialCiphertexts, verifyCredentialCiphertexts } from './ciphertext-inventory'
import { prepareCredentialValidation, selectStartupCredentialIdentity } from './bootstrap'
import { CredentialIdentityError } from './selection'
import { resolveBootstrapConfigRoot, resolveElectronProfile } from '../storage/electron-profile'

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
  it('does not let an inactive journal bypass an unreadable application database', () => {
    const paths = fixture()
    const path = join(paths.configRoot, 'open-science.db')
    const original = Buffer.from('not a SQLite database')
    const journal = Buffer.alloc(28)
    writeFileSync(path, original)
    writeFileSync(`${path}-journal`, journal)
    expect(() => readCredentialCiphertexts(paths)).toThrow(
      expect.objectContaining({ reason: 'ciphertext-inventory-unavailable' })
    )
    expect(readFileSync(path)).toEqual(original)
    expect(readFileSync(`${path}-journal`)).toEqual(journal)
  })

  it.each([
    ['application', 'before journal sync'],
    ['cookies', 'before journal sync'],
    ['application', 'after spilling uncommitted pages'],
    ['cookies', 'after spilling uncommitted pages']
  ])('reads committed %s ciphertext after a writer exits %s', (store, stage) => {
    const paths = fixture()
    const path = join(
      store === 'application' ? paths.configRoot : paths.profilePath,
      store === 'application' ? 'open-science.db' : 'Cookies'
    )
    const table = store === 'application' ? 'ComputeCredential' : 'cookies'
    const column = store === 'application' ? 'ciphertext' : 'encrypted_value'
    const spill = stage === 'after spilling uncommitted pages'
    // Let SQLite create both crash states, without fabricating a journal header.
    const writer = spawnSync(process.execPath, [
      '--no-warnings',
      '-e',
      `
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(process.argv[1])
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=5; PRAGMA cache_spill=${spill ? 'ON' : 'OFF'}')
        db.exec('CREATE TABLE ${table}(${column} BLOB, padding BLOB)')
        db.prepare('INSERT INTO ${table} VALUES (?, zeroblob(65536))').run(Buffer.from('committed-ciphertext'))
        db.exec('BEGIN IMMEDIATE')
        db.prepare('UPDATE ${table} SET ${column}=?, padding=randomblob(65536)').run(Buffer.from('uncommitted-ciphertext'))
        require('node:fs').writeSync(1, 'journal-written')
        process.kill(process.pid, 'SIGKILL')
        `,
      path
    ])
    expect(writer.error).toBeUndefined()
    expect(writer.stdout.toString()).toBe('journal-written')
    expect(writer.status).toBe(process.platform === 'win32' ? 1 : null)
    expect(writer.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL')
    const original = readFileSync(path)
    const journal = readFileSync(`${path}-journal`)
    expect(journal.length).toBeGreaterThan(512)
    if (spill) expect(journal.subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7')
    else {
      expect(journal.subarray(0, 12)).toEqual(Buffer.alloc(12))
      expect(journal.subarray(12, 28)).not.toEqual(Buffer.alloc(16))
    }

    // Establish the reported contrast using SQLite itself on an independent copy.
    const controlPath = join(paths.configRoot, 'control.db')
    copyFileSync(path, controlPath)
    copyFileSync(`${path}-journal`, `${controlPath}-journal`)
    const control = new DatabaseSync(controlPath, { readOnly: !spill })
    try {
      expect(control.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
      expect(
        Buffer.from(
          control.prepare(`SELECT ${column} FROM ${table}`).get()![column] as Uint8Array
        ).toString()
      ).toBe('committed-ciphertext')
    } finally {
      control.close()
    }

    const inspect = (): string[] | string => {
      try {
        return readCredentialCiphertexts(paths).map((value) => value.toString())
      } catch (error) {
        if (!(error instanceof CredentialIdentityError)) throw error
        return error.reason
      }
    }
    const first = inspect()
    const second = inspect()
    expect(readFileSync(path)).toEqual(original)
    expect(readFileSync(`${path}-journal`)).toEqual(journal)
    expect({ first, second }).toEqual({
      first: ['committed-ciphertext'],
      second: ['committed-ciphertext']
    })
  })

  it.each(['DELETE', 'PERSIST'])(
    'accepts an existing .open-science directory without renaming it after a completed %s transaction',
    (mode) => {
      const home = mkdtempSync(join(tmpdir(), 'credential-upgrade-home-'))
      roots.push(home)
      const appData = join(home, 'AppData', 'Roaming')
      const legacyProfile = join(appData, 'Open Science')
      mkdirSync(legacyProfile, { recursive: true })
      const configRoot = resolveBootstrapConfigRoot(home, true, {})
      expect(configRoot).toBe(join(home, '.open-science'))
      mkdirSync(configRoot)
      writeFileSync(
        join(configRoot, 'settings.json'),
        JSON.stringify({ version: 1, providers: [] })
      )
      const path = join(configRoot, 'open-science.db')
      const db = new DatabaseSync(path)
      // Only committed SQLite page writes are needed. This does not invent a historical app schema.
      db.exec(`PRAGMA journal_mode=${mode}; PRAGMA user_version=1; PRAGMA user_version=2`)
      db.close()
      const contents = (directory: string): Record<string, Buffer> =>
        Object.fromEntries(
          readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))])
        )
      const original = contents(configRoot)
      if (mode === 'PERSIST') {
        expect(original['open-science.db-journal'].length).toBeGreaterThan(512)
        expect(original['open-science.db-journal'].subarray(0, 28)).toEqual(Buffer.alloc(28))
      }
      const preflight = (): string => {
        const selectedRoot = resolveBootstrapConfigRoot(home, true, {})
        const profilePath = resolveElectronProfile({
          appData,
          configRoot: selectedRoot,
          packaged: true,
          env: {}
        })
        // Renaming the configuration directory must not replace the Electron profile.
        expect(profilePath).toBe(legacyProfile)
        try {
          const identity = selectStartupCredentialIdentity({ platform: 'win32', packaged: true })
          prepareCredentialValidation(identity, { configRoot: selectedRoot, profilePath })
          return 'ready'
        } catch (error) {
          if (!(error instanceof CredentialIdentityError)) throw error
          return error.reason
        }
      }
      const beforeRename = preflight()
      expect(contents(configRoot)).toEqual(original)
      const backup = join(home, '.open-science.backup')
      renameSync(configRoot, backup)
      const afterRename = preflight()
      expect(afterRename).toBe('ready')
      expect(existsSync(configRoot)).toBe(false)
      expect(contents(backup)).toEqual(original)
      renameSync(backup, configRoot)
      const afterRestore = preflight()
      expect(contents(configRoot)).toEqual(original)
      expect(readdirSync(legacyProfile)).toEqual([])
      expect({ beforeRename, afterRename, afterRestore }).toEqual({
        beforeRename: 'ready',
        afterRename: 'ready',
        afterRestore: 'ready'
      })
    }
  )

  it.each(['DELETE', 'PERSIST'])(
    'reads committed profile cookies after a completed %s transaction',
    (mode) => {
      const paths = fixture()
      const directory = join(paths.profilePath, 'Network')
      mkdirSync(directory)
      const path = join(directory, 'Cookies')
      const db = new DatabaseSync(path)
      db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE cookies(encrypted_value BLOB)`)
      db.prepare('INSERT INTO cookies VALUES (?)').run(Buffer.from('legacy-cookie'))
      db.close()
      const before = Object.fromEntries(
        readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))])
      )
      if (mode === 'PERSIST') {
        expect(before['Cookies-journal'].length).toBeGreaterThan(512)
        expect(before['Cookies-journal'].subarray(0, 28)).toEqual(Buffer.alloc(28))
      }
      expect(readCredentialCiphertexts(paths).map((value) => value.toString())).toEqual([
        'legacy-cookie'
      ])
      expect(
        Object.fromEntries(
          readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))])
        )
      ).toEqual(before)
    }
  )

  it('finds refs in settings and the shared credentials document without rewriting either', () => {
    const paths = fixture()
    const settings = JSON.stringify({
      version: 2,
      providers: [{ keyRef: ref('old-provider') }],
      classification: { services: [{ keyRef: ref('classification-key') }] },
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
      'classification-key',
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

  it('preserves a classified native key failure through the complete ciphertext validation boundary', () => {
    const failure = new CredentialIdentityError('native-secret-operation-failed')
    expect(() =>
      verifyCredentialCiphertexts([Buffer.from('v10fixture')], () => {
        throw failure
      })
    ).toThrow(failure)
    try {
      verifyCredentialCiphertexts([Buffer.from('v10fixture')], () => {
        throw failure
      })
    } catch (error) {
      expect(error).toBe(failure)
    }
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
      classification: { services: [{ keyRef: ref('classification-key') }] },
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
    'classification-key',
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
