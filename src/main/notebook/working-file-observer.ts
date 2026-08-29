import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  NotebookFileEvidenceReason,
  NotebookRunFileEvidence,
  NotebookRunRecord,
  NotebookWorkingFile
} from '../../shared/notebook'
import {
  assertDiskReserve,
  copyOpenFileWithinBudget,
  digestFileWithinBudget
} from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS, ResourceBudgetExceededError } from '../resource-budget'
import { defaultFileDurability } from '../storage/file-durability'
import { writeDurableJsonFile } from '../storage/durable-json-file'
import { availableBytes } from '../storage/usage'

type WorkingFileObservationRequest = {
  dataRoot: string
  notebookSessionRoot: string
  runId?: string
  signal?: AbortSignal
}

type WorkingFileObservationResult = {
  workingFiles: NotebookWorkingFile[]
  fileEvidence: NotebookRunFileEvidence
}

type WorkingFileObservation = {
  finish: (signal?: AbortSignal) => Promise<WorkingFileObservationResult>
}

type WorkingFileObservationDependencies = {
  watchDirectory?: typeof watch
  createId?: () => string
  now?: () => number
  maxGenerationBytes?: number
  maxRunBytes?: number
  diskReserveBytes?: number
  getAvailableBytes?: typeof availableBytes
  writeEvidenceFile?: typeof writeDurableJsonFile
  publishDirectory?: typeof rename
  syncFile?: typeof defaultFileDurability.syncFile
  syncDirectory?: typeof defaultFileDurability.syncDirectory
}

type ActiveObservation = { conflicted: boolean }
type SnapshotEntry = NotebookWorkingFile & {
  physicalPath: string
  dev: number
  ino: number
  ctimeMs: number
}
type SnapshotCapture =
  | { state: 'available'; files: Map<string, SnapshotEntry> }
  | { state: 'unavailable'; reason: NotebookFileEvidenceReason }
type ObservedFileChange = {
  relation: 'created' | 'modified' | 'deleted'
  relativePath: string
  before?: SnapshotEntry
  after?: SnapshotEntry
}
type RootObservationResult = {
  changes: ObservedFileChange[]
  reasonCodes: NotebookFileEvidenceReason[]
  available: boolean
}
type RootObservation = { finish: () => Promise<RootObservationResult> }
type PersistedFileGeneration = {
  generationId: string
  relativePath: string
  checksum: string
  sizeBytes: number
  contentStorageKey: string
  capturedAt: string
}
type PersistedFileRelation = {
  relation: ObservedFileChange['relation']
  relativePath: string
  pathPortability: 'relative'
  authority: 'advisory'
  before?: Pick<SnapshotEntry, 'size' | 'mtimeMs' | 'ctimeMs'>
  generation?: PersistedFileGeneration
  reasonCode?: NotebookFileEvidenceReason
}
type PersistedNotebookFileEvidence = {
  schemaVersion: 1
  evidenceId: string
  runId: string
  state: 'partial' | 'unavailable'
  observedRoots: Array<'data' | 'handoff'>
  managedRootsFinalState: 'partial' | 'unavailable'
  fileReads: 'unavailable'
  externalPaths: 'unavailable'
  writerAttribution: 'unavailable'
  reasonCodes: NotebookFileEvidenceReason[]
  relations: PersistedFileRelation[]
}

const activeByObservedRoot = new Map<string, Set<ActiveObservation>>()
let reservedDiskBytes = 0
const MAX_CHANGED_PATHS = 10_000
const MAX_FALLBACK_SNAPSHOT_ENTRIES = 50_000
const EVENT_SETTLE_MS = 20
const WATCHER_READY_MS = 5
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const BASELINE_REASON_CODES: NotebookFileEvidenceReason[] = [
  'file-reads-not-observed',
  'initial-file-generations-not-captured',
  'external-paths-not-observed',
  'transient-files-not-captured',
  'writer-not-isolated'
]

class SnapshotEntryLimitError extends Error {}
class UnsafeEvidencePathError extends Error {}

const isPathInside = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

const toPortableNotebookRelativePath = (path: string, hostSeparator = sep): string =>
  hostSeparator === '/' ? path : path.split(hostSeparator).join('/')

const uniqueReasons = (
  reasons: readonly NotebookFileEvidenceReason[]
): NotebookFileEvidenceReason[] => [...new Set(reasons)].sort()

