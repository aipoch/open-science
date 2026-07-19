import { Menu, Tray, nativeImage, screen, type NativeImage } from 'electron'

import { createLogger } from './logger'

const logger = createLogger('tray')

// macOS menu-bar icons should be monochrome "template" images: black pixels on a transparent background
// that the system tints to match the light/dark menu bar. The app icon is a light ring-of-dots glyph on
// a dark rounded-square container, so we keep the dots (mapping their brightness to alpha) and drop the
// dark container, then paint everything black and flag it as a template. Returns undefined on any
// failure so the caller can fall back to the full-color icon.
const TEMPLATE_ICON_SIZE = 18
const createMacTemplateIcon = (iconPath: string): NativeImage | undefined => {
  try {
    const source = nativeImage.createFromPath(iconPath)
    if (source.isEmpty()) return undefined

    const { width, height } = source.getSize()
    if (!width || !height) return undefined

    // toBitmap() is BGRA. Map luminance to alpha so the dark container (low luminance) becomes
    // transparent and the light dots stay opaque with soft anti-aliased edges; paint every pixel black
    // so setTemplateImage can tint it.
    const bitmap = source.toBitmap()
    for (let i = 0; i < bitmap.length; i += 4) {
      const luminance = 0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i]
      const alpha = Math.max(0, Math.min(255, Math.round(((luminance - 90) / (232 - 90)) * 255)))
      bitmap[i] = 0
      bitmap[i + 1] = 0
      bitmap[i + 2] = 0
      bitmap[i + 3] = alpha
    }

    const template = nativeImage
      .createFromBitmap(bitmap, { width, height })
      .resize({ width: TEMPLATE_ICON_SIZE, height: TEMPLATE_ICON_SIZE, quality: 'best' })
    if (template.isEmpty()) return undefined
    template.setTemplateImage(true)
    return template
  } catch (error) {
    logger.error('failed to build macOS template tray icon; falling back to the color icon', error)
    return undefined
  }
}

// Builds a system tray icon with a Show/Quit menu. Returns undefined when the platform has no tray
// host (e.g. Linux without a StatusNotifier/AppIndicator), letting the app fall back to quit-on-close.
const createAppTray = (opts: {
  iconPath: string
  onShow: () => void
  onHide: () => void
  onQuit: () => void
  headless?: boolean
  onOpenWeb?: () => void | Promise<void>
  onCopyWebUrl?: () => void | Promise<void>
}): Tray | undefined => {
  try {
    // macOS gets a monochrome template glyph that follows the menu-bar appearance; other platforms use
    // the full-color icon. An empty image is tolerated so the tray still appears with a blank glyph.
    const icon =
      process.platform === 'darwin'
        ? (createMacTemplateIcon(opts.iconPath) ?? nativeImage.createFromPath(opts.iconPath))
        : nativeImage.createFromPath(opts.iconPath)
    const tray = new Tray(icon)

    const headlessWeb = opts.headless && opts.onOpenWeb && opts.onCopyWebUrl
    const menu = Menu.buildFromTemplate(
      headlessWeb
        ? [
            { label: 'Open Web UI', click: () => void opts.onOpenWeb!() },
            { label: 'Copy URL', click: () => void opts.onCopyWebUrl!() },
            { type: 'separator' },
            { label: 'Quit', click: () => opts.onQuit() }
          ]
        : [
            { label: 'Show', click: () => opts.onShow() },
            { label: 'Hide', click: () => opts.onHide() },
            { type: 'separator' },
            { label: 'Quit', click: () => opts.onQuit() }
          ]
    )

    tray.setToolTip(headlessWeb ? 'Open Science (Web)' : 'Open Science')

    const primaryAction = (): void => {
      if (headlessWeb) void opts.onOpenWeb!()
      else opts.onShow()
    }

    // Under --open-science-headless on Windows, Chromium renders the native tray menu invisibly
    // (electron/electron#48982), so setContextMenu is useless there: pop the menu explicitly on
    // right-click and bind single/double click to the primary action. The normal desktop app — every
    // platform, Windows included — keeps the standard setContextMenu + single-click-to-show, so this
    // workaround stays scoped to the headless case it exists for.
    if (process.platform === 'win32' && headlessWeb) {
      tray.on('right-click', () => {
        tray.popUpContextMenu(menu, screen.getCursorScreenPoint())
      })
      tray.on('click', primaryAction)
      tray.on('double-click', primaryAction)
    } else {
      tray.setContextMenu(menu)
      tray.on('click', primaryAction)
    }

    return tray
  } catch (error) {
    // No tray host available: log and let the caller fall back to normal window/quit behavior.
    logger.error('failed to create tray', error)
    return undefined
  }
}

export { createAppTray }
