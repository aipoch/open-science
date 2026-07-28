import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { NotebookWorkingFile } from '../../shared/notebook'

type WorkingFileObservationRequest = {
  dataRoot: string
  notebookSessionRoot: string
}

type WorkingFileObservation = {
  finish: () => Promise<NotebookWorkingFile[]>
}

type WorkingFileObservationDependencies = {
  watchDirectory?: typeof watch
}

type ActiveObservation = {
  conflicted: boolean
}

const activeByDataRoot = new Map<string, Set<ActiveObservation>>()
const MAX_CHANGED_PATHS = 10_000
const MAX_FALLBACK_SNAPSHOT_ENTRIES = 50_000
const EVENT_SETTLE_MS = 20
const WATCHER_READY_MS = 5

const isPathInside = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

// Notebook metadata is persisted and exchanged as a portable path, independent of the host OS.
const toPortableNotebookRelativePath = (path: string, hostSeparator = sep): string =>
  hostSeparator === '/' ? path : path.split(hostSeparator).join('/')

const unavailableObservation = (): WorkingFileObservation => ({
  finish: async () => []
})

const registerObservation = (dataRoot: string, observation: ActiveObservation): (() => void) => {
  const active = activeByDataRoot.get(dataRoot) ?? new Set<ActiveObservation>()
  if (active.size > 0) {
    observation.conflicted = true
    for (const existing of active) existing.conflicted = true
  }
  active.add(observation)
  activeByDataRoot.set(dataRoot, active)

  return () => {
    active.delete(observation)
    if (active.size === 0) activeByDataRoot.delete(dataRoot)
  }
}

const settleWatcherEvents = (): Promise<void> =>
  new Promise((resolveSettled) => setTimeout(resolveSettled, EVENT_SETTLE_MS))

const waitForWatcherReady = (): Promise<void> =>
  new Promise((resolveReady) => setTimeout(resolveReady, WATCHER_READY_MS))

const resolveChangedFile = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string,
  candidatePath: string
): Promise<NotebookWorkingFile | undefined> => {
  try {
    const linkMetadata = await lstat(candidatePath)
    if (linkMetadata.isSymbolicLink()) return undefined

    const canonicalPath = await realpath(candidatePath)
    if (!isPathInside(dataRoot, canonicalPath)) return undefined
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) return undefined
    const logicalPath = resolve(logicalDataRoot, relative(dataRoot, canonicalPath))

    return {
      path: logicalPath,
      relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
      kind: 'other',
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

type SnapshotEntry = NotebookWorkingFile & { ctimeMs: number }

const captureFallbackSnapshot = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string
): Promise<Map<string, SnapshotEntry> | undefined> => {
  try {
    const files = new Map<string, SnapshotEntry>()
    let entriesSeen = 0

    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        entriesSeen += 1
        if (entriesSeen > MAX_FALLBACK_SNAPSHOT_ENTRIES) {
          throw new Error('Notebook working-file fallback exceeded its entry limit.')
        }

        const candidatePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(candidatePath)
          continue
        }
        if (!entry.isFile()) continue

        const canonicalPath = await realpath(candidatePath)
        if (!isPathInside(dataRoot, canonicalPath))
          throw new Error('Working file escaped data root.')
        const metadata = await stat(canonicalPath)
        const logicalPath = resolve(logicalDataRoot, relative(dataRoot, canonicalPath))
        files.set(logicalPath, {
          path: logicalPath,
          relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
          kind: 'other',
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs
        })
      }
    }

    await visit(dataRoot)
    return files
  } catch {
    return undefined
  }
}

const startFallbackObservation = async (
  dataRoot: string,
  logicalDataRoot: string,
  logicalSessionRoot: string
): Promise<WorkingFileObservation> => {
  const active: ActiveObservation = { conflicted: false }
  const unregister = registerObservation(dataRoot, active)
  const before = await captureFallbackSnapshot(dataRoot, logicalDataRoot, logicalSessionRoot)
  let finished = false

  return {
    finish: async () => {
      if (finished) return []
      finished = true
      const after = await captureFallbackSnapshot(dataRoot, logicalDataRoot, logicalSessionRoot)
      unregister()
      if (active.conflicted || !before || !after) return []

      return Array.from(after.values())
        .filter((file) => {
          const previous = before.get(file.path)
          return (
            !previous ||
            previous.size !== file.size ||
            previous.mtimeMs !== file.mtimeMs ||
            previous.ctimeMs !== file.ctimeMs
          )
        })
        .map((file) => ({
          path: file.path,
          relativePath: file.relativePath,
          kind: file.kind,
          size: file.size,
          mtimeMs: file.mtimeMs
        }))
    }
  }
}

const startWorkingFileObservation = async (
  request: WorkingFileObservationRequest,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  let watcher: FSWatcher | undefined
  try {
    const logicalDataRoot = resolve(request.dataRoot)
    const logicalSessionRoot = resolve(request.notebookSessionRoot)
    const [dataRoot, sessionRoot] = await Promise.all([
      realpath(request.dataRoot),
      realpath(request.notebookSessionRoot)
    ])
    if (!isPathInside(sessionRoot, dataRoot)) return unavailableObservation()

    const active: ActiveObservation = { conflicted: false }
    const changedPaths = new Set<string>()
    let invalid = false
    let finished = false

    try {
      watcher = (dependencies.watchDirectory ?? watch)(
        dataRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (invalid) return
          if (!filename) {
            invalid = true
            return
          }

          const eventPath = filename.toString()
          if (isAbsolute(eventPath)) {
            invalid = true
            return
          }
          const candidatePath = resolve(dataRoot, eventPath)
          if (!isPathInside(dataRoot, candidatePath)) {
            invalid = true
            return
          }
          if (changedPaths.size >= MAX_CHANGED_PATHS) {
            invalid = true
            return
          }

          changedPaths.add(candidatePath)
        }
      )
    } catch {
      return startFallbackObservation(dataRoot, logicalDataRoot, logicalSessionRoot)
    }
    watcher.on('error', () => {
      invalid = true
    })
    await waitForWatcherReady()
    if (invalid) {
      watcher.close()
      return startFallbackObservation(dataRoot, logicalDataRoot, logicalSessionRoot)
    }
    // Recursive watchers can replay pre-existing paths while their initial scan settles. Execution
    // has not started yet, so those events cannot prove this run created or changed the files.
    changedPaths.clear()
    const unregister = registerObservation(dataRoot, active)

    return {
      finish: async () => {
        if (finished) return []
        finished = true
        if (!active.conflicted) await settleWatcherEvents()
        watcher?.close()
        unregister()

        if (active.conflicted || invalid) return []
        try {
          const files = await Promise.all(
            Array.from(changedPaths)
              .sort((left, right) => left.localeCompare(right))
              .map((candidatePath) =>
                resolveChangedFile(dataRoot, logicalDataRoot, logicalSessionRoot, candidatePath)
              )
          )
          return files.filter((file): file is NotebookWorkingFile => file !== undefined)
        } catch {
          return []
        }
      }
    }
  } catch {
    watcher?.close()
    return unavailableObservation()
  }
}

export { startWorkingFileObservation, toPortableNotebookRelativePath }
export type { WorkingFileObservation }
