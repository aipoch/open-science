const key = 'open-science:smart-reevaluation-confirmation-dismissed'
export function shouldConfirmSmartReevaluation(): boolean {
  try {
    return window.localStorage.getItem(key) !== 'true'
  } catch {
    return true
  }
}
export function setSmartReevaluationConfirmation(enabled: boolean): boolean {
  try {
    if (enabled) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, 'true')
    return true
  } catch {
    return false
  }
}
