let settingsReturnFocusTarget: HTMLElement | null = null

export const rememberSettingsReturnFocusTarget = (isSettingsOpen: boolean): void => {
  if (isSettingsOpen || typeof document === 'undefined') return
  const activeElement = document.activeElement
  settingsReturnFocusTarget =
    activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null
}

export const takeSettingsReturnFocusTarget = (): HTMLElement | null => {
  const target = settingsReturnFocusTarget
  settingsReturnFocusTarget = null
  return target
}
