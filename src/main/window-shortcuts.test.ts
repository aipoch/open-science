import { beforeEach, describe, expect, it, vi } from 'vitest'

const { watchWindowShortcuts } = vi.hoisted(() => ({
  watchWindowShortcuts: vi.fn()
}))

vi.mock('@electron-toolkit/utils', () => ({
  optimizer: {
    watchWindowShortcuts
  }
}))

import type { App } from 'electron'
import { installWindowShortcuts } from './window-shortcuts'

// Regression guard for issue #336: without `zoom: true`, electron-toolkit's helper calls
// `event.preventDefault()` on `Cmd+-` and `Cmd+=` in its `before-input-event` listener, which
// silently blocks Electron's built-in zoomOut / zoomIn menu accelerators and leaves the user
// stuck at whatever zoom level they last chose — no zoom out, no actual size.
describe('installWindowShortcuts', () => {
  let appOnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    appOnSpy = vi.fn()
    watchWindowShortcuts.mockReset()
  })

  it('registers a browser-window-created listener that forwards windows with zoom enabled', () => {
    installWindowShortcuts({ on: appOnSpy } as unknown as App)

    expect(appOnSpy).toHaveBeenCalledTimes(1)
    expect(appOnSpy).toHaveBeenCalledWith('browser-window-created', expect.any(Function))

    const handler = appOnSpy.mock.calls[0]![1] as (event: unknown, window: unknown) => void
    const fakeWindow = { id: 42 }
    handler(null, fakeWindow)

    expect(watchWindowShortcuts).toHaveBeenCalledTimes(1)
    expect(watchWindowShortcuts).toHaveBeenCalledWith(fakeWindow, { zoom: true })
  })

  it('preserves caller-supplied non-zoom options while still forcing zoom on', () => {
    installWindowShortcuts({ on: appOnSpy } as unknown as App, { escToCloseWindow: true })

    const handler = appOnSpy.mock.calls[0]![1] as (event: unknown, window: unknown) => void
    handler(null, {})

    expect(watchWindowShortcuts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ escToCloseWindow: true, zoom: true })
    )
  })
})
