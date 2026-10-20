import {
  SETTINGS_WINDOW_CHANNELS,
  type SettingsWindowOpenRequest,
  type SettingsWindowState,
  type SettingsWindowContext,
  type SettingsWorkspaceNavigation
} from '../settings-window'
import type {
  CloseConfirmDismissal,
  CloseConfirmRequest,
  CloseConfirmResponse,
  WindowFindAppearance,
  WindowFindRequest,
  WindowFindResult,
  WindowsTitleBarAppearance,
  WindowsTitleBarCommand,
  WindowsTitleBarMenuRequest
} from '../window-controls'

import type { InterfaceScale } from '../interface-scale'

import {
  callable,
  SEND,
  type RemoveListener,
  WINDOW_FIND_READY,
  MAPPED_NATIVE,
  ELECTRON,
  CLOSE_PANE_EVENT,
  ELECTRON_EVENT,
  type AcpListener
} from './definition'

export const contracts = {
  'window.openSettings': callable<(request?: SettingsWindowOpenRequest) => Promise<void>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.open, ELECTRON],
    { optionalMember: true }
  ),
  'window.closeSettings': callable<() => Promise<void>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.close, ELECTRON],
    { optionalMember: true }
  ),
  'window.onSettingsCloseRequested': callable<(listener: () => void) => RemoveListener>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.closeRequested, ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'window.settingsReady': callable<() => Promise<SettingsWindowState>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.ready, ELECTRON],
    { optionalMember: true }
  ),
  'window.onSettingsOpened': callable<
    (listener: (state: SettingsWindowState) => void) => RemoveListener
  >()('window', [SETTINGS_WINDOW_CHANNELS.opened, ELECTRON_EVENT], { optionalMember: true }),
  'window.updateSettingsContext': callable<(context: SettingsWindowContext) => Promise<void>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.context, ELECTRON],
    { optionalMember: true }
  ),
  'window.navigateWorkspace': callable<(request: SettingsWorkspaceNavigation) => Promise<void>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.navigate, ELECTRON],
    { optionalMember: true }
  ),
  'window.onWorkspaceNavigation': callable<
    (
      listener: (request: SettingsWorkspaceNavigation & { navigationToken: number }) => void
    ) => RemoveListener
  >()('window', [SETTINGS_WINDOW_CHANNELS.navigation, ELECTRON_EVENT], { optionalMember: true }),
  'window.workspaceNavigated': callable<(navigationToken: number) => Promise<void>>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.navigated, ELECTRON],
    { optionalMember: true }
  ),
  'window.onSettingsCatalogChanged': callable<(listener: () => void) => RemoveListener>()(
    'window',
    [SETTINGS_WINDOW_CHANNELS.catalogChanged, ELECTRON_EVENT],
    { optionalMember: true }
  ),

  'window.announceWindowFindAppearance': callable<(appearance: WindowFindAppearance) => void>()(
    'window',
    ['window:find-appearance-changed', SEND],
    { optionalMember: true }
  ),
  'window.announceWindowFindContentReady': callable<() => void>()(
    'window',
    ['shortcut:window-find-content-ready', SEND],
    { optionalMember: true }
  ),
  'window.announceWindowFindReady': callable<() => RemoveListener>()(
    'window',
    ['shortcut:window-find-ready', WINDOW_FIND_READY],
    { optionalMember: true }
  ),
  'window.clearFind': callable<() => void>()('window', ['window:clear-find-in-page', SEND], {
    optionalMember: true
  }),
  'window.close': callable<() => Promise<void>>()('window', ['window:close', MAPPED_NATIVE]),
  'window.isFullScreen': callable<() => Promise<boolean>>()(
    'window',
    ['window:is-full-screen', ELECTRON],
    { optionalMember: true }
  ),
  'window.onFullScreenChanged': callable<
    (listener: (fullscreen: boolean) => void) => RemoveListener
  >()('window', ['window:full-screen-changed', ELECTRON_EVENT], { optionalMember: true }),
  'window.showTitleBarMenu': callable<
    (request: WindowsTitleBarMenuRequest) => Promise<WindowsTitleBarCommand | null>
  >()('window', ['window:show-titlebar-menu', ELECTRON], { optionalMember: true }),
  'window.updateTitleBar': callable<(appearance: WindowsTitleBarAppearance) => Promise<void>>()(
    'window',
    ['window:update-titlebar', ELECTRON],
    { optionalMember: true }
  ),
  'window.setZoomFactor': callable<(factor: number) => Promise<void>>()(
    'window',
    ['window:set-zoom-factor', ELECTRON],
    { optionalMember: true }
  ),
  'window.closeFind': callable<() => void>()('window', ['window:find-close', SEND], {
    optionalMember: true
  }),
  'window.findInPage': callable<(request: WindowFindRequest) => void>()(
    'window',
    ['window:find-in-page', SEND],
    { optionalMember: true }
  ),
  'window.onCloseActivePane': callable<(listener: () => void) => RemoveListener>()(
    'window',
    ['shortcut:close-active-pane', CLOSE_PANE_EVENT],
    { optionalMember: true }
  ),
  'window.onInterfaceScaleShortcut': callable<
    (listener: (scale: InterfaceScale) => void) => RemoveListener
  >()('window', ['shortcut:interface-scale', ELECTRON_EVENT], { optionalMember: true }),
  'window.onCloseConfirmDismiss': callable<
    (listener: (payload: CloseConfirmDismissal) => void) => RemoveListener
  >()('window', ['window:close-confirm-dismiss', ELECTRON_EVENT], { optionalMember: true }),
  'window.onCloseConfirmRequest': callable<
    (listener: (payload: CloseConfirmRequest) => void) => RemoveListener
  >()('window', ['window:close-confirm-request', ELECTRON_EVENT], { optionalMember: true }),
  'window.onFindInPageResult': callable<
    (listener: AcpListener<WindowFindResult>) => RemoveListener
  >()('window', ['window:find-in-page-result', ELECTRON_EVENT], { optionalMember: true }),
  'window.onFindInOffice': callable<(listener: AcpListener<string>) => RemoveListener>()(
    'window',
    ['window:find-office', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'window.onHideWindowFind': callable<(listener: () => void) => RemoveListener>()(
    'window',
    ['window:find-hide', ELECTRON_EVENT],
    { optionalMember: true }
  ),
  'window.onShowWindowFind': callable<
    (listener: AcpListener<WindowFindAppearance>) => RemoveListener
  >()('window', ['window:find-show', ELECTRON_EVENT], { optionalMember: true }),
  'window.onWindowFindAppearance': callable<
    (listener: AcpListener<WindowFindAppearance>) => RemoveListener
  >()('window', ['window:find-appearance', ELECTRON_EVENT], { optionalMember: true }),
  'window.sendCloseConfirmResponse': callable<(payload: CloseConfirmResponse) => void>()(
    'window',
    ['window:close-confirm-response', SEND],
    { optionalMember: true }
  )
} as const
