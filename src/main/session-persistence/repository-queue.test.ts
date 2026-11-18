import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDataRoot } from '../storage-root'
import type { PersistedChatSession } from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const { SessionRepository } = await import('./repository')

const roots: string[] = []
const root = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'session-queue-'))
  roots.push(directory)
  initDataRoot(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const createSession = (id: string, projectId = 'project-a'): PersistedChatSession => ({
  id,
  projectId,
  title: id,
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
})

describe('session persistence repository save ordering', () => {
  it('does not start a later session write while an earlier one is still writing', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const writes: string[] = []
    const repository = new SessionRepository(await root(), {
      journalDependencies: {
        writeFile: async (path, contents, options) => {
          if (path.includes('.jsonl.')) {
            const id = (JSON.parse(contents) as { document: { session: { id: string } } }).document
              .session.id
            writes.push(id)
            await (id === 'first-session' ? firstGate.promise : secondGate.promise)
          }
          await writeFile(path, contents, options)
        }
      }
    })
    const firstSave = repository.saveSession(createSession('first-session'))
    await vi.waitFor(() => expect(writes).toEqual(['first-session']))
    const secondSave = repository.saveSession(createSession('second-session'))
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['first-session'])
    firstGate.resolve()
    await firstSave
    await vi.waitFor(() => expect(writes).toEqual(['first-session', 'second-session']))
    secondGate.resolve()
    await secondSave
    expect((await repository.loadAll()).sessions.map(({ id }) => id).sort()).toEqual([
      'first-session',
      'second-session'
    ])
  })

  it('does not let one Project write stall an independent Project write', async () => {
    const firstGate = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    const repository = new SessionRepository(await root(), {
      journalDependencies: {
        writeFile: async (path, contents, options) => {
          if (path.includes('.jsonl.')) {
            if (path.includes('project-a')) {
              firstStarted.resolve()
              await firstGate.promise
            } else secondStarted.resolve()
          }
          await writeFile(path, contents, options)
        }
      }
    })
    const first = repository.saveSession(createSession('session-a', 'project-a'))
    await firstStarted.promise
    const second = repository.saveSession(createSession('session-b', 'project-b'))
    const outcome = await Promise.race([
      secondStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 250))
    ])
    firstGate.resolve()
    await Promise.all([first, second])
    expect(outcome).toBe('started')
    expect((await repository.loadAll()).sessions.map(({ id }) => id).sort()).toEqual([
      'session-a',
      'session-b'
    ])
  })
})