const unavailableEvidence = (
  reasons: readonly NotebookFileEvidenceReason[]
): NotebookRunFileEvidence => ({
  schemaVersion: 1,
  state: 'unavailable',
  managedRootsFinalState: 'unavailable',
  fileReads: 'unavailable',
  externalPaths: 'unavailable',
  writerAttribution: 'unavailable',
  reasonCodes: uniqueReasons([...BASELINE_REASON_CODES, ...reasons])
})

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT'

const isExistingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'EEXIST'

const assertRealDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new UnsafeEvidencePathError(`Unsafe Notebook file-evidence directory: ${path}`)
  }
}

const ensureRealDirectory = async (path: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isExistingPathError(error)) throw error
  }
  await assertRealDirectory(path)
}

const secureEvidenceRoot = async (notebookSessionRoot: string): Promise<string> => {
  const resolvedSessionRoot = resolve(notebookSessionRoot)
  await assertRealDirectory(resolvedSessionRoot)
  const canonicalSessionRoot = await realpath(resolvedSessionRoot)
  const evidenceRoot = join(canonicalSessionRoot, 'file-evidence')
  await ensureRealDirectory(evidenceRoot)
  if ((await realpath(evidenceRoot)) !== evidenceRoot) {
    throw new UnsafeEvidencePathError('Notebook file-evidence root resolves through a symlink.')
  }
  return evidenceRoot
}

const ensureSecureDirectoryChain = async (
  trustedRoot: string,
  segments: readonly string[]
): Promise<string> => {
  await assertRealDirectory(trustedRoot)
  let current = trustedRoot
  for (const segment of segments) {
    if ((await realpath(current)) !== current) {
      throw new UnsafeEvidencePathError('Notebook file-evidence ancestor changed.')
    }
    current = join(current, segment)
    await ensureRealDirectory(current)
  }
  if ((await realpath(current)) !== current) {
    throw new UnsafeEvidencePathError('Notebook file-evidence path resolves through a symlink.')
  }
  return current
}

const stripUnpublishedGenerations = (workingFiles: NotebookWorkingFile[]): NotebookWorkingFile[] =>
  workingFiles.map((file) => {
    const unpublished = { ...file }
    delete unpublished.generationId
    delete unpublished.checksum
    return unpublished
  })

