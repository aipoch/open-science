import { useEffect, type RefObject } from 'react'

const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
const HIDDEN_SEARCH_SELECTOR = '[data-state="closed"], [hidden], [aria-hidden="true"]'

export const getSettingsSearchKeyShortcuts = (): string =>
  window.api?.platform === 'darwin' ? 'Meta+K' : 'Control+K'

export const useSettingsSearchShortcut = (
  inputRef: RefObject<HTMLInputElement | null>,
  enabled = true
): void => {
  useEffect(() => {
    if (!enabled) return

    const focusSearch = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return
      }

      const input = inputRef.current
      if (!input?.isConnected || input.disabled) return
      if (input.closest(HIDDEN_SEARCH_SELECTOR)) return

      const dialogs = document.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR)
      const topmostDialog = dialogs.item(dialogs.length - 1)
      if (topmostDialog && input.closest(OPEN_DIALOG_SELECTOR) !== topmostDialog) return

      event.preventDefault()
      input.focus({ preventScroll: true })
    }

    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [enabled, inputRef])
}
