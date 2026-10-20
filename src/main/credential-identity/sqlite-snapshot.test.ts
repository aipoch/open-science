import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withReadOnlySqliteSnapshot } from './sqlite-snapshot'

const hooks = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
      const count = actual.readSync(fd, buffer, offset, length, position)
      const callback = hooks.afterRead
      hooks.afterRead = undefined
      callback?.()
      return count
    }
  }
})

const roots: string[] = []
const fixture = (): { root: string; path: string } => {
  const root = mkdtempSync(join(tmpdir(), 'credential-snapshot-source-'))
  roots.push(root)
  return { root, path: join(root, 'source.db') }
}
const contents = (root: string): Record<string, Buffer> =>
  Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => [name, readFileSync(join(root, name))])
  )
const createWal = (path: string): void => {
  // Kill only the fixture writer so committed data stays in WAL without a close-time checkpoint.
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE secrets(value TEXT); INSERT INTO secrets VALUES ('wal-ciphertext')")
    require('node:fs').writeSync(1, 'wal-committed')
    process.kill(process.pid, 'SIGKILL')
  `,
    path
  ])
  expect(result.error).toBeUndefined()
  expect(result.stdout.toString()).toBe('wal-committed')
  // A self-kill is reported as exit code 1 on Windows, not as a POSIX signal.
  expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL')
  expect(result.status).toBe(process.platform === 'win32' ? 1 : null)
  expect(existsSync(`${path}-wal`)).toBe(true)
}

const createRollback = (path: string): void => {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; CREATE TABLE secrets(value TEXT, padding BLOB); INSERT INTO secrets VALUES ('committed-ciphertext', zeroblob(65536)); BEGIN IMMEDIATE; UPDATE secrets SET value='uncommitted-ciphertext', padding=randomblob(65536)")
    require('node:fs').writeSync(1, 'rollback-pending')
    process.kill(process.pid, 'SIGKILL')
  `,
    path
  ])
  expect(result.error).toBeUndefined()
  expect(result.stdout.toString()).toBe('rollback-pending')
  expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL')
  expect(result.status).toBe(process.platform === 'win32' ? 1 : null)
  expect(readFileSync(`${path}-journal`).subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7')
}