const existingRealDirectory = async (path: string): Promise<string | undefined> => {
  try {
    await assertRealDirectory(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
  if ((await realpath(path)) !== path) {
    throw new UnsafeEvidencePathError('Notebook file-evidence path resolves through a symlink.')
  }
  return path
}

const removeEvidenceChildren = async (
  parent: string,
  retainedNames: ReadonlySet<string>
): Promise<number> => {
  const entries = await readdir(parent, { withFileTypes: true })
  let removed = 0
  for (const entry of entries) {
    if (retainedNames.has(entry.name)) continue
    await assertRealDirectory(parent)
    if ((await realpath(parent)) !== parent) {
      throw new UnsafeEvidencePathError('Notebook file-evidence cleanup path changed.')
    }
    await rm(join(parent, entry.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

const reconcileWorkingFileEvidence = async (
  notebookSessionRoot: string,
  runs: readonly Pick<NotebookRunRecord, 'runId' | 'fileEvidence'>[]
): Promise<{ removedStagingEntries: number; removedRunEntries: number }> => {
  const resolvedSessionRoot = resolve(notebookSessionRoot)
  await assertRealDirectory(resolvedSessionRoot)
  const canonicalSessionRoot = await realpath(resolvedSessionRoot)
  const evidenceRoot = await existingRealDirectory(join(canonicalSessionRoot, 'file-evidence'))
  if (!evidenceRoot) return { removedStagingEntries: 0, removedRunEntries: 0 }

  const stagingRoot = await existingRealDirectory(join(evidenceRoot, 'staging'))
  const runsRoot = await existingRealDirectory(join(evidenceRoot, 'runs'))
  const referencedRunIds = new Set(
    runs.flatMap((run) => {
      if (!SAFE_RUN_ID.test(run.runId)) return []
      const expectedStorageKey = toPortableNotebookRelativePath(
        join('file-evidence', 'runs', run.runId, 'evidence.json')
      )
      return run.fileEvidence?.storageKey === expectedStorageKey ? [run.runId] : []
    })
  )

  return {
    removedStagingEntries: stagingRoot ? await removeEvidenceChildren(stagingRoot, new Set()) : 0,
    removedRunEntries: runsRoot ? await removeEvidenceChildren(runsRoot, referencedRunIds) : 0
  }
}

const registerObservation = (
  observedRoot: string,
  observation: ActiveObservation
): (() => void) => {
  const active = activeByObservedRoot.get(observedRoot) ?? new Set<ActiveObservation>()
  if (active.size > 0) {
    observation.conflicted = true
    for (const existing of active) existing.conflicted = true
  }
  active.add(observation)
  activeByObservedRoot.set(observedRoot, active)
  return () => {
    active.delete(observation)
    if (active.size === 0) activeByObservedRoot.delete(observedRoot)
  }
}

const settleWatcherEvents = (): Promise<void> =>
  new Promise((resolveSettled) => setTimeout(resolveSettled, EVENT_SETTLE_MS))
const waitForWatcherReady = (): Promise<void> =>
  new Promise((resolveReady) => setTimeout(resolveReady, WATCHER_READY_MS))

const snapshotEntry = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string,
  candidatePath: string
): Promise<SnapshotEntry | undefined> => {
  const linkMetadata = await lstat(candidatePath)
  if (linkMetadata.isSymbolicLink()) return undefined
  const canonicalPath = await realpath(candidatePath)
  if (!isPathInside(observedRoot, canonicalPath)) return undefined
  const metadata = await stat(canonicalPath)
  if (!metadata.isFile()) return undefined
  const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, canonicalPath))
  return {
    physicalPath: canonicalPath,
    path: logicalPath,
    relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
    kind: 'other',
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino
  }
}

const captureSnapshot = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string
): Promise<SnapshotCapture> => {
  try {
    const files = new Map<string, SnapshotEntry>()
    let entriesSeen = 0
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        entriesSeen += 1
        if (entriesSeen > MAX_FALLBACK_SNAPSHOT_ENTRIES) throw new SnapshotEntryLimitError()
        const candidatePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(candidatePath)
          continue
        }
        if (!entry.isFile()) continue
        const file = await snapshotEntry(
          observedRoot,
          logicalObservedRoot,
          logicalSessionRoot,
          candidatePath
        )
        if (file) files.set(file.path, file)
      }
    }
    await visit(observedRoot)
    return { state: 'available', files }
  } catch (error) {
    return {
      state: 'unavailable',
      reason:
        error instanceof SnapshotEntryLimitError ? 'observer-limit-exceeded' : 'observer-failed'
    }
  }
}

