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
  isCloseWindowChord
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

const createMainWindow = (): BrowserWindow => {
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

  // The renderer decides pane-vs-window, but only once it has mounted its listener. Track that via the
  // ready signal so the chord is never forwarded into the void: before the renderer is ready (initial
  // load, reload, in-flight navigation) the send() below would be dropped and Cmd/Ctrl+W would do
  // nothing, so main closes the window itself instead. Reset on every top-level load, since a fresh
  // document has to re-subscribe before it can own the chord again.
  let rendererListenerReady = false
  const onListenerReady = (event: IpcMainEvent): void => {
    if (event.sender === window.webContents) rendererListenerReady = true
  }
  ipcMain.on(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
  window.webContents.on('did-start-loading', () => {
    rendererListenerReady = false
  })
  window.on('closed', () => {
    ipcMain.removeListener(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
  })

  // Intercept Cmd+W / Ctrl+W before the default menu "Close" role fires. preventDefault here also
  // suppresses the menu accelerator (electron/electron#19279), so the chord never closes the window
  // behind the renderer's back. Forward to the renderer when it is ready, otherwise close directly.
  window.webContents.on('before-input-event', (event, input) => {
    if (!isCloseWindowChord(input, process.platform)) return

    event.preventDefault()
    if (rendererListenerReady) {
      window.webContents.send(CLOSE_ACTIVE_PANE_CHANNEL)
    } else {
      window.close()
    }
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
