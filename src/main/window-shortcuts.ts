import type { App, BrowserWindow, Input, WebContents } from 'electron'
import { optimizer, type shortcutOptions } from '@electron-toolkit/utils'

import {
  INTERFACE_SCALE_SHORTCUT_CHANNEL,
  isInterfaceScale,
  resolveInterfaceScaleShortcut,
  type InterfaceScaleShortcut
} from '../shared/interface-scale'

const scaleShortcutForInput = (input: Input): InterfaceScaleShortcut | undefined => {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined

  if (
    (input.code === 'Equal' && (input.key === '=' || input.key === '+')) ||
    input.code === 'NumpadAdd'
  )
    return 'increase'
  if (input.code === 'Minus' && input.key === '-') return 'decrease'
  if ((input.code === 'Digit0' || input.code === 'Numpad0') && input.key === '0') return 'reset'
  return undefined
}

const applyInterfaceScaleShortcut = (
  webContents: Pick<WebContents, 'getZoomFactor' | 'setZoomFactor' | 'send'>,
  shortcut: InterfaceScaleShortcut
): void => {
  const factor = webContents.getZoomFactor()
  const current = isInterfaceScale(factor) ? factor : 1
  const next = resolveInterfaceScaleShortcut(current, shortcut)
  webContents.setZoomFactor(next)
  webContents.send(INTERFACE_SCALE_SHORTCUT_CHANNEL, next)
}

// Main-window shortcuts and the Settings control use the same Electron zoom factor. Other windows
// keep their native zoom menu behavior. `zoom: true` leaves the chords available to this listener.
const installWindowShortcuts = (
  app: App,
  options?: Omit<shortcutOptions, 'zoom'>,
  isMainWindow: (window: BrowserWindow) => boolean = () => true
): void => {
  app.on('browser-window-created', (_event: unknown, window: BrowserWindow) => {
    optimizer.watchWindowShortcuts(window, { ...options, zoom: true })

    window.webContents.on('before-input-event', (event, input) => {
      if (!isMainWindow(window)) return
      const shortcut = scaleShortcutForInput(input)
      if (!shortcut) return

      event.preventDefault()
      applyInterfaceScaleShortcut(window.webContents, shortcut)
    })
  })
}

export { applyInterfaceScaleShortcut, installWindowShortcuts, scaleShortcutForInput }
