import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { exposeMock, onMock, removeListenerMock, sendMock } = vi.hoisted(() => ({
  exposeMock: vi.fn(),
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  sendMock: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeMock },
  ipcRenderer: {
    on: onMock,
    removeListener: removeListenerMock,
    send: sendMock
  }
}))

type FindOverlayApi = {
  window: {
    findInPage: (request: unknown) => void
    clearFind: () => void
    onFindInPageResult: (listener: (payload: unknown) => void) => () => void
    onShowWindowFind: (listener: (payload: unknown) => void) => () => void
    onWindowFindAppearance: (listener: (payload: unknown) => void) => () => void
    closeFind: () => void
  }
}

const collectFunctionPaths = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'function') return [prefix]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value)
    .flatMap(([key, child]) => collectFunctionPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

let api: FindOverlayApi

beforeAll(async () => {
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('./find-overlay')
  const exposed = exposeMock.mock.calls.find(([key]) => key === 'api')?.[1] as
    FindOverlayApi | undefined
  if (!exposed) throw new Error('find overlay preload did not expose an "api" bridge')
  api = exposed
})

afterEach(() => {
  onMock.mockClear()
  removeListenerMock.mockClear()
  sendMock.mockClear()
})

describe('find overlay preload capability boundary', () => {
  it('exposes only the window-find operations required by the overlay', () => {
    expect(collectFunctionPaths(api)).toEqual([
      'window.clearFind',
      'window.closeFind',
      'window.findInPage',
      'window.onFindInPageResult',
      'window.onShowWindowFind',
      'window.onWindowFindAppearance'
    ])
  })

  it('sends only the overlay request, clear, and close channels', () => {
    const request = { requestId: 7, text: 'result', findNext: true, forward: false }

    api.window.findInPage(request)
    api.window.clearFind()
    api.window.closeFind()

    expect(sendMock.mock.calls).toEqual([
      ['window:find-in-page', request],
      ['window:clear-find-in-page'],
      ['window:find-close']
    ])
  })

  it.each([
    ['onFindInPageResult', 'window:find-in-page-result'],
    ['onShowWindowFind', 'window:find-show'],
    ['onWindowFindAppearance', 'window:find-appearance']
  ] as const)('subscribes %s to %s and returns a working unsubscribe', (method, channel) => {
    const listener = vi.fn()
    const remove = api.window[method](listener)
    const wrappedListener = onMock.mock.calls.find(
      ([registered]) => registered === channel
    )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
    expect(wrappedListener).toBeDefined()

    const payload = { value: channel }
    wrappedListener!({}, payload)
    remove()

    expect(listener).toHaveBeenCalledWith(payload)
    expect(removeListenerMock).toHaveBeenCalledWith(channel, wrappedListener)
  })
})
