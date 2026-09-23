import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

import { createElectronSurfaceAdapter } from './ipc-surfaces/adapter'
import type { NamedElectronSurfaceAdapter } from './runtime-electron-wiring'
import { disposeIpcHandlerRegistry } from './ipc-handler-registry'

import { registerFindOverlayOwner, resolveFindOverlayOwner } from './find-overlay-registry'
import {
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_RESULT_CHANNEL,
  type WindowFindResult
} from '../shared/window-controls'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter(), BrowserWindow: {} }
})

const { registerWindowFindIpcHandlers } = await import('./window-find-ipc')

type FoundInPageResult = WindowFindResult & { requestId: number }
type FindInPageOptions = { findNext: boolean; forward: boolean; matchCase: boolean }

// The MAIN window: the webContents that actually gets searched and emits found-in-page.
type TargetWindow = {
  webContents: EventEmitter & {
    findInPage: Mock<(text: string, options: FindInPageOptions) => number>
    stopFindInPage: Mock<(action: 'clearSelection') => void>
    focus: Mock<() => void>
  }
  emitFoundInPage: (result: FoundInPageResult) => void
}

// The OVERLAY window: a separate webContents that issues requests and receives results. Its own
// content is never searched, so its query cannot become a false match.
type OverlaySender = {
  send: Mock<(channel: string, result: WindowFindResult) => void>
}

const createTargetWindow = (): TargetWindow => {
  const webContents = Object.assign(new EventEmitter(), {
    findInPage: vi.fn<(text: string, options: FindInPageOptions) => number>(() => 17),
    stopFindInPage: vi.fn<(action: 'clearSelection') => void>(),
    focus: vi.fn()
  })
  return {
    webContents,
    emitFoundInPage: (result) => {
      webContents.emit('found-in-page', {}, result)
    }
  }
}

const createOverlay = (): OverlaySender => ({
  send: vi.fn<(channel: string, result: WindowFindResult) => void>()
})

describe('window find IPC', () => {
  afterEach(() => {
    ipcMain.removeAllListeners()
    disposeIpcHandlerRegistry()
    vi.restoreAllMocks()
  })

  it('searches the resolved MAIN window and returns the match count to the overlay sender', () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
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

  it('clears the previous native source target and ignores its late search result', () => {
    const host = createTargetWindow()
    const source = createTargetWindow()
    const overlay = createOverlay()
    let active = source.webContents
    registerWindowFindIpcHandlers({
      resolveMainWindow: () => host,
      resolveSearchTarget: () => active
    })
    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    expect(source.webContents.findInPage).toHaveBeenCalledOnce()
    active = host.webContents
    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: overlay },
      { requestId: 2, text: 'new', findNext: true, forward: true }
    )
    expect(source.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    source.emitFoundInPage({ requestId: 17, activeMatchOrdinal: 1, matches: 2, finalUpdate: true })
    expect(overlay.send).not.toHaveBeenCalled()
    ipcMain.emit(WINDOW_FIND_CLEAR_CHANNEL, { sender: overlay })
    expect(host.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
  })

  it('does not return an asynchronous result from a superseded query to the overlay', () => {
    const target = createTargetWindow()
    target.webContents.findInPage.mockReturnValueOnce(17).mockReturnValueOnce(18)
    const overlay = createOverlay()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
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

    ipcMain.emit(WINDOW_FIND_CLEAR_CHANNEL, { sender: overlay }, undefined)

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

    ipcMain.emit(WINDOW_FIND_CLOSE_CHANNEL, { sender: overlay }, undefined)

    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })

  it('records the searched source guest so closing find restores its focus', () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    const closeOverlay = vi.fn()
    registerFindOverlayOwner(overlay, { mainWindow: target, closeOverlay })
    registerWindowFindIpcHandlers({ resolveMainWindow: () => target })

    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    const owner = resolveFindOverlayOwner(overlay)
    expect(owner?.focusSource?.()).toBe(true)
    ipcMain.emit(WINDOW_FIND_CLOSE_CHANNEL, { sender: overlay }, undefined)

    expect(target.webContents.focus).toHaveBeenCalledOnce()
    expect(closeOverlay).toHaveBeenCalledOnce()
  })

  it('does not restore focus to a source after the search target changes', () => {
    const host = createTargetWindow()
    const source = createTargetWindow()
    const overlay = createOverlay()
    let active = source.webContents
    registerFindOverlayOwner(overlay, { mainWindow: host, closeOverlay: vi.fn() })
    registerWindowFindIpcHandlers({
      resolveMainWindow: () => host,
      resolveSearchTarget: () => active
    })
    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: overlay },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )
    active = host.webContents
    expect(resolveFindOverlayOwner(overlay)?.focusSource?.()).toBe(false)
    expect(source.webContents.focus).not.toHaveBeenCalled()
  })

  it('ignores a request when no main window can be resolved for the overlay', () => {
    const target = createTargetWindow()
    registerWindowFindIpcHandlers({ resolveMainWindow: () => null })

    ipcMain.emit(
      WINDOW_FIND_REQUEST_CHANNEL,
      { sender: createOverlay() },
      { requestId: 1, text: 'protein', findNext: true, forward: true }
    )

    expect(target.webContents.findInPage).not.toHaveBeenCalled()
  })
})

