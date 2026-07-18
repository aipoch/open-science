import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted taskkill spawn double: records calls and returns an EventEmitter so a test can drive the
// taskkill process's exit/close/error events.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => new EventEmitter())
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { terminateProcessTree } = await import('./process-tree')

// Minimal ChildProcess stand-in exposing only the pid and kill the code under test touches.
const makeChild = (
  pid: number | undefined
): { pid: number | undefined; kill: ReturnType<typeof vi.fn> } => ({
  pid,
  kill: vi.fn(() => true)
})

const originalPlatform = process.platform
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
  vi.clearAllMocks()
})

describe('terminateProcessTree', () => {
  it('on win32 kills the whole tree via taskkill and resolves when taskkill exits', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = makeChild(4321)

    const pending = terminateProcessTree(child as never)

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )
    expect(child.kill).not.toHaveBeenCalled()

    // The promise stays pending until taskkill finishes; emitting 'exit' must resolve it.
    killer.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()
  })

  it('on win32 resolves when taskkill emits an error (no reject, no throw)', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = makeChild(999)

    const pending = terminateProcessTree(child as never)
    killer.emit('error', new Error('taskkill not found'))

    await expect(pending).resolves.toBeUndefined()
  })

  it('on win32 with an undefined pid does not spawn taskkill and resolves', async () => {
    setPlatform('win32')
    const child = makeChild(undefined)

    await expect(terminateProcessTree(child as never)).resolves.toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('on win32 resolves when spawn itself throws synchronously', async () => {
    setPlatform('win32')
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const child = makeChild(555)

    await expect(terminateProcessTree(child as never)).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('on non-win32 calls child.kill with the given signal, never invokes taskkill, and resolves', async () => {
    setPlatform('linux')
    const child = makeChild(1234)

    await expect(terminateProcessTree(child as never, 'SIGTERM')).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('on non-win32 calls child.kill with undefined when no signal is provided', async () => {
    setPlatform('darwin')
    const child = makeChild(1234)

    await expect(terminateProcessTree(child as never)).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith(undefined)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
