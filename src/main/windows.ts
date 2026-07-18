import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { isAllowedExternalNavigation, isAllowedFrameNavigation } from './navigation-policy'

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
