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

  it('delegates IPC to an injected owner while returning the scheduler strategy', async () => {
    const strategy = createStrategy()
    const owner: UpdateCommandOwner = {
      getAppInfo: vi.fn(() => ({ name: 'Injected', version: '1.0.0', copyright: 'test' })),
      getStatus: vi.fn(() => status),
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
      'update:get-app-info',
      'update:get-status',
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
