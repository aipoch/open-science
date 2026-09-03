import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { capturePortableMetadata, restorePortableMetadata } from './data-migration'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from './durable-json-file'
import {
  MIGRATION_MARKER_FILENAME,
  readMigrationMarker,
  removeMigrationMarker,
  scanInventory
} from './migration-marker'
import { defaultFileDurability } from './file-durability'

const DATA_ROOT_CLEANUP_FILENAME = 'data-root-cleanup.json'
const CLEANUP_JOURNAL_VERSION = 1 as const
const ALLOWED_CLEANUP_DIRS = new Set([
  ...MIGRATABLE_DATA_DIRS,
  'runtime',
  join('runtime', 'pkgs'),
  join('runtime', '.repair-required.json'),
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
type CleanupRuntimeCache = (source: string) => Promise<boolean> | boolean
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

const migrationMarkerIsMissing = async (target: string): Promise<boolean> => {
  try {
    await lstat(join(target, MIGRATION_MARKER_FILENAME))
    return false
  } catch (error) {
    return missingPathError(error)
  }
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

const refreshEntryIdentity = async (
  source: string,
  entry: CleanupEntrySnapshot
): Promise<CleanupEntrySnapshot> => {
  if (!entry.present) return entry
  const stats = await lstat(join(source, entry.dir), { bigint: true })
  const dev = stats.dev.toString()
  const ino = stats.ino.toString()
  if (dev !== entry.dev || ino !== entry.ino) {
    throw new Error('Data-root cleanup source changed while staging.')
  }
  return { ...entry, dev, ino, birthtimeNs: stats.birthtimeNs.toString() }
}

const markerAllowsCleanup = (
  verifiedDirs: readonly string[],
  intent: DataRootCleanupIntent
): boolean => {
  const markerDirs = new Set(verifiedDirs)
  const runtimeCleanupAllowed =
    markerDirs.has(join('runtime', 'pkgs')) &&
    markerDirs.has(join('runtime', 'provenance', 'environment-manifests'))
  return intent.entries.every(
    ({ dir, present }) =>
      !present ||
      (dir !== 'runtime' && markerDirs.has(dir)) ||
      (dir === 'runtime' && runtimeCleanupAllowed)
  )
}

const canonicalizeCleanupSource = async (
  input: string
): Promise<{ path: string; present: boolean }> => {
  const resolvedInput = resolve(input)
  try {
    return { path: resolve(await realpath(resolvedInput)), present: true }
  } catch (error) {
    if (!missingPathError(error)) throw error
  }

  let ancestor = dirname(resolvedInput)
  while (true) {
    try {
      const canonicalAncestor = resolve(await realpath(ancestor))
      return {
        path: resolve(canonicalAncestor, relative(ancestor, resolvedInput)),
        present: false
      }
    } catch (error) {
      if (!missingPathError(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return { path: resolvedInput, present: false }
      ancestor = parent
    }
  }
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

  async stage(input: StageDataRootCleanupIntent): Promise<string[]> {
    if (
      input.dirs.length === 0 ||
      new Set(input.dirs).size !== input.dirs.length ||
      !input.dirs.every((dir) => ALLOWED_CLEANUP_DIRS.has(dir))
    ) {
      throw new Error('Refused unsafe data-root cleanup paths.')
    }
    const [source, target] = await Promise.all([
      canonicalizeCleanupSource(input.source),
      realpath(input.target)
    ])
    const canonicalSource = source.path
    const canonicalTarget = resolve(target)
    if (
      isPathInsideOrEqual(canonicalSource, canonicalTarget) ||
      isPathInsideOrEqual(canonicalTarget, canonicalSource)
    ) {
      throw new Error('Refused overlapping data-root cleanup paths.')
    }
    let entries: CleanupEntrySnapshot[]
    if (source.present) {
      const sourceMetadata = await capturePortableMetadata(canonicalSource, input.dirs)
      const entriesBeforeRestore = await (async () => {
        try {
          return await Promise.all(
            input.dirs.map((dir) => captureEntrySnapshot(canonicalSource, dir))
          )
        } finally {
          await restorePortableMetadata(canonicalSource, sourceMetadata)
        }
      })()
      // Restoring source timestamps can update birthtime on macOS. Bind the durable cleanup
      // receipt to the final on-disk identity, while refusing a source replacement during staging.
      entries = await Promise.all(
        entriesBeforeRestore.map((entry) => refreshEntryIdentity(canonicalSource, entry))
      )
    } else {
      entries = input.dirs.map((dir) => ({ dir, present: false }))
    }
    const existing = (await this.read())?.intents ?? []
    if (existing.some(({ token }) => token === input.token)) {
      throw new Error('Duplicate data-root cleanup token.')
    }
    if (existing.some((intent) => !intent.committed && samePath(intent.target, canonicalSource))) {
      throw new Error('An earlier data-root cleanup must be recovered before moving again.')
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
    return entries.filter(({ present }) => present).map(({ dir }) => dir)
  }

  async markCommitted(expectedToken: string): Promise<boolean> {
    const journal = await this.read()
    if (!journal) throw new Error('Data-root cleanup intent is missing.')
    let committedIntent: DataRootCleanupIntent | undefined
    const intents = journal.intents.map((intent) => {
      if (intent.token !== expectedToken) return intent
      committedIntent = { ...intent, committed: true }
      return committedIntent
    })
    if (!committedIntent) throw new Error('Data-root cleanup intent is missing.')
    await this.write(intents)
    const committedSource = committedIntent.source
    return intents.some(
      (intent) => intent.token !== expectedToken && samePath(intent.target, committedSource)
    )
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
    currentDataRoot: string,
    allowMissingMarker: boolean
  ): Promise<DataRootCleanupIntent | undefined> {
    let current: string
    let source: string
    try {
      const [canonicalCurrent, canonicalSource] = await Promise.all([
        canonicalizeCleanupSource(currentDataRoot),
        canonicalizeCleanupSource(intent.source)
      ])
      current = canonicalCurrent.path
      source = canonicalSource.path
    } catch {
      return undefined
    }
    if (samePath(current, source)) {
      if (!intent.committed) await this.clear(intent.token)
      return undefined
    }
    let target: string
    try {
      target = resolve(await realpath(intent.target))
    } catch {
      return undefined
    }
    if (
      (!intent.committed && !samePath(current, target)) ||
      !samePath(source, intent.source) ||
      !samePath(target, intent.target) ||
      isPathInsideOrEqual(source, target) ||
      isPathInsideOrEqual(target, source)
    ) {
      return undefined
    }

    const marker = await readMigrationMarker(target)
    if (!marker) {
      if (intent.committed && allowMissingMarker && (await migrationMarkerIsMissing(target))) {
        // Marker removal is the first half of cleanup completion. If clearing the journal then
        // fails or the process exits, the committed journal plus the live migration chain remains
        // sufficient authority to retry only the snapshotted source entries.
        return intent
      }
      return undefined
    }
    if (marker.status !== 'verified' || marker.token !== intent.token || !marker.inventory) {
      return undefined
    }
    if (!markerAllowsCleanup(marker.migratedDirs ?? marker.inventory.dirs, intent)) return undefined
    let markerSource: string
    let markerTarget: string
    try {
      const [canonicalMarkerSource, canonicalMarkerTarget] = await Promise.all([
        canonicalizeCleanupSource(marker.source),
        realpath(marker.target).then(resolve)
      ])
      markerSource = canonicalMarkerSource.path
      markerTarget = canonicalMarkerTarget
    } catch {
      return undefined
    }
    if (!samePath(markerSource, source) || !samePath(markerTarget, target)) return undefined

    let targetInventory: CleanupInventory
    try {
      targetInventory = await scanInventory(target, marker.migratedDirs ?? marker.inventory.dirs)
    } catch {
      return undefined
    }
    if (!sameInventory(marker.inventory, targetInventory)) return undefined

    if (!intent.committed) {
      await this.markCommitted(intent.token)
      return { ...intent, committed: true }
    }
    return intent
  }

  private async recoverIntent(
    intent: DataRootCleanupIntent,
    currentDataRoot: string,
    deleteSources: DeleteSources,
    cleanupRuntimeCache: CleanupRuntimeCache | undefined,
    allowMissingMarker: boolean
  ): Promise<number> {
    const committedIntent = await this.prepareCommittedIntent(
      intent,
      currentDataRoot,
      allowMissingMarker
    )
    if (!committedIntent) {
      if (!intent.committed) return 0
      for (const { dir } of intent.entries) {
        try {
          await lstat(join(intent.source, dir))
          return 0
        } catch (error) {
          if (!missingPathError(error)) return 0
        }
      }
      try {
        await this.clear(intent.token)
        return 0
      } catch {
        return 1
      }
    }

    let current: string
    let source: string
    let sourcePresent = false
    try {
      const [canonicalCurrent, canonicalSource] = await Promise.all([
        canonicalizeCleanupSource(currentDataRoot),
        canonicalizeCleanupSource(committedIntent.source)
      ])
      current = canonicalCurrent.path
      source = canonicalSource.path
      sourcePresent = canonicalSource.present
    } catch {
      return 0
    }
    if (samePath(current, source) || !samePath(source, committedIntent.source)) return 0
    if (!sourcePresent && committedIntent.entries.some(({ present }) => present)) {
      if (allowMissingMarker && (await migrationMarkerIsMissing(committedIntent.target))) {
        try {
          await this.clear(committedIntent.token)
        } catch {
          return 1
        }
      }
      return 0
    }

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

    if (cleanupRuntimeCache) {
      try {
        if (!(await cleanupRuntimeCache(source))) return 1
      } catch {
        return 1
      }
    }

    try {
      await removeMigrationMarker(committedIntent.target)
      await this.clear(committedIntent.token)
      return 0
    } catch {
      return 1
    }
  }

  async recover(
    currentDataRoot: string,
    deleteSources: DeleteSources,
    cleanupRuntimeCache?: CleanupRuntimeCache
  ): Promise<CleanupRecoveryResult> {
    let journal: DataRootCleanupJournalFile | undefined
    try {
      journal = await this.read()
    } catch {
      return { pending: true, failureCount: 0 }
    }
    if (!journal) return { pending: false, failureCount: 0 }

    let current: string
    try {
      current = (await canonicalizeCleanupSource(currentDataRoot)).path
    } catch {
      return { pending: true, failureCount: 0 }
    }

    // Follow target <- source links back from the live root. Only that chain can authorize source
    // deletion; an independent committed intent remains pending instead of deleting an unrelated
    // old root. A duplicated target or cycle is ambiguous and therefore fails closed.
    const cleanupChain: DataRootCleanupIntent[] = []
    const cleanupTokens = new Set<string>()
    let cursor = current
    while (true) {
      const candidates = journal.intents.filter(({ target }) => samePath(target, cursor))
      if (candidates.length === 0) break
      if (candidates.length > 1) return { pending: true, failureCount: 0 }
      const [candidate] = candidates
      if (cleanupTokens.has(candidate.token)) return { pending: true, failureCount: 0 }
      cleanupTokens.add(candidate.token)
      cleanupChain.unshift(candidate)
      cursor = candidate.source
    }

    // Failed switchovers never authorize deletion, but their uncommitted receipt can be retired
    // once the source is still the live root, even if the discarded staging target is gone.
    const abandoned = journal.intents.filter(
      ({ committed, source, token }) =>
        !committed && !cleanupTokens.has(token) && samePath(source, current)
    )

    let failureCount = 0
    for (const intent of [...cleanupChain, ...abandoned]) {
      let currentIntent: DataRootCleanupIntent | undefined
      let dependsOnPendingTarget = false
      try {
        const currentJournal = await this.read()
        currentIntent = currentJournal?.intents.find(({ token }) => token === intent.token)
        if (currentIntent) {
          const { source, token } = currentIntent
          dependsOnPendingTarget = Boolean(
            currentJournal?.intents.some(
              (candidate) => candidate.token !== token && samePath(candidate.target, source)
            )
          )
        }
      } catch {
        return { pending: true, failureCount }
      }
      if (!currentIntent || dependsOnPendingTarget) continue
      failureCount += await this.recoverIntent(
        currentIntent,
        currentDataRoot,
        deleteSources,
        cleanupRuntimeCache,
        cleanupTokens.has(currentIntent.token)
      )
    }
    return { pending: await this.hasPending(), failureCount }
  }
}

export { DATA_ROOT_CLEANUP_FILENAME, DataRootCleanupJournal }
export type {
  CleanupRecoveryResult,
  CleanupRuntimeCache,
  DeleteSources,
  StageDataRootCleanupIntent
}
