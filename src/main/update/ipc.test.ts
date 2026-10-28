import { beforeEach, describe, expect, it, vi } from 'vitest'

import { APP } from '../../shared/app-config'
import type { UpdateStrategy } from './strategy'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

const { registerUpdateIpcHandlers } = await import('./ipc')
type UpdateCommandOwner = import('./ipc').UpdateCommandOwner

const status = { state: 'available' as const, current: '0.5.1', latest: '0.5.2' }

const createStrategy = (): UpdateStrategy => ({
  getInstaller: vi.fn(async () => null),
  revealInstaller: vi.fn(async () => 'unavailable' as const),
  getStatus: vi.fn(() => status),
  check: vi.fn().mockResolvedValue(status),
  download: vi.fn().mockResolvedValue(status),
  cancel: vi.fn().mockResolvedValue(status),
  apply: vi.fn().mockResolvedValue(status)
})

describe('registerUpdateIpcHandlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('validates the application frame before all native update actions including recovery', () => {
    const strategy = createStrategy()
    const validate = vi.fn(() => {
      throw new Error('foreign frame')
    })
    registerUpdateIpcHandlers(strategy, undefined, validate)
    for (const channel of [
      'update:apply',
      'update:cancel',
      'update:recover',
      'update:recheck',
      'update:get-installer',
      'update:reveal-installer',
      'update:get-status'
    ])
      expect(() => handlers.get(channel)!({ sender: 'preview' })).toThrow('foreign frame')
    expect(strategy.apply).not.toHaveBeenCalled()
    expect(strategy.cancel).not.toHaveBeenCalled()
    expect(strategy.getStatus).not.toHaveBeenCalled()
  })

  it('delegates IPC to an injected owner while returning the scheduler strategy', async () => {
    const strategy = createStrategy()
    const owner: UpdateCommandOwner = {
      getInstaller: vi.fn(async () => null),
      revealInstaller: vi.fn(async () => 'unavailable' as const),
      getAppInfo: vi.fn(() => ({ name: 'Injected', version: '1.0.0', copyright: 'test' })),
      getStatus: vi.fn(() => status),
      recheck: vi.fn(),
      recover: vi.fn(),
      check: vi.fn().mockResolvedValue(status),
      download: vi.fn().mockResolvedValue(status),
      cancel: vi.fn().mockResolvedValue(status),
      apply: vi.fn().mockResolvedValue(status)
    }

    expect(registerUpdateIpcHandlers(strategy, owner)).toBe(strategy)
    expect(handlers.get('update:get-app-info')?.()).toMatchObject({ name: 'Injected' })
    await expect(handlers.get('update:check')?.()).resolves.toBe(status)
    await expect(handlers.get('update:download')?.({}, { nonInteractive: true })).resolves.toBe(
      status
    )
    await expect(handlers.get('update:apply')?.({}, { relaunch: false })).resolves.toBe(status)
    expect(owner.download).toHaveBeenCalledWith({ nonInteractive: true })
    expect(owner.apply).toHaveBeenCalledWith({ relaunch: false })
    expect(strategy.check).not.toHaveBeenCalled()
  })

  it('registers every renderer update command and returns the supplied strategy', async () => {
    const strategy = createStrategy()

    expect(registerUpdateIpcHandlers(strategy)).toBe(strategy)
    expect([...handlers.keys()]).toEqual([
      'update:recheck',
      'update:recover',
      'update:get-app-info',
      'update:get-status',
      'update:get-installer',
      'update:reveal-installer',
      'update:check',
      'update:download',
      'update:cancel',
      'update:apply'
    ])

    expect(handlers.get('update:get-app-info')?.()).toEqual({
      name: APP.name,
      version: status.current,
      copyright: APP.copyright
    })
    expect(handlers.get('update:get-status')?.()).toBe(status)
    await expect(handlers.get('update:get-installer')?.({}, '/untrusted')).resolves.toBeNull()
    await expect(handlers.get('update:reveal-installer')?.({}, '/untrusted')).resolves.toBe(
      'unavailable'
    )
    expect(strategy.getInstaller).toHaveBeenCalledWith()
    expect(strategy.revealInstaller).toHaveBeenCalledWith()
    await expect(handlers.get('update:check')?.()).resolves.toBe(status)
    await expect(handlers.get('update:download')?.()).resolves.toBe(status)
    await expect(handlers.get('update:cancel')?.()).resolves.toBe(status)
    await expect(handlers.get('update:apply')?.()).resolves.toBe(status)

    expect(strategy.check).toHaveBeenCalledTimes(1)
    expect(strategy.download).toHaveBeenCalledTimes(1)
    expect(strategy.cancel).toHaveBeenCalledTimes(1)
    expect(strategy.apply).toHaveBeenCalledTimes(1)
  })
})

await (
  await import('../../../test/runtime-host')
).configureTestElectronHost(await import('electron'))
