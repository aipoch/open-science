import { useEffect, type RefObject } from 'react'

const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
const HIDDEN_SEARCH_SELECTOR = '[data-state="closed"], [hidden], [aria-hidden="true"]'

export const getSettingsSearchKeyShortcuts = (): string =>
  window.api?.platform === 'darwin' ? 'Meta+K' : 'Control+K'

type RegisteredSettingsSearch = {
  // The ref rather than the element: popover-mounted fields attach their input after the
  // registering effect runs, so eligibility is resolved at shortcut time.
  inputRef: RefObject<HTMLInputElement | null>
  // Higher priority wins within the same topmost dialog. Panel-scoped fields stay at 0; the
  // dialog-wide settings search registers above them so the shortcut is not captured by
  // whichever panel search mounted last.
  priority: number
  // Registration order breaks same-priority ties toward the most recently mounted field, matching
  // the historical last-listener-wins behavior.
  order: number
}

const registered: RegisteredSettingsSearch[] = []
let registrationOrder = 0
let listening = false

const isEligible = (input: HTMLInputElement | null): input is HTMLInputElement => {
  if (!input?.isConnected || input.disabled) return false
  if (input.closest(HIDDEN_SEARCH_SELECTOR)) return false

  const dialogs = document.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR)
  const topmostDialog = dialogs.item(dialogs.length - 1)
  if (topmostDialog && input.closest(OPEN_DIALOG_SELECTOR) !== topmostDialog) return false
  return true
}

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

  let winner: RegisteredSettingsSearch | undefined
  for (const entry of registered) {
    if (!isEligible(entry.inputRef.current)) continue
    if (
      !winner ||
      entry.priority > winner.priority ||
      (entry.priority === winner.priority && entry.order > winner.order)
    ) {
      winner = entry
    }
  }
  if (!winner) return

  event.preventDefault()
  winner.inputRef.current?.focus({ preventScroll: true })
}

export const useSettingsSearchShortcut = (
  inputRef: RefObject<HTMLInputElement | null>,
  enabled = true,
  priority = 0
): void => {
  useEffect(() => {
    if (!enabled) return

    const entry: RegisteredSettingsSearch = { inputRef, priority, order: ++registrationOrder }
    registered.push(entry)
    if (!listening) {
      window.addEventListener('keydown', focusSearch)
      listening = true
    }

    return () => {
      const index = registered.indexOf(entry)
      if (index >= 0) registered.splice(index, 1)
      if (listening && registered.length === 0) {
        window.removeEventListener('keydown', focusSearch)
        listening = false
      }
    }
  }, [enabled, priority, inputRef])
}
