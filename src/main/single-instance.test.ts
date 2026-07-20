import { afterEach, describe, expect, it, vi } from 'vitest'

// Minimal electron app double: a toggleable lock result plus a listener recorder so the test can
// fire the 'second-instance' event and assert the forwarded argv/cwd.
const { appMock } = vi.hoisted(() => ({
  appMock: {
    requestSingleInstanceLock: vi.fn(),
    listeners: new Map<string, (event: unknown, argv: string[], cwd: string) => void>(),
    on: vi.fn((event: string, fn: (event: unknown, argv: string[], cwd: string) => void) => {
      appMock.listeners.set(event, fn)
    })
  }
}))

vi.mock('electron', () => ({ app: appMock }))

const { acquireSingleInstanceLock } = await import('./single-instance')

afterEach(() => {
  appMock.listeners.clear()
  vi.clearAllMocks()
})

describe('acquireSingleInstanceLock', () => {
  it('returns false and registers no listener when the lock is not acquired', () => {
    appMock.requestSingleInstanceLock.mockReturnValue(false)
    const onSecondInstance = vi.fn()

    const isPrimary = acquireSingleInstanceLock({ onSecondInstance })

    expect(isPrimary).toBe(false)
    expect(appMock.on).not.toHaveBeenCalled()
  })

  it('returns true and registers a second-instance listener when the lock is acquired', () => {
    appMock.requestSingleInstanceLock.mockReturnValue(true)
    const onSecondInstance = vi.fn()

    const isPrimary = acquireSingleInstanceLock({ onSecondInstance })

    expect(isPrimary).toBe(true)
    expect(appMock.on).toHaveBeenCalledWith('second-instance', expect.any(Function))
    expect(appMock.listeners.has('second-instance')).toBe(true)
  })

  it('forwards argv and workingDirectory to onSecondInstance', () => {
    appMock.requestSingleInstanceLock.mockReturnValue(true)
    const onSecondInstance = vi.fn()
    acquireSingleInstanceLock({ onSecondInstance })

    const argv = ['electron', 'open-science', '--open', 'notebook.ipynb']
    const cwd = '/Users/tester/projects'
    appMock.listeners.get('second-instance')?.({}, argv, cwd)

    expect(onSecondInstance).toHaveBeenCalledTimes(1)
    expect(onSecondInstance).toHaveBeenCalledWith(argv, cwd)
  })
})
