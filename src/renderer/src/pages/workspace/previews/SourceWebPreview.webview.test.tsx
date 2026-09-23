// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionMenuProvider } from '@/components/action-menu'
import { SourceWebPreview } from './SourceWebPreview'
import type { PreviewSourceItem } from '@/stores/preview-workbench-store'

const item: PreviewSourceItem = {
  id: 'source:https://example.com/paper',
  type: 'source',
  title: 'Paper',
  url: 'https://example.com/paper'
} as PreviewSourceItem
const fire = (element: Element, name: string, details: Record<string, unknown>): void => {
  element.dispatchEvent(Object.assign(new Event(name), details))
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  window.api = {
    getRuntimeVersions: () => ({ electron: '39.8.10', chrome: '142', node: '22' }),
    sourcePreview: { onContextMenu: () => () => {} }
  } as unknown as Window['api']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const render = async (title = 'Paper'): Promise<void> => {
  await act(async () =>
    root.render(
      <StrictMode>
        <ActionMenuProvider>
          <SourceWebPreview item={{ ...item, title }} />
        </ActionMenuProvider>
      </StrictMode>
    )
  )
}
describe('source webview lifetime', () => {
  it('ignores guest broadcasts while a connected tag is still attaching', async () => {
    const listeners: {
      blocked: (request: { guestId: number; url: string; navigationId: number }) => void
      menu: (request: { guestId: number; x: number; y: number }) => void
    } = { blocked: vi.fn(), menu: vi.fn() }
    window.api.sourcePreview!.onNavigationBlocked = (callback) => {
      listeners.blocked = callback
      return () => {}
    }
    window.api.sourcePreview!.onContextMenu = (callback) => {
      listeners.menu = callback
      return () => {}
    }
    await render()
    const guest = container.querySelector('webview')!
    Object.assign(guest, {
      getWebContentsId: () => {
        throw new Error('NOT_ATTACHED')
      },
      getClientRects: () => [{}]
    })
    expect(() =>
      listeners.blocked({ guestId: 20, url: 'http://blocked.example', navigationId: 0 })
    ).not.toThrow()
    expect(() => listeners.menu({ guestId: 20, x: 10, y: 10 })).not.toThrow()
    expect(container.querySelector('[data-source-preview-error]')).toBeNull()
  })
  it('ignores a blocked event from an older navigation generation', async () => {
    let blocked:
      ((request: { guestId: number; url: string; navigationId: number }) => void) | undefined
    window.api.sourcePreview!.onNavigationBlocked = (callback) => {
      blocked = callback
      return () => {}
    }
    await render()
    const webview = container.querySelector('webview')!
    Object.assign(webview, { getWebContentsId: () => 12, getClientRects: () => [{}] })
    await act(async () => {
      fire(webview, 'did-start-navigation', {
        isMainFrame: true,
        isInPlace: false,
        url: 'https://example.com/one'
      })
      fire(webview, 'did-start-navigation', {
        isMainFrame: true,
        isInPlace: false,
        url: 'https://example.com/two'
      })
    })
    await act(async () => {
      blocked?.({ guestId: 12, url: 'http://old.example', navigationId: 1 })
    })
    expect(container.querySelector('[data-source-preview-error]')).toBeNull()
    await act(async () => {
      blocked?.({ guestId: 12, url: 'http://current.example', navigationId: 2 })
    })
    expect(container.querySelector('[data-source-preview-error]')).not.toBeNull()
  })
  it.each(['hidden', 'inert'])(
    'does not restore menu focus into a %s source panel',
    async (attribute) => {
      let menu!: (request: { guestId: number; x: number; y: number }) => void
      window.api.sourcePreview!.onContextMenu = (callback) => {
        menu = callback
        return () => {}
      }
      await render()
      const guest = container.querySelector('webview')!
      const focus = vi.fn()
      Object.assign(guest, { getWebContentsId: () => 12, getClientRects: () => [{}], focus })
      await act(async () => menu({ guestId: 12, x: 10, y: 10 }))
      const action = document.body.querySelector<HTMLElement>('[data-action-id="open-source"]')!
      expect(action).not.toBeNull()
      // Keep the guest alive as a background tab while the shared menu is dismissed.
      container.setAttribute(attribute, '')
      vi.spyOn(window, 'open').mockReturnValue(null)
      await act(async () => action.click())
      expect(focus).not.toHaveBeenCalled()
    }
  )
  it('keeps one connected guest and writes src only once across StrictMode and rerenders', async () => {
    const setAttribute = vi.spyOn(Element.prototype, 'setAttribute')
    await render()
    const webview = container.querySelector('[data-source-preview-frame]')!
    expect(webview?.tagName).toBe('WEBVIEW')
    expect(webview.getAttribute('src')).toBe(item.url)
    await act(async () =>
      fire(webview, 'did-frame-navigate', {
        isMainFrame: true,
        url: 'https://example.com/redirect',
        httpResponseCode: 200,
        httpStatusText: 'OK'
      })
    )
    await render('Updated title')
    expect(container.querySelector('webview')).toBe(webview)
    expect(container.querySelector('[data-source-preview-header-url]')?.textContent).toBe(
      'https://example.com/redirect'
    )
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toEqual([['src', item.url]])
    expect(webview.isConnected).toBe(true)
  })
  it('retries the existing guest instead of replacing its browsing context', async () => {
    await render()
    const webview = container.querySelector('[data-source-preview-frame]')!
    expect(webview?.tagName).toBe('WEBVIEW')
    const reload = vi.fn()
    Object.assign(webview, { reload })
    await act(async () =>
      fire(webview, 'did-fail-load', {
        isMainFrame: true,
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        validatedURL: item.url
      })
    )
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again'
    )
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(reload).toHaveBeenCalledOnce()
    expect(container.querySelector('webview')).toBe(webview)
    expect(webview.getAttribute('src')).toBe(item.url)
  })
  it('ignores aborted and child-frame failures and retains HTTP errors through hash changes', async () => {
    await render()
    const webview = container.querySelector('[data-source-preview-frame]')!
    expect(webview?.tagName).toBe('WEBVIEW')
    await act(async () => {
      fire(webview, 'did-frame-navigate', {
        isMainFrame: true,
        url: item.url,
        httpResponseCode: 404,
        httpStatusText: 'Not Found'
      })
      fire(webview, 'did-navigate-in-page', { url: item.url + '#details', isMainFrame: true })
      fire(webview, 'did-fail-load', { isMainFrame: true, errorCode: -3 })
      fire(webview, 'did-fail-load', { isMainFrame: false, errorCode: -102 })
    })
    expect(container.querySelector('[data-source-preview-error]')?.textContent).toContain(
      'HTTP 404'
    )
    expect(container.querySelector('[data-source-preview-header-url]')?.textContent).toBe(
      item.url + '#details'
    )
  })
})