const sameSnapshotEntry = (left: SnapshotEntry, right: SnapshotEntry): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const diffSnapshots = (
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>
): ObservedFileChange[] => {
  const changes: ObservedFileChange[] = []
  for (const [path, current] of after) {
    const previous = before.get(path)
    if (!previous) {
      changes.push({ relation: 'created', relativePath: current.relativePath, after: current })
    } else if (!sameSnapshotEntry(previous, current)) {
      changes.push({
        relation: 'modified',
        relativePath: current.relativePath,
        before: previous,
        after: current
      })
    }
  }
  for (const [path, previous] of before) {
    if (!after.has(path)) {
      changes.push({ relation: 'deleted', relativePath: previous.relativePath, before: previous })
    }
  }
  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

const fallbackObservation = (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string,
  before: ReadonlyMap<string, SnapshotEntry>,
  reasonCodes: readonly NotebookFileEvidenceReason[],
  lifecycle?: { active: ActiveObservation; unregister: () => void }
): RootObservation => {
  let finished = false
  return {
    finish: async () => {
      if (finished) {
        return { changes: [], reasonCodes: ['observer-failed'], available: false }
      }
      finished = true
      if (lifecycle?.active.conflicted) {
        lifecycle.unregister()
        return { changes: [], reasonCodes: ['observer-conflict'], available: false }
      }
      const after = await captureSnapshot(observedRoot, logicalObservedRoot, logicalSessionRoot)
      const conflicted = lifecycle?.active.conflicted ?? false
      lifecycle?.unregister()
      if (conflicted) {
        return { changes: [], reasonCodes: ['observer-conflict'], available: false }
      }
      if (after.state === 'unavailable') {
        return {
          changes: [],
          reasonCodes: uniqueReasons([...reasonCodes, after.reason]),
          available: false
        }
      }
      return {
        changes: diffSnapshots(before, after.files),
        reasonCodes: uniqueReasons(reasonCodes),
        available: true
      }
    }
  }
}

const startRootObservation = async (
  rootPath: string,
  logicalRootPath: string,
  logicalSessionRootPath: string,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<RootObservation> => {
  let watcher: FSWatcher | undefined
  try {
    const logicalObservedRoot = resolve(logicalRootPath)
    const logicalSessionRoot = resolve(logicalSessionRootPath)
    const [observedRoot, sessionRoot] = await Promise.all([
      realpath(rootPath),
      realpath(logicalSessionRootPath)
    ])
    if (!isPathInside(sessionRoot, observedRoot)) {
      return {
        finish: async () => ({ changes: [], reasonCodes: ['observer-failed'], available: false })
      }
    }

    const active: ActiveObservation = { conflicted: false }
    const changedPaths = new Set<string>()
    let watcherUnavailable = false
    let watcherLimitExceeded = false
    let finished = false
    try {
      watcher = (dependencies.watchDirectory ?? watch)(
        observedRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (watcherUnavailable || watcherLimitExceeded) return
          if (!filename) {
            watcherUnavailable = true
            return
          }
          const eventPath = filename.toString()
          if (isAbsolute(eventPath)) {
            watcherUnavailable = true
            return
          }
          const candidatePath = resolve(observedRoot, eventPath)
          if (!isPathInside(observedRoot, candidatePath)) {
            watcherUnavailable = true
            return
          }
          if (changedPaths.size >= MAX_CHANGED_PATHS) {
            watcherLimitExceeded = true
            return
          }
          changedPaths.add(candidatePath)
        }
      )
      watcher.on('error', () => {
        watcherUnavailable = true
      })
      await waitForWatcherReady()
    } catch {
      watcherUnavailable = true
    }

    changedPaths.clear()
    const before = await captureSnapshot(observedRoot, logicalObservedRoot, logicalSessionRoot)
    if (before.state === 'unavailable') {
      watcher?.close()
      return {
        finish: async () => ({ changes: [], reasonCodes: [before.reason], available: false })
      }
    }
    if (watcherUnavailable || watcherLimitExceeded || !watcher) {
      watcher?.close()
      const unregister = registerObservation(observedRoot, active)
      return fallbackObservation(
        observedRoot,
        logicalObservedRoot,
        logicalSessionRoot,
        before.files,
        [
          ...(watcherUnavailable || !watcher ? (['watcher-unavailable'] as const) : []),
          ...(watcherLimitExceeded ? (['observer-limit-exceeded'] as const) : [])
        ],
        { active, unregister }
      )
    }

    const unregister = registerObservation(observedRoot, active)
    return {
      finish: async () => {
        if (finished) {
          return { changes: [], reasonCodes: ['observer-failed'], available: false }
        }
        finished = true
        if (!active.conflicted) await settleWatcherEvents()
        watcher?.close()
        if (active.conflicted) {
          unregister()
          return { changes: [], reasonCodes: ['observer-conflict'], available: false }
        }
        if (watcherUnavailable || watcherLimitExceeded) {
          return fallbackObservation(
            observedRoot,
            logicalObservedRoot,
            logicalSessionRoot,
            before.files,
            [
              ...(watcherUnavailable ? (['watcher-unavailable'] as const) : []),
              ...(watcherLimitExceeded ? (['observer-limit-exceeded'] as const) : [])
            ],
            { active, unregister }
          ).finish()
        }

        try {
          const changes: ObservedFileChange[] = []
          for (const candidatePath of [...changedPaths].sort()) {
            const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, candidatePath))
            const previous = before.files.get(logicalPath)
            const current = await snapshotEntry(
              observedRoot,
              logicalObservedRoot,
              logicalSessionRoot,
              candidatePath
            ).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
              throw error
            })
            if (!current && previous) {
              changes.push({
                relation: 'deleted',
                relativePath: previous.relativePath,
                before: previous
              })
            } else if (current && !previous) {
              changes.push({
                relation: 'created',
                relativePath: current.relativePath,
                after: current
              })
            } else if (current && previous && !sameSnapshotEntry(previous, current)) {
              changes.push({
                relation: 'modified',
                relativePath: current.relativePath,
                before: previous,
                after: current
              })
            }
          }
          if (changes.length > 0) {
            if (active.conflicted) {
              return { changes: [], reasonCodes: ['observer-conflict'], available: false }
            }
            return {
              changes: changes.sort((left, right) =>
                left.relativePath.localeCompare(right.relativePath)
              ),
              reasonCodes: [],
              available: true
            }
          }
          return fallbackObservation(
            observedRoot,
            logicalObservedRoot,
            logicalSessionRoot,
            before.files,
            [],
            { active, unregister }
          ).finish()
        } catch {
          return { changes: [], reasonCodes: ['observer-failed'], available: false }
        } finally {
          unregister()
        }
      }
    }
  } catch {
    watcher?.close()
    return {
      finish: async () => ({ changes: [], reasonCodes: ['observer-failed'], available: false })
    }
  }
}

