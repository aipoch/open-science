import { mkdirSync, realpathSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// This database has no application tables. Its exclusive transaction is a kernel-backed,
// process-lifetime lock, shared by Node and Electron. Never unlink or replace the file: doing
// so would let another writer lock a different inode while this process still owns the old one.
export const RUNTIME_LOCK_FILE = '.open-science-runtime.sqlite'

export class RuntimeOwnershipConflict extends Error {
  constructor(
    readonly directory: string,
    options?: ErrorOptions
  ) {
    super(`Open-Science is already using this directory: ${directory}`, options)
    this.name = 'RuntimeOwnershipConflict'
  }
}

export type RuntimeDirectoryLease = Readonly<{
  directory: string
  release(): void
}>

export function acquireRuntimeDirectorySync(directory: string): RuntimeDirectoryLease {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = realpathSync(directory)
  const path = join(canonical, RUNTIME_LOCK_FILE)
  try {
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw new Error(`Unsafe runtime lock file: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let database: DatabaseSync
  for (let attempt = 0; ; attempt++) {
    database = new DatabaseSync(path)
    try {
      database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE')
      break
    } catch (error) {
      database.close()
      const code = (error as { errcode?: number }).errcode
      if (code !== 5 && code !== 6) throw error
      // Simultaneous first opens can both hold SQLite's transient shared lock while upgrading.
      // Drop our handle before bounded jittered retries so a winner can establish ownership.
      // Stay synchronous: Electron must bind its credential identity before the ready event.
      if (attempt < 6) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 30)
        continue
      }
      throw new RuntimeOwnershipConflict(canonical, { cause: error })
    }
  }
  let released = false
  return {
    directory: canonical,
    release() {
      if (released) return
      released = true
      database.close()
    }
  }
}

export async function acquireRuntimeDirectory(directory: string): Promise<RuntimeDirectoryLease> {
  return acquireRuntimeDirectorySync(directory)
}

// Config ownership precedes bootstrap writes; data ownership is added after read-only location
// selection. Keep both leases through shutdown and retain source leases during data-root handoff.
export class RuntimeDirectoryOwnership {
  private readonly leases = new Map<string, RuntimeDirectoryLease>()
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  acquireSync(directory: string): void {
    if (this.closed) throw new Error('Runtime directory ownership is closed.')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const canonical = realpathSync(directory)
    if (!this.leases.has(canonical))
      this.leases.set(canonical, acquireRuntimeDirectorySync(canonical))
  }

  acquire(directory: string): Promise<void> {
    const operation = this.tail.then(() => this.acquireSync(directory))
    this.tail = operation.catch(() => undefined)
    return operation
  }

  async close(): Promise<void> {
    this.closed = true
    await this.tail
    for (const lease of [...this.leases.values()].reverse()) lease.release()
    this.leases.clear()
  }

  // Tests that synchronously rewrite an owned directory need the lease dropped inline: Windows
  // denies deleting a tree while the runtime lock file inside it stays open. Call only when the
  // acquire queue has settled; production teardown uses close().
  closeSync(): void {
    this.closed = true
    for (const lease of [...this.leases.values()].reverse()) lease.release()
    this.leases.clear()
  }
}

type RuntimeDirectoryOwner = Pick<RuntimeDirectoryOwnership, 'acquireSync' | 'acquire'>
let runtimeOwnership: RuntimeDirectoryOwner | undefined
export function configureRuntimeDirectoryOwnership(ownership: RuntimeDirectoryOwner): void {
  if (runtimeOwnership) throw new Error('Runtime directory ownership is already configured.')
  runtimeOwnership = ownership
}
export async function ownRuntimeDataDirectory(directory: string): Promise<void> {
  if (!runtimeOwnership)
    throw new Error('Runtime directory ownership must be configured by the host entry.')
  await runtimeOwnership.acquire(directory)
}

export function ownRuntimeDataDirectorySync(directory: string): void {
  if (!runtimeOwnership)
    throw new Error('Runtime directory ownership must be configured by the host entry.')
  runtimeOwnership.acquireSync(directory)
}
