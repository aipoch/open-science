// Shared window-control contract between main, preload, and renderer. No main/renderer imports so it
// can be consumed from any layer.
//
// Cmd+W (macOS) / Ctrl+W (Windows, Linux) is repurposed: when the workspace preview panel (the third
// column) is open it closes that panel instead of the window. The main process intercepts the chord
// and forwards it to the renderer, which decides whether to collapse the panel or close the window.

import type { ActiveSessionInfo } from './storage'

// Renderer -> main: close the focused window (the fallback when no pane is open).
export const WINDOW_CLOSE_CHANNEL = 'window:close'

// Main -> renderer: the close chord was pressed; the renderer decides pane-vs-window.
export const CLOSE_ACTIVE_PANE_CHANNEL = 'shortcut:close-active-pane'

// Renderer -> main: the renderer's close-chord listener is mounted. Until main sees this it must not
// swallow the chord (the forwarded message would be dropped), so it closes the window directly instead.
export const CLOSE_ACTIVE_PANE_READY_CHANNEL = 'shortcut:close-active-pane-ready'

// Renderer -> main: the close-chord listener has been torn down (hook unmount). Main re-arms its
// direct-close fallback so a stale "ready" flag never makes it swallow the chord into a gone listener.
export const CLOSE_ACTIVE_PANE_UNREADY_CHANNEL = 'shortcut:close-active-pane-unready'

// Renderer -> main: the Workspace find listener is mounted or unmounted. Main preserves the browser's
// normal Cmd/Ctrl+F behavior outside Workspace rather than swallowing the chord into a missing UI.
export const WINDOW_FIND_READY_CHANNEL = 'shortcut:window-find-ready'
export const WINDOW_FIND_UNREADY_CHANNEL = 'shortcut:window-find-unready'

// Renderer -> main requests and main -> renderer result events for Electron's native whole-window find.
export const WINDOW_FIND_REQUEST_CHANNEL = 'window:find-in-page'
export const WINDOW_FIND_CLEAR_CHANNEL = 'window:clear-find-in-page'
export const WINDOW_FIND_RESULT_CHANNEL = 'window:find-in-page-result'

// Main -> overlay: the find bar was just shown — apply the main renderer's resolved appearance,
// focus the field, and re-run the remembered query. `followsSystem` lets the separate file:// overlay
// live-follow OS changes without trying to read the renderer's origin-scoped localStorage.
export const WINDOW_FIND_SHOW_CHANNEL = 'window:find-show'

// Main -> overlay: refresh only the overlay appearance after an asynchronous renderer lookup. Kept
// separate from SHOW so a late theme result never steals focus or re-runs the remembered query.
export const WINDOW_FIND_APPEARANCE_CHANNEL = 'window:find-appearance'

// Main renderer -> main: the app's resolved appearance changed. Main validates and caches this on the
// window-owned overlay manager, which forwards it if the find bar is currently open.
export const WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL = 'window:find-appearance-changed'

// Overlay -> main: the user closed the find bar — hide the overlay and release the main-window focus.
export const WINDOW_FIND_CLOSE_CHANNEL = 'window:find-close'

export type WindowFindRequest = {
  requestId: number
  text: string
  findNext: boolean
  forward: boolean
}

