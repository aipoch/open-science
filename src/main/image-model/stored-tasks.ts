import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { observeFile, sameFileObservation, type FileObservation } from '../bounded-file-io'
import {
  imageTaskIsActive,
  matchesImageTaskSource,
  imageTaskSchema,
  imageTaskIdentitySchema,
  imageTaskScopeSchema,
  type ImageTask,
  type ImageTaskIdentity,
  type ImageTaskScope,
  type ImageTaskList
} from '../../shared/image-task'

async function taskDirectory(
  root: string,
  scope: ImageTaskScope,
  create = false
): Promise<string | undefined> {
  imageTaskScopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId })
  let path = root
  for (const part of ['artifacts', scope.projectId, scope.sessionId, '.image-tasks']) {
    path = join(path, part)
    if (create)
      await mkdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return undefined
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Unsafe image task directory.')
  }
  return path
}
export async function readStoredImageTask(
  root: string,
  scope: ImageTaskIdentity
): Promise<ImageTask | undefined> {
  imageTaskIdentitySchema.parse({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    id: scope.id
  })
  const directory = await taskDirectory(root, scope)
  if (!directory) return undefined
  return readRecord(directory, scope)
}
async function readRecord(
  directory: string,
  scope: ImageTaskIdentity,
  observe?: (path: string, observation: FileObservation) => void
): Promise<ImageTask | undefined> {
  const path = join(directory, `${scope.id}.json`)
  const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe image task record.')
  const task = imageTaskSchema.parse(JSON.parse(await readFileWithinLimit(path, 512 * 1024)))
  if (
    task.id !== scope.id ||
    task.projectId !== scope.projectId ||
    task.sessionId !== scope.sessionId
  )
    throw new Error('Image task ownership mismatch.')
  if (observe) observe(path, observeFile(info))
  return task
}
type HistoryEntry = Pick<ImageTask, 'id' | 'frameId' | 'branchId' | 'createdAt' | 'state'> & {
  edit: { source: Pick<ImageTask['edit']['source'], 'sourceVersionId'> }
}

const compareTasks = (
  a: Pick<HistoryEntry, 'createdAt' | 'id'>,
  b: Pick<HistoryEntry, 'createdAt' | 'id'>
): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

