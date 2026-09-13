import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEvents = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return new EventEmitter()
})
vi.mock('electron', () => ({ ipcMain: ipcEvents }))

import { registerUnreadTaskIpc } from './unread-task-ipc'

describe('registerUnreadTaskIpc', () => {
  beforeEach(() => ipcEvents.removeAllListeners())
  afterEach(() => vi.useRealTimers())

  it('accepts only normalized visibility from the current main renderer', async () => {
    const sender = { id: 1 }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      {
        visibleSessionId: ' session-2 ',
        existingSessionIds: ['session-2', 'session-1', 'session-2']
      }
    )
    await Promise.resolve()

    expect(controller.syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-2' })
  })

  it('accepts visibility without an authoritative session set', async () => {
    const sender = { id: 1 }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { visibleSessionId: ' session-2 ' }
    )
    await Promise.resolve()

    expect(controller.syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-2' })
  })

  it('challenges the current main renderer and resolves from its matching visibility ack', async () => {
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    const visibility = probe.confirmSessionVisible('session-2')
    const challengeId = sender.send.mock.calls[0]?.[1]

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { challengeId, visibleSessionId: 'session-2' }
    )

    await expect(visibility).resolves.toBe(true)
    expect(controller.syncViewState).not.toHaveBeenCalled()
  })

  it('settles a challenge immediately while an earlier projection persistence is pending', async () => {
    let finishProjection: (() => void) | undefined
    const projection = new Promise<void>((resolve) => {
      finishProjection = resolve
    })
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const controller = { syncViewState: vi.fn(() => projection) }
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { visibleSessionId: 'session-1', existingSessionIds: ['session-1'] }
    )
    const visibility = probe.confirmSessionVisible('session-2')
    const challengeId = sender.send.mock.calls[0]?.[1]
    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { challengeId, visibleSessionId: 'session-2' }
    )

    await expect(visibility).resolves.toBe(true)
    expect(controller.syncViewState).toHaveBeenCalledTimes(1)
    finishProjection?.()
    await projection
  })

  it('ignores legacy session-catalog data while preserving valid visibility', async () => {
    const sender = { id: 1 }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      {
        visibleSessionId: 'session-2',
        existingSessionIds: ['session-1', 'session-2']
      }
    )
    await Promise.resolve()

    expect(controller.syncViewState).toHaveBeenCalledWith({ visibleSessionId: 'session-2' })
  })

  it('fails a visibility challenge closed when the renderer reports another session', async () => {
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller: { syncViewState: vi.fn(async () => undefined) }
    })

    const visibility = probe.confirmSessionVisible('session-2')
    const challengeId = sender.send.mock.calls[0]?.[1]
    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { challengeId, visibleSessionId: 'session-1' }
    )

    await expect(visibility).resolves.toBe(false)
  })

  it('fails a visibility challenge closed and reports a renderer send error', async () => {
    const error = new Error('renderer destroyed')
    const onError = vi.fn()
    const sender = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw error
      })
    }
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller: { syncViewState: vi.fn(async () => undefined) },
      onError
    })

    await expect(probe.confirmSessionVisible('session-2')).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('fails a visibility challenge closed when the renderer does not answer', async () => {
    vi.useFakeTimers()
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller: { syncViewState: vi.fn(async () => undefined) },
      probeTimeoutMs: 50
    })

    const visibility = probe.confirmSessionVisible('session-2')
    await vi.advanceTimersByTimeAsync(50)

    await expect(visibility).resolves.toBe(false)
  })

  it('ignores calls from a preview or stale renderer', () => {
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: { id: 1 } }),
      controller
    })

    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender: { id: 2 } },
      { visibleSessionId: 'session-1' }
    )
    expect(controller.syncViewState).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { visibleSessionId: 123 },
    { visibleSessionId: 'x'.repeat(513) },
    { challengeId: 0 },
    { challengeId: 1.5 }
  ])('ignores malformed view state: %j', (input) => {
    const sender = { id: 1 }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    ipcEvents.emit('notifications:sync-unread-view', { sender }, input)
    expect(controller.syncViewState).not.toHaveBeenCalled()
  })

  it('reports an unexpected controller rejection without creating an unhandled promise', async () => {
    const sender = { id: 1 }
    const error = new Error('sync failed')
    const onError = vi.fn()
    const controller = { syncViewState: vi.fn(() => Promise.reject(error)) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller,
      onError
    })

    ipcEvents.emit('notifications:sync-unread-view', { sender }, { visibleSessionId: 'session-1' })
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(error)
  })

  it('disposes only its listener and fails all pending and future probes closed without timers', async () => {
    vi.useFakeTimers()
    const sender = { id: 1, send: vi.fn(), isDestroyed: () => false }
    const controller = { syncViewState: vi.fn(async () => {}) }
    const external = vi.fn()
    ipcEvents.on('notifications:sync-unread-view', external)
    const probe = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })
    const first = probe.confirmSessionVisible('session-1')
    const second = probe.confirmSessionVisible('session-2')
    const lateListener = ipcEvents.listeners('notifications:sync-unread-view')[1]
    const challengeId = sender.send.mock.calls[0][1]
    expect(vi.getTimerCount()).toBe(2)
    probe.dispose()
    probe.dispose()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender },
      { challengeId, visibleSessionId: 'session-1' }
    )
    lateListener({ sender }, { visibleSessionId: 'session-1' })
    expect(external).toHaveBeenCalledOnce()
    expect(controller.syncViewState).not.toHaveBeenCalled()
    expect(ipcEvents.listeners('notifications:sync-unread-view')).toEqual([external])
    sender.send.mockClear()
    await expect(probe.confirmSessionVisible('session-3')).resolves.toBe(false)
    expect(sender.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('delivers a visibility projection once after disposal and reinstallation', async () => {
    const sender = { id: 1 }
    const old = { syncViewState: vi.fn(async () => {}) }
    const current = { syncViewState: vi.fn(async () => {}) }
    const previous = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller: old
    })
    previous.dispose()
    const next = registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller: current
    })
    ipcEvents.emit('notifications:sync-unread-view', { sender }, { visibleSessionId: 'session-1' })
    await Promise.resolve()
    expect(old.syncViewState).not.toHaveBeenCalled()
    expect(current.syncViewState).toHaveBeenCalledExactlyOnceWith({ visibleSessionId: 'session-1' })
    next.dispose()
  })
})
