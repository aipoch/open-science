// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFindOverlay, LAST_QUERY_STORAGE_KEY } from './findOverlay.js'

const overlayHtml = readFileSync(resolve('resources/find-overlay/index.html'), 'utf8')

function setup() {
  const input = document.createElement('input')
  input.type = 'text'
  const count = document.createElement('span')
  const prev = document.createElement('button')
  const next = document.createElement('button')
  const close = document.createElement('button')
  document.body.append(input, count, prev, next, close)

  const resultListeners = new Set()
  const showListeners = new Set()
  const appearanceListeners = new Set()
  const api = {
    findInPage: vi.fn(),
    clearFind: vi.fn(),
    closeFind: vi.fn(),
    onFindInPageResult: vi.fn((listener) => {
      resultListeners.add(listener)
      return () => resultListeners.delete(listener)
    }),
    onShowWindowFind: vi.fn((listener) => {
      showListeners.add(listener)
      return () => showListeners.delete(listener)
    }),
    onWindowFindAppearance: vi.fn((listener) => {
      appearanceListeners.add(listener)
      return () => appearanceListeners.delete(listener)
    })
  }

  const store = new Map()
  const storage = {
    getItem: vi.fn((k) => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn((k, v) => {
      store.set(k, String(v))
    })
  }

  let systemDark = false
  const systemThemeListeners = new Set()
  const mediaQuery = {
    get matches() {
      return systemDark
    },
    addEventListener: vi.fn((_event, listener) => systemThemeListeners.add(listener)),
    removeEventListener: vi.fn((_event, listener) => systemThemeListeners.delete(listener))
  }
  Object.defineProperty(document.defaultView, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => mediaQuery)
  })

  const deps = { input, count, prev, next, close, api, storage }
  const emitResult = (r) => resultListeners.forEach((l) => l(r))
  const emitShow = (appearance = { theme: 'light', followsSystem: false }) =>
    showListeners.forEach((l) => l(appearance))
  const emitAppearance = (appearance) => appearanceListeners.forEach((l) => l(appearance))
  const emitSystemTheme = (matches) => {
    systemDark = matches
    systemThemeListeners.forEach((listener) => listener({ matches }))
  }
  return {
    deps,
    api,
    storage,
    store,
    input,
    count,
    prev,
    next,
    close,
    emitResult,
    emitShow,
    emitAppearance,
    emitSystemTheme,
    mediaQuery
  }
}

