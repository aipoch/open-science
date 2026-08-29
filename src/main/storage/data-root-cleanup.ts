import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { RELOCATABLE_DATA_DIRS } from './data-directories'
import { capturePortableMetadata, restorePortableMetadata } from './data-migration'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from './durable-json-file'
import {
  readMigrationMarker,
  removeMigrationMarker,
  scanInventory,
  type MigrationMarker
} from './migration-marker'
import { defaultFileDurability } from './file-durability'

const DATA_ROOT_CLEANUP_FILENAME = 'data-root-cleanup.json'
const CLEANUP_JOURNAL_VERSION = 1 as const
const ALLOWED_CLEANUP_DIRS = new Set([
  ...RELOCATABLE_DATA_DIRS,
  'runtime',
  join('runtime', 'pkgs'),
  join('runtime', 'provenance', 'environment-manifests')
])

type CleanupInventory = Awaited<ReturnType<typeof scanInventory>>
type CleanupEntrySnapshot =
  | Readonly<{ dir: string; present: false }>
  | Readonly<{
      dir: string
      present: true
      dev: string
      ino: string
      birthtimeNs: string
      inventory: CleanupInventory
    }>

type DataRootCleanupIntent = Readonly<{
  token: string
  source: string
  target: string
  entries: CleanupEntrySnapshot[]
  createdAt: number
  committed: boolean
}>

type DataRootCleanupJournalFile = Readonly<{
  version: typeof CLEANUP_JOURNAL_VERSION
  intents: DataRootCleanupIntent[]
}>

type StageDataRootCleanupIntent = Readonly<{
  token: string
  source: string
  target: string
  dirs: string[]
  createdAt: number
}>
type DeleteSources = (
  source: string,
  dirs: string[]
) => Promise<{ deleted: string[]; failed: { dir: string; error: string }[] }>
type CleanupRecoveryResult = Readonly<{ pending: boolean; failureCount: number }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isInventory = (value: unknown): value is CleanupInventory => {
  if (!isRecord(value)) return false
  return (
    Array.isArray(value.dirs) &&
    value.dirs.every((dir) => typeof dir === 'string' && ALLOWED_CLEANUP_DIRS.has(dir)) &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) >= 0 &&
    Number.isSafeInteger(value.totalBytes) &&
    (value.totalBytes as number) >= 0 &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest)
  )
}

const decodeEntrySnapshot = (value: unknown): CleanupEntrySnapshot => {
  if (
    !isRecord(value) ||
    typeof value.dir !== 'string' ||
    !ALLOWED_CLEANUP_DIRS.has(value.dir) ||
    typeof value.present !== 'boolean'
  ) {
    throw new Error('Invalid data-root cleanup entry snapshot.')
  }
  if (!value.present) return { dir: value.dir, present: false }
  if (
    typeof value.dev !== 'string' ||
    !/^\d+$/.test(value.dev) ||
    typeof value.ino !== 'string' ||
    !/^\d+$/.test(value.ino) ||
    typeof value.birthtimeNs !== 'string' ||
    !/^\d+$/.test(value.birthtimeNs) ||
    !isInventory(value.inventory)
  ) {
    throw new Error('Invalid data-root cleanup entry snapshot.')
  }
  return {
    dir: value.dir,
    present: true,
    dev: value.dev,
    ino: value.ino,
    birthtimeNs: value.birthtimeNs,
    inventory: {
      dirs: [...value.inventory.dirs],
      fileCount: value.inventory.fileCount,
      totalBytes: value.inventory.totalBytes,
      digest: value.inventory.digest
    }
  }
}

const decodeCleanupIntent = (value: unknown): DataRootCleanupIntent => {
  if (!isRecord(value)) throw new Error('Invalid data-root cleanup intent.')
  if (
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    typeof value.source !== 'string' ||
    !isAbsolute(value.source) ||
    typeof value.target !== 'string' ||
    !isAbsolute(value.target) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.committed !== 'boolean'
  ) {
    throw new Error('Invalid data-root cleanup intent.')
  }
  const entries = value.entries.map(decodeEntrySnapshot)
  if (new Set(entries.map(({ dir }) => dir)).size !== entries.length) {
    throw new Error('Invalid data-root cleanup intent.')
  }
  return {
    token: value.token,
    source: resolve(value.source),
    target: resolve(value.target),
    entries,
    createdAt: value.createdAt,
    committed: value.committed
  }
}

