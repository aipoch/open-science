import {
  INTERFACE_SCALE_OPTIONS,
  isInterfaceScale,
  type InterfaceScale
} from '../../../shared/interface-scale'

// Interface scale is a renderer-only display preference. It is intentionally kept separate from
// settings.json; the native zoom factor is applied before React mounts.
export const INTERFACE_SCALE_STORAGE_KEY = 'open-science-interface-scale'

const DEFAULT_INTERFACE_SCALE: InterfaceScale = 1
const WEB_SURFACE_ATTRIBUTE = 'data-open-science-web-events'

export const isDesktopRenderer = (): boolean =>
  typeof document === 'undefined' || !document.documentElement.hasAttribute(WEB_SURFACE_ATTRIBUTE)

export const getStoredInterfaceScale = (): InterfaceScale | undefined => {
  try {
    const value = Number(localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY))
    return isInterfaceScale(value) ? value : undefined
  } catch {
    return undefined
  }
}

export const resolveInterfaceScale = (): InterfaceScale =>
  getStoredInterfaceScale() ?? DEFAULT_INTERFACE_SCALE

export const applyInterfaceScale = async (scale: InterfaceScale): Promise<void> => {
  if (!isDesktopRenderer()) return

  const setZoomFactor = window.api?.window?.setZoomFactor
  if (typeof setZoomFactor === 'function') await setZoomFactor(scale)
}

export const persistInterfaceScale = (scale: InterfaceScale): void => {
  try {
    localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY, String(scale))
  } catch {
    // Non-fatal: the scale still applies for this session, it just won't be remembered.
  }
}

export { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_OPTIONS, isInterfaceScale }
export type { InterfaceScale }
