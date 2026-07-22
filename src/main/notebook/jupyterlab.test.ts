import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { JupyterLabManager, type SpawnProcess } from './jupyterlab'

type FakeChild = ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
}

const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    killed: { value: false, writable: true }
  })
  child.kill = vi.fn(() => true)
  return child
}

const exit = (child: FakeChild, code: number): void => {
  Object.defineProperty(child, 'exitCode', { value: code, writable: true })
  child.emit('exit', code, null)
}

describe('JupyterLabManager', () => {
  it('installs when the probe fails, launches, and opens the reported URL', async () => {
    let installed = false
    let launched: FakeChild | undefined
    const spawnProcess = vi.fn<SpawnProcess>((_command, args) => {
      const child = fakeChild()
      if (args.includes('--version')) {
        queueMicrotask(() => {
          exit(child, installed ? 0 : 1)
        })
      } else {
        launched = child
        queueMicrotask(() => child.stderr.write('http://127.0.0.1:4321/lab?token=secret\n'))
      }
      return child
    })
    const ensureInstalled = vi.fn(async () => {
      installed = true
    })
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const manager = new JupyterLabManager({ spawnProcess, openExternal })

    const result = await manager.launch({
      sessionId: 'session-1',
      command: '/env/bin/python',
      notebookPath: '/session/data/session.ipynb',
      rootDir: '/session/data',
      cwd: '/session/data',
      ensureInstalled
    })

    expect(result).toEqual({
      url: 'http://127.0.0.1:4321/lab?token=secret',
      alreadyRunning: false
    })
    expect(ensureInstalled).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(result.url)
    expect(spawnProcess).toHaveBeenLastCalledWith(
      '/env/bin/python',
      expect.arrayContaining([
        '-m',
        'jupyterlab',
        '/session/data/session.ipynb',
        '--no-browser',
        '--ServerApp.port=0',
        '--ServerApp.root_dir=/session/data'
      ]),
      expect.objectContaining({ cwd: '/session/data' })
    )
    expect(launched).toBeDefined()
  })

  it('reopens an already-running session without spawning another process', async () => {
    const launchChild = fakeChild()
    const spawnProcess = vi.fn<SpawnProcess>((_command, args) => {
      if (args.includes('--version')) {
        const probe = fakeChild()
        queueMicrotask(() => {
          exit(probe, 0)
        })
        return probe
      }
      queueMicrotask(() => launchChild.stdout.write('http://localhost:9999/lab?token=t\n'))
      return launchChild
    })
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const manager = new JupyterLabManager({ spawnProcess, openExternal })
    const request = {
      sessionId: 'session-1',
      command: 'python',
      notebookPath: '/data/session.ipynb',
      rootDir: '/data',
      cwd: '/data',
      ensureInstalled: vi.fn()
    }

    await manager.launch(request)
    const second = await manager.launch(request)

    expect(second.alreadyRunning).toBe(true)
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('terminates tracked process trees during shutdown', async () => {
    const launchChild = fakeChild()
    const spawnProcess = vi.fn<SpawnProcess>((_command, args) => {
      if (args.includes('--version')) {
        const probe = fakeChild()
        queueMicrotask(() => {
          exit(probe, 0)
        })
        return probe
      }
      queueMicrotask(() => launchChild.stdout.write('http://localhost:9999/lab?token=t\n'))
      return launchChild
    })
    const terminate = vi.fn().mockResolvedValue({ reaped: true })
    const manager = new JupyterLabManager({
      spawnProcess,
      openExternal: vi.fn().mockResolvedValue(undefined),
      terminate
    })
    await manager.launch({
      sessionId: 'session-1',
      command: 'python',
      notebookPath: '/data/session.ipynb',
      rootDir: '/data',
      cwd: '/data',
      ensureInstalled: vi.fn()
    })

    await expect(manager.shutdownAll()).resolves.toEqual({ reaped: true })
    expect(terminate).toHaveBeenCalledWith(launchChild)
  })
})
