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
    platform: NodeJS.Platform = 'win32',
    isMainWindow: (window: unknown) => boolean = () => true
  ): {
    webContents: Record<'on' | 'getZoomFactor' | 'setZoomFactor' | 'send', ReturnType<typeof vi.fn>>
    dispatch: (overrides?: Partial<Input>) => { preventDefault: ReturnType<typeof vi.fn> }
  } => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    installWindowShortcuts({ on: appOnSpy } as unknown as App, undefined, isMainWindow)
    const webContents = {
      on: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
      setZoomFactor: vi.fn(),
      send: vi.fn()
    }
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
  ])('uses the shared scale for the Windows alias $code', (input) => {
    const { webContents, dispatch } = createShortcut()
    expect(dispatch(input).preventDefault).toHaveBeenCalledOnce()
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.1)
    expect(webContents.send).toHaveBeenCalledExactlyOnceWith('shortcut:interface-scale', 1.1)
  })

  it('uses the shared scale for decrease and reset', () => {
    const { webContents, dispatch } = createShortcut()
    webContents.getZoomFactor.mockReturnValueOnce(1.1).mockReturnValueOnce(1.25)

    expect(dispatch({ key: '-', code: 'Minus' }).preventDefault).toHaveBeenCalledOnce()
    expect(webContents.setZoomFactor).toHaveBeenCalledWith(1)
    expect(webContents.send).toHaveBeenCalledWith('shortcut:interface-scale', 1)

    expect(dispatch({ key: '0', code: 'Digit0' }).preventDefault).toHaveBeenCalledOnce()
    expect(webContents.setZoomFactor).toHaveBeenLastCalledWith(1)
    expect(webContents.send).toHaveBeenLastCalledWith('shortcut:interface-scale', 1)
  })

  it.each([
    { type: 'keyUp' },
    { control: false },
    { alt: true },
    { key: '-' },
    { key: '0', code: 'Key0' },
    { key: 'Process' }
  ] satisfies Partial<Input>[])('leaves native chords and unrelated input alone: %j', (input) => {
    const { webContents, dispatch } = createShortcut()
    expect(dispatch(input).preventDefault).not.toHaveBeenCalled()
    expect(webContents.setZoomFactor).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)(
    'does not treat the meta key as a zoom modifier on %s',
    (platform) => {
      const { webContents, dispatch } = createShortcut(platform)
      expect(dispatch({ control: false, meta: true }).preventDefault).not.toHaveBeenCalled()
      expect(webContents.setZoomFactor).not.toHaveBeenCalled()
    }
  )

  it('uses the meta key as the zoom modifier on macOS', () => {
    const { webContents, dispatch } = createShortcut('darwin')
    expect(dispatch({ control: false, meta: true }).preventDefault).toHaveBeenCalledOnce()
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.1)
  })

  it.each(['darwin', 'linux'] as const)('handles shared shortcuts on %s', (platform) => {
    const { webContents } = createShortcut(platform)
    expect(webContents.on).toHaveBeenCalledWith('before-input-event', expect.any(Function))
  })

  it('leaves secondary windows on native zoom behavior', () => {
    const { webContents, dispatch } = createShortcut('win32', () => false)
    expect(dispatch({ key: '=', code: 'Equal' }).preventDefault).not.toHaveBeenCalled()
    expect(webContents.setZoomFactor).not.toHaveBeenCalled()
  })
})
