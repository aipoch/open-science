import type { App, BrowserWindow } from 'electron'
import { optimizer, type shortcutOptions } from '@electron-toolkit/utils'

// Wraps `@electron-toolkit/utils`' `optimizer.watchWindowShortcuts` so it (a) tests cleanly with a
// mocked `app`, and (b) gets `zoom: true` baked in — without that the helper `preventDefault`s
// `Cmd/Ctrl+=` and `Cmd/Ctrl+-` in its `before-input-event` listener, silently disabling Electron's
// built-in zoomIn/zoomOut menu accelerators (issue #336). Default DevTools / reload behavior from
// electron-toolkit is preserved unchanged.
const installWindowShortcuts = (app: App, options?: Omit<shortcutOptions, 'zoom'>): void => {
  app.on('browser-window-created', (_event: unknown, window: BrowserWindow) => {
    optimizer.watchWindowShortcuts(window, { ...options, zoom: true })
  })
}

export { installWindowShortcuts }
