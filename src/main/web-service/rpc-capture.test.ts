import { describe, expect, it, vi } from 'vitest'

import { installRpcCapture } from './rpc-capture'

describe('installRpcCapture', () => {
  it('records handlers, invokes them with stable client senders, and releases clients', async () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        nativeHandlers.set(channel, handler)
      })
    }
    const capture = installRpcCapture(ipcMain as never)
    const destroyed = vi.fn()

    ipcMain.handle('example:sum', (...args: unknown[]) => {
      const [event, left, right] = args as [
        { sender: { id: number; once: (event: string, listener: () => void) => unknown } },
        number,
        number
      ]
      const sender = event.sender
      sender.once('destroyed', destroyed)
      return { result: left + right, senderId: sender.id }
    })

    const first = (await capture.invoke('example:sum', 'client-a', [2, 3])) as {
      result: number
      senderId: number
    }
    const second = (await capture.invoke('example:sum', 'client-a', [4, 5])) as {
      senderId: number
    }
    expect(first.result).toBe(5)
    expect(first.senderId).toBeLessThan(0)
    expect(second.senderId).toBe(first.senderId)
    expect(capture.channels()).toEqual(['example:sum'])
    expect(nativeHandlers.has('example:sum')).toBe(true)

    capture.releaseClient('client-a')
    expect(destroyed).toHaveBeenCalledTimes(2)
    capture.dispose()
  })

  it('rejects unknown channels', async () => {
    const capture = installRpcCapture({ handle: vi.fn() } as never)
    await expect(capture.invoke('missing', 'client', [])).rejects.toThrow('Unknown RPC channel')
    capture.dispose()
  })

  it('preserves lifecycle identity when a web client sender is recreated', async () => {
    const ipcMain = { handle: vi.fn() }
    const capture = installRpcCapture(ipcMain as never)
    ipcMain.handle('example:identity', (event: unknown) => {
      const sender = (event as { sender: { id: number; lifecycleClientId?: string } }).sender
      return { senderId: sender.id, lifecycleClientId: sender.lifecycleClientId }
    })

    const first = (await capture.invoke('example:identity', 'browser-1', [])) as {
      senderId: number
      lifecycleClientId: string
    }
    capture.releaseClient('browser-1')
    const reconnected = (await capture.invoke('example:identity', 'browser-1', [])) as typeof first

    expect(reconnected.senderId).not.toBe(first.senderId)
    expect(first.lifecycleClientId).toBe('web:browser-1')
    expect(reconnected.lifecycleClientId).toBe(first.lifecycleClientId)
    capture.dispose()
  })
})
