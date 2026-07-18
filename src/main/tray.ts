import { Menu, Tray, nativeImage } from 'electron'

import { createLogger } from './logger'

const logger = createLogger('tray')

// Builds a system tray icon with a Show/Quit menu. Returns undefined when the platform has no tray
// host (e.g. Linux without a StatusNotifier/AppIndicator), letting the app fall back to quit-on-close.
const createAppTray = (opts: {
  iconPath: string
  onShow: () => void
  onHide: () => void
  onQuit: () => void
}): Tray | undefined => {
  try {
    // Load the icon; an empty image is tolerated so the tray still appears with a blank glyph.
    const icon = nativeImage.createFromPath(opts.iconPath)
    const tray = new Tray(icon)

    // Right-click (or platform default) menu with the core actions.
    const menu = Menu.buildFromTemplate([
      { label: 'Show', click: () => opts.onShow() },
      { label: 'Hide', click: () => opts.onHide() },
      { type: 'separator' },
      { label: 'Quit', click: () => opts.onQuit() }
    ])

    tray.setToolTip('Open Science')
    tray.setContextMenu(menu)

    // Left click reveals the window on Windows/Linux where it is the expected affordance.
    tray.on('click', () => opts.onShow())

    return tray
  } catch (error) {
    // No tray host available: log and let the caller fall back to normal window/quit behavior.
    logger.error('failed to create tray', error)
    return undefined
  }
}

export { createAppTray }
