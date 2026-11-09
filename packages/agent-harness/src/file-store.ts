import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { checkState } from './session-state'
import type { AgentCheckpoint, AgentStore } from './session-types'

export type JsonFileAgentStoreOptions = {
  directory: string
  lockTimeoutMs?: number
}

/** Durable single-owner JSON checkpoints with atomic rename and an inter-process lock file.
 * Use a database-backed AgentStore when many workers or high write throughput are required. */
export function createJsonFileAgentStore(options: JsonFileAgentStoreOptions): AgentStore {
  const timeout = options.lockTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeout) || timeout < 100)
    throw new Error('Invalid file-store lock timeout')
  const fileFor = (sessionId: string): string =>
    join(options.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  const lockFor = (file: string): string => `${file}.lock`
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const withLock = async <T>(file: string, work: () => Promise<T>): Promise<T> => {
    await mkdir(options.directory, { recursive: true })
    const lock = lockFor(file)
    const started = Date.now()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (!handle) {
      try {
        handle = await open(lock, 'wx')
      } catch (error) {
        if (Date.now() - started >= timeout)
          throw new Error('File-store lock timeout', { cause: error })
        await sleep(10)
      }
    }
    try {
      return await work()
    } finally {
      await handle.close()
      await unlink(lock).catch(() => undefined)
    }
  }
  const loadRaw = async (file: string): Promise<AgentCheckpoint | undefined> => {
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as AgentCheckpoint
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Invalid agent checkpoint file', { cause: error })
    }
  }
  const writeRaw = async (file: string, value: AgentCheckpoint): Promise<void> => {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  }
  return {
    async load(sessionId) {
      const value = await loadRaw(fileFor(sessionId))
      if (value) checkState(value, sessionId)
      return value && structuredClone(value)
    },
    async commit(sessionId, expectedRevision, next) {
      const file = fileFor(sessionId)
      return withLock(file, async () => {
        const current = await loadRaw(file)
        if ((current?.revision ?? null) !== expectedRevision) return false
        checkState(next, sessionId)
        if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
          throw new Error('Invalid checkpoint revision')
        await writeRaw(file, structuredClone(next))
        return true
      })
    }
  }
}
