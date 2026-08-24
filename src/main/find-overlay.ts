import {
  WINDOW_FIND_APPEARANCE_CHANNEL,
  WINDOW_FIND_HIDE_CHANNEL,
  WINDOW_FIND_SHOW_CHANNEL,
  type WindowFindAppearance
} from '../shared/window-controls'
import type { FindOverlayOwner } from './find-overlay-registry'

// Preferred geometry for the find overlay, in CSS pixels. 420px ~ 26rem at the app's 16px base.
const OVERLAY_WIDTH = 420
const OVERLAY_HEIGHT = 40
const OVERLAY_MARGIN = 8
const OVERLAY_MIN_WIDTH = 240

// Computes the overlay's bounds within the main window's content area: pinned to the top-right with a
// small margin, shrinking (down to a floor) on narrow windows and never sliding off the left edge.
export const computeOverlayBounds = (
  contentWidth: number
): { x: number; y: number; width: number; height: number } => {
  const width = Math.max(
    OVERLAY_MIN_WIDTH,
    Math.min(OVERLAY_WIDTH, contentWidth - OVERLAY_MARGIN * 2)
  )
  const x = Math.max(0, contentWidth - width - OVERLAY_MARGIN)
  return { x, y: OVERLAY_MARGIN, width, height: OVERLAY_HEIGHT }
}

// The overlay view the manager drives. Kept structural so the manager is unit-testable without
// importing electron: the real caller passes a `new WebContentsView(...)`. Method syntax (rather than
// arrow properties) makes these bivariant, so a real Electron BrowserWindow / WebContentsView satisfies
// the shape without manual casts.
type OverlayWebContents = {
  loadFile(path: string): Promise<void>
  send(channel: string, payload?: unknown): void
  focus(): void
}
type OverlayView = {
  webContents: OverlayWebContents
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setBackgroundColor(color: string): void
  destroy?(): void
}

// The main window the overlay searches and attaches to. Structural for the same testability reason.
type OverlayMainWindow = {
  contentView: { addChildView(view: OverlayView): void }
  getContentBounds(): { width: number; height: number }
  on(event: 'resize', listener: () => void): void
  removeListener?(event: 'resize', listener: () => void): void
  off?(event: 'resize', listener: () => void): void
  webContents: {
    focus(): void
    send(channel: string, payload?: unknown): void
    stopFindInPage(action: 'clearSelection'): void
  }
}

export type FindOverlayDeps = {
  mainWindow: OverlayMainWindow
  createView: (opts: {
    webPreferences: { preload: string; sandbox: boolean; contextIsolation: boolean }
  }) => OverlayView
  preloadPath: string
  overlayHtmlPath: string
  // Records that this overlay's webContents is owned by this main window, so the find-IPC handler can
  // route search requests to the right window and the close channel can invoke closeOverlay. Optional
  // only for tests.
  registerOwner?: (overlay: object, owner: FindOverlayOwner) => void
}

export type FindOverlayManager = {
  open: () => void
  close: () => void
  destroy: () => void
  isOpen: () => boolean
  updateAppearance: (appearance: WindowFindAppearance) => void
}

const ZERO_BOUNDS = { x: 0, y: 0, width: 0, height: 0 }
const FALLBACK_APPEARANCE: WindowFindAppearance = { theme: 'light', followsSystem: true }
const LIGHT_BACKGROUND = '#fafaf8'
const DARK_BACKGROUND = '#1a1a18'

// Owns the find overlay WebContentsView for one main window. The view is created lazily on first open
// and stays attached for the life of the window: open/close toggle its bounds (real vs. zero) rather
// than attaching/detaching, which keeps the overlay's webContents — and its remembered query — alive
// across open/close cycles. The overlay is a separate webContents from the main window's, so its own
// query text is never part of the main window's page search.
export const createFindOverlayManager = (deps: FindOverlayDeps): FindOverlayManager => {
  let view: OverlayView | null = null
  let loadPromise: Promise<void> | null = null
  let opened = false
  let cachedAppearance = FALLBACK_APPEARANCE

  const backgroundFor = (appearance: WindowFindAppearance): string =>
    appearance.theme === 'dark' ? DARK_BACKGROUND : LIGHT_BACKGROUND

  const position = (): void => {
    if (!view) return
    const { width } = deps.mainWindow.getContentBounds()
    view.setBounds(computeOverlayBounds(width))
  }

  const onResize = (): void => {
    if (opened && !loadPromise) position()
  }
  deps.mainWindow.on('resize', onResize)

  const close = (): void => {
    if (!opened) return
    opened = false
    view?.setBounds(ZERO_BOUNDS)
    deps.mainWindow.webContents.stopFindInPage('clearSelection')
    deps.mainWindow.webContents.send(WINDOW_FIND_HIDE_CHANNEL)
    deps.mainWindow.webContents.focus()
  }

  const appearancesEqual = (left: WindowFindAppearance, right: WindowFindAppearance): boolean =>
    left.theme === right.theme && left.followsSystem === right.followsSystem

  const showLoadedView = (): void => {
    if (!opened || !view || loadPromise) return
    // Keep the shortcut path synchronous once the static overlay page is loaded so keystrokes
    // immediately following Cmd/Ctrl+F land in the query field.
    view.webContents.focus()
    view.webContents.send(WINDOW_FIND_SHOW_CHANNEL, cachedAppearance)
  }

  return {
    isOpen: () => opened,

    open: () => {
      if (!view) {
        view = deps.createView({
          webPreferences: { preload: deps.preloadPath, sandbox: true, contextIsolation: true }
        })
        const pendingView = view
        pendingView.setBounds(ZERO_BOUNDS)
        pendingView.setBackgroundColor(backgroundFor(cachedAppearance))
        const firstLoad = view.webContents.loadFile(deps.overlayHtmlPath)
        loadPromise = firstLoad
        void firstLoad.then(
          () => {
            if (loadPromise !== firstLoad) return
            loadPromise = null
            if (opened) position()
            showLoadedView()
          },
          () => {
            if (loadPromise !== firstLoad) return
            loadPromise = null
            close()
            pendingView.destroy?.()
            if (view === pendingView) view = null
          }
        )
        deps.mainWindow.contentView.addChildView(view)
        // Register the owner with the close handle so the find-IPC close channel can hide this overlay.
        deps.registerOwner?.(view.webContents, { mainWindow: deps.mainWindow, closeOverlay: close })
      }
      opened = true
      if (!loadPromise) {
        position()
        showLoadedView()
      }
    },

    close,

    updateAppearance: (appearance) => {
      if (appearancesEqual(appearance, cachedAppearance)) return
      cachedAppearance = appearance
      view?.setBackgroundColor(backgroundFor(appearance))
      if (opened && view && !loadPromise) {
        view.webContents.send(WINDOW_FIND_APPEARANCE_CHANNEL, appearance)
      }
    },

    destroy: () => {
      if (deps.mainWindow.removeListener) {
        deps.mainWindow.removeListener('resize', onResize)
      } else {
        deps.mainWindow.off?.('resize', onResize)
      }
      view?.destroy?.()
      view = null
      loadPromise = null
      opened = false
    }
  }
}
