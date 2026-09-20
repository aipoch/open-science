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

const rejectPendingRollback = (path: string): void => {
  const journal = sourceState(`${path}-journal`)
  // A main-only copy would discard recovery information and could expose uncommitted contents.
  if (journal && (!journal.isFile() || journal.size > 0n)) {
    throw new Error('SQLite rollback journal requires recovery before inspection')
  }
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
export const withReadOnlySqliteSnapshot = (
  path: string,
  read: (database: DatabaseSync) => void
): void => {
  const main = openSource(path)
  if (!main) return
  const sources = [main]
  let temporary: string | undefined
  try {
    rejectPendingRollback(path)
    const walPath = `${path}-wal`
    const wal = openSource(walPath)
    if (wal) sources.push(wal)
    temporary = mkdtempSync(join(tmpdir(), 'credential-snapshot-'))
    chmodSync(temporary, 0o700)
    const snapshot = join(temporary, 'snapshot.db')
    copySource(main, snapshot)
    if (wal) copySource(wal, `${snapshot}-wal`)

    // File descriptors pin the copied objects; path checks also catch replacement or rename.
    // If WAL was absent initially, a newly created WAL invalidates the main-only snapshot.
    for (const source of sources) verifySource(source)
    if (!wal && sourceState(walPath)) throw new Error('SQLite WAL changed while copying')
    rejectPendingRollback(path)

    const sqlite = process.getBuiltinModule('node:sqlite') as
      typeof import('node:sqlite') | undefined
    if (!sqlite) throw new Error('Read-only SQLite inspection is unavailable')
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
