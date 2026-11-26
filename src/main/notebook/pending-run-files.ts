import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  defaultFileDurability,
  isDurableJsonTemporaryFileName,
  isRecoverableDurableJsonTemporaryFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import { isNotebookRunReference, type StoredNotebookRun } from './run-record-reference'

export const PENDING_RUN_DIRECTORY = '.pending-runs'
export const PENDING_RUN_LIMIT = 16
export const PENDING_RUN_BYTES = 64 * 1024
export const PENDING_REFERENCE_BYTES = PENDING_RUN_LIMIT * PENDING_RUN_BYTES
export type PendingRunScope = { projectId: string; sessionId: string; frameId: string | null }
export class CorruptPendingRunError extends Error {}

type Entry = PendingRunScope & { slot: number; updatedAt: number; run: StoredNotebookRun }

// Some volumes expose coarse directory timestamps. Readers in the single writer process also
// observe every acknowledged replacement, even if two renames share a timestamp.
const publications = new Map<string, number>()
let revision = 0

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function pendingDirectoryIdentity(manifest: string): Promise<string | undefined> {
  const info = await lstat(join(dirname(manifest), PENDING_RUN_DIRECTORY), { bigint: true }).catch(
    (error) => {
      if (missing(error)) return undefined
      throw error
    }
  )
  if (!info) return undefined
  if (!info.isDirectory())
    throw new CorruptPendingRunError('Invalid Notebook pending Run directory.')
  return [info.dev, info.ino, info.mtimeNs, info.ctimeNs, publications.get(manifest) ?? 0].join('/')
}

async function entries(
  directory: string,
  publishedOnly = false
): Promise<{ slots: number[]; names: string[] }> {
  const names = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (missing(error)) return []
    throw error
  })
  const found = new Set<number>()
  for (const file of names) {
    const match = /^(0|[1-9]\d{0,9})\.json(?:\..+\.tmp)?$/u.exec(file.name)
    if (!file.isFile() || !match)
      throw new CorruptPendingRunError('Invalid Notebook pending Run file.')
    if (file.name.endsWith('.tmp')) {
      const target = join(directory, match[1] + '.json')
      if (!isDurableJsonTemporaryFileName(target, file.name))
        throw new CorruptPendingRunError('Invalid Notebook pending Run file.')
      if (isRecoverableDurableJsonTemporaryFile(target, file.name)) {
        // A completed writer cannot have published a temporary file above the slot budget.
        const info = await lstat(join(directory, file.name)).catch((error) => {
          if (!missing(error)) throw error
        })
        if (info && info.size > PENDING_RUN_BYTES)
          throw new CorruptPendingRunError('Invalid Notebook pending Run file.')
      } else if (!publishedOnly) {
        throw new CorruptPendingRunError('Notebook pending Run writer is still active.')
      }
      if (publishedOnly) continue
    }
    found.add(Number(match[1]))
  }
  if (found.size > PENDING_RUN_LIMIT)
    throw new CorruptPendingRunError('Notebook pending Run limit exceeded.')
  return { slots: Array.from(found).sort((a, b) => a - b), names: names.map((entry) => entry.name) }
}

function decode(
  contents: string,
  slot: number,
  scope: PendingRunScope,
  validate: (run: unknown) => boolean
): Entry {
  let row: Entry
  try {
    row = JSON.parse(contents) as Entry
  } catch {
    throw new CorruptPendingRunError('Invalid Notebook pending Run JSON.')
  }
  if (
    !row ||
    row.slot !== slot ||
    row.projectId !== scope.projectId ||
    row.sessionId !== scope.sessionId ||
    row.frameId !== scope.frameId ||
    !Number.isFinite(row.updatedAt) ||
    !row.run ||
    (typeof row.run === 'object' && 'storage' in row.run && row.run.storage === 'file'
      ? !isNotebookRunReference(row.run)
      : !validate(row.run)) ||
    typeof row.run.runId !== 'string'
  )
    throw new CorruptPendingRunError('Invalid Notebook pending Run.')
  return row
}

export async function assertPendingRunsCheckpointable(manifest: string): Promise<void> {
  const { names } = await entries(join(dirname(manifest), PENDING_RUN_DIRECTORY))
  if (names.some((name) => name.endsWith('.tmp')))
    throw new CorruptPendingRunError('Notebook pending Run requires recovery before checkpoint.')
}

