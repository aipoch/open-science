import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
  }
}))
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn() })
}))
vi.mock('./renderer-broadcast', () => ({
  broadcastToRenderers: vi.fn()
}))

import { registerLifecycleIpcHandlers } from './lifecycle-broadcast'

describe('lifecycle broadcast IPC', () => {
  beforeEach(() => ipcHandlers.clear())

  it('identifies Electron and Web renderers through stable lifecycle client IDs', async () => {
    registerLifecycleIpcHandlers()

    const getClientId = ipcHandlers.get('lifecycle:client-id')
    expect(getClientId?.({ sender: { id: 42 } })).toBe('electron:42')
    expect(getClientId?.({ sender: { id: -2, lifecycleClientId: 'web:browser-1' } })).toBe(
      'web:browser-1'
    )
  })
})