export type WindowFindResult = {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export type WindowFindAppearance = {
  theme: 'light' | 'dark'
  followsSystem: boolean
}

export const isWindowFindAppearance = (value: unknown): value is WindowFindAppearance => {
  if (!value || typeof value !== 'object') return false
  const appearance = value as Partial<WindowFindAppearance>
  return (
    (appearance.theme === 'light' || appearance.theme === 'dark') &&
    typeof appearance.followsSystem === 'boolean'
  )
}

// The minimal IPC surface the renderer handshake needs, kept structural so the wiring can be unit-tested
// without loading preload or importing electron.
export type CloseActivePaneBridge = {
  on: (channel: string, listener: () => void) => () => void
  send: (channel: string) => void
}

// Wires a renderer close-chord subscription to the main handshake: announce READY on subscribe so main
// forwards the chord here, and UNREADY on teardown so main re-arms its direct-close fallback. Lives here
// (not inline in preload) so the exact channels and ordering are covered by shared unit tests.
export const subscribeCloseActivePane = (
  bridge: CloseActivePaneBridge,
  listener: () => void
): (() => void) => {
  const removeListener = bridge.on(CLOSE_ACTIVE_PANE_CHANNEL, listener)
  bridge.send(CLOSE_ACTIVE_PANE_READY_CHANNEL)

  return () => {
    removeListener()
    bridge.send(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL)
  }
}

// In the overlay-window architecture main opens the find bar itself (no OPEN message reaches the
// renderer), so the Workspace only needs to tell main that it is mounted and searchable. This announces
// READY on mount and UNREADY on teardown, so main can keep intercepting Cmd/Ctrl+F only while a
// searchable Workspace is actually present.
export const announceWindowFindReady = (
  bridge: Pick<CloseActivePaneBridge, 'send'>
): (() => void) => {
  bridge.send(WINDOW_FIND_READY_CHANNEL)
  return () => bridge.send(WINDOW_FIND_UNREADY_CHANNEL)
}

// The subset of Electron's before-input-event Input that the chord test needs. Kept structural so the
// helper stays pure and unit-testable without importing electron.
export type KeyChordInput = {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat?: boolean
}

// Matches the platform-correct "close" chord: Cmd+W on macOS, Ctrl+W elsewhere (mirrors Electron's
// CmdOrCtrl accelerator). Matches the produced character `key` (not the physical `code`) so it tracks
// whatever key the OS Close accelerator responds to under non-QWERTY layouts — on AZERTY the character
// 'w' sits on a different physical key, so a `code === 'KeyW'` check would miss it and let the default
// Close fire uninterrupted. Rejects auto-repeat so a held chord cannot fall through to close the window
// after the pane is already gone.
export const isCloseWindowChord = (input: KeyChordInput, platform: string): boolean => {
  if (input.type !== 'keyDown') return false
  if (input.isAutoRepeat) return false
  if (input.key.toLowerCase() !== 'w') return false
  if (input.alt || input.shift) return false

  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}

// Matches the platform find chord. Shift is deliberately rejected: Cmd/Ctrl+Shift+F remains available
// to any future feature that needs that distinct accelerator.
export const isFindInPageChord = (input: KeyChordInput, platform: string): boolean => {
  if (input.type !== 'keyDown') return false
  if (input.isAutoRepeat) return false
  if (input.key.toLowerCase() !== 'f') return false
  if (input.alt || input.shift) return false

  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}

// --- Close/quit confirmation dialog (Windows X, and explicit quit when work is running) ---

// Main -> renderer: show the close/quit confirmation modal for `variant`, listing `sessions`.
export const WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL = 'window:close-confirm-request'

// Renderer -> main: modal mounted (ack) or the user chose an action (choice), keyed by requestId.
export const WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL = 'window:close-confirm-response'

// How a titlebar close resolves synchronously at close time: 'close' lets the window close, 'hide'
// minimizes to tray, 'confirm' asks the user via the confirmation modal.
export type CloseClassification = 'close' | 'hide' | 'confirm'

// 'close-to-tray' = Windows X (Minimize vs Quit); 'quit' = explicit quit (Quit vs Cancel).
export type CloseConfirmVariant = 'close-to-tray' | 'quit'

// 'minimize' only occurs for the 'close-to-tray' variant; 'cancel' keeps the app/window as-is.
export type CloseConfirmChoice = 'quit' | 'minimize' | 'cancel'

// Saved behavior for the Windows titlebar close action. Undefined means ask every time.
export type CloseActionPreference = Extract<CloseConfirmChoice, 'quit' | 'minimize'>

export type CloseConfirmRequest = {
  requestId: string
  variant: CloseConfirmVariant
  sessions: ActiveSessionInfo[]
}

// ack:true when the modal mounts (proves the renderer is alive); choice set when the user decides.
// remember is only meaningful for close-to-tray choices.
export type CloseConfirmResponse = {
  requestId: string
  ack?: boolean
  choice?: CloseConfirmChoice
  remember?: boolean
}
