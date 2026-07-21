import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { isAllowedExternalNavigation, isAllowedFrameNavigation } from './navigation-policy'
import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  isCloseWindowChord,
  type CloseConfirmChoice
} from '../shared/window-controls'

const rendererEntry = join(__dirname, '../renderer/index.html')
const preloadEntry = join(__dirname, '../preload/index.js')

const loadRenderer = (window: BrowserWindow): void => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
    return
  }

  void window.loadFile(rendererEntry)
}

const createAppWindow = (options: BrowserWindowConstructorOptions): BrowserWindow => {
  const window = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    ...(process.platform !== 'darwin' ? { icon } : {}),
    ...options,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...options.webPreferences
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalNavigation(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-frame-navigate', (details) => {
    if (!isAllowedFrameNavigation(details.url, details.isMainFrame, window.webContents.getURL())) {
      details.preventDefault()
    }
  })

  return window
}

// How the main window resolves a close: classifyClose decides synchronously at close time
// ('close' = let it close, 'hide' = minimize to tray, 'confirm' = ask via resolveCloseAction).
// resolveCloseAction is awaited only for 'confirm'; requestQuit is called when the choice is quit.
type MainWindowCloseOptions = {
  classifyClose: () => 'close' | 'hide' | 'confirm'
  resolveCloseAction: () => Promise<CloseConfirmChoice>
  requestQuit: () => void
}

const createMainWindow = (opts?: MainWindowCloseOptions): BrowserWindow => {
  const window = createAppWindow({
    width: 1280,
    // The first-run environment summary needs enough vertical space to keep its Continue action
    // visible at the default size. Electron still clamps this to the display work area on smaller
    // screens, where the onboarding surface provides its own vertical scroll fallback.
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'Open Science'
  })

  // The renderer decides pane-vs-window, but only once it has a live, responsive listener. If main
  // forwards the chord to a renderer that cannot handle it, preventDefault() has already suppressed the
  // menu Close accelerator, so Cmd/Ctrl+W becomes a silent no-op. Two independent conditions gate the
  // forward:
  //   - listener readiness: the renderer mounted its listener (READY) and has not torn it down (UNREADY),
  //     been replaced by a fresh top-level document (did-start-navigation), or died (render-process-gone).
  //   - responsiveness: a hung renderer receives the send but never processes it, so treat unresponsive
  //     as not-forwardable and restore on recovery — tracked separately so a recovered renderer keeps
  //     its subscription instead of having to re-handshake.
  // When either fails, main closes the window itself so the chord always does something.
  let rendererListenerReady = false
  let rendererResponsive = true
  const onListenerReady = (event: IpcMainEvent): void => {
    if (event.sender !== window.webContents) return
    rendererListenerReady = true
    // A renderer that just handshook is by definition running and processing IPC. Clear any stale
    // unresponsive state here too: after unresponsive -> render-process-gone -> reload, the fresh
    // process never emits 'responsive' (that only fires as recovery on the *same* process), so READY
    // is the only signal that the new renderer can act on the chord.
    rendererResponsive = true
  }
  const onListenerGone = (event: IpcMainEvent): void => {
    if (event.sender === window.webContents) rendererListenerReady = false
  }
  ipcMain.on(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
  ipcMain.on(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL, onListenerGone)
  // A top-level document swap replaces the mounted hook, which must re-subscribe; a dead render process
  // took its listener with it. Both revoke readiness until the next READY handshake. Gate on the main
  // frame and a real document change so a dynamic preview iframe loading (or a same-document hash /
  // pushState navigation) — neither of which remounts the hook — does not falsely disarm the forward.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) rendererListenerReady = false
  })
  window.webContents.on('render-process-gone', () => {
    rendererListenerReady = false
  })
  window.webContents.on('unresponsive', () => {
    rendererResponsive = false
  })
  window.webContents.on('responsive', () => {
    rendererResponsive = true
  })
  window.on('closed', () => {
    ipcMain.removeListener(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
    ipcMain.removeListener(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL, onListenerGone)
  })

  // Intercept Cmd+W / Ctrl+W before the default menu "Close" role fires. preventDefault here also
  // suppresses the menu accelerator (electron/electron#19279), so the chord never closes the window
  // behind the renderer's back. Forward to the renderer only when it can act on it, otherwise close.
  //
  // Accepted residual: send() is fire-and-forget, so a renderer that crashes or hangs in the gap
  // between this send and its handler running drops this one chord. It is self-correcting — that same
  // crash/hang revokes readiness, so the next press falls back to the direct close below. A per-chord
  // ack + timeout would close that gap but risks a worse bug: if a slow-but-healthy renderer collapses
  // the pane and its ack lands after the timeout, main would then also close the window. We accept one
  // lost keystroke during a renderer crash over that regression.
  window.webContents.on('before-input-event', (event, input) => {
    if (!isCloseWindowChord(input, process.platform)) return

    event.preventDefault()
    if (rendererListenerReady && rendererResponsive) {
      window.webContents.send(CLOSE_ACTIVE_PANE_CHANNEL)
    } else {
      // The chord's window-close fallback now routes through classifyClose below: Windows surfaces the
      // confirm dialog, Linux hides to tray, and everyone else closes.
      window.close()
    }
  })

  // Close handling. classifyClose decides synchronously so darwin / no-tray / mid-quit still close
  // instantly; 'hide' minimizes to tray (Linux); 'confirm' (Windows X) asks the user. The
  // Cmd/Ctrl+W fallback window.close() routes through here unchanged.
  let awaitingChoice = false
  window.on('close', (event) => {
    const action = opts?.classifyClose?.() ?? 'close'
    if (action === 'close') return
    event.preventDefault()
    if (action === 'hide') {
      window.hide()
      return
    }
    if (awaitingChoice) return
    awaitingChoice = true
    void opts!
      .resolveCloseAction()
      .then((choice) => {
        if (choice === 'minimize') window.hide()
        else if (choice === 'quit') opts!.requestQuit()
      })
      .finally(() => {
        awaitingChoice = false
      })
  })

  // In dev, mirror the "(DEV)" app suffix in the title bar. The renderer's <title> overwrites the
  // constructor title on load, so append the suffix whenever the page updates its title.
  if (!app.isPackaged) {
    window.on('page-title-updated', (event, pageTitle) => {
      event.preventDefault()
      window.setTitle(`${pageTitle} (DEV)`)
    })
  }

  loadRenderer(window)
  return window
}

export { createMainWindow }