// Atomic task writes replace directory entries. Keep selection metadata for the last
// browsed session and re-read only the records needed for the current request.
const MAX_HISTORY_INDEX_ENTRIES = 4096
let historyIndex: { directory: string; revision: string; entries: HistoryEntry[] } | undefined
async function directoryRevision(directory: string): Promise<string> {
  const stat = await lstat(directory, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`
}

type TaskSnapshot = {
  directory: string
  revision: string
  files: Array<[string, FileObservation]>
  tasks: ImageTask[]
}
const exportSnapshot = new AsyncLocalStorage<{ current?: TaskSnapshot }>()

export function withImageTaskSnapshot<T>(work: () => Promise<T>): Promise<T> {
  return exportSnapshot.getStore() ? work() : exportSnapshot.run({}, work)
}

async function filesUnchanged(files: TaskSnapshot['files']): Promise<boolean> {
  for (let offset = 0; offset < files.length; offset += 32) {
    const checks = await Promise.all(
      files.slice(offset, offset + 32).map(async ([path, before]) => {
        const stat = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        return Boolean(stat?.isFile() && sameFileObservation(before, observeFile(stat)))
      })
    )
    if (!checks.every(Boolean)) return false
  }
  return true
}

export async function readStoredImageTasks(
  root: string,
  scope: ImageTaskScope,
  options?: {
    limit: number
    onInvalid: (error: unknown) => void
    history?: ImageTaskList['history']
    recovery?: ImageTaskList['recovery']
  }
): Promise<ImageTask[]> {
  const directory = await taskDirectory(root, scope)
  if (!directory) return []
  const history = options?.history
  const recovery = options?.recovery
  const snapshot = options ? undefined : exportSnapshot.getStore()
  const revision = options || snapshot ? await directoryRevision(directory) : undefined
  const previous = snapshot?.current
  if (
    previous?.directory === directory &&
    previous.revision === revision &&
    (await filesUnchanged(previous.files)) &&
    revision === (await directoryRevision(directory))
  )
    return structuredClone(previous.tasks)
  const observed: TaskSnapshot['files'] | undefined = snapshot ? [] : undefined
  const matchesScope = (entry: HistoryEntry): boolean => {
    if (history)
      return (
        entry.branchId === history.branchId &&
        (!history.before || compareTasks(entry, history.before) > 0)
      )
    return !recovery || (entry.frameId === recovery.frameId && entry.branchId === recovery.branchId)
  }
  const matchesSource = (entry: HistoryEntry): boolean =>
    Boolean(recovery && matchesImageTaskSource(entry, recovery))
  const tasks: ImageTask[] = []
  let latestSourceTask: ImageTask | undefined
  if (options && historyIndex?.directory === directory && historyIndex.revision === revision) {
    let terminalCount = 0
    for (const entry of historyIndex.entries) {
      if (!matchesScope(entry)) continue
      const isRecent = terminalCount < options.limit
      if (!isRecent && !imageTaskIsActive(entry) && (latestSourceTask || !matchesSource(entry)))
        continue
      try {
        const task = await readRecord(directory, { ...scope, id: entry.id })
        if (!task || !matchesScope(task)) continue
        const isLatestSource = !latestSourceTask && matchesSource(task)
        const active = imageTaskIsActive(task)
        if (isLatestSource) latestSourceTask = task
        if (isRecent || isLatestSource || active) tasks.push(task)
        if (history && tasks.length >= options.limit) break
        if (!active) terminalCount++
      } catch (error) {
        options.onInvalid(error)
      }
    }
    if (revision === (await directoryRevision(directory))) return tasks
    tasks.length = 0
    latestSourceTask = undefined
  }
  const filenames = await readdir(directory)
  const entries: HistoryEntry[] | undefined =
    options && filenames.length <= MAX_HISTORY_INDEX_ENTRIES ? [] : undefined
  for (const filename of filenames) {
    if (!filename.endsWith('.json')) continue
    const identity = imageTaskIdentitySchema.safeParse({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      id: filename.slice(0, -5)
    })
    if (!identity.success) continue
    try {
      const task = await readRecord(
        directory,
        identity.data,
        observed ? (path, file) => observed.push([path, file]) : undefined
      )
      if (!task) continue
      entries?.push({
        id: task.id,
        frameId: task.frameId,
        branchId: task.branchId,
        createdAt: task.createdAt,
        state: task.state,
        edit: { source: { sourceVersionId: task.edit.source.sourceVersionId } }
      })
      if (!matchesScope(task)) continue
      if (matchesSource(task) && (!latestSourceTask || compareTasks(task, latestSourceTask) < 0))
        latestSourceTask = task
      tasks.push(task)
      if (options && tasks.length > options.limit) {
        // Retain all live work and the most recent terminal history without sorting each read.
        let oldest = -1
        let terminalCount = 0
        for (let i = 0; i < tasks.length; i++) {
          if (!options.history && imageTaskIsActive(tasks[i])) continue
          terminalCount++
          if (oldest < 0 || compareTasks(tasks[i], tasks[oldest]) > 0) oldest = i
        }
        if (terminalCount > options.limit) tasks.splice(oldest, 1)
      }
    } catch (error) {
      if (!options) throw error // Export must not silently omit damaged records.
      options.onInvalid(error)
    }
  }
  if (revision && entries && revision === (await directoryRevision(directory)))
    historyIndex = { directory, revision, entries: entries.sort(compareTasks) }
  if (latestSourceTask && !tasks.includes(latestSourceTask)) tasks.push(latestSourceTask)
  tasks.sort(compareTasks)
  if (snapshot && revision && observed && revision === (await directoryRevision(directory))) {
    snapshot.current = { directory, revision, files: observed, tasks: structuredClone(tasks) }
  }
  return tasks
}
export async function writeStoredImageTask(root: string, value: ImageTask): Promise<void> {
  const task = imageTaskSchema.parse(value)
  const directory = await taskDirectory(root, task, true)
  await writeDurableJsonFile(join(directory!, `${task.id}.json`), JSON.stringify(task))
}
