import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const builds = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  packages: vi.fn(),
  backend: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ rm: builds.invalidate }))
vi.mock('./build-dev-packages.mjs', () => ({
  packageBuildProjects: () => [],
  buildDevPackages: builds.packages
}))
vi.mock('./build-backend.mjs', () => ({
  createBackendBuilder: async () => ({ rebuild: builds.backend, dispose: builds.dispose })
}))
import { devBuildWatch } from './dev-build-watch.mjs'

it('does not lose a save received during a failed build, and waits for an in-flight build on close', async () => {
  vi.useFakeTimers()
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
  const server = { watcher, config: { logger, optimizeDeps: {} }, restart: vi.fn() }
  const plugin = devBuildWatch()
  const configure = plugin.configureServer
  const close = plugin.closeBundle
  if (typeof configure !== 'function' || typeof close !== 'function')
    throw new Error('Missing dev hooks')
  let fail!: (error: Error) => void
  let finish!: () => void
  builds.packages
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
  builds.backend.mockResolvedValue(undefined)
  try {
    // These hooks only use Vite's watcher/logger/restart contract. Real Vite is covered separately.
    await configure.call({} as never, server as never)
    watcher.emit('all', 'change', resolve('src/main/example.ts'))
    await vi.advanceTimersByTimeAsync(100)
    expect(builds.packages).toHaveBeenCalledTimes(1)
    expect(builds.invalidate).toHaveBeenCalledWith(resolve('out/backend/dev-build.json'), {
      force: true
    })
    expect(builds.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      builds.packages.mock.invocationCallOrder[0]
    )
    watcher.emit('all', 'change', resolve('src/main/example.ts'))
    await vi.advanceTimersByTimeAsync(100)
    fail(new Error('first save did not compile'))
    await vi.advanceTimersByTimeAsync(200)
    expect(builds.packages).toHaveBeenCalledTimes(2)
    expect(builds.backend).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Build ready'))
    expect(server.restart).not.toHaveBeenCalled()
    watcher.emit('all', 'change', resolve('src/main/example.ts'))
    await vi.advanceTimersByTimeAsync(100)
    const closing = close.call({} as never)
    expect(builds.dispose).not.toHaveBeenCalled()
    finish()
    await closing
    expect(builds.dispose).toHaveBeenCalledTimes(1)
    expect(builds.backend).toHaveBeenCalledTimes(1)
    expect(watcher.listenerCount('all')).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
