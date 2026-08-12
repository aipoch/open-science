import { describe, expect, it, vi } from 'vitest'

import {
  createDesktopBadgeAdapter,
  createWindowsBadgeBitmap,
  type DesktopBadgeWindow
} from './desktop-badge'

const makeWindow = (): DesktopBadgeWindow => ({
  isDestroyed: vi.fn(() => false),
  setOverlayIcon: vi.fn()
})

describe('createDesktopBadgeAdapter', () => {
  it('uses the numeric Dock badge on macOS', () => {
    const setBadgeCount = vi.fn(() => true)
    const adapter = createDesktopBadgeAdapter({
      platform: 'darwin',
      setBadgeCount,
      isUnityRunning: () => false,
      getMainWindow: () => undefined,
      createWindowsOverlay: vi.fn()
    })

    adapter.setCount(3)
    adapter.setCount(0)

    expect(setBadgeCount.mock.calls).toEqual([[3], [0]])
  })

  it('sets a Windows overlay with 1-9 and 9+ labels and clears it with null', () => {
    const window = makeWindow()
    const overlays = new Map([
      ['3', { label: '3' }],
      ['9+', { label: '9+' }]
    ])
    const createWindowsOverlay = vi.fn((label: string) => overlays.get(label))
    const adapter = createDesktopBadgeAdapter({
      platform: 'win32',
      setBadgeCount: vi.fn(),
      isUnityRunning: () => false,
      getMainWindow: () => window,
      createWindowsOverlay
    })

    adapter.setCount(3)
    adapter.setCount(19)
    adapter.setCount(0)

    expect(createWindowsOverlay.mock.calls).toEqual([['3'], ['9+']])
    expect(window.setOverlayIcon).toHaveBeenNthCalledWith(1, overlays.get('3'), '3 unread messages')
    expect(window.setOverlayIcon).toHaveBeenNthCalledWith(
      2,
      overlays.get('9+'),
      '19 unread messages'
    )
    expect(window.setOverlayIcon).toHaveBeenNthCalledWith(3, null, '')
  })

  it('waits for a live Windows window and can reapply the count later', () => {
    const windowHolder: { current: DesktopBadgeWindow | undefined } = { current: undefined }
    const createWindowsOverlay = vi.fn(() => ({ badge: true }))
    const adapter = createDesktopBadgeAdapter({
      platform: 'win32',
      setBadgeCount: vi.fn(),
      isUnityRunning: () => false,
      getMainWindow: () => windowHolder.current,
      createWindowsOverlay
    })

    adapter.setCount(2)
    expect(createWindowsOverlay).not.toHaveBeenCalled()

    windowHolder.current = makeWindow()
    adapter.setCount(2)
    expect(windowHolder.current.setOverlayIcon).toHaveBeenCalledTimes(1)
  })

  it('uses Unity numeric badges on Linux and otherwise degrades to a no-op', () => {
    const supported = vi.fn(() => true)
    const setSupportedBadge = vi.fn(() => true)
    const supportedAdapter = createDesktopBadgeAdapter({
      platform: 'linux',
      setBadgeCount: setSupportedBadge,
      isUnityRunning: supported,
      getMainWindow: () => undefined,
      createWindowsOverlay: vi.fn()
    })
    const setUnsupportedBadge = vi.fn(() => true)
    const unsupportedAdapter = createDesktopBadgeAdapter({
      platform: 'linux',
      setBadgeCount: setUnsupportedBadge,
      isUnityRunning: () => false,
      getMainWindow: () => undefined,
      createWindowsOverlay: vi.fn()
    })

    supportedAdapter.setCount(4)
    unsupportedAdapter.setCount(4)

    expect(supported).toHaveBeenCalledTimes(1)
    expect(setSupportedBadge).toHaveBeenCalledWith(4)
    expect(setUnsupportedBadge).not.toHaveBeenCalled()
  })

  it('isolates native badge errors', () => {
    const error = new Error('native badge unavailable')
    const onError = vi.fn()
    const adapter = createDesktopBadgeAdapter({
      platform: 'darwin',
      setBadgeCount: () => {
        throw error
      },
      isUnityRunning: () => false,
      getMainWindow: () => undefined,
      createWindowsOverlay: vi.fn(),
      onError
    })

    expect(() => adapter.setCount(1)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
  })
})

describe('createWindowsBadgeBitmap', () => {
  it('creates a transparent 16x16 BGRA bitmap with distinct prebuilt digit glyphs', () => {
    const one = createWindowsBadgeBitmap('1')
    const ninePlus = createWindowsBadgeBitmap('9+')

    expect(one).toHaveLength(16 * 16 * 4)
    expect(ninePlus).toHaveLength(16 * 16 * 4)
    expect(one.equals(ninePlus)).toBe(false)
    expect([...one].filter((_, index) => index % 4 === 3 && one[index] > 0).length).toBeGreaterThan(
      0
    )
  })
})
