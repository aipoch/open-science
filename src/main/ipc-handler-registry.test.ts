import { describe, expect, it, vi } from 'vitest'

import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent } from './caller-lifecycle'
import { createTaskCallerContext, createWebCallerContext } from './caller-context'
import { createIpcHandlerRegistry } from './ipc-handler-registry'
import { createManagedPreviewOwnerRegistry } from './managed-preview-ipc'

describe('createIpcHandlerRegistry', () => {
  it('keeps injected handler registrars callable without an Electron event', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const handler = vi.fn(() => 'complete')
    registry.ipcMainHandle('test:direct-handler', handler)

    expect(nativeHandlers.get('test:direct-handler')?.(undefined)).toBe('complete')
    expect(handler).toHaveBeenCalledWith(undefined)
  })

  it('aborts a native surface lease before a destroyed sender can dispatch again', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const listeners = new Map<string, () => void>()
    const sender = {
      id: 42,
      once: (name: string, listener: () => void) => listeners.set(name, listener)
    }
    const handler = vi.fn((event) => callerLeaseForEvent(event))
    registry.ipcMainHandle('projects:list', handler)

    const lease = nativeHandlers.get('projects:list')?.({ sender })
    expect(lease).toMatchObject({ leaseId: 'electron:42', generation: 1 })

    listeners.get('destroyed')?.()
    expect((lease as { signal: AbortSignal }).signal.aborted).toBe(true)
    expect(() => nativeHandlers.get('projects:list')?.({ sender })).toThrow(
      'Caller lease is no longer current.'
    )
    expect(handler).toHaveBeenCalledOnce()
  })

  it('renews a crashed WebContents lease but keeps destroyed terminal', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const listeners = new Map<string, Array<() => void>>()
    const sender = {
      id: 42,
      once: (name: string, listener: () => void): void => {
        const registered = listeners.get(name) ?? []
        registered.push(listener)
        listeners.set(name, registered)
      }
    }
    const dispatchedEvents: Array<{ sender: object }> = []
    const handler = vi.fn((event: { sender: object }) => {
      dispatchedEvents.push(event)
      return callerLeaseForEvent(event)
    })
    registry.ipcMainHandle('projects:list', handler)

    const first = nativeHandlers.get('projects:list')?.({ sender }) as {
      generation: number
      signal: AbortSignal
    }
    listeners.get('render-process-gone')?.[0]?.()
    const replacement = nativeHandlers.get('projects:list')?.({ sender }) as typeof first

    expect(replacement.generation).toBeGreaterThan(first.generation)
    expect(replacement.signal.aborted).toBe(false)
    expect(callerLeaseForEvent(dispatchedEvents[0])).toBe(first)
    expect(callerLeaseForEvent(dispatchedEvents[1])).toBe(replacement)
    listeners.get('render-process-gone')?.[0]?.()
    expect(replacement.signal.aborted).toBe(false)

    for (const destroyed of listeners.get('destroyed') ?? []) destroyed()
    expect(replacement.signal.aborted).toBe(true)
    expect(() => nativeHandlers.get('projects:list')?.({ sender })).toThrow(
      'Caller lease is no longer current.'
    )
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps a replacement Electron generation isolated from stale teardown callbacks', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const sender = (
      listeners: Map<string, () => void>
    ): { id: number; once: (name: string, listener: () => void) => void } => ({
      id: 7,
      once: (name: string, listener: () => void) => {
        listeners.set(name, listener)
      }
    })
    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))

    const firstListeners = new Map<string, () => void>()
    const first = nativeHandlers.get('projects:list')?.({ sender: sender(firstListeners) }) as {
      generation: number
      signal: AbortSignal
    }
    firstListeners.get('destroyed')?.()

    const replacementListeners = new Map<string, () => void>()
    const replacement = nativeHandlers.get('projects:list')?.({
      sender: sender(replacementListeners)
    }) as typeof first
    firstListeners.get('render-process-gone')?.()

    expect(replacement.generation).toBeGreaterThan(first.generation)
    expect(replacement.signal.aborted).toBe(false)
  })

  it('keeps caller-controlled Web lease ids isolated from Electron ownership', async () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))

    const electronLease = nativeHandlers.get('projects:list')?.({ sender: { id: 7 } }) as {
      leaseId: string
      signal: AbortSignal
      isCurrent: () => boolean
    }
    const webLease = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('electron:7'),
      []
    )) as typeof electronLease

    expect(electronLease.leaseId).toBe('electron:7')
    expect(webLease.leaseId).toBe('electron:7')
    expect(electronLease.signal.aborted).toBe(false)
    expect(electronLease.isCurrent()).toBe(true)
    expect(webLease.isCurrent()).toBe(true)
  })

  it('keeps colliding Web and Task callers isolated when the Web client is released', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))

    const webLease = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('headless-task-api'),
      []
    )) as ApplicationCallerLease
    const taskLease = (await registry.webRpc.invoke(
      'projects:list',
      createTaskCallerContext(),
      []
    )) as ApplicationCallerLease
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    }
    const owners = createManagedPreviewOwnerRegistry(resources as never)
    const webOwner = owners.register(webLease)
    const taskOwner = owners.register(taskLease)

    expect(taskLease).not.toBe(webLease)
    expect(taskLease.signal).not.toBe(webLease.signal)
    expect(taskOwner.ownerId).not.toBe(webOwner.ownerId)

    registry.webRpc.releaseClient('headless-task-api')

    expect(webLease.signal.aborted).toBe(true)
    expect(taskLease.signal.aborted).toBe(false)
    expect(taskLease.isCurrent()).toBe(true)
    expect(resources.releaseOwner).toHaveBeenCalledOnce()
    expect(resources.releaseOwner).toHaveBeenCalledWith(webOwner.ownerId)
    expect(owners.register(taskLease)).toBe(taskOwner)

    registry.webRpc.dispose()
    expect(taskLease.signal.aborted).toBe(true)
  })

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

  it('starts fresh Web and Task lease epochs when handlers are registered after disposal', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))

    const disposedWebLease = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )) as ApplicationCallerLease
    const disposedTaskLease = (await registry.webRpc.invoke(
      'projects:list',
      createTaskCallerContext(),
      []
    )) as ApplicationCallerLease
    registry.webRpc.dispose()

    expect(disposedWebLease.signal.aborted).toBe(true)
    expect(disposedWebLease.isCurrent()).toBe(false)
    expect(disposedTaskLease.signal.aborted).toBe(true)
    expect(disposedTaskLease.isCurrent()).toBe(false)

    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))
    const replacementWebLease = (await registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )) as ApplicationCallerLease
    const replacementTaskLease = (await registry.webRpc.invoke(
      'projects:list',
      createTaskCallerContext(),
      []
    )) as ApplicationCallerLease

    expect(replacementWebLease).not.toBe(disposedWebLease)
    expect(replacementWebLease.signal).not.toBe(disposedWebLease.signal)
    expect(replacementWebLease.signal.aborted).toBe(false)
    expect(replacementWebLease.isCurrent()).toBe(true)
    expect(replacementTaskLease).not.toBe(disposedTaskLease)
    expect(replacementTaskLease.signal).not.toBe(disposedTaskLease.signal)
    expect(replacementTaskLease.signal.aborted).toBe(false)
    expect(replacementTaskLease.isCurrent()).toBe(true)

    registry.webRpc.releaseClient('browser-1')
    expect(replacementWebLease.signal.aborted).toBe(true)
    expect(replacementTaskLease.signal.aborted).toBe(false)
  })

  it('keeps disposed native handler epochs terminal after later registrations', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const initialHandler = vi.fn((event) => callerLeaseForEvent(event))
    registry.ipcMainHandle('projects:list', initialHandler)
    const disposedWrapper = nativeHandlers.get('projects:list')
    const sender = { id: 42 }

    const disposedLease = disposedWrapper?.({ sender }) as ApplicationCallerLease
    registry.webRpc.dispose()

    expect(() => disposedWrapper?.({ sender })).toThrow('registry is disposed')
    expect(initialHandler).toHaveBeenCalledOnce()

    const replacementHandler = vi.fn((event) => callerLeaseForEvent(event))
    registry.ipcMainHandle('projects:list', replacementHandler)
    const replacementLease = nativeHandlers.get('projects:list')?.({
      sender
    }) as ApplicationCallerLease

    expect(() => disposedWrapper?.({ sender })).toThrow('registry is disposed')
    expect(initialHandler).toHaveBeenCalledOnce()
    expect(replacementHandler).toHaveBeenCalledOnce()
    expect(disposedLease.signal.aborted).toBe(true)
    expect(disposedLease.isCurrent()).toBe(false)
    expect(replacementLease.signal.aborted).toBe(false)
    expect(replacementLease.isCurrent()).toBe(true)
  })

  it('lets in-flight Web work observe final client release without cancelling its result', async () => {
    const registry = createIpcHandlerRegistry({ handle: vi.fn() } as never)
    let resolve!: (value: string) => void
    const pending = new Promise<string>((complete) => (resolve = complete))
    const observedRelease = vi.fn()
    registry.ipcMainHandle('projects:list', (event: unknown) => {
      callerLeaseForEvent(event as { sender: object }).signal.addEventListener(
        'abort',
        observedRelease,
        { once: true }
      )
      return pending
    })

    const invocation = registry.webRpc.invoke(
      'projects:list',
      createWebCallerContext('browser-1'),
      []
    )
    registry.webRpc.releaseClient('browser-1')
    resolve('complete')

    await expect(invocation).resolves.toBe('complete')
    expect(observedRelease).toHaveBeenCalledOnce()
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
