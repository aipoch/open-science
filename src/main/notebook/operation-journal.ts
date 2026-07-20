import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The journal file for a runtime root (<storageRoot>/runtime). Derived from the root so the write side
// (provisioner/fetch) and the startup recovery side agree on one path without sharing an instance.
export const operationJournalPath = (runtimeRoot: string): string =>
  join(runtimeRoot, 'operation-journal.json')

// One in-flight, crash-recoverable runtime operation. Persisted BEFORE the operation runs (write
// intent) and removed only after it commits, so a process that dies mid-operation leaves a record the
// next startup can reconcile (redownload/verify/repair). See notebook-runtime-crash-recovery.
export type RuntimeOperationKind = 'download' | 'materialize' | 'upgrade' | 'install' | 'disable'

export type RuntimeOperationRecord = {
  operationId: string
  kind: RuntimeOperationKind
  // The runtime the operation targets (env id / pack id). Used to reject a second concurrent op on the
  // same runtime and to scope recovery.
  runtimeId: string
  sessionId?: string
  phase: string
  startedAt: number
  // Staging/prefix the op writes into, so recovery can clean a partial ".incoming-*" or verify a prefix.
  targetPath?: string
  // The OS pid of the child (micromamba/pip/R) doing the work + when it started, so recovery can
  // confirm the recorded process is still the ORIGINAL op process (not a pid reused after a crash)
  // before cleaning staging / verifying / retrying.
  childPid?: number
  childStartedAt?: number
}

// Durable, crash-recoverable journal of in-flight runtime operations for one app storage root. Writes
// are atomic (temp file + rename) and serialized through a save queue so concurrent begins/completions
// can never race a torn file; a missing or corrupt journal reads as empty (best-effort). The consumer
// persists intent with begin() BEFORE performing an operation and calls complete() only after it has
// committed, so pending() on the next startup is exactly the set of operations that were interrupted.
export class RuntimeOperationJournal {
  private saveQueue: Promise<void> = Promise.resolve()
  private saveSequence = 0

  // journalPath: absolute path to the journal file (e.g. <runtimeRoot>/operation-journal.json).
  constructor(private readonly journalPath: string) {}

  // The operations currently recorded as in-flight (empty when the journal is missing or corrupt).
  async pending(): Promise<RuntimeOperationRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.journalPath, 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed.filter(isOperationRecord) : []
    } catch {
      return []
    }
  }

  // Whether an operation for this runtime is already in flight — the concurrency guard so no two
  // operations ever touch the same runtime at once.
  async hasRuntimeOperation(runtimeId: string): Promise<boolean> {
    return (await this.pending()).some((record) => record.runtimeId === runtimeId)
  }

  // Records the intent to run an operation, written BEFORE the operation performs anything. Replacing
  // an existing record with the same operationId is idempotent (e.g. re-begin after a phase change).
  async begin(record: RuntimeOperationRecord): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.pending()
      await this.write([
        ...current.filter((entry) => entry.operationId !== record.operationId),
        record
      ])
    })
  }

  // Updates progress (phase / childPid / …) for an existing operation without changing its identity.
  // A no-op when the operationId is not present (already completed, or never began).
  async update(operationId: string, patch: Partial<RuntimeOperationRecord>): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.pending()
      if (!current.some((entry) => entry.operationId === operationId)) return
      await this.write(
        current.map((entry) =>
          entry.operationId === operationId ? { ...entry, ...patch, operationId } : entry
        )
      )
    })
  }

  // Removes an operation once it has COMMITTED (cleared from the journal). Idempotent; deletes the
  // journal file entirely once the last operation clears, so an absent file means "nothing in flight".
  async complete(operationId: string): Promise<void> {
    await this.enqueue(async () => {
      const current = await this.pending()
      const next = current.filter((entry) => entry.operationId !== operationId)
      if (next.length === current.length) return
      if (next.length === 0) await rm(this.journalPath, { force: true })
      else await this.write(next)
    })
  }

  private async write(records: RuntimeOperationRecord[]): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true })
    this.saveSequence += 1
    const temporaryPath = `${this.journalPath}.${Date.now()}-${this.saveSequence}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.journalPath)
  }

  // Serializes every mutation through one chain so overlapping begins/updates/completions can't race a
  // stale read against another writer's rename. Keeps the chain moving even if a turn throws.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.saveQueue.then(operation)
    this.saveQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

const isOperationRecord = (value: unknown): value is RuntimeOperationRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.operationId === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.runtimeId === 'string' &&
    typeof record.phase === 'string' &&
    typeof record.startedAt === 'number'
  )
}