describe('createFindOverlay', () => {
  let ctx
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.classList.remove('dark')
    ctx = setup()
  })

  it('subscribes to api events and returns a destroy() that unsubscribes all', () => {
    const overlay = createFindOverlay(ctx.deps)
    expect(ctx.api.onShowWindowFind).toHaveBeenCalledTimes(1)
    expect(ctx.api.onFindInPageResult).toHaveBeenCalledTimes(1)
    expect(ctx.api.onWindowFindAppearance).toHaveBeenCalledTimes(1)

    overlay.destroy()

    // After destroy, emitted events must not reach handlers (no throw, no find calls).
    expect(() => ctx.emitShow()).not.toThrow()
    expect(() => ctx.emitAppearance({ theme: 'dark', followsSystem: false })).not.toThrow()
    expect(() =>
      ctx.emitResult({ requestId: 1, activeMatchOrdinal: 1, matches: 1, finalUpdate: true })
    ).not.toThrow()
  })

  it('exports the storage key constant', () => {
    expect(LAST_QUERY_STORAGE_KEY).toBe('open-science:window-find:last-query')
  })

  it('provides an accessible tooltip for every icon button', () => {
    const markup = new DOMParser().parseFromString(overlayHtml, 'text/html')
    const buttons = [...markup.querySelectorAll('button')]

    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      const tooltipId = button.getAttribute('aria-describedby')
      expect(button.hasAttribute('aria-label')).toBe(true)
      expect(button.hasAttribute('title')).toBe(false)
      expect(tooltipId).toBeTruthy()
      expect(markup.getElementById(tooltipId)?.getAttribute('role')).toBe('tooltip')
    }
  })

  it('uses app semantic tokens and visible keyboard focus styles', () => {
    expect(overlayHtml).not.toMatch(/--(?:bg|text|hover):/)
    expect(overlayHtml).toContain('--background:')
    expect(overlayHtml).toContain('--foreground:')
    expect(overlayHtml).toContain('--muted-foreground:')
    expect(overlayHtml).toContain('--ring:')
    expect(overlayHtml).toContain('.dark {')
    expect(overlayHtml).toContain('input:focus-visible')
    expect(overlayHtml).toContain('.btn:focus-visible')
    expect(overlayHtml).toMatch(/\.btn\s*\{[^}]*outline:\s*none/s)
    expect(overlayHtml).toMatch(/\.btn\s*\{[^}]*border-radius:\s*6px/s)
    expect(overlayHtml).toMatch(/\.btn\s*\{[^}]*transition:\s*(?:background-color|color)/s)
    expect(overlayHtml).toContain('@media (prefers-reduced-motion: reduce)')
    expect(overlayHtml).toContain("matchMedia?.('(prefers-color-scheme: dark)')")
    expect(overlayHtml.indexOf('matchMedia?.')).toBeLessThan(overlayHtml.indexOf('<style>'))
  })

  it('on show: focuses input and restores remembered query, searching with requestId 1', () => {
    ctx.store.set(LAST_QUERY_STORAGE_KEY, 'protein')
    const focusSpy = vi.spyOn(ctx.input, 'focus')

    createFindOverlay(ctx.deps)
    ctx.emitShow()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(ctx.input.value).toBe('protein')
    expect(ctx.api.findInPage).toHaveBeenCalledTimes(1)
    expect(ctx.api.findInPage).toHaveBeenCalledWith({
      requestId: 1,
      text: 'protein',
      findNext: true,
      forward: true
    })
  })

  it('on show with empty/absent remembered query: leaves input blank and does not search', () => {
    const focusSpy = vi.spyOn(ctx.input, 'focus')

    createFindOverlay(ctx.deps)
    ctx.emitShow()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(ctx.input.value).toBe('')
    expect(ctx.api.findInPage).not.toHaveBeenCalled()
  })

  it('applies the renderer-resolved app theme whenever the overlay is shown', () => {
    createFindOverlay(ctx.deps)

    ctx.emitShow({ theme: 'dark', followsSystem: false })

    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('lets an explicit light appearance override the dark-system startup fallback', () => {
    createFindOverlay(ctx.deps)
    ctx.emitSystemTheme(true)
    document.documentElement.classList.add('dark')

    ctx.emitShow({ theme: 'light', followsSystem: false })

    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('live-follows OS theme changes while the app preference is system', () => {
    createFindOverlay(ctx.deps)
    ctx.emitShow({ theme: 'light', followsSystem: true })

    ctx.emitSystemTheme(true)

    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('uses the current OS theme instead of a stale renderer snapshot in system mode', () => {
    createFindOverlay(ctx.deps)

    ctx.emitShow({ theme: 'dark', followsSystem: true })

    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('applies an asynchronous appearance update without refocusing or rerunning the query', () => {
    const focusSpy = vi.spyOn(ctx.input, 'focus')
    ctx.store.set(LAST_QUERY_STORAGE_KEY, 'protein')
    createFindOverlay(ctx.deps)
    ctx.emitShow({ theme: 'light', followsSystem: false })
    focusSpy.mockClear()
    ctx.api.findInPage.mockClear()

    ctx.emitAppearance({ theme: 'dark', followsSystem: false })

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(focusSpy).not.toHaveBeenCalled()
    expect(ctx.api.findInPage).not.toHaveBeenCalled()
  })

  it('typing a non-empty value searches with an incremented requestId and persists', () => {
    createFindOverlay(ctx.deps)

    ctx.input.value = 'pro'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(ctx.storage.setItem).toHaveBeenCalledWith(LAST_QUERY_STORAGE_KEY, 'pro')
    expect(ctx.api.findInPage).toHaveBeenCalledTimes(1)
    expect(ctx.api.findInPage).toHaveBeenCalledWith({
      requestId: 1,
      text: 'pro',
      findNext: true,
      forward: true
    })

    ctx.input.value = 'prote'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(ctx.storage.setItem).toHaveBeenCalledWith(LAST_QUERY_STORAGE_KEY, 'prote')
    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'prote',
      findNext: true,
      forward: true
    })
  })

  it('typing an empty value clears the find and renders 0 / 0', () => {
    createFindOverlay(ctx.deps)

    ctx.input.value = ''
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(ctx.storage.setItem).toHaveBeenCalledWith(LAST_QUERY_STORAGE_KEY, '')
    expect(ctx.api.clearFind).toHaveBeenCalledTimes(1)
    expect(ctx.api.findInPage).not.toHaveBeenCalled()
    expect(ctx.count.textContent).toBe('0 / 0')
  })

  it('renders active / total from a matching result', () => {
    createFindOverlay(ctx.deps)

    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1

    ctx.emitResult({ requestId: 1, activeMatchOrdinal: 3, matches: 7, finalUpdate: true })
    expect(ctx.count.textContent).toBe('3 / 7')
  })

  it('ignores stale results from an earlier requestId', () => {
    createFindOverlay(ctx.deps)

    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1
    ctx.input.value = 'variant'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 2

    // Late result for the abandoned "protein" search.
    ctx.emitResult({ requestId: 1, activeMatchOrdinal: 2, matches: 9, finalUpdate: true })
    expect(ctx.count.textContent).toBe('0 / 0')

    // Fresh result for "variant" wins.
    ctx.emitResult({ requestId: 2, activeMatchOrdinal: 1, matches: 4, finalUpdate: true })
    expect(ctx.count.textContent).toBe('1 / 4')
  })

  it('next button searches forward with findNext:false and an incremented id', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1

    ctx.next.dispatchEvent(new Event('click', { bubbles: true }))

    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'protein',
      findNext: false,
      forward: true
    })
  })

  it('Enter (no shift) in input searches forward like the next button and prevents default', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1

    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      bubbles: true,
      cancelable: true
    })
    ctx.input.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'protein',
      findNext: false,
      forward: true
    })
  })

  it('previous button searches backward with findNext:false, forward:false', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1

    ctx.prev.dispatchEvent(new Event('click', { bubbles: true }))

    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'protein',
      findNext: false,
      forward: false
    })
  })

  it('Shift+Enter in input searches backward and prevents default', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1

    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    ctx.input.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'protein',
      findNext: false,
      forward: false
    })
  })

  it('does not hijack Enter from a focused action button', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))
    ctx.api.findInPage.mockClear()

    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    })
    ctx.prev.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(false)
    expect(ctx.api.findInPage).not.toHaveBeenCalled()
  })

  it('next/prev do nothing when the query is empty', () => {
    createFindOverlay(ctx.deps)
    ctx.next.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.prev.dispatchEvent(new Event('click', { bubbles: true }))
    expect(ctx.api.findInPage).not.toHaveBeenCalled()
  })

  it('close button calls api.closeFind()', () => {
    createFindOverlay(ctx.deps)
    ctx.close.dispatchEvent(new Event('click', { bubbles: true }))
    expect(ctx.api.closeFind).toHaveBeenCalledTimes(1)
  })

  it('Escape in input calls api.closeFind() and prevents default; localStorage is not cleared', () => {
    createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))
    ctx.storage.setItem.mockClear()

    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ctx.input.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(ctx.api.closeFind).toHaveBeenCalledTimes(1)
    expect(ctx.storage.setItem).not.toHaveBeenCalledWith(LAST_QUERY_STORAGE_KEY, '')
    expect(ctx.storage.setItem).not.toHaveBeenCalledWith(LAST_QUERY_STORAGE_KEY, '')
  })

  it('Escape closes the overlay after a navigation button receives focus', () => {
    createFindOverlay(ctx.deps)
    ctx.next.focus()

    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ctx.next.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(ctx.api.closeFind).toHaveBeenCalledTimes(1)
  })

  it('destroy() detaches all DOM listeners so later events are inert', () => {
    const overlay = createFindOverlay(ctx.deps)
    ctx.input.value = 'protein'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true })) // requestId 1
    ctx.api.findInPage.mockClear()
    ctx.api.closeFind.mockClear()
    ctx.storage.setItem.mockClear()

    overlay.destroy()

    ctx.input.value = 'variant'
    ctx.input.dispatchEvent(new Event('input', { bubbles: true }))
    ctx.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    ctx.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    ctx.next.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.prev.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.close.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.emitAppearance({ theme: 'dark', followsSystem: false })

    expect(ctx.api.findInPage).not.toHaveBeenCalled()
    expect(ctx.api.closeFind).not.toHaveBeenCalled()
    expect(ctx.storage.setItem).not.toHaveBeenCalled()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(ctx.mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })
})
