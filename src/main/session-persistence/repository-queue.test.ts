import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(),
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

const createSession = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project-a',
  title: id,
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
})

describe('session persistence repository save ordering', () => {
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
    await flushMicrotasks()

    const secondSave = repository.saveSession(createSession('second-session'))
    await flushMicrotasks()

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)

    firstWrite.resolve(undefined)
    await firstSave
    await flushMicrotasks()

    expect(fsMock.writeFile).toHaveBeenCalledTimes(2)

    secondWrite.resolve(undefined)
    await secondSave

    expect(writes[0]).toContain('first-session')
    expect(writes[1]).toContain('second-session')
  })
})
