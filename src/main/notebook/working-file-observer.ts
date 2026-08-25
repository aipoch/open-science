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

const activeByObservedRoot = new Map<string, Set<ActiveObservation>>()
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

type SnapshotEntry = NotebookWorkingFile & { ctimeMs: number }

const resolveChangedFile = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string,
  candidatePath: string
): Promise<SnapshotEntry | undefined> => {
  try {
    const linkMetadata = await lstat(candidatePath)
    if (linkMetadata.isSymbolicLink()) return undefined

    const canonicalPath = await realpath(candidatePath)
    if (!isPathInside(observedRoot, canonicalPath)) return undefined
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) return undefined
    const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, canonicalPath))

    return {
      path: logicalPath,
      relativePath: toPortableNotebookRelativePath(relative(logicalSessionRoot, logicalPath)),
      kind: 'other',
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const diffSnapshots = (
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>
): NotebookWorkingFile[] =>
  Array.from(after.values())
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

const captureFallbackSnapshot = async (
  observedRoot: string,
  logicalObservedRoot: string,
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
        if (!isPathInside(observedRoot, canonicalPath))
          throw new Error('Working file escaped observed root.')
        const metadata = await stat(canonicalPath)
        const logicalPath = resolve(logicalObservedRoot, relative(observedRoot, canonicalPath))
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

    await visit(observedRoot)
    return files
  } catch {
    return undefined
  }
}

const startFallbackObservation = async (
  observedRoot: string,
  logicalObservedRoot: string,
  logicalSessionRoot: string
): Promise<WorkingFileObservation> => {
  const active: ActiveObservation = { conflicted: false }
  const unregister = registerObservation(observedRoot, active)
  const before = await captureFallbackSnapshot(
    observedRoot,
    logicalObservedRoot,
    logicalSessionRoot
  )
  let finished = false

  return {
    finish: async () => {
      if (finished) return []
      finished = true
      const after = await captureFallbackSnapshot(
        observedRoot,
        logicalObservedRoot,
        logicalSessionRoot
      )
      unregister()
      if (active.conflicted || !before || !after) return []

      return diffSnapshots(before, after)
    }
  }
}

const startRootObservation = async (
  rootPath: string,
  logicalRootPath: string,
  logicalSessionRootPath: string,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  let watcher: FSWatcher | undefined
  try {
    const logicalObservedRoot = resolve(logicalRootPath)
    const logicalSessionRoot = resolve(logicalSessionRootPath)
    const [observedRoot, sessionRoot] = await Promise.all([
      realpath(rootPath),
      realpath(logicalSessionRootPath)
    ])
    if (!isPathInside(sessionRoot, observedRoot)) return unavailableObservation()

    const active: ActiveObservation = { conflicted: false }
    const changedPaths = new Set<string>()
    let invalid = false
    let finished = false

    try {
      watcher = (dependencies.watchDirectory ?? watch)(
        observedRoot,
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
          const candidatePath = resolve(observedRoot, eventPath)
          if (!isPathInside(observedRoot, candidatePath)) {
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
      return startFallbackObservation(observedRoot, logicalObservedRoot, logicalSessionRoot)
    }
    watcher.on('error', () => {
      invalid = true
    })
    await waitForWatcherReady()
    if (invalid) {
      watcher.close()
      return startFallbackObservation(observedRoot, logicalObservedRoot, logicalSessionRoot)
    }
    // Recursive watchers can replay pre-existing paths while their initial scan settles. Execution
    // has not started yet, so those events cannot prove this run created or changed the files.
    changedPaths.clear()
    const before = await captureFallbackSnapshot(
      observedRoot,
      logicalObservedRoot,
      logicalSessionRoot
    )
    if (!before) {
      watcher.close()
      return unavailableObservation()
    }
    const unregister = registerObservation(observedRoot, active)

    return {
      finish: async () => {
        if (finished) return []
        finished = true
        if (!active.conflicted) await settleWatcherEvents()
        watcher?.close()
        unregister()

        if (active.conflicted || invalid) return []
        try {
          const candidates = await Promise.all(
            Array.from(changedPaths)
              .sort((left, right) => left.localeCompare(right))
              .map((candidatePath) =>
                resolveChangedFile(
                  observedRoot,
                  logicalObservedRoot,
                  logicalSessionRoot,
                  candidatePath
                )
              )
          )
          const changedFiles = candidates
            .filter((file): file is SnapshotEntry => file !== undefined)
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
          if (changedFiles.length > 0) return changedFiles

          // macOS can deliver recursive watcher events after the bounded settle window. A full diff
          // is reserved for the empty/no-op event path so correctness does not impose two tree scans
          // on normal runs.
          const after = await captureFallbackSnapshot(
            observedRoot,
            logicalObservedRoot,
            logicalSessionRoot
          )
          return after ? diffSnapshots(before, after) : []
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

const startWorkingFileObservation = async (
  request: WorkingFileObservationRequest,
  dependencies: WorkingFileObservationDependencies = {}
): Promise<WorkingFileObservation> => {
  const logicalSessionRoot = resolve(request.notebookSessionRoot)
  const handoffRoot = join(logicalSessionRoot, 'handoff')
  const roots = [
    { path: request.dataRoot, logicalPath: request.dataRoot },
    ...(await realpath(handoffRoot).then(
      () => [{ path: handoffRoot, logicalPath: handoffRoot }],
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
    finish: async () => {
      if (finished) return []
      finished = true
      return (await Promise.all(observations.map((observation) => observation.finish())))
        .flat()
        .sort((left, right) => left.path.localeCompare(right.path))
    }
  }
}

export { startWorkingFileObservation, toPortableNotebookRelativePath }
export type { WorkingFileObservation }
