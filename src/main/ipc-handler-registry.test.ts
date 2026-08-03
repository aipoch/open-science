import { describe, expect, it, vi } from 'vitest'

import { createWebCallerContext } from './caller-context'
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
      registry.webRpc.invoke('projects:list', createWebCallerContext('client-a'), [{ page: 1 }])
    ).resolves.toEqual({ request: { page: 1 } })
    await expect(
      registry.webRpc.invoke('test:unsafe', createWebCallerContext('client-a'), [])
    ).rejects.toThrow('Unknown Web RPC channel')
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

    const first = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )) as {
      senderId: number
      lifecycleClientId: string
    }
    const second = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )) as typeof first
    expect(second.senderId).toBe(first.senderId)
    expect(first.lifecycleClientId).toBe('web:browser-1')

    registry.webRpc.releaseClient('browser-1')
    expect(destroyed).toHaveBeenCalledTimes(2)

    const reconnected = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )) as typeof first
    expect(reconnected.senderId).not.toBe(first.senderId)
    expect(reconnected.lifecycleClientId).toBe(first.lifecycleClientId)
    expect(handle).toHaveBeenCalledTimes(1)
    registry.webRpc.dispose()
  })

  it('scopes remote pairing authority to the current Web RPC invocation', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    registry.ipcMainHandle('remote-access:get-snapshot', (event: unknown) =>
      (
        event as { sender: { callerContext: { authorities: readonly string[] } } }
      ).sender.callerContext.authorities.includes('manage-remote-pairing')
    )

    await expect(
      registry.webRpc.invoke(
        'remote-access:get-snapshot',
        createWebCallerContext('browser-1', {
          location: 'remote',
          authorities: ['manage-remote-pairing']
        }),
        []
      )
    ).resolves.toBe(true)
    await expect(
      registry.webRpc.invoke('remote-access:get-snapshot', createWebCallerContext('browser-1'), [])
    ).resolves.toBe(false)
  })

  it('does not leak authority between concurrent calls from the same Web client', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    let resumeFirst!: () => void
    const firstPaused = new Promise<void>((resolve) => {
      resumeFirst = resolve
    })
    registry.ipcMainHandle(
      'remote-access:get-snapshot',
      async (event: unknown, request: { pause?: boolean }) => {
        if (request.pause) await firstPaused
        return (
          event as { sender: { callerContext: { authorities: readonly string[] } } }
        ).sender.callerContext.authorities.includes('manage-remote-pairing')
      }
    )

    const trusted = registry.webRpc.invoke(
      'remote-access:get-snapshot',
      createWebCallerContext('browser-1', {
        location: 'remote',
        authorities: ['manage-remote-pairing']
      }),
      [{ pause: true }]
    )
    await expect(
      registry.webRpc.invoke(
        'remote-access:get-snapshot',
        createWebCallerContext('browser-1', { location: 'remote' }),
        [{}]
      )
    ).resolves.toBe(false)
    resumeFirst()
    await expect(trusted).resolves.toBe(true)
  })

  it('rejects a caller whose authorization became stale before dispatch', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    const handler = vi.fn()
    registry.ipcMainHandle('projects:list', handler)
    const context = createWebCallerContext('browser-1', {
      location: 'remote',
      isAuthorizationCurrent: () => false
    })

    await expect(registry.webRpc.invoke('projects:list', context, [])).rejects.toThrow(
      'authorization is no longer current'
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('uninstalls only the handlers registered by a completed installation scope', () => {
    const removeHandler = vi.fn()
    const registry = createIpcHandlerRegistry({ handle: vi.fn(), removeHandler } as never)
    registry.ipcMainHandle('projects:list', vi.fn())

    const scope = registry.createInstallationScope()
    registry.ipcMainHandle('test:scoped', vi.fn())
    const cleanup = vi.fn()
    const installation = scope.complete(cleanup)

    installation.uninstall()
    installation.uninstall()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(removeHandler).toHaveBeenCalledOnce()
    expect(removeHandler).toHaveBeenCalledWith('test:scoped')
  })

  it('rolls back handlers registered before an installation failure', () => {
    const removeHandler = vi.fn()
    const registry = createIpcHandlerRegistry({ handle: vi.fn(), removeHandler } as never)
    const scope = registry.createInstallationScope()
    registry.ipcMainHandle('test:partial', vi.fn())

    scope.rollback()

    expect(removeHandler).toHaveBeenCalledWith('test:partial')
  })

  it('records a rejected native handler once without retaining its payload', async () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      nativeHandlers.set(channel, handler)
    })
    const warn = vi.fn()
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125)
    const registry = createIpcHandlerRegistry({ handle } as never, { log: { warn }, now })
    const rejection = new Error('private native failure')
    registry.ipcMainHandle('projects:list', async () => {
      throw rejection
    })

    await expect(
      nativeHandlers.get('projects:list')?.(
        { sender: { id: 42 } },
        { token: 'native-secret', path: '/private/native.txt' }
      )
    ).rejects.toBe(rejection)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('ipc handler rejected', {
      channel: 'projects:list',
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human',
      durationMs: 25,
      errorCategory: 'error'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('native-secret')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/native.txt')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private native failure')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('42')
  })

  it('records a rejected Web RPC handler once using the supplied caller vocabulary', async () => {
    const warn = vi.fn()
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(18)
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never, { log: { warn }, now })
    const rejection = new TypeError('private Web failure')
    registry.ipcMainHandle('projects:list', async () => {
      throw rejection
    })

    await expect(
      registry.webRpc.invoke(
        'projects:list',
        createWebCallerContext('secret-client-id', {
          location: 'remote',
          principalKind: 'automation',
          actionOrigin: 'agent-session'
        }),
        [{ token: 'web-secret' }]
      )
    ).rejects.toBe(rejection)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('ipc handler rejected', {
      channel: 'projects:list',
      surface: 'web',
      location: 'remote',
      principalKind: 'automation',
      actionOrigin: 'agent-session',
      durationMs: 8,
      errorCategory: 'type'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-client-id')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('web-secret')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private Web failure')
  })
})
