// Route the owning Settings dialog's Escape to its inline About guide, including when focus has
// moved into another Settings section. Portaled dialogs have a different owner and stay independent.
export const SETTINGS_MANUAL_UPDATE_GUIDE_CLOSE = 'settings-manual-update-guide-close'

export const dismissSettingsManualUpdateGuide = (event: KeyboardEvent): boolean => {
  const owner =
    event.target instanceof Element ? event.target.closest('[data-slot="settings-dialog"]') : null
  const guide = owner?.querySelector('[data-manual-update-guide]')
  if (!guide) return false
  event.preventDefault()
  guide.dispatchEvent(new Event(SETTINGS_MANUAL_UPDATE_GUIDE_CLOSE, { bubbles: true }))
  return true
}