// Only the recovery owner may publish a surviving temporary file. Diagnostics and exports
// can read in other processes while the writer is still syncing its temporary file.
export async function recoverPendingRuns(
  manifest: string,
  scope: PendingRunScope,
  validate: (run: unknown) => boolean
): Promise<void> {
  if (!(await pendingDirectoryIdentity(manifest))) return
  const directory = join(dirname(manifest), PENDING_RUN_DIRECTORY)
  await entries(directory)
  await recoverDurableJsonDirectory(
    directory,
    (target, contents) => decode(contents, Number(basename(target, '.json')), scope, validate),
    {},
    { maxBytes: PENDING_RUN_BYTES }
  )
}

async function readPendingFile(file: string, limit: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new CorruptPendingRunError('Invalid Notebook pending Run file.')
    // Atomic publication gives each reader one immutable inode. Bound even a changed file.
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null)
      if (!bytesRead) break
      bytes += bytesRead
    }
    if (bytes !== info.size)
      throw new CorruptPendingRunError('Notebook pending Run changed during read.')
    return buffer.toString('utf8', 0, bytes)
  } finally {
    await handle.close()
  }
}

export async function mergePendingRuns<T extends { runId: string }>(
  manifest: string,
  scope: PendingRunScope,
  runs: (T | StoredNotebookRun)[],
  validate: (run: unknown) => boolean,
  budget?: number
): Promise<{ updatedAt: number; checkpointed: boolean }> {
  if (!(await pendingDirectoryIdentity(manifest))) return { updatedAt: 0, checkpointed: false }
  const directory = join(dirname(manifest), PENDING_RUN_DIRECTORY)
  const { slots: ids } = await entries(directory, true)
  let checkpointed = false
  let updatedAt = 0
  let slotBudget = PENDING_RUN_BYTES * PENDING_RUN_LIMIT
  let referenceBudget = PENDING_REFERENCE_BYTES
  for (const slot of ids) {
    const file = join(directory, slot + '.json')
    const contents = await readPendingFile(
      file,
      Math.min(slotBudget, budget ?? Infinity, PENDING_RUN_BYTES)
    ).catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (contents === undefined) continue
    const row = decode(contents, slot, scope, validate)
    const bytes = Buffer.byteLength(contents)
    slotBudget -= bytes
    if (budget !== undefined) budget -= bytes
    // A durable checkpoint may be followed by a crash before its hot files are unlinked.
    if (slot < runs.length) {
      if (runs[slot].runId !== row.run.runId)
        throw new CorruptPendingRunError('Conflicting Notebook pending Run.')
      checkpointed = true
      continue
    }
    if (slot !== runs.length || runs.some((r) => r.runId === row.run.runId))
      throw new CorruptPendingRunError('Invalid Notebook pending Run position.')
    if (isNotebookRunReference(row.run)) {
      referenceBudget -= row.run.bytes
      if (budget !== undefined) budget -= row.run.bytes
      if (referenceBudget < 0 || (budget !== undefined && budget < 0))
        throw new CorruptPendingRunError('Notebook pending Run body exceeds read budget.')
    }
    runs.push(row.run)
    updatedAt = Math.max(updatedAt, row.updatedAt)
  }
  return { updatedAt, checkpointed }
}

export async function publishPendingRun(manifest: string, entry: Entry): Promise<boolean> {
  const text = JSON.stringify(entry)
  if (Buffer.byteLength(text) > PENDING_RUN_BYTES) return false
  const parent = dirname(manifest),
    directory = join(parent, PENDING_RUN_DIRECTORY)
  if (!(await pendingDirectoryIdentity(manifest))) {
    await mkdir(directory, { recursive: true })
    await defaultFileDurability.syncDirectory(parent)
  }
  await writeDurableJsonFile(join(directory, entry.slot + '.json'), text)
  publications.set(manifest, ++revision)
  return true
}

// Called by the sole writer after the complete manifest and its directory are durable.
export async function clearPendingRuns(manifest: string): Promise<void> {
  if (!(await pendingDirectoryIdentity(manifest))) return
  const directory = join(dirname(manifest), PENDING_RUN_DIRECTORY)
  const { names } = await entries(directory)
  for (const name of names) await unlink(join(directory, name))
  await defaultFileDurability.syncDirectory(directory)
  await rmdir(directory)
  publications.delete(manifest)
  await defaultFileDurability.syncDirectory(dirname(manifest))
}
