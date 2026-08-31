import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'

const fsMock = vi.hoisted(() => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('node:fs/promises', () => fsMock)
// Session encode/decode falls back to resolveDataRoot(), which reads electron's app.getPath.
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

const { SessionRepository } = await import('./repository')

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
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
  beforeEach(() => {
    vi.resetAllMocks()
    fsMock.lstat.mockImplementation((path: string) =>
      path.endsWith('.json')
        ? Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }))
        : Promise.resolve({
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false
          })
    )
    fsMock.open.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined)
    })
    fsMock.rm.mockResolvedValue(undefined)
  })

  it('does not start a later session write while an earlier one is still writing', async () => {
    const firstWrite = createDeferred<void>()
    const secondWrite = createDeferred<void>()
    const writes: string[] = []
    const repository = new SessionRepository('/session-storage')

    fsMock.mkdir.mockResolvedValue(undefined)
    fsMock.rename.mockResolvedValue(undefined)
    fsMock.writeFile.mockImplementation((_path: string, content: string) => {
      writes.push(content)
      return writes.length === 1 ? firstWrite.promise : secondWrite.promise
    })

    const firstSave = repository.saveSession(createSession('first-session'))
    await vi.waitFor(() => expect(fsMock.writeFile).toHaveBeenCalledTimes(1))

    const secondSave = repository.saveSession(createSession('second-session'))
    await flushMicrotasks()

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)

    firstWrite.resolve(undefined)
    await firstSave
    await vi.waitFor(() => expect(fsMock.writeFile).toHaveBeenCalledTimes(2))

    secondWrite.resolve(undefined)
    await secondSave

    expect(writes[0]).toContain('first-session')
    expect(writes[1]).toContain('second-session')
  })

  it('does not let one Project write stall an independent Project write', async () => {
    const projectOneGate = createDeferred<void>()
    const projectOneStarted = createDeferred<void>()
    const projectTwoStarted = createDeferred<void>()
    const repository = new SessionRepository('/session-storage')

    fsMock.mkdir.mockResolvedValue(undefined)
    fsMock.rename.mockResolvedValue(undefined)
    fsMock.writeFile.mockImplementation((path: string) => {
      if (path.includes('project-a')) {
        projectOneStarted.resolve(undefined)
        return projectOneGate.promise
      }
      projectTwoStarted.resolve(undefined)
      return Promise.resolve()
    })

    const projectOne = repository.saveSession(createSession('session-a', 'project-a'))
    await projectOneStarted.promise
    const projectTwo = repository.saveSession(createSession('session-b', 'project-b'))
    const outcome = await Promise.race([
      projectTwoStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])
    projectOneGate.resolve(undefined)
    await Promise.all([projectOne, projectTwo])

    expect(outcome).toBe('started')
  })
})
