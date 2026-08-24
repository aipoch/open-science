import { Menu, Tray, nativeImage, screen, type NativeImage } from 'electron'

import { DEFAULT_APP_ICON_VARIANT, type AppIconVariant } from '../shared/settings'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import { createLogger } from './logger'

const logger = createLogger('tray')
const trayMenuRefreshers = new WeakMap<Tray, () => void>()

// Builds a NativeImage for one app-icon variant, or undefined when the asset is missing/unreadable,
// so callers fall back instead of blanking the tray.
const createVariantIcon = (
  variantPaths: Partial<Record<AppIconVariant, string>>,
  variant: AppIconVariant
): NativeImage | undefined => {
  const path = variantPaths[variant]
  if (!path) return undefined
  try {
    const image = nativeImage.createFromPath(path)
    return image.isEmpty() ? undefined : image
  } catch (error) {
    logger.error('failed to load tray icon variant asset', { variant, error })
    return undefined
  }
}

// Re-points a live tray at the given app-icon variant. Called when the user switches the app icon in
// settings so the tray glyph matches the window icon. Guards a destroyed tray (the settings IPC can
// outlive it during teardown) and keeps the current image when the variant asset is unreadable.
const setTrayIconVariant = (
  tray: Tray,
  variantPaths: Partial<Record<AppIconVariant, string>>,
  variant: AppIconVariant
): void => {
  if (tray.isDestroyed()) return
  const image = createVariantIcon(variantPaths, variant)
  if (image) tray.setImage(image)
}

// macOS menu-bar icons should be monochrome "template" images: black pixels on a transparent background
// that the system tints to match the light/dark menu bar. A prepared 16px/32px source is used directly;
// the legacy full-color conversion remains as a fallback when no dedicated asset is supplied.
const TEMPLATE_ICON_SIZE = 18
const createMacTemplateIcon = (
  iconPath: string,
  preparedTemplate: boolean
): NativeImage | undefined => {
  try {
    const source = nativeImage.createFromPath(iconPath)
    if (source.isEmpty()) return undefined

    if (preparedTemplate) {
      source.setTemplateImage(true)
      return source
    }

    const { width, height } = source.getSize()
    if (!width || !height) return undefined

    // toBitmap() is BGRA. Map luminance to alpha so the dark container (low luminance) becomes
    // transparent and the light dots stay opaque with soft anti-aliased edges; paint every pixel black
    // so setTemplateImage can tint it.
    const bitmap = source.toBitmap()
    for (let i = 0; i < bitmap.length; i += 4) {
      const luminance = 0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i]
      const luminanceAlpha = Math.max(
        0,
        Math.min(255, Math.round(((luminance - 90) / (232 - 90)) * 255))
      )
      const alpha = Math.round((luminanceAlpha * bitmap[i + 3]) / 255)
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
  templateIconPath?: string
  // Windows-only: per-variant tray tiles so the tray glyph follows the app icon chosen in settings
  // (light tile for the light variant, dark tile for the dark one). Switched live via
  // setTrayIconVariant when the user changes the setting.
  variantIconPaths?: Partial<Record<AppIconVariant, string>>
  // The persisted variant to start with; defaults to the shared default when unset.
  initialVariant?: AppIconVariant
  onShow: () => void
  onHide: () => void
  onQuit: () => void
  headless?: boolean
  onOpenWeb?: () => void | Promise<void>
  onCopyWebUrl?: () => void | Promise<void>
  translate?: NativeTranslator
}): Tray | undefined => {
  try {
    // macOS gets a monochrome template glyph that follows the menu-bar appearance; other platforms use
    // the full-color icon. An empty image is tolerated so the tray still appears with a blank glyph.
    const icon =
      process.platform === 'darwin'
        ? (createMacTemplateIcon(
            opts.templateIconPath ?? opts.iconPath,
            Boolean(opts.templateIconPath)
          ) ?? nativeImage.createFromPath(opts.iconPath))
        : ((opts.variantIconPaths &&
            createVariantIcon(
              opts.variantIconPaths,
              opts.initialVariant ?? DEFAULT_APP_ICON_VARIANT
            )) ??
          nativeImage.createFromPath(opts.iconPath))
    const tray = new Tray(icon)

    const headlessWeb = opts.headless && opts.onOpenWeb && opts.onCopyWebUrl
    const translate = opts.translate ?? englishNativeTranslator
    let menu: ReturnType<typeof Menu.buildFromTemplate>
    const rebuildMenu = (): void => {
      menu = Menu.buildFromTemplate(
        headlessWeb
          ? [
              { label: translate('Open Web UI'), click: () => void opts.onOpenWeb!() },
              { label: translate('Copy URL'), click: () => void opts.onCopyWebUrl!() },
              { type: 'separator' },
              { label: translate('Quit', { context: 'verb' }), click: () => opts.onQuit() }
            ]
          : [
              { label: translate('Show'), click: () => opts.onShow() },
              { label: translate('Hide'), click: () => opts.onHide() },
              { type: 'separator' },
              { label: translate('Quit', { context: 'verb' }), click: () => opts.onQuit() }
            ]
      )
      if (!(process.platform === 'win32' && headlessWeb)) tray.setContextMenu(menu)
    }
    rebuildMenu()
    trayMenuRefreshers.set(tray, rebuildMenu)

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
      tray.on('click', primaryAction)
    }

    return tray
  } catch (error) {
    // No tray host available: log and let the caller fall back to normal window/quit behavior.
    logger.error('failed to create tray', error)
    return undefined
  }
}

const refreshAppTrayLocale = (tray: Tray | undefined): void => {
  if (!tray || tray.isDestroyed()) return
  trayMenuRefreshers.get(tray)?.()
}

export { createAppTray, refreshAppTrayLocale, setTrayIconVariant }
