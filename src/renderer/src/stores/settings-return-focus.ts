let settingsReturnFocusTarget: HTMLElement | null = null

const findMenuTrigger = (menuItem: HTMLElement): HTMLElement | null => {
  if (
    typeof menuItem.matches !== 'function' ||
    !menuItem.matches('[role="menuitem"], [data-slot="dropdown-menu-item"]')
  )
    return null
  const menu = menuItem.closest?.('[role="menu"], [data-slot="dropdown-menu-content"]')
  if (!(menu instanceof HTMLElement) || !menu.id) return null
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find(
      (candidate) => candidate.isConnected && candidate.getAttribute('aria-controls') === menu.id
    ) ?? null
  )
}

export const rememberSettingsReturnFocusTarget = (isSettingsOpen: boolean): void => {
  if (isSettingsOpen || typeof document === 'undefined') return
  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement) || activeElement === document.body) {
    settingsReturnFocusTarget = null
    return
  }
  const isTransientMenuItem =
    typeof activeElement.matches === 'function' &&
    activeElement.matches('[role="menuitem"], [data-slot="dropdown-menu-item"]')
  settingsReturnFocusTarget =
    findMenuTrigger(activeElement) ?? (isTransientMenuItem ? null : activeElement)
}

export const takeSettingsReturnFocusTarget = (): HTMLElement | null => {
  const target = settingsReturnFocusTarget
  settingsReturnFocusTarget = null
  return target
}