const createCompletedRollback = (path: string, mode = 'PERSIST'): void => {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE secrets(value TEXT)`)
    db.prepare('INSERT INTO secrets VALUES (?)').run('committed-ciphertext')
  } finally {
    db.close()
  }
}

afterEach(() => {
  hooks.afterRead = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('isolated SQLite ciphertext snapshots', () => {
  it.each(['PERSIST', 'TRUNCATE'])(
    'reads a completed %s transaction without modifying its database or journal',
    (mode) => {
      const { root, path } = fixture()
      createCompletedRollback(path, mode)
      const before = contents(root)
      if (mode === 'PERSIST') {
        expect(before['source.db-journal'].length).toBeGreaterThan(512)
        expect(before['source.db-journal'].subarray(0, 28)).toEqual(Buffer.alloc(28))
      } else expect(before['source.db-journal']).toEqual(Buffer.alloc(0))
      let snapshot = ''
      withReadOnlySqliteSnapshot(path, (db) => {
        expect(db.prepare('SELECT value FROM secrets').get()?.value).toBe('committed-ciphertext')
        snapshot = String(db.prepare('PRAGMA database_list').get()?.file)
        expect(dirname(snapshot)).not.toBe(root)
        expect(() => db.exec("UPDATE secrets SET value='forbidden'")).toThrow()
      })
      expect(contents(root)).toEqual(before)
      expect(existsSync(dirname(snapshot))).toBe(false)
    }
  )

  it.each(['truncated', 'partially-cleared'])(
    'rejects a %s journal header instead of accepting it as a completed transaction',
    (kind) => {
      const { root, path } = fixture()
      createCompletedRollback(path)
      const journal = `${path}-journal`
      const bytes = readFileSync(journal)
      if (kind === 'truncated') writeFileSync(journal, bytes.subarray(0, 27))
      else {
        bytes[27] = 1
        writeFileSync(journal, bytes)
      }
      const before = contents(root)
      const read = vi.fn()
      expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/journal.*safely/i)
      expect(read).not.toHaveBeenCalled()
      expect(contents(root)).toEqual(before)
    }
  )

  it.each(['replace', 'change', 'remove'])(
    'rejects a completed journal that changes during inspection: %s',
    (mutation) => {
      const { path } = fixture()
      createCompletedRollback(path)
      const journal = `${path}-journal`
      const original = readFileSync(journal)
      hooks.afterRead = () => {
        if (mutation === 'remove') unlinkSync(journal)
        else if (mutation === 'replace') {
          renameSync(journal, `${journal}.old`)
          writeFileSync(journal, original)
        } else writeFileSync(journal, Buffer.concat([original, Buffer.from('changed')]))
      }
      const read = vi.fn()
      expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/changed/i)
      expect(read).not.toHaveBeenCalled()
    }
  )

  it.each(['hot', 'completed'])(
    'keeps blocking conflicting nonempty WAL and %s rollback journals',
    (kind) => {
      const { root, path } = fixture()
      if (kind === 'hot') createRollback(path)
      else createCompletedRollback(path)
      writeFileSync(`${path}-wal`, 'conflicting-wal')
      const before = contents(root)
      const read = vi.fn()
      expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/conflicting recovery journals/)
      expect(read).not.toHaveBeenCalled()
      expect(contents(root)).toEqual(before)
    }
  )

  it('skips an absent source without creating a database', () => {
    const { root, path } = fixture()
    const read = vi.fn()
    withReadOnlySqliteSnapshot(path, read)
    expect(read).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual([])
  })

  it.each([false, true])(
    'reads committed WAL data without modifying the source (missing shm: %s)',
    (missingShm) => {
      const { root, path } = fixture()
      createWal(path)
      if (missingShm) unlinkSync(`${path}-shm`)
      const before = contents(root)
      let snapshot = ''
      withReadOnlySqliteSnapshot(path, (db) => {
        expect(db.prepare('SELECT value FROM secrets').get()?.value).toBe('wal-ciphertext')
        snapshot = String(db.prepare('PRAGMA database_list').get()?.file)
        expect(dirname(snapshot)).not.toBe(root)
        if (process.platform !== 'win32') {
          expect(statSync(dirname(snapshot)).mode & 0o777).toBe(0o700)
          expect(statSync(snapshot).mode & 0o777).toBe(0o600)
          expect(statSync(`${snapshot}-wal`).mode & 0o777).toBe(0o600)
        }
        expect(() => db.exec("INSERT INTO secrets VALUES ('forbidden')")).toThrow()
      })
      expect(contents(root)).toEqual(before)
      expect(existsSync(dirname(snapshot))).toBe(false)
    }
  )

  it('recovers only the private copy after a writer crash and exposes committed ciphertexts read-only', () => {
    const { root, path } = fixture()
    createRollback(path)
    const before = contents(root)
    let snapshot = ''
    withReadOnlySqliteSnapshot(path, (db) => {
      expect(db.prepare('SELECT value FROM secrets').get()?.value).toBe('committed-ciphertext')
      snapshot = String(db.prepare('PRAGMA database_list').get()?.file)
      expect(dirname(snapshot)).not.toBe(root)
      expect(() => db.exec("UPDATE secrets SET value='forbidden'")).toThrow()
    })
    expect(contents(root)).toEqual(before)
    expect(existsSync(dirname(snapshot))).toBe(false)
  })

  it.each(['replace', 'change', 'remove'])(
    'rejects rollback journal changes while copying: %s',
    (mutation) => {
      const { path } = fixture()
      createRollback(path)
      const journal = `${path}-journal`
      const original = readFileSync(journal)
      hooks.afterRead = () => {
        if (mutation === 'remove') unlinkSync(journal)
        else if (mutation === 'replace') {
          renameSync(journal, `${journal}.old`)
          writeFileSync(journal, original)
        } else writeFileSync(journal, Buffer.concat([original, Buffer.from('changed')]))
      }
      const read = vi.fn()
      expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/changed|recovery|recovered/i)
      expect(read).not.toHaveBeenCalled()
    }
  )

  it('rejects rollback journals referencing a super-journal outside the private copy', () => {
    const { root, path } = fixture()
    createRollback(path)
    const journal = `${path}-journal`
    const external = join(root, 'external-super-journal')
    writeFileSync(external, 'must not be opened or deleted')
    const name = Buffer.from(external)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(name.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE([...name].reduce((sum, byte) => sum + byte, 0))
    writeFileSync(
      journal,
      Buffer.concat([
        readFileSync(journal),
        name,
        length,
        checksum,
        Buffer.from('d9d505f920a163d7', 'hex')
      ])
    )
    const before = contents(root)
    const read = vi.fn()
    expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/super-journal/)
    expect(read).not.toHaveBeenCalled()
    expect(contents(root)).toEqual(before)
  })

  it('rejects symbolic-link rollback journals before opening SQLite', () => {
    const { root, path } = fixture()
    createRollback(path)
    const journal = `${path}-journal`
    const target = join(root, 'original-journal')
    renameSync(journal, target)
    symlinkSync(target, journal)
    const before = contents(root)
    expect(() => withReadOnlySqliteSnapshot(path, vi.fn())).toThrow(/regular|symbolic/i)
    expect(contents(root)).toEqual(before)
  })

  it('cleans up its snapshot when the consumer throws', () => {
    const { root, path } = fixture()
    const source = new DatabaseSync(path)
    source.exec('CREATE TABLE secrets(value TEXT)')
    source.close()
    const before = contents(root)
    let snapshot = ''
    expect(() =>
      withReadOnlySqliteSnapshot(path, (db) => {
        snapshot = String(db.prepare('PRAGMA database_list').get()?.file)
        throw new Error('consumer failure')
      })
    ).toThrow('consumer failure')
    expect(contents(root)).toEqual(before)
    expect(existsSync(dirname(snapshot))).toBe(false)
  })

  it.each([
    'replace-main',
    'change-main',
    'change-main-same-size',
    'add-wal',
    'remove-wal',
    'replace-wal',
    'change-wal'
  ])('blocks source changes during copying: %s', (mutation) => {
    const { path } = fixture()
    createWal(path)
    if (mutation === 'add-wal') unlinkSync(`${path}-wal`)
    const original = readFileSync(path)
    hooks.afterRead = () => {
      if (mutation === 'replace-main') {
        renameSync(path, `${path}.old`)
        writeFileSync(path, original)
      } else if (mutation === 'change-main') {
        writeFileSync(path, Buffer.concat([original, Buffer.from('changed')]))
      } else if (mutation === 'change-main-same-size') {
        const modified = Buffer.from(original)
        modified[modified.length - 1] ^= 1
        writeFileSync(path, modified)
      } else if (mutation === 'add-wal') {
        writeFileSync(`${path}-wal`, 'new-wal')
      } else if (mutation === 'remove-wal') {
        unlinkSync(`${path}-wal`)
      } else if (mutation === 'replace-wal') {
        const wal = readFileSync(`${path}-wal`)
        renameSync(`${path}-wal`, `${path}-wal.old`)
        writeFileSync(`${path}-wal`, wal)
      } else {
        const wal = readFileSync(`${path}-wal`)
        wal[wal.length - 1] ^= 1
        writeFileSync(`${path}-wal`, wal)
      }
    }
    const read = vi.fn()
    expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/changed|stable/i)
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a symbolic-link source before opening SQLite', () => {
    const { root, path } = fixture()
    const target = join(root, 'target.db')
    writeFileSync(target, 'must not be opened')
    symlinkSync(target, path)
    expect(() => withReadOnlySqliteSnapshot(path, vi.fn())).toThrow(/regular|symbolic/i)
    expect(readFileSync(target, 'utf8')).toBe('must not be opened')
  })

  it('rejects a symbolic-link WAL before opening SQLite', () => {
    const { root, path } = fixture()
    const source = new DatabaseSync(path)
    source.exec('CREATE TABLE secrets(value TEXT)')
    source.close()
    const target = join(root, 'target-wal')
    writeFileSync(target, 'must not be opened')
    symlinkSync(target, `${path}-wal`)
    expect(() => withReadOnlySqliteSnapshot(path, vi.fn())).toThrow(/regular|symbolic/i)
    expect(readFileSync(target, 'utf8')).toBe('must not be opened')
  })

  it.each([false, true])(
    'blocks a nonempty rollback journal (created during copying: %s)',
    (duringCopy) => {
      const { root, path } = fixture()
      const source = new DatabaseSync(path)
      source.exec('CREATE TABLE secrets(value TEXT)')
      source.close()
      const addJournal = (): void => writeFileSync(`${path}-journal`, 'pending-rollback')
      if (duringCopy) hooks.afterRead = addJournal
      else addJournal()
      const read = vi.fn()
      expect(() => withReadOnlySqliteSnapshot(path, read)).toThrow(/journal|recovery/i)
      expect(read).not.toHaveBeenCalled()
      expect(readFileSync(join(root, 'source.db-journal'), 'utf8')).toBe('pending-rollback')
    }
  )
})
