import { describe, expect, it, vi } from 'vitest'

import { createOfficePreviewViewFactory } from './office-preview-view'

describe('createOfficePreviewViewFactory', () => {
  it('loads the isolated runtime and forwards state only from its own webContents', async () => {
    const addChildView = vi.fn()
    const removeChildView = vi.fn()
    const send = vi.fn()
    const close = vi.fn()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const webContents = {
      id: 91,
      send,
      close,
      isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
        listeners.set(event, listener)
      ),
      off: vi.fn((event: string) => listeners.delete(event))
    }
    const platformView = {
      webContents,
      setBounds: vi.fn(),
      setVisible: vi.fn()
    }
    let runtimeStateListener:
      ((senderId: number, state: { sessionId: string; phase: 'ready' }) => void) | undefined
    const removeRuntimeStateListener = vi.fn()
    const loadRuntime = vi.fn().mockResolvedValue(undefined)
    const onState = vi.fn()
    const onGone = vi.fn().mockResolvedValue(undefined)
    const factory = createOfficePreviewViewFactory({
      resolveParentWindow: vi.fn().mockReturnValue({ addChildView, removeChildView }),
      createPlatformView: vi.fn().mockReturnValue(platformView),
      listenRuntimeState: (listener) => {
        runtimeStateListener = listener
        return removeRuntimeStateListener
      },
      loadRuntime
    })
    const child = factory({ parentOwnerId: 7, sessionId: 'session-1', onState, onGone })
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.xlsx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'xlsx' as const,
      name: 'report.xlsx',
      attempt: 0
    }

    await child.start(start)
    runtimeStateListener?.(92, { sessionId: 'session-1', phase: 'ready' })
    runtimeStateListener?.(91, { sessionId: 'session-1', phase: 'ready' })

    expect(addChildView).toHaveBeenCalledWith(platformView)
    expect(loadRuntime).toHaveBeenCalledWith(webContents)
    expect(send).toHaveBeenCalledWith('office-preview-runtime:start', start)
    expect(onState).toHaveBeenCalledTimes(1)

    const preventDefault = vi.fn()
    listeners.get('will-navigate')?.({ preventDefault }, 'https://example.com')
    expect(preventDefault).toHaveBeenCalledOnce()

    child.close()
    child.close()
    expect(removeRuntimeStateListener).toHaveBeenCalledTimes(1)
    expect(removeChildView).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(listeners.has('will-navigate')).toBe(false)
  })

  it('reports a child crash or hang only once', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const onGone = vi.fn().mockResolvedValue(undefined)
    const platformView = {
      webContents: {
        id: 91,
        send: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
          listeners.set(event, listener)
        ),
        off: vi.fn((event: string) => listeners.delete(event))
      },
      setBounds: vi.fn(),
      setVisible: vi.fn()
    }
    const factory = createOfficePreviewViewFactory({
      resolveParentWindow: vi.fn().mockReturnValue({
        addChildView: vi.fn(),
        removeChildView: vi.fn()
      }),
      createPlatformView: vi.fn().mockReturnValue(platformView),
      listenRuntimeState: () => vi.fn(),
      loadRuntime: vi.fn().mockResolvedValue(undefined)
    })

    factory({ parentOwnerId: 7, sessionId: 'session-1', onState: vi.fn(), onGone })
    listeners.get('unresponsive')?.()
    listeners.get('render-process-gone')?.()
    await Promise.resolve()

    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it('still closes child contents when the parent native hierarchy is already destroyed', () => {
    const close = vi.fn()
    const webContents = {
      id: 92,
      send: vi.fn(),
      close,
      isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }
    const factory = createOfficePreviewViewFactory({
      resolveParentWindow: () => ({
        addChildView: vi.fn(),
        removeChildView: vi.fn(() => {
          throw new TypeError('Object has been destroyed')
        })
      }),
      createPlatformView: () => ({
        webContents,
        setBounds: vi.fn(),
        setVisible: vi.fn()
      }),
      listenRuntimeState: () => vi.fn(),
      loadRuntime: vi.fn().mockResolvedValue(undefined)
    })
    const child = factory({
      parentOwnerId: 7,
      sessionId: 'session-2',
      onState: vi.fn(),
      onGone: vi.fn().mockResolvedValue(undefined)
    })

    expect(() => child.close()).not.toThrow()
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })
})
