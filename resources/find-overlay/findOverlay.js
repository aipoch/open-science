export const LAST_QUERY_STORAGE_KEY = 'open-science:window-find:last-query'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function createFindOverlay(deps) {
  const { input, count, prev, next, close, api, storage } = deps
  const ownerDocument = input.ownerDocument
  const systemTheme = ownerDocument.defaultView?.matchMedia?.(DARK_QUERY)

  let currentRequestId = 0
  let followsSystem = false
  count.textContent = '0 / 0'

  const nextRequestId = () => {
    currentRequestId += 1
    return currentRequestId
  }

  const search = (text, { findNext = true, forward = true } = {}) => {
    const requestId = nextRequestId()
    api.findInPage({ requestId, text, findNext, forward })
  }

  const applyTheme = (theme) => {
    ownerDocument.documentElement.classList.toggle('dark', theme === 'dark')
  }

  const onSystemThemeChange = (event) => {
    if (followsSystem) applyTheme(event.matches ? 'dark' : 'light')
  }
  systemTheme?.addEventListener('change', onSystemThemeChange)

  const handleAppearance = (appearance) => {
    followsSystem = appearance?.followsSystem === true
    const theme =
      followsSystem && systemTheme
        ? systemTheme.matches
          ? 'dark'
          : 'light'
        : appearance?.theme === 'dark' || appearance?.theme === 'light'
          ? appearance.theme
          : systemTheme?.matches
            ? 'dark'
            : 'light'
    applyTheme(theme)
  }

  const handleShow = (appearance) => {
    handleAppearance(appearance)
    input.focus()
    const remembered = storage.getItem(LAST_QUERY_STORAGE_KEY) ?? ''
    if (remembered) {
      input.value = remembered
      search(remembered, { findNext: true, forward: true })
    }
  }

  const onInput = () => {
    const value = input.value
    storage.setItem(LAST_QUERY_STORAGE_KEY, value)
    if (value === '') {
      nextRequestId()
      api.clearFind()
      count.textContent = '0 / 0'
    } else {
      search(value, { findNext: true, forward: true })
    }
  }

  const onResult = (result) => {
    if (result.requestId !== currentRequestId) {
      return
    }
    count.textContent = `${result.activeMatchOrdinal} / ${result.matches}`
  }

  const query = () => input.value

  const goForward = () => {
    if (query() === '') {
      return
    }
    search(query(), { findNext: false, forward: true })
  }

  const goBackward = () => {
    if (query() === '') {
      return
    }
    search(query(), { findNext: false, forward: false })
  }

  const handleClose = () => {
    api.closeFind()
  }

  const onKeydown = (event) => {
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault()
      if (event.shiftKey) {
        goBackward()
      } else {
        goForward()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      handleClose()
    }
  }

  input.addEventListener('input', onInput)
  ownerDocument.addEventListener('keydown', onKeydown)
  prev.addEventListener('click', goBackward)
  next.addEventListener('click', goForward)
  close.addEventListener('click', handleClose)

  const offResult = api.onFindInPageResult(onResult)
  const offShow = api.onShowWindowFind(handleShow)
  const offAppearance = api.onWindowFindAppearance(handleAppearance)

  return {
    destroy() {
      offResult()
      offShow()
      offAppearance()
      input.removeEventListener('input', onInput)
      ownerDocument.removeEventListener('keydown', onKeydown)
      prev.removeEventListener('click', goBackward)
      next.removeEventListener('click', goForward)
      close.removeEventListener('click', handleClose)
      systemTheme?.removeEventListener('change', onSystemThemeChange)
    }
  }
}

// Self-wire when loaded as the overlay page's module. Guarded on the overlay's own element ids so
// importing this module in a test harness (jsdom, no #find-overlay-query) is a no-op.
const bootOverlay = () => {
  if (typeof document === 'undefined') return
  const input = document.getElementById('find-overlay-query')
  if (!(input instanceof HTMLInputElement)) return
  const count = document.getElementById('find-overlay-count')
  const prev = document.getElementById('find-overlay-prev')
  const next = document.getElementById('find-overlay-next')
  const close = document.getElementById('find-overlay-close')
  if (!count || !prev || !next || !close) return
  const api = window.api?.window
  if (!api) return
  createFindOverlay({ input, count, prev, next, close, api, storage: window.localStorage })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOverlay, { once: true })
  } else {
    bootOverlay()
  }
}