const decodeCleanupJournal = (contents: string): DataRootCleanupJournalFile => {
  const value = JSON.parse(contents) as unknown
  if (!isRecord(value)) throw new Error('Invalid data-root cleanup journal.')
  if (value.version !== CLEANUP_JOURNAL_VERSION) {
    throw new DurableJsonRecoveryBarrierError('Unsupported data-root cleanup journal version.')
  }
  if (!Array.isArray(value.intents) || value.intents.length === 0) {
    throw new Error('Invalid data-root cleanup journal.')
  }
  const intents = value.intents.map(decodeCleanupIntent)
  if (new Set(intents.map(({ token }) => token)).size !== intents.length) {
    throw new Error('Invalid data-root cleanup journal.')
  }
  return { version: CLEANUP_JOURNAL_VERSION, intents }
}

const isPathInsideOrEqual = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

const sameInventory = (left: CleanupInventory, right: CleanupInventory): boolean =>
  left.fileCount === right.fileCount &&
  left.totalBytes === right.totalBytes &&
  left.digest === right.digest &&
  left.dirs.length === right.dirs.length &&
  left.dirs.every((dir, index) => dir === right.dirs[index])

const missingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const captureEntrySnapshot = async (source: string, dir: string): Promise<CleanupEntrySnapshot> => {
  let stats
  try {
    stats = await lstat(join(source, dir), { bigint: true })
  } catch (error) {
    if (missingPathError(error)) return { dir, present: false }
    throw error
  }
  return {
    dir,
    present: true,
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
    inventory: await scanInventory(source, [dir])
  }
}

const markerAllowsCleanup = (marker: MigrationMarker, intent: DataRootCleanupIntent): boolean => {
  const markerDirs = new Set(marker.migratedDirs ?? RELOCATABLE_DATA_DIRS)
  const runtimeCleanupAllowed =
    markerDirs.has(join('runtime', 'pkgs')) &&
    markerDirs.has(join('runtime', 'provenance', 'environment-manifests'))
  return intent.entries.every(
    ({ dir }) =>
      (dir !== 'runtime' && markerDirs.has(dir)) || (dir === 'runtime' && runtimeCleanupAllowed)
  )
}

class DataRootCleanupJournal {
  private readonly filePath: string

  constructor(configRoot: string) {
    this.filePath = join(configRoot, DATA_ROOT_CLEANUP_FILENAME)
  }

  private async read(): Promise<DataRootCleanupJournalFile | undefined> {
    const result = await readDurableJsonFile(this.filePath, decodeCleanupJournal)
    return result.status === 'found' ? result.value : undefined
  }