// Exercise the production installation contract; EventEmitter retains duplicate listeners,
// unlike the single-handler map used by the earlier request-only tests.
describe('window find installation lifecycle', () => {
  afterEach(() => {
    ipcMain.removeAllListeners()
    disposeIpcHandlerRegistry()
    vi.restoreAllMocks()
  })

  const install = (target: TargetWindow): ReturnType<NamedElectronSurfaceAdapter['install']> =>
    createElectronSurfaceAdapter('desktop-utilities', () =>
      registerWindowFindIpcHandlers({ resolveMainWindow: () => target })
    ).install()
  const request = { requestId: 1, text: 'protein', findNext: true, forward: true }
  const result = { requestId: 17, activeMatchOrdinal: 1, matches: 4, finalUpdate: true }
  const channels = [
    WINDOW_FIND_REQUEST_CHANNEL,
    WINDOW_FIND_CLEAR_CHANNEL,
    WINDOW_FIND_CLOSE_CHANNEL
  ]

  it('stops dispatching requests after the surface is uninstalled', async () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    const external = vi.fn()
    ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, external)
    const installation = await install(target)
    await installation.uninstall()
    await installation.uninstall()
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, { sender: overlay }, request)
    expect(target.webContents.findInPage).not.toHaveBeenCalled()
    expect(external).toHaveBeenCalledOnce()
    expect(ipcMain.listeners(WINDOW_FIND_REQUEST_CHANNEL)).toEqual([external])
    expect(ipcMain.listenerCount(WINDOW_FIND_CLEAR_CHANNEL)).toBe(0)
    expect(ipcMain.listenerCount(WINDOW_FIND_CLOSE_CHANNEL)).toBe(0)
  })

  it('does not publish late native results after uninstall', async () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    const installation = await install(target)
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, { sender: overlay }, request)
    expect(target.webContents.findInPage).toHaveBeenCalledOnce()
    await installation.uninstall()
    target.emitFoundInPage(result)
    expect(overlay.send).not.toHaveBeenCalled()
    expect(target.webContents.listenerCount('found-in-page')).toBe(0)
  })

  it('handles each request and result only once after reinstall', async () => {
    const target = createTargetWindow()
    const overlay = createOverlay()
    const first = await install(target)
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, { sender: overlay }, request)
    await first.uninstall()
    const second = await install(target)
    target.webContents.findInPage.mockClear()
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, { sender: overlay }, request)
    expect(target.webContents.findInPage).toHaveBeenCalledOnce()
    target.emitFoundInPage(result)
    expect(overlay.send).toHaveBeenCalledOnce()
    await second.uninstall()
  })

  it('rolls back event listeners when registration fails partway through', () => {
    const external = vi.fn()
    ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, external)
    const on = ipcMain.on.bind(ipcMain)
    vi.spyOn(ipcMain, 'on').mockImplementation((channel, listener) => {
      if (channel === WINDOW_FIND_CLOSE_CHANNEL) throw new Error('listener installation failed')
      return on(channel, listener)
    })
    expect(() => install(createTargetWindow())).toThrow('listener installation failed')
    expect(ipcMain.listeners(WINDOW_FIND_REQUEST_CHANNEL)).toEqual([external])
    expect(ipcMain.listenerCount(WINDOW_FIND_CLEAR_CHANNEL)).toBe(0)
    expect(ipcMain.listenerCount(WINDOW_FIND_CLOSE_CHANNEL)).toBe(0)
  })

  it('releases searched window subscriptions on destruction without touching other listeners', async () => {
    const target = createTargetWindow()
    const external = vi.fn()
    target.webContents.on('found-in-page', external)
    const installation = await install(target)
    const overlay = createOverlay()
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, { sender: overlay }, request)
    target.webContents.emit('destroyed')
    target.emitFoundInPage(result)
    expect(overlay.send).not.toHaveBeenCalled()
    expect(target.webContents.listeners('found-in-page')).toEqual([external])
    expect(target.webContents.listenerCount('destroyed')).toBe(0)
    await installation.uninstall()
    for (const channel of channels) expect(ipcMain.listenerCount(channel)).toBe(0)
  })
})
