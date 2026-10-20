import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
  type BigIntStats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

type SourceFile = { path: string; descriptor: number; initial: BigIntStats }

const sameFileState = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const sourceState = (path: string): BigIntStats | undefined =>
  lstatSync(path, { bigint: true, throwIfNoEntry: false })

// Return whether the private copy needs recovery; completed journals remain valid snapshot inputs.
const validateRollback = (source: SourceFile): boolean => {
  if (source.initial.size === 0n) return false
  const magic = 'd9d505f920a163d7'
  const header = Buffer.alloc(28)
  const trailer = Buffer.alloc(8)
  if (readSync(source.descriptor, header, 0, header.length, 0) !== header.length)
    throw new Error('SQLite rollback journal header cannot be read safely')
  // SQLite's PERSIST commit zeros all 28 header bytes instead of deleting the journal.
  // Require the whole cleared header, not just missing magic, before accepting it as inactive.
  // https://www.sqlite.org/lockingv3.html#writing_to_a_database_file
  if (header.every((byte) => byte === 0)) return false
  if (source.initial.size <= 512n || header.subarray(0, 8).toString('hex') !== magic)
    throw new Error('SQLite rollback journal cannot be recovered safely')
  readSync(source.descriptor, trailer, 0, 8, Number(source.initial.size) - 8)
  // An attached-database super-journal can reference files outside the private copy.
  // Keep rejecting it: only SQLite's single-database rollback is safe to run here.
  if (trailer.toString('hex') === magic)
    throw new Error('SQLite super-journal requires recovery before inspection')
  return true
}

const openSource = (path: string): SourceFile | undefined => {
  const initial = sourceState(path)
  if (!initial) return undefined
  if (!initial.isFile()) throw new Error('SQLite snapshot source must be a regular file')
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFileState(initial, fstatSync(descriptor, { bigint: true }))) {
      throw new Error('SQLite snapshot source changed while opening')
    }
    return { path, descriptor, initial }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

const verifySource = (source: SourceFile): void => {
  const current = sourceState(source.path)
  if (
    !current ||
    !sameFileState(source.initial, current) ||
    !sameFileState(source.initial, fstatSync(source.descriptor, { bigint: true }))
  ) {
    throw new Error('SQLite snapshot source changed while copying')
  }
}

const copySource = (source: SourceFile, destination: string): void => {
  if (source.initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('SQLite snapshot source cannot be copied reliably')
  }
  const target = openSync(destination, 'wx', 0o600)
  try {
    fchmodSync(target, 0o600)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const size = Number(source.initial.size)
    for (let position = 0; position < size;) {
      const count = readSync(
        source.descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position
      )
      if (count === 0) throw new Error('SQLite snapshot source changed while copying')
      let written = 0
      while (written < count) {
        const next = writeSync(target, buffer, written, count - written, position + written)
        if (next === 0) throw new Error('SQLite snapshot copy could not complete')
        written += next
      }
      position += count
    }
  } finally {
    closeSync(target)
  }
}

// SQLite may create a WAL shared-memory file even for a read-only connection. Inspect only a
// private copy, retaining committed WAL records without ever opening the original in SQLite.
// A hot rollback journal is recovered by SQLite in that copy before read-only inspection.
export const withReadOnlySqliteSnapshot = (
  path: string,
  read: (database: DatabaseSync) => void
): void => {
  const main = openSource(path)
  if (!main) return
  const sources = [main]
  let temporary: string | undefined
  try {
    const journalPath = `${path}-journal`
    const journal = openSource(journalPath)
    let needsRecovery = false
    if (journal) {
      sources.push(journal)
      needsRecovery = validateRollback(journal)
    }
    const walPath = `${path}-wal`
    const wal = openSource(walPath)
    if (wal) sources.push(wal)
    if (wal?.initial.size && journal?.initial.size)
      throw new Error('SQLite has conflicting recovery journals')
    temporary = mkdtempSync(join(tmpdir(), 'credential-snapshot-'))
    chmodSync(temporary, 0o700)
    const snapshot = join(temporary, 'snapshot.db')
    copySource(main, snapshot)
    if (wal) copySource(wal, `${snapshot}-wal`)
    if (journal) copySource(journal, `${snapshot}-journal`)

    // File descriptors pin the copied objects; path checks also catch replacement or rename.
    // If WAL was absent initially, a newly created WAL invalidates the main-only snapshot.
    for (const source of sources) verifySource(source)
    if (!wal && sourceState(walPath)) throw new Error('SQLite WAL changed while copying')
    if (!journal && sourceState(journalPath))
      throw new Error('SQLite rollback journal changed while copying')

    const sqlite = process.getBuiltinModule('node:sqlite') as
      typeof import('node:sqlite') | undefined
    if (!sqlite) throw new Error('Read-only SQLite inspection is unavailable')
    if (needsRecovery) {
      const recovery = new sqlite.DatabaseSync(snapshot)
      try {
        // The first actual read makes SQLite roll back a hot journal. Never recover the source.
        recovery.prepare('SELECT count(*) FROM sqlite_master').get()
      } finally {
        recovery.close()
      }
    }
    const database = new sqlite.DatabaseSync(snapshot, { readOnly: true })
    try {
      database.exec('PRAGMA query_only = ON')
      read(database)
    } finally {
      database.close()
    }
  } finally {
    try {
      for (const source of sources) closeSync(source.descriptor)
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    }
  }
}
