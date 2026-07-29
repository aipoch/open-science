import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { registerFindOverlayOwner } from './find-overlay-registry'
import {
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_RESULT_CHANNEL,
  type WindowFindResult
} from '../shared/window-controls'

const handlers = new Map<string, (event: unknown, payload: unknown) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      handlers.set(channel, listener)
    }
  },
  BrowserWindow: {}
}))

const { registerWindowFindIpcHandlers } = await import('./window-find-ipc')

type FoundInPageResult = WindowFindResult & { requestId: number }
type FindInPageOptions = { findNext: boolean; forward: boolean; matchCase: boolean }

// The MAIN window: the webContents that actually gets searched and emits found-in-page.
type TargetWindow = {
  webContents: {
    findInPage: Mock<(text: string, options: FindInPageOptions) => number>
    stopFindInPage: Mock<(action: 'clearSelection') => void>
    on: Mock<
      (
        event: 'found-in-page',
        listener: (event: unknown, result: FoundInPageResult) => void
      ) => void
    >
  }
  emitFoundInPage: (result: FoundInPageResult) => void
}

// The OVERLAY window: a separate webContents that issues requests and receives results. Its own
// content is never searched, so its query cannot become a false match.
type OverlaySender = {
  send: Mock<(channel: string, result: WindowFindResult) => void>
}

const createTargetWindow = (): TargetWindow => {
  const foundListeners: Array<(event: unknown, result: FoundInPageResult) => void> = []
  const webContents = {
    findInPage: vi.fn<(text: string, options: FindInPageOptions) => number>(() => 17),
    stopFindInPage: vi.fn<(action: 'clearSelection') => void>(),
    on: vi.fn<
      (
        event: 'found-in-page',
        listener: (event: unknown, result: FoundInPageResult) => void
      ) => void
    >((_event, listener) => {
      foundListeners.push(listener)
    })
  }

  return {
    webContents,
    emitFoundInPage: (result: FoundInPageResult): void => {
      for (const listener of foundListeners) listener({}, result)
    }
  }
}

const createOverlay = (): OverlaySender => ({
  send: vi.fn<(channel: string, result: WindowFindResult) => void>()
})

describe('window find IPC', () => {
  beforeEach(() => handlers.clear())

  it('searches the resolved MAIN window and returns the match count to the overlay sender', () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    handlers.get(WINDOW_FIND_REQUEST_CHANNEL)!(
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    target.emitFoundInPage({ requestId: 17, activeMatchOrdinal: 1, matches: 4, finalUpdate: true })

    // The search runs against the MAIN window's webContents, never the overlay's.
    expect(target.webContents.findInPage).toHaveBeenCalledWith('protein', {
      findNext: true,
      forward: true,
      matchCase: false
    })
    // The result is delivered to the overlay that asked, not echoed back to the main window.
    expect(overlay.send).toHaveBeenCalledWith(WINDOW_FIND_RESULT_CHANNEL, {
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 4,
      finalUpdate: true
    })
  })

  it('does not return an asynchronous result from a superseded query to the overlay', () => {
    const target = createTargetWindow()
    target.webContents.findInPage.mockReturnValueOnce(17).mockReturnValueOnce(18)
    const overlay = createOverlay()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    handlers.get(WINDOW_FIND_REQUEST_CHANNEL)!(
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    handlers.get(WINDOW_FIND_REQUEST_CHANNEL)!(
      { sender: overlay },
      { requestId: 2, text: 'variant', findNext: true, forward: true }
    )
    target.emitFoundInPage({ requestId: 17, activeMatchOrdinal: 1, matches: 4, finalUpdate: true })
    target.emitFoundInPage({ requestId: 18, activeMatchOrdinal: 1, matches: 2, finalUpdate: true })

    expect(overlay.send).toHaveBeenCalledTimes(1)
    expect(overlay.send).toHaveBeenCalledWith(WINDOW_FIND_RESULT_CHANNEL, {
      requestId: 2,
      activeMatchOrdinal: 1,
      matches: 2,
      finalUpdate: true
    })
  })

  it('clears the search selection on the MAIN window when the overlay closes', () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    handlers.get(WINDOW_FIND_CLEAR_CHANNEL)!({ sender: overlay }, undefined)

    expect(target.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
  })

  it('hides the overlay by invoking the registered owner close handler', () => {
    // The overlay's X button / Esc send WINDOW_FIND_CLOSE_CHANNEL; main looks up the owner registered
    // for that overlay (which knows how to hide it) and invokes its closeOverlay.
    const target = createTargetWindow()
    const overlay = createOverlay()
    const closeOverlay = vi.fn()
    registerFindOverlayOwner(overlay, { mainWindow: target, closeOverlay })
    registerWindowFindIpcHandlers()

    handlers.get(WINDOW_FIND_CLOSE_CHANNEL)!({ sender: overlay }, undefined)

    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('ignores a request when no main window can be resolved for the overlay', () => {
    const target = createTargetWindow()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => null })

    handlers.get(WINDOW_FIND_REQUEST_CHANNEL)!(
      { sender: createOverlay() },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )

    expect(target.webContents.findInPage).not.toHaveBeenCalled()
  })
})
