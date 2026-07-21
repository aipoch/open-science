import { beforeEach, describe, expect, it, vi } from 'vitest'

import { APP } from '../../shared/app-config'
import type { UpdateStrategy } from './strategy'

const handlers = new Map<string, () => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler)
  }
}))

const { registerUpdateIpcHandlers } = await import('./ipc')

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
