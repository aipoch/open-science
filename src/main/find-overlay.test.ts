import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  computeOverlayBounds,
  createFindOverlayManager,
  type FindOverlayManager
} from './find-overlay'
import { WINDOW_FIND_SHOW_CHANNEL } from '../shared/window-controls'

describe('computeOverlayBounds', () => {
  it('anchors the bar to the top-right of the content area with a margin', () => {
    expect(computeOverlayBounds(1000)).toEqual({ x: 572, y: 8, width: 420, height: 40 })
  })

  it('shrinks the width when the window is narrower than the preferred bar', () => {
    // 300 wide: width clamps to contentWidth - 2*margin = 284, x stays at the left margin.
    expect(computeOverlayBounds(300)).toEqual({ x: 8, y: 8, width: 284, height: 40 })
  })

  it('keeps a minimum width and never slides off the left edge on very narrow windows', () => {
    expect(computeOverlayBounds(200)).toEqual({ x: 0, y: 8, width: 240, height: 40 })
  })
})

const PRELOAD_PATH = '/p/index.js'
const HTML_PATH = '/r/find-overlay/index.html'

type FindOverlayTestFakes = {
  view: {
    webContents: { loadFile: Mock; send: Mock; focus: Mock }
    setBounds: Mock
    destroy: Mock
  }
  mainWindow: {
    contentView: { addChildView: Mock }
    getContentBounds: () => { width: number; height: number }
    on: Mock
    removeListener: Mock
    webContents: { focus: Mock; stopFindInPage: Mock }
  }
  createView: Mock
  registerOwner: Mock
  manager: FindOverlayManager
}

const createFakes = (): FindOverlayTestFakes => {
  const view = {
    webContents: { loadFile: vi.fn(), send: vi.fn(), focus: vi.fn() },
    setBounds: vi.fn(),
    destroy: vi.fn()
  }
  const mainWindow = {
    contentView: { addChildView: vi.fn() },
    getContentBounds: () => ({ width: 1000, height: 800 }),
    on: vi.fn(),
    removeListener: vi.fn(),
    webContents: { focus: vi.fn(), stopFindInPage: vi.fn() }
  }
  const createView = vi.fn(() => view)
  const registerOwner = vi.fn()
  const manager = createFindOverlayManager({
    mainWindow,
    createView,
    preloadPath: PRELOAD_PATH,
    overlayHtmlPath: HTML_PATH,
    registerOwner
  })
  return { view, mainWindow, createView, registerOwner, manager }
}

describe('find overlay manager', () => {
  it('open() creates, loads, attaches, positions, focuses the overlay and signals show', () => {
    const { view, mainWindow, createView, registerOwner, manager } = createFakes()

    manager.open()

    expect(createView).toHaveBeenCalledWith({
      webPreferences: { preload: PRELOAD_PATH, sandbox: true, contextIsolation: true }
    })
    expect(view.webContents.loadFile).toHaveBeenCalledWith(HTML_PATH)
    expect(mainWindow.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 572, y: 8, width: 420, height: 40 })
    expect(view.webContents.focus).toHaveBeenCalledTimes(1)
    expect(view.webContents.send).toHaveBeenCalledWith(WINDOW_FIND_SHOW_CHANNEL)
    expect(registerOwner).toHaveBeenCalledWith(view.webContents, {
      mainWindow,
      closeOverlay: expect.any(Function)
    })
  })

  it('registers a closeOverlay that hides the bar (invoked by the find-IPC close channel)', () => {
    const { view, mainWindow, registerOwner, manager } = createFakes()
    manager.open()

    const owner = registerOwner.mock.calls[0]?.[1] as { closeOverlay: () => void }
    expect(owner.closeOverlay).toBeTypeOf('function')
    view.setBounds.mockClear()
    mainWindow.webContents.stopFindInPage.mockClear()

    // Simulate the overlay's X button -> main -> owner.closeOverlay().
    owner.closeOverlay()

    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(mainWindow.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(manager.isOpen()).toBe(false)
  })

  it('reuses the same view across repeated opens and re-signals show each time', () => {
    const { view, mainWindow, createView, manager } = createFakes()

    manager.open()
    manager.open()

    expect(createView).toHaveBeenCalledTimes(1)
    expect(mainWindow.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(view.webContents.send).toHaveBeenCalledTimes(2)
    expect(view.webContents.focus).toHaveBeenCalledTimes(2)
  })

  it('close() hides the overlay, clears the main selection, and returns focus to the main window', () => {
    const { view, mainWindow, manager } = createFakes()
    manager.open()
    view.setBounds.mockClear()
    mainWindow.webContents.stopFindInPage.mockClear()

    manager.close()

    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(mainWindow.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(mainWindow.webContents.focus).toHaveBeenCalledTimes(1)
    expect(manager.isOpen()).toBe(false)
  })

  it('close() is a no-op when the overlay is already hidden', () => {
    const { mainWindow, manager } = createFakes()

    manager.close()

    expect(mainWindow.webContents.stopFindInPage).not.toHaveBeenCalled()
    expect(mainWindow.webContents.focus).not.toHaveBeenCalled()
  })

  it('repositions on resize while open and ignores resize while hidden', () => {
    const { view, mainWindow, manager } = createFakes()
    const resizeListener = mainWindow.on.mock.calls.find(([event]) => event === 'resize')?.[1] as
      (() => void) | undefined
    expect(resizeListener).toBeTruthy()

    mainWindow.getContentBounds = () => ({ width: 1400, height: 900 })

    // Hidden: a resize must not touch the overlay.
    resizeListener!()

    manager.open()
    view.setBounds.mockClear()
    resizeListener!()

    expect(view.setBounds).toHaveBeenCalledWith(computeOverlayBounds(1400))
  })
})
