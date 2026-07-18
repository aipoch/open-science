// Shared window-control contract between main, preload, and renderer. No main/renderer imports so it
// can be consumed from any layer.
//
// Cmd+W (macOS) / Ctrl+W (Windows, Linux) is repurposed: when the workspace preview panel (the third
// column) is open it closes that panel instead of the window. The main process intercepts the chord
// and forwards it to the renderer, which decides whether to collapse the panel or close the window.

// Renderer -> main: close the focused window (the fallback when no pane is open).
export const WINDOW_CLOSE_CHANNEL = 'window:close'

// Main -> renderer: the close chord was pressed; the renderer decides pane-vs-window.
export const CLOSE_ACTIVE_PANE_CHANNEL = 'shortcut:close-active-pane'

// Renderer -> main: the renderer's close-chord listener is mounted. Until main sees this it must not
// swallow the chord (the forwarded message would be dropped), so it closes the window directly instead.
export const CLOSE_ACTIVE_PANE_READY_CHANNEL = 'shortcut:close-active-pane-ready'

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
