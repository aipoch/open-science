import type { App, BrowserWindow, NativeImage } from 'electron'

import type { AppIconPreview, AppIconVariant } from '../shared/settings'
import { APP_ICON_VARIANT_INFOS, DEFAULT_APP_ICON_VARIANT } from '../shared/settings'
import { createLogger } from './logger'

const logger = createLogger('app-icon')

// Minimal electron surface the controller touches, injected so the wiring is unit-testable without a
// real Electron runtime (mirrors tray.ts).
export type AppIconElectron = {
  app: Pick<App, 'on' | 'dock' | 'isReady'>
  getAllWindows: () => BrowserWindow[]
  nativeImage: {
    createFromPath: (path: string) => NativeImage
  }
}

// Edge size (px) of the settings-preview thumbnail. Small enough to keep the data URLs light while
// staying crisp on high-DPI tiles.
const PREVIEW_SIZE = 96

// Builds the renderer-facing preview list: each known variant's label/description plus a small PNG
// data URL rendered from its bundled asset, so the picker shows exactly what will be applied. A
// variant whose asset is missing/empty is dropped rather than shown as a blank tile.
export const buildAppIconPreviews = (
  nativeImage: AppIconElectron['nativeImage'],
  variantPaths: Record<AppIconVariant, string>
): AppIconPreview[] => {
  const previews: AppIconPreview[] = []

  for (const info of APP_ICON_VARIANT_INFOS) {
    const path = variantPaths[info.id]
    if (!path) continue

    try {
      const image = nativeImage.createFromPath(path)
      if (image.isEmpty()) continue

      const thumbnail = image.resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, quality: 'best' })
      previews.push({ ...info, previewDataUrl: thumbnail.toDataURL() })
    } catch (error) {
      logger.error('failed to build app icon preview', { variant: info.id, error })
    }
  }

  return previews
}

export type AppIconControllerDeps = {
  electron: AppIconElectron
  // Absolute filesystem path of each variant's bundled platform asset (resolved by the ?asset import).
  variantPaths: Record<AppIconVariant, string>
  // The persisted variant to apply on startup.
  initialVariant: AppIconVariant
  // Overridable for tests; defaults to the host platform.
  platform?: NodeJS.Platform
}

// Owns the runtime app icon: the per-window icon off macOS (title bar / Alt-Tab, and the taskbar on
// most Linux WMs) and the Dock on macOS. The selected variant is applied to every current window and
// re-applied to each new window as it is created, so the choice survives window recreation (macOS
// activate, second-instance surface). NOTE: on Windows setIcon changes the window's own icon but NOT
// the taskbar button, which Windows keys off the AppUserModelID / the baked-in exe icon — so the
// taskbar there is intentionally out of scope. The installed bundle/exe icon is baked in and unaffected.
export type AppIconController = {
  // Applies a variant to every open window (off macOS) or the Dock (macOS) and remembers it for
  // windows created later.
  setVariant: (variant: AppIconVariant) => void
  // The variant currently applied.
  getVariant: () => AppIconVariant
}

// Builds a NativeImage for a variant, or undefined when the asset is missing/empty (so callers skip a
// blank icon rather than clearing the current one).
const loadIcon = (
  deps: AppIconControllerDeps,
  variant: AppIconVariant
): NativeImage | undefined => {
  const path = deps.variantPaths[variant]
  if (!path) return undefined

  try {
    const image = deps.electron.nativeImage.createFromPath(path)
    return image.isEmpty() ? undefined : image
  } catch (error) {
    logger.error('failed to load app icon asset', { variant, error })
    return undefined
  }
}

export const createAppIconController = (deps: AppIconControllerDeps): AppIconController => {
  const platform = deps.platform ?? process.platform
  const isDarwin = platform === 'darwin'
  // Cache each built image so repeated applies (every new window) don't re-decode the platform asset.
  const cache = new Map<AppIconVariant, NativeImage | undefined>()
  let current: AppIconVariant = deps.initialVariant

  const iconFor = (variant: AppIconVariant): NativeImage | undefined => {
    if (!cache.has(variant)) cache.set(variant, loadIcon(deps, variant))
    return cache.get(variant)
  }

  // Applies the current variant to one window. No-op on macOS: window icons are not shown there (the
  // dock carries the app icon instead), and setIcon would be a wasted call.
  const applyToWindow = (window: BrowserWindow): void => {
    if (isDarwin || window.isDestroyed()) return
    const icon = iconFor(current)
    if (icon) window.setIcon(icon)
  }

  // Applies the current variant to the macOS dock. No-op off macOS or before the dock exists.
  const applyToDock = (): void => {
    if (!isDarwin) return
    const icon = iconFor(current)
    if (icon) deps.electron.app.dock?.setIcon(icon)
  }

  const applyEverywhere = (): void => {
    if (isDarwin) {
      applyToDock()
      return
    }
    for (const window of deps.electron.getAllWindows()) applyToWindow(window)
  }

  // Every window created from here on picks up the current variant before it is shown, so a variant
  // switched while no window exists still lands on the next one (macOS activate, tray "Show").
  deps.electron.app.on('browser-window-created', (_event, window) => {
    applyToWindow(window)
  })

  // Apply the persisted variant now: the dock right away, and any window that already exists.
  applyEverywhere()

  return {
    setVariant: (variant: AppIconVariant): void => {
      current = variant
      applyEverywhere()
    },
    getVariant: (): AppIconVariant => current
  }
}

export { DEFAULT_APP_ICON_VARIANT }
