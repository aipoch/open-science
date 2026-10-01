import {
  BrowserWindow,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron'

import { APP } from '../shared/app-config'
import {
  WINDOWS_TITLEBAR_HEIGHT,
  WINDOWS_TITLEBAR_LABELS,
  type WindowsTitleBarAppearance,
  type WindowsTitleBarCommand,
  type WindowsTitleBarMenuRequest
} from '../shared/window-controls'
import { ipcMainHandle } from './ipc-handler-registry'
import { createLogger, diagnosticErrorFields } from './logger'
import { applyInterfaceScaleShortcut } from './window-shortcuts'

type TitleBarDeps = {
  isMainWindow: (window: BrowserWindow) => boolean
  platform?: string
  resolveWindow?: (event: IpcMainInvokeEvent) => BrowserWindow | null
}

const isMenuRequest = (value: unknown): value is WindowsTitleBarMenuRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as WindowsTitleBarMenuRequest
  return (
    ['file', 'edit', 'view', 'help'].includes(request.menu) &&
    Number.isFinite(request.x) &&
    Number.isFinite(request.y) &&
    request.x >= 0 &&
    request.y >= 0 &&
    typeof request.settingsEnabled === 'boolean' &&
    typeof request.searchEnabled === 'boolean' &&
    !!request.labels &&
    typeof request.labels === 'object' &&
    WINDOWS_TITLEBAR_LABELS.every(
      (key) =>
        typeof request.labels[key] === 'string' &&
        request.labels[key].length > 0 &&
        request.labels[key].length <= 128
    )
  )
}

const isAppearance = (value: unknown): value is WindowsTitleBarAppearance => {
  if (!value || typeof value !== 'object') return false
  const appearance = value as WindowsTitleBarAppearance
  return /^#[\da-f]{6}$/i.test(appearance.color) && /^#[\da-f]{6}$/i.test(appearance.symbolColor)
}

// Native popups preserve the editing target while the renderer supplies the title-bar buttons.
// Resolve all native effects against the invoking main window, never whichever window is focused.
export const registerWindowsTitleBarIpc = ({
  isMainWindow,
  platform = process.platform,
  resolveWindow = (event) => BrowserWindow.fromWebContents(event.sender)
}: TitleBarDeps): void => {
  if (platform !== 'win32') return
  const log = createLogger('windows-titlebar')
  const pending = new Set<BrowserWindow>()
  const ownerFor = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const window = resolveWindow(event)
    return window &&
      !window.isDestroyed() &&
      isMainWindow(window) &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
      ? window
      : null
  }

  ipcMainHandle(
    'window:is-full-screen',
    (event): boolean => ownerFor(event)?.isFullScreen() ?? false
  )

  ipcMainHandle('window:update-titlebar', (event, appearance: unknown): void => {
    const window = ownerFor(event)
    if (!window || !isAppearance(appearance)) return
    window.setTitleBarOverlay({
      ...appearance,
      height: Math.round(WINDOWS_TITLEBAR_HEIGHT * window.webContents.getZoomFactor())
    })
  })

  ipcMainHandle(
    'window:show-titlebar-menu',
    (event, request: unknown): Promise<WindowsTitleBarCommand | null> | null => {
      const window = ownerFor(event)
      if (!window || !isMenuRequest(request) || pending.has(window)) return null
      const bounds = window.getContentBounds()
      const scale = window.webContents.getZoomFactor()
      const x = Math.round(request.x * scale)
      const y = Math.round(request.y * scale)
      if (x > bounds.width || y > Math.round(WINDOWS_TITLEBAR_HEIGHT * scale)) return null

      return new Promise((resolve, reject) => {
        pending.add(window)
        let menu: Menu | undefined
        let settled = false
        const finish = (command: WindowsTitleBarCommand | null = null, error?: unknown): void => {
          if (settled) return
          settled = true
          pending.delete(window)
          window.removeListener('closed', onClosed)
          window.webContents.removeListener('did-start-navigation', onNavigation)
          if (error) reject(error)
          else resolve(command)
        }
        const dismiss = (): void => {
          menu?.closePopup(window)
          finish()
        }
        const onClosed = (): void => finish()
        const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
          if (details.isMainFrame && !details.isSameDocument) dismiss()
        }
        const item = (
          label: (typeof WINDOWS_TITLEBAR_LABELS)[number],
          role: MenuItemConstructorOptions['role']
        ): MenuItemConstructorOptions => ({
          label: request.labels[label],
          role,
          registerAccelerator: false
        })
        const separator: MenuItemConstructorOptions = { type: 'separator' }
        const template: MenuItemConstructorOptions[] =
          request.menu === 'file'
            ? [
                {
                  label: request.labels.Settings,
                  accelerator: 'Ctrl+,',
                  registerAccelerator: false,
                  enabled: request.settingsEnabled,
                  click: () => finish('settings')
                },
                separator,
                item('Close window', 'close'),
                item('Quit', 'quit')
              ]
            : request.menu === 'edit'
              ? [
                  item('Undo', 'undo'),
                  item('Redo', 'redo'),
                  separator,
                  item('Cut', 'cut'),
                  item('Copy', 'copy'),
                  item('Paste', 'paste'),
                  separator,
                  item('Select all', 'selectAll')
                ]
              : request.menu === 'view'
                ? [
                    {
                      label: request.labels.Search,
                      accelerator: 'Ctrl+K',
                      registerAccelerator: false,
                      enabled: request.searchEnabled,
                      click: () => finish('search')
                    },
                    separator,
                    ...(['increase', 'decrease', 'reset'] as const).map((shortcut, index) => ({
                      label:
                        request.labels[(['Zoom in', 'Zoom out', 'Reset zoom'] as const)[index]],
                      accelerator: ['Ctrl+Plus', 'Ctrl+-', 'Ctrl+0'][index],
                      registerAccelerator: false,
                      click: () => applyInterfaceScaleShortcut(window.webContents, shortcut)
                    })),
                    separator,
                    { ...item('Full screen', 'togglefullscreen'), checked: window.isFullScreen() }
                  ]
                : [
                    ...(['Documentation', 'GitHub'] as const).map((label) => ({
                      label: request.labels[label],
                      click: () => {
                        void shell
                          .openExternal(
                            label === 'Documentation' ? APP.links.docs : APP.links.githubRepo
                          )
                          .catch((error: unknown) =>
                            log.warn('help link open failed', diagnosticErrorFields(error))
                          )
                      }
                    }))
                  ]
        window.once('closed', onClosed)
        window.webContents.on('did-start-navigation', onNavigation)
        try {
          menu = Menu.buildFromTemplate(template)
          // Electron adds the window's content origin internally. Keep this anchor in local DIPs.
          menu.popup({ window, x, y, callback: () => finish() })
        } catch (error) {
          finish(null, error)
        }
      })
    }
  )
}
