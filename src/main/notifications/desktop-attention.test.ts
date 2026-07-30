import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  createDesktopAttentionController,
  type DesktopAttentionController,
  type DesktopAttentionControllerDeps,
  type DesktopAttentionDock,
  type DesktopAttentionWindow,
  wireDesktopAttention
} from './desktop-attention'

type WindowState = {
  destroyed: boolean
  minimized: boolean
  visible: boolean
}

type MockedAttentionWindow = {
  [Key in keyof DesktopAttentionWindow]: Mock<DesktopAttentionWindow[Key]>
}

type MockedAttentionDock = {
  [Key in keyof DesktopAttentionDock]: Mock<DesktopAttentionDock[Key]>
}

const makeWindow = (state: Partial<WindowState> = {}): MockedAttentionWindow => ({
  flashFrame: vi.fn<(flag: boolean) => void>(),
  isDestroyed: vi.fn(() => state.destroyed ?? false),
  isMinimized: vi.fn(() => state.minimized ?? false),
  isVisible: vi.fn(() => state.visible ?? true)
})

const makeDock = (requestId = 41): MockedAttentionDock => ({
  bounce: vi.fn<DesktopAttentionDock['bounce']>(() => requestId),
  cancelBounce: vi.fn<DesktopAttentionDock['cancelBounce']>()
})

const makeController = (
  overrides: Partial<DesktopAttentionControllerDeps> = {}
): DesktopAttentionController =>
  createDesktopAttentionController({
    platform: 'darwin',
    headless: false,
    isAppFocused: () => false,
    isMainWindowHidden: () => false,
    getMainWindow: () => undefined,
    ...overrides
  })