const fingerprint = (
  value: Pick<SnapshotEntry, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
): string => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':')

const freezeGeneration = async (
  request: Required<Pick<WorkingFileObservationRequest, 'notebookSessionRoot' | 'runId'>> &
    Pick<WorkingFileObservationRequest, 'signal'>,
  file: SnapshotEntry,
  dependencies: WorkingFileObservationDependencies,
  reservedBytes: number,
  stagingRunRoot: string
): Promise<
  | { state: 'available'; generation: PersistedFileGeneration }
  | { state: 'unavailable'; reason: NotebookFileEvidenceReason }
> => {
  const maxGenerationBytes =
    dependencies.maxGenerationBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes
  const maxRunBytes = dependencies.maxRunBytes ?? LOCAL_RESOURCE_BUDGETS.artifactTurnBytes
  if (
    file.size === undefined ||
    file.size > maxGenerationBytes ||
    reservedBytes + file.size > maxRunBytes
  ) {
    return { state: 'unavailable', reason: 'generation-budget-exceeded' }
  }
  const fileSize = file.size

  const incomingRoot = join(stagingRunRoot, 'incoming')
  const temporaryPath = join(incomingRoot, `${randomUUID()}.tmp`)
  let releaseDiskReservation: (() => void) | undefined
  let ownedStagedContentPath: string | undefined
  try {
    await ensureSecureDirectoryChain(stagingRunRoot, ['incoming'])
    const sourceHandle = await open(file.physicalPath, 'r')
    let copied: { sizeBytes: number; checksum: string }
    try {
      const beforeCopy = await sourceHandle.stat()
      if (!beforeCopy.isFile() || fingerprint(file) !== fingerprint(beforeCopy)) {
        return { state: 'unavailable', reason: 'generation-freeze-failed' }
      }

      const freeBytes = await (dependencies.getAvailableBytes ?? availableBytes)(stagingRunRoot)
      assertDiskReserve(
        Math.max(0, freeBytes - reservedDiskBytes),
        fileSize,
        dependencies.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
      )
      reservedDiskBytes += fileSize
      releaseDiskReservation = () => {
        reservedDiskBytes -= fileSize
      }

      // The snapshot size is also the stream limit. A growing source therefore cannot consume
      // unreserved disk before the post-copy fingerprint check rejects it.
      copied = await copyOpenFileWithinBudget(
        sourceHandle,
        temporaryPath,
        Math.min(maxGenerationBytes, fileSize),
        request.signal
      )
      const afterCopy = await sourceHandle.stat()
      if (fingerprint(beforeCopy) !== fingerprint(afterCopy) || copied.sizeBytes !== fileSize) {
        return { state: 'unavailable', reason: 'generation-freeze-failed' }
      }
      request.signal?.throwIfAborted()
    } finally {
      await sourceHandle.close()
    }

    const checksum = copied.checksum
    const contentStorageKey = toPortableNotebookRelativePath(
      join(
        'file-evidence',
        'runs',
        request.runId,
        'blobs',
        'sha256',
        checksum.slice(0, 2),
        checksum
      )
    )
    const stagedContentPath = join(
      stagingRunRoot,
      'blobs',
      'sha256',
      checksum.slice(0, 2),
      checksum
    )
    await ensureSecureDirectoryChain(stagingRunRoot, ['blobs', 'sha256', checksum.slice(0, 2)])
    await assertRealDirectory(incomingRoot)
    try {
      await rename(temporaryPath, stagedContentPath)
      ownedStagedContentPath = stagedContentPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await digestFileWithinBudget(
        stagedContentPath,
        maxGenerationBytes,
        request.signal
      )
      if (existing.sizeBytes !== copied.sizeBytes || existing.checksum !== checksum) throw error
    }
    request.signal?.throwIfAborted()
    await (dependencies.syncFile ?? defaultFileDurability.syncFile)(stagedContentPath)
    await (dependencies.syncDirectory ?? defaultFileDurability.syncDirectory)(
      dirname(stagedContentPath)
    )

    return {
      state: 'available',
      generation: {
        generationId: (dependencies.createId ?? randomUUID)(),
        relativePath: file.relativePath,
        checksum,
        sizeBytes: fileSize,
        contentStorageKey,
        capturedAt: new Date((dependencies.now ?? Date.now)()).toISOString()
      }
    }
  } catch (error) {
    if (ownedStagedContentPath) {
      await rm(ownedStagedContentPath, { force: true }).catch(() => undefined)
    }
    return {
      state: 'unavailable',
      reason:
        error instanceof ResourceBudgetExceededError
          ? 'generation-budget-exceeded'
          : 'generation-freeze-failed'
    }
  } finally {
    releaseDiskReservation?.()
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const persistEvidence = async (
  request: WorkingFileObservationRequest,
  rootKinds: Array<'data' | 'handoff'>,
  rootResults: RootObservationResult[],
  dependencies: WorkingFileObservationDependencies
): Promise<WorkingFileObservationResult> => {
  const changes = rootResults.flatMap((result) => result.changes)
  const workingFiles = changes.flatMap((change): NotebookWorkingFile[] =>
    change.after
      ? [
          {
            path: change.after.path,
            relativePath: change.after.relativePath,
            kind: change.after.kind,
            size: change.after.size,
            mtimeMs: change.after.mtimeMs
          }
        ]
      : []
  )
  const workingFilesByPath = new Map(workingFiles.map((file) => [file.path, file]))
  if (!request.runId || !SAFE_RUN_ID.test(request.runId)) {
    return { workingFiles, fileEvidence: unavailableEvidence(['run-identity-missing']) }
  }

  const evidenceId = `notebook-file-evidence-${request.runId}`
  let evidenceRoot: string
  let stagingRoot: string
  let runsRoot: string
  let stagingRunRoot: string
  try {
    evidenceRoot = await secureEvidenceRoot(request.notebookSessionRoot)
    stagingRoot = await ensureSecureDirectoryChain(evidenceRoot, ['staging'])
    runsRoot = await ensureSecureDirectoryChain(evidenceRoot, ['runs'])
    stagingRunRoot = await ensureSecureDirectoryChain(stagingRoot, [
      `${request.runId}-${randomUUID()}`
    ])
  } catch {
    return {
      workingFiles,
      fileEvidence: unavailableEvidence(['evidence-persistence-failed'])
    }
  }
  const finalRunRoot = join(runsRoot, request.runId)
  const relationResults: PersistedFileRelation[] = []
  const dynamicReasons = rootResults.flatMap((result) => result.reasonCodes)
  let reservedBytes = 0
  for (const change of changes) {
    const relation: PersistedFileRelation = {
      relation: change.relation,
      relativePath: change.relativePath,
      pathPortability: 'relative',
      authority: 'advisory',
      ...(change.before
        ? {
            before: {
              size: change.before.size,
              mtimeMs: change.before.mtimeMs,
              ctimeMs: change.before.ctimeMs
            }
          }
        : {})
    }
    if (change.after) {
      const workingFile = workingFilesByPath.get(change.after.path)
      if (workingFile) {
        workingFile.change = change.relation === 'created' ? 'created' : 'modified'
      }
      const frozen = await freezeGeneration(
        {
          notebookSessionRoot: request.notebookSessionRoot,
          runId: request.runId,
          signal: request.signal
        },
        change.after,
        dependencies,
        reservedBytes,
        stagingRunRoot
      )
      if (frozen.state === 'available') {
        relation.generation = frozen.generation
        reservedBytes += frozen.generation.sizeBytes
        if (workingFile) {
          workingFile.generationId = frozen.generation.generationId
          workingFile.checksum = frozen.generation.checksum
        }
      } else {
        relation.reasonCode = frozen.reason
        dynamicReasons.push(frozen.reason)
      }
    }
    relationResults.push(relation)
  }

  const rootsAvailable = rootResults.every((result) => result.available)
  const reasonCodes = uniqueReasons([...BASELINE_REASON_CODES, ...dynamicReasons])
  const sidecar: PersistedNotebookFileEvidence = {
    schemaVersion: 1,
    evidenceId,
    runId: request.runId,
    state: rootsAvailable ? 'partial' : 'unavailable',
    observedRoots: rootKinds,
    managedRootsFinalState: rootsAvailable ? 'partial' : 'unavailable',
    fileReads: 'unavailable',
    externalPaths: 'unavailable',
    writerAttribution: 'unavailable',
    reasonCodes,
    relations: relationResults
  }
  const serialized = `${JSON.stringify(sidecar, null, 2)}\n`
  const checksum = createHash('sha256').update(serialized).digest('hex')
  const evidenceStorageKey = toPortableNotebookRelativePath(
    join('file-evidence', 'runs', request.runId, 'evidence.json')
  )
  const stagedEvidencePath = join(stagingRunRoot, 'evidence.json')
  let published = false
  try {
    await rm(join(stagingRunRoot, 'incoming'), { recursive: true, force: true })
    await assertRealDirectory(stagingRunRoot)
    assertDiskReserve(
      await (dependencies.getAvailableBytes ?? availableBytes)(stagingRunRoot),
      Buffer.byteLength(serialized),
      dependencies.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
    )
    await (dependencies.writeEvidenceFile ?? writeDurableJsonFile)(stagedEvidencePath, serialized)
    await assertRealDirectory(stagingRunRoot)
    await assertRealDirectory(runsRoot)
    if (
      (await realpath(stagingRunRoot)) !== stagingRunRoot ||
      (await realpath(runsRoot)) !== runsRoot
    ) {
      throw new UnsafeEvidencePathError('Notebook file-evidence publication path changed.')
    }
    await (dependencies.publishDirectory ?? rename)(stagingRunRoot, finalRunRoot)
    published = true
    await (dependencies.syncDirectory ?? defaultFileDurability.syncDirectory)(dirname(finalRunRoot))
    return {
      workingFiles,
      fileEvidence: {
        schemaVersion: 1,
        evidenceId,
        state: sidecar.state,
        checksum,
        storageKey: evidenceStorageKey,
        relationCount: relationResults.length,
        generationCount: relationResults.filter((relation) => relation.generation).length,
        managedRootsFinalState: sidecar.managedRootsFinalState,
        fileReads: sidecar.fileReads,
        externalPaths: sidecar.externalPaths,
        writerAttribution: sidecar.writerAttribution,
        reasonCodes
      }
    }
  } catch {
    await rm(published ? finalRunRoot : stagingRunRoot, { recursive: true, force: true }).catch(
      () => undefined
    )
    return {
      workingFiles: stripUnpublishedGenerations(workingFiles),
      fileEvidence: unavailableEvidence([...reasonCodes, 'evidence-persistence-failed'])
    }
  }
}

const startWorkingFileObservation = async (
  request: WorkingFileObservationRequest,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  const logicalSessionRoot = resolve(request.notebookSessionRoot)
  const handoffRoot = join(logicalSessionRoot, 'handoff')
  const roots: Array<{ kind: 'data' | 'handoff'; path: string; logicalPath: string }> = [
    { kind: 'data', path: request.dataRoot, logicalPath: request.dataRoot },
    ...(await realpath(handoffRoot).then(
      () => [{ kind: 'handoff' as const, path: handoffRoot, logicalPath: handoffRoot }],
      () => []
    ))
  ]
  const observations = await Promise.all(
    roots.map((root) =>
      startRootObservation(root.path, root.logicalPath, logicalSessionRoot, dependencies)
    )
  )
  let finished = false
  return {
    finish: async (signal) => {
      if (finished) {
        return { workingFiles: [], fileEvidence: unavailableEvidence(['observer-failed']) }
      }
      finished = true
      const results = await Promise.all(observations.map((observation) => observation.finish()))
      return persistEvidence(
        { ...request, signal: signal ?? request.signal },
        roots.map((root) => root.kind),
        results,
        dependencies
      )
    }
  }
}

export { reconcileWorkingFileEvidence, startWorkingFileObservation, toPortableNotebookRelativePath }
export type { WorkingFileObservation, WorkingFileObservationResult }
