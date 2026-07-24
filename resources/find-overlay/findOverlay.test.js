// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFindOverlay, LAST_QUERY_STORAGE_KEY } from './findOverlay.js'

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
    })
  }

  const store = new Map()
  const storage = {
    getItem: vi.fn((k) => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn((k, v) => {
      store.set(k, String(v))
    })
  }

  const deps = { input, count, prev, next, close, api, storage }
  const emitResult = (r) => resultListeners.forEach((l) => l(r))
  const emitShow = () => showListeners.forEach((l) => l())
  return { deps, api, storage, store, input, count, prev, next, close, emitResult, emitShow }
}

describe('createFindOverlay', () => {
  let ctx
  beforeEach(() => {
    document.body.innerHTML = ''
    ctx = setup()
  })

  it('subscribes to api events and returns a destroy() that unsubscribes both', () => {
    const overlay = createFindOverlay(ctx.deps)
    expect(ctx.api.onShowWindowFind).toHaveBeenCalledTimes(1)
    expect(ctx.api.onFindInPageResult).toHaveBeenCalledTimes(1)

    overlay.destroy()

    // After destroy, emitted events must not reach handlers (no throw, no find calls).
    expect(() => ctx.emitShow()).not.toThrow()
    expect(() => ctx.emitResult({ requestId: 1, activeMatchOrdinal: 1, matches: 1, finalUpdate: true })).not.toThrow()
  })

  it('exports the storage key constant', () => {
    expect(LAST_QUERY_STORAGE_KEY).toBe('open-science:window-find:last-query')
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

    const evt = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
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

    const evt = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    ctx.input.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(ctx.api.findInPage).toHaveBeenLastCalledWith({
      requestId: 2,
      text: 'protein',
      findNext: false,
      forward: false
    })
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
    ctx.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    ctx.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    ctx.next.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.prev.dispatchEvent(new Event('click', { bubbles: true }))
    ctx.close.dispatchEvent(new Event('click', { bubbles: true }))

    expect(ctx.api.findInPage).not.toHaveBeenCalled()
    expect(ctx.api.closeFind).not.toHaveBeenCalled()
    expect(ctx.storage.setItem).not.toHaveBeenCalled()
  })
})
