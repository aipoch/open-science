import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import {
  imageTaskIsActive,
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
  scope: ImageTaskIdentity
): Promise<ImageTask | undefined> {
  const path = join(directory, `${scope.id}.json`)
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
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
  return task
}
type HistoryEntry = Pick<ImageTask, 'id' | 'branchId' | 'createdAt'>

const compareTasks = (
  a: Pick<HistoryEntry, 'createdAt' | 'id'>,
  b: Pick<HistoryEntry, 'createdAt' | 'id'>
): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

// Atomic task writes replace directory entries. Cache only cursor metadata for the
// last browsed session, and re-read the authoritative records on every page.
const MAX_HISTORY_INDEX_ENTRIES = 4096
let historyIndex: { directory: string; revision: string; entries: HistoryEntry[] } | undefined
async function directoryRevision(directory: string): Promise<string> {
  const stat = await lstat(directory, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`
}

export async function readStoredImageTasks(
  root: string,
  scope: ImageTaskScope,
  options?: {
    limit: number
    onInvalid: (error: unknown) => void
    history?: ImageTaskList['history']
  }
): Promise<ImageTask[]> {
  const directory = await taskDirectory(root, scope)
  if (!directory) return []
  const history = options?.history
  const revision = history ? await directoryRevision(directory) : undefined
  const matchesHistory = (entry: HistoryEntry): boolean =>
    !history ||
    (entry.branchId === history.branchId &&
      (!history.before || compareTasks(entry, history.before) > 0))
  const tasks: ImageTask[] = []
  if (
    options &&
    history &&
    historyIndex?.directory === directory &&
    historyIndex.revision === revision
  ) {
    for (const entry of historyIndex.entries) {
      if (!matchesHistory(entry)) continue
      try {
        const task = await readRecord(directory, { ...scope, id: entry.id })
        if (task && matchesHistory(task)) tasks.push(task)
        if (tasks.length >= options.limit) break
      } catch (error) {
        options.onInvalid(error)
      }
    }
    if (revision === (await directoryRevision(directory))) return tasks
    tasks.length = 0
  }
  const filenames = await readdir(directory)
  const entries: HistoryEntry[] | undefined =
    history && filenames.length <= MAX_HISTORY_INDEX_ENTRIES ? [] : undefined
  for (const filename of filenames) {
    if (!filename.endsWith('.json')) continue
    const identity = imageTaskIdentitySchema.safeParse({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      id: filename.slice(0, -5)
    })
    if (!identity.success) continue
    try {
      const task = await readRecord(directory, identity.data)
      if (!task) continue
      entries?.push({ id: task.id, branchId: task.branchId, createdAt: task.createdAt })
      if (!matchesHistory(task)) continue
      tasks.push(task)
      if (options && tasks.length > options.limit) {
        // Retain all live work and the most recent terminal history without sorting each read.
        let oldest = -1
        let terminalCount = 0
        for (let i = 0; i < tasks.length; i++) {
          if (!options.history && imageTaskIsActive(tasks[i])) continue
          terminalCount++
          if (
            oldest < 0 ||
            tasks[i].createdAt < tasks[oldest].createdAt ||
            (tasks[i].createdAt === tasks[oldest].createdAt && tasks[i].id < tasks[oldest].id)
          )
            oldest = i
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
  return tasks.sort(compareTasks)
}
export async function writeStoredImageTask(root: string, value: ImageTask): Promise<void> {
  const task = imageTaskSchema.parse(value)
  const directory = await taskDirectory(root, task, true)
  await writeDurableJsonFile(join(directory!, `${task.id}.json`), JSON.stringify(task))
}
