import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, input: unknown) => void>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: { sender: unknown }, input: unknown) => void): void => {
      handlers.set(channel, handler)
    }
  }
}))

import { registerUnreadTaskIpc } from './unread-task-ipc'

describe('registerUnreadTaskIpc', () => {
  beforeEach(() => handlers.clear())
  afterEach(() => vi.useRealTimers())

  it('accepts only normalized visibility from the current main renderer', async () => {
    const sender = { id: 1 }
    const controller = { syncViewState: vi.fn(async () => undefined) }
    registerUnreadTaskIpc({
      getMainWindow: () => ({ webContents: sender }),
      controller
    })

    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.(
      { sender },
      { visibleSessionId: 'session-1', existingSessionIds: ['session-1'] }
    )
    const visibility = probe.confirmSessionVisible('session-2')
    const challengeId = sender.send.mock.calls[0]?.[1]
    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.(
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
    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.(
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

    handlers.get('notifications:sync-unread-view')?.({ sender }, input)
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

    handlers.get('notifications:sync-unread-view')?.({ sender }, { visibleSessionId: 'session-1' })
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(error)
  })
})
