import { beforeEach, describe, expect, it, vi } from 'vitest'

const { watchWindowShortcuts } = vi.hoisted(() => ({
  watchWindowShortcuts: vi.fn()
}))

vi.mock('@electron-toolkit/utils', () => ({
  optimizer: {
    watchWindowShortcuts
  }
}))

import type { App, Input } from 'electron'
import { installWindowShortcuts } from './window-shortcuts'

// Regression guard for issue #336: without `zoom: true`, electron-toolkit's helper calls
// `event.preventDefault()` on `Cmd+-` and `Cmd+=` in its `before-input-event` listener, which
// silently blocks Electron's built-in zoomOut / zoomIn menu accelerators and leaves the user
// stuck at whatever zoom level they last chose — no zoom out, no actual size.
describe('installWindowShortcuts', () => {
  let appOnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    appOnSpy = vi.fn()
    watchWindowShortcuts.mockReset()
  })

  it('registers a browser-window-created listener that forwards windows with zoom enabled', () => {
    installWindowShortcuts({ on: appOnSpy } as unknown as App)

    expect(appOnSpy).toHaveBeenCalledTimes(1)
    expect(appOnSpy).toHaveBeenCalledWith('browser-window-created', expect.any(Function))

    const handler = appOnSpy.mock.calls[0]![1] as (event: unknown, window: unknown) => void
    const fakeWindow = { id: 42, webContents: { on: vi.fn() } }
    handler(null, fakeWindow)

    expect(watchWindowShortcuts).toHaveBeenCalledTimes(1)
    expect(watchWindowShortcuts).toHaveBeenCalledWith(fakeWindow, { zoom: true })
  })

  it('preserves caller-supplied non-zoom options while still forcing zoom on', () => {
    installWindowShortcuts({ on: appOnSpy } as unknown as App, { escToCloseWindow: true })

    const handler = appOnSpy.mock.calls[0]![1] as (event: unknown, window: unknown) => void
    handler(null, { webContents: { on: vi.fn() } })

    expect(watchWindowShortcuts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escToCloseWindow: true, zoom: true })
    )
  })

  const createShortcut = (
    platform: NodeJS.Platform = 'win32'
  ): {
    webContents: Record<'on' | 'getZoomLevel' | 'setZoomLevel', ReturnType<typeof vi.fn>>
    dispatch: (overrides?: Partial<Input>) => { preventDefault: ReturnType<typeof vi.fn> }
  } => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    installWindowShortcuts({ on: appOnSpy } as unknown as App)
    const webContents = { on: vi.fn(), getZoomLevel: vi.fn(() => 1), setZoomLevel: vi.fn() }
    appOnSpy.mock.calls[0]![1](null, { webContents })
    const dispatch = (
      overrides: Partial<Input> = {}
    ): { preventDefault: ReturnType<typeof vi.fn> } => {
      const event = { preventDefault: vi.fn() }
      webContents.on.mock.calls[0]?.[1](event, {
        type: 'keyDown',
        key: '=',
        code: 'Equal',
        control: true,
        shift: false,
        alt: false,
        meta: false,
        ...overrides
      })
      return event
    }
    return { webContents, dispatch }
  }

  it.each([
    { key: '=', code: 'Equal' },
    { key: '+', code: 'NumpadAdd' }
  ])('zooms once for the Windows alias $code', (input) => {
    const { webContents, dispatch } = createShortcut()
    expect(dispatch(input).preventDefault).toHaveBeenCalledOnce()
    expect(webContents.setZoomLevel).toHaveBeenCalledExactlyOnceWith(1.5)
  })

  it.each([
    { type: 'keyUp' },
    { control: false },
    { alt: true },
    { meta: true },
    { key: '+', shift: true },
    { key: '-' },
    { key: '0' },
    { key: 'Process' }
  ] satisfies Partial<Input>[])('leaves native chords and unrelated input alone: %j', (input) => {
    const { webContents, dispatch } = createShortcut()
    expect(dispatch(input).preventDefault).not.toHaveBeenCalled()
    expect(webContents.setZoomLevel).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('preserves native shortcuts on %s', (platform) => {
    const { webContents } = createShortcut(platform)
    expect(webContents.on).not.toHaveBeenCalled()
  })
})
