import { describe, expect, it, vi } from 'vitest'

import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent } from './caller-lifecycle'
import { createIpcHandlerRegistry } from './ipc-handler-registry'

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

  it('replaces a native surface lease when a new main-frame document starts navigating', () => {
    const nativeHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const registry = createIpcHandlerRegistry({
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        nativeHandlers.set(channel, handler)
    } as never)
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const on = (name: string, listener: (...args: unknown[]) => void): void => {
      const registered = listeners.get(name) ?? new Set()
      registered.add(listener)
      listeners.set(name, registered)
    }
    const sender = {
      id: 42,
      on,
      once: on,
      removeListener: (name: string, listener: (...args: unknown[]) => void): void => {
        listeners.get(name)?.delete(listener)
      }
    }
    const emit = (name: string, ...args: unknown[]): void => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    }
    registry.ipcMainHandle('projects:list', (event) => callerLeaseForEvent(event))

    const first = nativeHandlers.get('projects:list')?.({ sender }) as ApplicationCallerLease
    const staleNavigationListener = [...(listeners.get('did-start-navigation') ?? [])][0]
    emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(nativeHandlers.get('projects:list')?.({ sender })).toBe(first)
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(nativeHandlers.get('projects:list')?.({ sender })).toBe(first)

    emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(first.signal.aborted).toBe(true)

    const replacement = nativeHandlers.get('projects:list')?.({ sender }) as ApplicationCallerLease
    expect(replacement.generation).toBeGreaterThan(first.generation)
    expect(replacement.signal.aborted).toBe(false)

    staleNavigationListener?.({ isMainFrame: true, isSameDocument: false })
    expect(replacement.signal.aborted).toBe(false)
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
    registry.dispose()

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
})