  private async write(intents: DataRootCleanupIntent[]): Promise<void> {
    if (intents.length === 0) {
      await rm(this.filePath, { force: true })
      await defaultFileDurability.syncDirectory(dirname(this.filePath))
      return
    }
    const journal: DataRootCleanupJournalFile = {
      version: CLEANUP_JOURNAL_VERSION,
      intents
    }
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(journal, null, 2)}\n`)
  }

  async stage(input: StageDataRootCleanupIntent): Promise<void> {
    if (
      input.dirs.length === 0 ||
      new Set(input.dirs).size !== input.dirs.length ||
      !input.dirs.every((dir) => ALLOWED_CLEANUP_DIRS.has(dir))
    ) {
      throw new Error('Refused unsafe data-root cleanup paths.')
    }
    const [source, target] = await Promise.all([realpath(input.source), realpath(input.target)])
    const canonicalSource = resolve(source)
    const canonicalTarget = resolve(target)
    if (
      isPathInsideOrEqual(canonicalSource, canonicalTarget) ||
      isPathInsideOrEqual(canonicalTarget, canonicalSource)
    ) {
      throw new Error('Refused overlapping data-root cleanup paths.')
    }
    const sourceMetadata = await capturePortableMetadata(canonicalSource, input.dirs)
    let entries: CleanupEntrySnapshot[]
    try {
      entries = await Promise.all(
        input.dirs.map((dir) => captureEntrySnapshot(canonicalSource, dir))
      )
    } finally {
      await restorePortableMetadata(canonicalSource, sourceMetadata)
    }
    const existing = (await this.read())?.intents ?? []
    if (existing.some(({ token }) => token === input.token)) {
      throw new Error('Duplicate data-root cleanup token.')
    }
    await this.write([
      ...existing,
      {
        token: input.token,
        source: canonicalSource,
        target: canonicalTarget,
        entries,
        createdAt: input.createdAt,
        committed: false
      }
    ])
  }

  async markCommitted(expectedToken: string): Promise<void> {
    const journal = await this.read()
    if (!journal) throw new Error('Data-root cleanup intent is missing.')
    let found = false
    const intents = journal.intents.map((intent) => {
      if (intent.token !== expectedToken) return intent
      found = true
      return { ...intent, committed: true }
    })
    if (!found) throw new Error('Data-root cleanup intent is missing.')
    await this.write(intents)
  }

  async clear(expectedToken?: string): Promise<void> {
    if (!expectedToken) {
      await this.write([])
      return
    }
    const journal = await this.read()
    if (!journal) return
    await this.write(journal.intents.filter(({ token }) => token !== expectedToken))
  }

  async hasPending(): Promise<boolean> {
    try {
      return ((await this.read())?.intents.length ?? 0) > 0
    } catch {
      return true
    }
  }

  private async prepareCommittedIntent(
    intent: DataRootCleanupIntent,
    currentDataRoot: string
  ): Promise<DataRootCleanupIntent | undefined> {
    if (intent.committed) return intent
    let current: string
    let source: string
    let target: string
    try {
      ;[current, source, target] = await Promise.all([
        realpath(currentDataRoot).then(resolve),
        realpath(intent.source).then(resolve),
        realpath(intent.target).then(resolve)
      ])
    } catch {
      return undefined
    }
    if (samePath(current, source)) {
      await this.clear(intent.token)
      return undefined
    }
    if (
      !samePath(current, target) ||
      !samePath(source, intent.source) ||
      !samePath(target, intent.target) ||
      isPathInsideOrEqual(source, target) ||
      isPathInsideOrEqual(target, source)
    ) {
      return undefined
    }

    const marker = await readMigrationMarker(target)
    if (
      !marker ||
      marker.status !== 'verified' ||
      marker.token !== intent.token ||
      !markerAllowsCleanup(marker, intent)
    ) {
      return undefined
    }
    let markerSource: string
    let markerTarget: string
    try {
      ;[markerSource, markerTarget] = await Promise.all([
        realpath(marker.source).then(resolve),
        realpath(marker.target).then(resolve)
      ])
    } catch {
      return undefined
    }
    if (!samePath(markerSource, source) || !samePath(markerTarget, target)) return undefined

    await this.markCommitted(intent.token)
    return { ...intent, committed: true }
  }

  private async recoverIntent(
    intent: DataRootCleanupIntent,
    currentDataRoot: string,
    deleteSources: DeleteSources
  ): Promise<number> {
    const committedIntent = await this.prepareCommittedIntent(intent, currentDataRoot)
    if (!committedIntent) return 0

    let source: string
    try {
      source = resolve(await realpath(committedIntent.source))
    } catch {
      return 0
    }
    if (!samePath(source, committedIntent.source)) return 0

    const dirsToDelete: string[] = []
    for (const expected of committedIntent.entries) {
      let actual: CleanupEntrySnapshot
      try {
        actual = await captureEntrySnapshot(source, expected.dir)
      } catch {
        return 0
      }
      if (!actual.present) continue
      if (
        !expected.present ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        actual.birthtimeNs !== expected.birthtimeNs ||
        !sameInventory(actual.inventory, expected.inventory)
      ) {
        return 0
      }
      dirsToDelete.push(expected.dir)
    }

    if (dirsToDelete.length > 0) {
      let result: Awaited<ReturnType<DeleteSources>>
      try {
        result = await deleteSources(source, dirsToDelete)
      } catch {
        return 1
      }
      if (result.failed.length > 0) return result.failed.length
    }

    try {
      await this.clear(committedIntent.token)
      await removeMigrationMarker(committedIntent.target).catch(() => undefined)
      return 0
    } catch {
      return 1
    }
  }

  async recover(
    currentDataRoot: string,
    deleteSources: DeleteSources
  ): Promise<CleanupRecoveryResult> {
    let journal: DataRootCleanupJournalFile | undefined
    try {
      journal = await this.read()
    } catch {
      return { pending: true, failureCount: 0 }
    }
    if (!journal) return { pending: false, failureCount: 0 }

    let failureCount = 0
    for (const intent of journal.intents) {
      failureCount += await this.recoverIntent(intent, currentDataRoot, deleteSources)
    }
    return { pending: await this.hasPending(), failureCount }
  }
}

export { DATA_ROOT_CLEANUP_FILENAME, DataRootCleanupJournal }
export type { CleanupRecoveryResult, DeleteSources, StageDataRootCleanupIntent }