describe('DesktopAttentionController', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['win32', 'linux'] as const)(
    'flashes a minimized %s taskbar or dock entry even when the window is not visible',
    (platform) => {
      const window = makeWindow({ minimized: true, visible: false })
      const controller = makeController({ platform, getMainWindow: () => window })

      controller.request()

      expect(window.flashFrame).toHaveBeenCalledWith(true)
    }
  )

  it.each(['win32', 'linux'] as const)(
    'does not flash a hidden-to-tray %s window that is still marked minimized',
    (platform) => {
      const window = makeWindow({ minimized: true, visible: false })
      const controller = makeController({
        platform,
        isMainWindowHidden: () => true,
        getMainWindow: () => window
      })

      controller.request()

      expect(window.flashFrame).not.toHaveBeenCalled()
    }
  )

  it.each([
    { platform: 'win32', label: 'hidden', state: { visible: false } },
    { platform: 'linux', label: 'hidden', state: { visible: false } },
    { platform: 'win32', label: 'destroyed', state: { destroyed: true } },
    { platform: 'linux', label: 'destroyed', state: { destroyed: true } }
  ] as const)('does not surface or flash a $label $platform window', ({ platform, state }) => {
    const window = makeWindow(state)
    const controller = makeController({ platform, getMainWindow: () => window })

    controller.request()

    expect(window.flashFrame).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('does nothing without a %s main window', (platform) => {
    const getMainWindow = vi.fn(() => undefined)
    const controller = makeController({ platform, getMainWindow })

    expect(() => controller.request()).not.toThrow()
    expect(getMainWindow).toHaveBeenCalledOnce()
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'does nothing in a headless %s process',
    (platform) => {
      const dock = makeDock()
      const getMainWindow = vi.fn()
      const controller = makeController({ platform, headless: true, getMainWindow, dock })

      controller.request()

      expect(dock.bounce).not.toHaveBeenCalled()
      expect(getMainWindow).not.toHaveBeenCalled()
    }
  )

  it('stops a macOS bounce after five seconds', () => {
    vi.useFakeTimers()
    const dock = makeDock(52)
    const controller = makeController({ dock })

    controller.request()
    vi.advanceTimersByTime(4_999)

    expect(dock.bounce).toHaveBeenCalledWith('critical')
    expect(dock.cancelBounce).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(dock.cancelBounce).toHaveBeenCalledWith(52)
  })

  it.each(['win32', 'linux'] as const)(
    'stops a %s taskbar flash after three seconds',
    (platform) => {
      vi.useFakeTimers()
      const window = makeWindow()
      const controller = makeController({ platform, getMainWindow: () => window })

      controller.request()
      vi.advanceTimersByTime(2_999)

      expect(window.flashFrame).toHaveBeenCalledTimes(1)
      expect(window.flashFrame).toHaveBeenLastCalledWith(true)

      vi.advanceTimersByTime(1)
      expect(window.flashFrame).toHaveBeenLastCalledWith(false)
    }
  )

  it('restarts the five-second macOS window when another approval arrives', () => {
    vi.useFakeTimers()
    const dock = makeDock(53)
    const controller = makeController({ dock })

    controller.request()
    vi.advanceTimersByTime(2_000)
    controller.request()

    expect(dock.bounce).toHaveBeenCalledTimes(2)
    expect(dock.cancelBounce).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(4_999)
    expect(dock.cancelBounce).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(dock.cancelBounce).toHaveBeenCalledTimes(2)
  })

  it('clears an active request when a later request observes app focus', () => {
    let focused = false
    const dock = makeDock(85)
    const controller = makeController({ isAppFocused: () => focused, dock })

    controller.request()
    focused = true
    controller.request()

    expect(dock.cancelBounce).toHaveBeenCalledWith(85)
  })

  it('reports macOS request errors without throwing into the notification flow', () => {
    const error = new Error('dock unavailable')
    const onError = vi.fn()
    const dock = makeDock()
    dock.bounce.mockImplementation(() => {
      throw error
    })
    const controller = makeController({ dock, onError })

    expect(() => controller.request()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })

  it.each(['win32', 'linux'] as const)(
    'reports %s flash request errors without throwing into the notification flow',
    (platform) => {
      const error = new Error('taskbar unavailable')
      const onError = vi.fn()
      const window = makeWindow()
      window.flashFrame.mockImplementation(() => {
        throw error
      })
      const controller = makeController({ platform, getMainWindow: () => window, onError })

      expect(() => controller.request()).not.toThrow()
      expect(onError).toHaveBeenCalledWith(error)
    }
  )

  it('reports macOS cancellation errors and still resets controller state', () => {
    const error = new Error('dock cancellation failed')
    const onError = vi.fn()
    const dock = makeDock(92)
    dock.cancelBounce.mockImplementation(() => {
      throw error
    })
    const controller = makeController({ dock, onError })

    controller.request()

    expect(() => controller.clear()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)

    controller.request()
    expect(dock.bounce).toHaveBeenCalledTimes(2)
  })

  it.each(['win32', 'linux'] as const)(
    'reports %s flash-clear errors and still resets controller state',
    (platform) => {
      const error = new Error('taskbar clear failed')
      const onError = vi.fn()
      const window = makeWindow()
      window.flashFrame.mockImplementation((flag) => {
        if (!flag) throw error
      })
      const controller = makeController({ platform, getMainWindow: () => window, onError })

      controller.request()

      expect(() => controller.clear()).not.toThrow()
      expect(onError).toHaveBeenCalledWith(error)

      controller.request()
      expect(window.flashFrame).toHaveBeenCalledWith(true)
      expect(window.flashFrame).toHaveBeenCalledTimes(3)
    }
  )

  it('reports destroyed-state errors while clearing without throwing', () => {
    const error = new Error('window handle unavailable')
    const onError = vi.fn()
    const window = makeWindow()
    window.isDestroyed.mockReturnValueOnce(false).mockImplementation(() => {
      throw error
    })
    const controller = makeController({
      platform: 'win32',
      getMainWindow: () => window,
      onError
    })

    controller.request()

    expect(() => controller.clear()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('ignores the macOS not-started bounce id returned after a focus race', () => {
    vi.useFakeTimers()
    const dock = makeDock(-1)
    const controller = makeController({ dock })

    controller.request()

    expect(dock.cancelBounce).not.toHaveBeenCalled()
  })
})

describe('wireDesktopAttention', () => {
  it('binds the controller and clears it on app focus and committed quit', () => {
    const listeners = new Map<string, () => void>()
    const controller = { request: vi.fn(), clear: vi.fn() }
    const setAttentionHandlers = vi.fn()

    wireDesktopAttention({
      app: {
        on: (event, listener) => {
          listeners.set(event, listener)
        }
      },
      taskNotifications: { setAttentionHandlers },
      controller
    })

    expect(setAttentionHandlers).toHaveBeenCalledWith(controller)
    listeners.get('browser-window-focus')?.()
    listeners.get('before-quit')?.()
    expect(controller.clear).toHaveBeenCalledTimes(1)

    listeners.get('will-quit')?.()
    expect(controller.clear).toHaveBeenCalledTimes(2)
  })
})
