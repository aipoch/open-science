// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createFindOverlayManager } from '../../../main/find-overlay'
import { initI18n } from '../i18n'
import { useWindowFindAppearanceSync } from './useWindowFindAppearanceSync'
// @ts-expect-error The standalone browser module intentionally ships as plain JavaScript.
import { createFindOverlay } from '../../../../resources/find-overlay/findOverlay.js'

const { listeners, exposed } = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  exposed: {
    api: undefined as
      | {
          window: Pick<
            Window['api']['window'],
            | 'findInPage'
            | 'clearFind'
            | 'closeFind'
            | 'onFindInPageResult'
            | 'onShowWindowFind'
            | 'onWindowFindAppearance'
          >
        }
      | undefined
  }
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: typeof exposed.api) => {
      exposed.api = api
    }
  },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
      listeners.get(channel)?.delete(listener),
    send: vi.fn()
  }
}))
vi.mock('@/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { preference: string; resolvedTheme: string }) => unknown) =>
    selector({ preference: 'light', resolvedTheme: 'light' })
}))

it('localizes the standalone page on open and on a live app language change', async () => {
  await import('../../../preload/find-overlay')
  const markup = new DOMParser().parseFromString(
    readFileSync(resolve('resources/find-overlay/index.html'), 'utf8'),
    'text/html'
  )
  const input = markup.querySelector('input')!
  const prev = markup.getElementById('find-overlay-prev')!
  const next = markup.getElementById('find-overlay-next')!
  const close = markup.getElementById('find-overlay-close')!
  const controller = createFindOverlay({
    input,
    prev,
    next,
    close,
    count: markup.getElementById('find-overlay-count'),
    api: exposed.api!.window,
    storage: { getItem: () => null, setItem: vi.fn() }
  })
  const focus = vi.fn()
  const manager = createFindOverlayManager({
    mainWindow: {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      getContentBounds: () => ({ width: 1000, height: 800 }),
      on: vi.fn(),
      webContents: { focus: vi.fn(), send: vi.fn(), stopFindInPage: vi.fn() }
    },
    createView: () => ({
      setBounds: vi.fn(),
      setBackgroundColor: vi.fn(),
      webContents: {
        loadFile: async () => {},
        focus,
        close: vi.fn(),
        isDestroyed: () => false,
        send: (channel, payload) =>
          listeners.get(channel)?.forEach((listener) => listener({}, payload))
      }
    }),
    preloadPath: 'unused',
    overlayHtmlPath: 'unused'
  })
  const previousApi = window.api
  window.api = {
    window: { announceWindowFindAppearance: manager.updateAppearance }
  } as unknown as Window['api']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const Harness = (): null => {
    useWindowFindAppearanceSync()
    return null
  }
  const i18n = initI18n('zh-Hans')
  try {
    await act(async () => root.render(<Harness />))
    manager.open()
    await Promise.resolve()
    expect.soft(markup.documentElement.lang).toBe('zh-Hans')
    expect.soft(input.placeholder).toBe('查找')
    expect.soft(input.getAttribute('aria-label')).toBe('查找文本')
    expect.soft(prev.getAttribute('aria-label')).toBe('上一个匹配项')
    expect
      .soft(markup.getElementById('find-overlay-prev-tooltip')?.textContent)
      .toBe('上一个匹配项 (Shift+Enter)')
    focus.mockClear()
    await act(async () => {
      await i18n.changeLanguage('ja')
    })
    expect.soft(markup.documentElement.lang).toBe('ja')
    expect.soft(input.placeholder).toBe('検索')
    expect.soft(next.getAttribute('aria-label')).toBe('次の一致')
    expect.soft(close.getAttribute('aria-label')).toBe('検索を閉じる')
    expect(focus).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    controller.destroy()
    manager.destroy()
    container.remove()
    window.api = previousApi
    await i18n.changeLanguage('en')
  }
})
