import { describe, expect, it, vi } from 'vitest'

import { createIpcHandlerRegistry } from './ipc-handler-registry'

describe('createIpcHandlerRegistry', () => {
  it('registers every native handler but routes only allowlisted Web RPC channels', async () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      nativeHandlers.set(channel, handler)
    })
    const registry = createIpcHandlerRegistry({ handle } as never)

    registry.ipcMainHandle('projects:list', (_event, request) => ({ request }))
    registry.ipcMainHandle('test:unsafe', () => ({ exposed: true }))

    expect([...nativeHandlers.keys()]).toEqual(['projects:list', 'test:unsafe'])
    expect(registry.webRpc.channels()).toEqual(['projects:list'])
    await expect(
      registry.webRpc.invoke('projects:list', 'client-a', [{ page: 1 }])
    ).resolves.toEqual({ request: { page: 1 } })
    await expect(registry.webRpc.invoke('test:unsafe', 'client-a', [])).rejects.toThrow(
      'Unknown Web RPC channel'
    )
  })

  it('uses stable lifecycle senders and releases them without patching ipcMain.handle', async () => {
    const handle = vi.fn()
    const registry = createIpcHandlerRegistry({ handle } as never)
    const destroyed = vi.fn()
    registry.ipcMainHandle('projects:list', (event: unknown) => {
      const sender = (
        event as {
          sender: {
            id: number
            lifecycleClientId: string
            once: (event: string, listener: () => void) => unknown
          }
        }
      ).sender
      sender.once('destroyed', destroyed)
      return { senderId: sender.id, lifecycleClientId: sender.lifecycleClientId }
    })

    const first = (await registry.webRpc.invoke('projects:list', 'browser-1', [])) as {
      senderId: number
      lifecycleClientId: string
    }
    const second = (await registry.webRpc.invoke('projects:list', 'browser-1', [])) as typeof first
    expect(second.senderId).toBe(first.senderId)
    expect(first.lifecycleClientId).toBe('web:browser-1')

    registry.webRpc.releaseClient('browser-1')
    expect(destroyed).toHaveBeenCalledTimes(2)

    const reconnected = (await registry.webRpc.invoke(
      'projects:list',
      'browser-1',
      []
    )) as typeof first
    expect(reconnected.senderId).not.toBe(first.senderId)
    expect(reconnected.lifecycleClientId).toBe(first.lifecycleClientId)
    expect(handle).toHaveBeenCalledTimes(1)
    registry.webRpc.dispose()
  })

  it('scopes remote pairing authority to the current Web RPC invocation', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    registry.ipcMainHandle(
      'remote-access:get-snapshot',
      (event: unknown) =>
        (event as { sender: { canManageRemotePairing?: boolean } }).sender
          .canManageRemotePairing === true
    )

    await expect(
      registry.webRpc.invoke('remote-access:get-snapshot', 'browser-1', [], {
        canManageRemotePairing: true
      })
    ).resolves.toBe(true)
    await expect(
      registry.webRpc.invoke('remote-access:get-snapshot', 'browser-1', [])
    ).resolves.toBe(false)
  })
})
