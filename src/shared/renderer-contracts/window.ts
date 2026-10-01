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
