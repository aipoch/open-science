import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'

import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  WINDOW_FIND_CONTENT_READY_CHANNEL,
  WINDOW_FIND_READY_CHANNEL,
  WINDOW_FIND_SHOW_CHANNEL,
  WINDOW_FIND_UNREADY_CHANNEL,
  WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL,
  type KeyChordInput
} from '../shared/window-controls'
import { SOURCE_PREVIEW_RELEASE_CHANNEL } from '../shared/source-preview'
import { PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL } from '../shared/preview-context-menu'

// Hoisted so the electron mock and the test body share the same spies.
const {
  openExternalMock,
  ipcMainOnMock,
  ipcMainRemoveListenerMock,
  showMessageBoxMock,
  webFrameMainFromIdMock
} = vi.hoisted(() => ({
  openExternalMock: vi.fn(async () => undefined),
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  webFrameMainFromIdMock: vi.fn()
}))

const { windowLogSpies } = vi.hoisted(() => ({
  windowLogSpies: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('./logger', () => ({
  createLogger: () => windowLogSpies,
  diagnosticErrorFields: () => ({ errorCategory: 'error' })
}))

// The overlay manager is a collaborator with its own deep test suite; here we only need to observe
// that the chord/Escape wiring drives it, so the real module is replaced with a spy object.
const { createFindOverlayManagerMock, findOverlayMock } = vi.hoisted(() => ({
  createFindOverlayManagerMock: vi.fn(),
  findOverlayMock: {
    open: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    updateAppearance: vi.fn(),
    isOpen: vi.fn(() => false)
  }
}))
vi.mock('./find-overlay', () => ({
  createFindOverlayManager: (...args: unknown[]) => {
    createFindOverlayManagerMock(...args)
    return findOverlayMock
  }
}))

// Captured window-open handler so tests can drive it directly, mirroring how Electron invokes it on a
// target="_blank" click or window.open() from the main app frame.
type WindowOpenDetails = { url: string; referrer: { url: string } }
let windowOpenHandler: ((details: WindowOpenDetails) => unknown) | undefined
type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame: boolean; requestingUrl: string }
) => void
type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: { isMainFrame: boolean; requestingUrl?: string }
) => boolean
type HeadersReceivedDetails = {
  webContentsId?: number
  frame?: { frameTreeNodeId: number } | null
  resourceType: string
  url: string
  statusCode: number
  statusLine: string
  responseHeaders?: Record<string, string[]>
}
type HeadersReceivedHandler = (
  details: HeadersReceivedDetails,
  callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void
) => void
let permissionRequestHandler: PermissionRequestHandler | undefined
let permissionCheckHandler: PermissionCheckHandler | undefined
let headersReceivedHandler: HeadersReceivedHandler | undefined

// The most recently constructed window and its captured handlers, so tests can drive the
// before-input-event / lifecycle listeners and the 'close' interceptor the way Electron would.
type WebContentsHandler = (...args: unknown[]) => void
// Fake close event mirroring Electron's: preventDefault records that the close was intercepted.
type CloseEvent = { preventDefault: () => void; defaultPrevented: boolean }

// currentWindow and lastWindow both point at the latest window; two describe blocks, one shared fake.
let currentWindow: FakeBrowserWindow | undefined
let lastWindow: FakeBrowserWindow | undefined
let lastWindowOptions: BrowserWindowConstructorOptions | undefined
let loadRendererDocument = (): Promise<void> => Promise.resolve()

class FakeBrowserWindow {
  closeMock = vi.fn()
  destroyMock = vi.fn()
  loadFileMock = vi.fn(() => loadRendererDocument())
  sendMock = vi.fn()
  showMock = vi.fn()
  webContentsHandlers = new Map<string, WebContentsHandler>()
  handlers = new Map<string, Array<(event: CloseEvent) => void>>()
  hidden = false
  destroyed = false
  hideCalls = 0
  mainFrame = { frameTreeNodeId: 1, name: '', url: 'file:///app/index.html', parent: null }
  webContents = {
    id: 101,
    setWindowOpenHandler: (handler: (details: WindowOpenDetails) => unknown): void => {
      windowOpenHandler = handler
    },
    on: (event: string, handler: WebContentsHandler): void => {
      this.webContentsHandlers.set(event, handler)
    },
    removeListener: (event: string, handler: WebContentsHandler): void => {
      if (this.webContentsHandlers.get(event) === handler) this.webContentsHandlers.delete(event)
    },
    send: (...args: unknown[]): void => this.sendMock(...args),
    getZoomFactor: (): number => 1,
    getURL: (): string => 'file:///app/index.html',
    mainFrame: this.mainFrame,
    session: {
      setPermissionRequestHandler: (handler: PermissionRequestHandler): void => {
        permissionRequestHandler = handler
      },
      setPermissionCheckHandler: (handler: PermissionCheckHandler): void => {
        permissionCheckHandler = handler
      },
      webRequest: {
        onHeadersReceived: (
          filterOrListener: { urls: string[] } | HeadersReceivedHandler | null,
          handler?: HeadersReceivedHandler | null
        ): void => {
          headersReceivedHandler =
            typeof filterOrListener === 'function' ? filterOrListener : (handler ?? undefined)
        }
      }
    }
  }

  on(event: string, handler: (event: CloseEvent) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  // Mirror Electron: close() fires the 'close' handlers, so a close-to-tray interceptor that
  // preventDefault()s keeps the window alive; otherwise the close proceeds to destroy the window.
  close(): void {
    this.closeMock()
    const event: CloseEvent = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true
      }
    }
    for (const handler of this.handlers.get('close') ?? []) handler(event)
    if (!event.defaultPrevented) this.destroyed = true
  }

  destroy(): void {
    this.destroyMock()
    this.destroyed = true
  }

  show(): void {
    this.showMock()
    this.hidden = false
  }

  hide(): void {
    this.hidden = true
    this.hideCalls += 1
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  loadURL(): Promise<void> {
    return Promise.resolve()
  }

  loadFile(): Promise<void> {
    return this.loadFileMock()
  }
}

vi.mock('electron', () => ({
  // isPackaged=true skips the dev title-suffix branch, keeping the fake focused on the open + close handlers.
  app: { isPackaged: true, getAppPath: () => '/app' },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) {
      lastWindowOptions = options
      currentWindow = new FakeBrowserWindow()
      lastWindow = currentWindow
      return currentWindow as unknown as object
    }
  },
  WebContentsView: class {},
  dialog: { showMessageBox: showMessageBoxMock },
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock },
  shell: { openExternal: openExternalMock },
  webFrameMain: { fromId: webFrameMainFromIdMock }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon-path' }))

const { createMainWindow } = await import('./windows')

// A keyDown close chord for the host platform: Cmd+W on macOS, Ctrl+W elsewhere. Built off
// process.platform so the interception test passes on every CI runner (windows, linux, macOS).
const closeChord = (overrides: Partial<KeyChordInput> = {}): KeyChordInput => ({
  type: 'keyDown',
  key: 'w',
  control: process.platform !== 'darwin',
  meta: process.platform === 'darwin',
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...overrides
})

const findChord = (overrides: Partial<KeyChordInput> = {}): KeyChordInput => ({
  type: 'keyDown',
  key: 'f',
  control: process.platform !== 'darwin',
  meta: process.platform === 'darwin',
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...overrides
})

// Drives the captured 'close' handlers with a fresh event, then mirrors Electron: an un-prevented
// close proceeds to destroy the window.
const emitClose = (window: FakeBrowserWindow): CloseEvent => {
  const event: CloseEvent = {
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true
    }
  }
  for (const handler of window.handlers.get('close') ?? []) handler(event)
  if (!event.defaultPrevented) window.destroyed = true
  return event
}

describe('window presentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps E2E windows hidden when they become ready', () => {
    vi.stubEnv('OPEN_SCIENCE_E2E_WINDOW_MODE', 'hidden')

    createMainWindow()
    const window = lastWindow!
    for (const handler of window.handlers.get('ready-to-show') ?? []) handler({} as CloseEvent)

    expect(window.showMock).not.toHaveBeenCalled()
  })

  it('keeps normal application startup behavior when no E2E mode is set', () => {
    vi.stubEnv('OPEN_SCIENCE_E2E_WINDOW_MODE', undefined)

    createMainWindow()
    const window = lastWindow!
    for (const handler of window.handlers.get('ready-to-show') ?? []) handler({} as CloseEvent)

    expect(window.showMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['linux', false],
    ['darwin', true],
    ['win32', true]
  ] as const)('sets %s menu auto-hide to %s', (platformName, autoHideMenuBar) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platformName })

    try {
      createMainWindow()
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }

    expect(lastWindowOptions?.autoHideMenuBar).toBe(autoHideMenuBar)
  })

  it('gives the find overlay a dedicated least-privilege preload', () => {
    createMainWindow()

    expect(createFindOverlayManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preloadPath: expect.stringMatching(/[\\/]preload[\\/]find-overlay\.js$/u)
      })
    )
  })

  it('unregisters the Session response listener when the window closes', () => {
    createMainWindow()
    const window = lastWindow!

    expect(headersReceivedHandler).toBeDefined()
    for (const closedHandler of window.handlers.get('closed') ?? []) {
      closedHandler({ preventDefault: vi.fn(), defaultPrevented: false })
    }

    expect(headersReceivedHandler).toBeUndefined()
  })

  it('forwards trusted preview frame context menus only while the window is alive', async () => {
    createMainWindow()
    const window = lastWindow!
    const contextMenuHandler = window.webContentsHandlers.get('context-menu')
    const frame = {
      url: 'open-science-preview://resource-1/report.html',
      parent: window.mainFrame,
      detached: false,
      isDestroyed: () => false,
      executeJavaScript: async () => false
    }

    contextMenuHandler?.(
      {},
      {
        x: 12,
        y: 24,
        frame,
        isEditable: false,
        formControlType: 'none'
      }
    )

    await vi.waitFor(() =>
      expect(window.sendMock).toHaveBeenCalledWith(PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, {
        x: 12,
        y: 24,
        frameUrl: 'open-science-preview://resource-1/report.html'
      })
    )

    for (const closedHandler of window.handlers.get('closed') ?? []) {
      closedHandler({ preventDefault: vi.fn(), defaultPrevented: false })
    }
    expect(window.webContentsHandlers.has('context-menu')).toBe(false)
  })
})

describe('window navigation policy', () => {
  it('allows only explicit external URL protocols', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(policy?.isAllowedExternalUrl('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalUrl('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalUrl('file:///Users/example/private.txt')).toBe(false)
    expect(policy?.isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    // External-open is gated on the protocol allowlist alone: the initiating referrer is unreliable
    // for both main-frame links and sandboxed source popups. The handler always denies an in-app
    // window after handing an allowlisted URL to the OS (see navigation-policy.ts).
    expect(policy?.isAllowedExternalNavigation('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('javascript:alert(1)')).toBe(false)
    expect(policy?.isAllowedExternalNavigation('file:///Users/example/private.txt')).toBe(false)
  })

  it('allows HTTPS source-preview subframes while keeping main-frame navigation constrained', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)
    const mainFrame = {
      frameTreeNodeId: 1,
      name: '',
      url: 'file:///app/index.html',
      parent: null
    }
    const guard = policy?.createFrameNavigationGuard(mainFrame)
    const sourceFrame = {
      frameTreeNodeId: 2,
      processId: 7,
      routingId: 8,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: mainFrame
    }

    expect(policy).toBeDefined()
    expect(guard?.('open-science-preview://resource/report.html', false)).toBe(true)
    expect(
      guard?.(
        'open-science-office-preview://runtime/office-preview.html?sessionId=session-1',
        false
      )
    ).toBe(true)
    expect(guard?.('https://example.com/paper', false)).toBe(false)
    expect(guard?.('https://example.com/paper', false, '', sourceFrame)).toBe(true)

    const redirectedSourceFrame = {
      frameTreeNodeId: 2,
      name: '',
      url: 'https://example.com/paper',
      parent: { ...mainFrame }
    }
    expect(guard?.('https://example.com/redirected', false, '', redirectedSourceFrame)).toBe(true)
    expect(
      guard?.('open-science-preview://resource/report.html', false, '', redirectedSourceFrame)
    ).toBe(false)
    const sourceDescendant = {
      frameTreeNodeId: 3,
      name: '',
      url: 'about:blank',
      parent: redirectedSourceFrame
    }
    expect(guard?.('https://static.example.com/embed', false, '', sourceDescendant)).toBe(true)
    expect(guard?.('about:blank', false, '', sourceDescendant)).toBe(true)
    expect(guard?.('about:srcdoc', false, '', sourceDescendant)).toBe(true)
    expect(guard?.('blob:https://static.example.com/fixture', false, '', sourceDescendant)).toBe(
      true
    )
    expect(guard?.('blob:null/fixture', false, '', sourceDescendant)).toBe(false)
    expect(guard?.('data:text/html,fixture', false, '', sourceDescendant)).toBe(false)
    expect(guard?.('about:blank', false, '', redirectedSourceFrame)).toBe(false)

    const htmlPreviewFrame = {
      frameTreeNodeId: 4,
      name: 'open-science-source-preview',
      url: 'open-science-preview://resource/report.html',
      parent: mainFrame
    }
    expect(guard?.('https://example.com/exfiltrate', false, '', htmlPreviewFrame)).toBe(false)
    const nestedSpoof = {
      frameTreeNodeId: 5,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: htmlPreviewFrame
    }
    expect(guard?.('https://example.com/exfiltrate', false, '', nestedSpoof)).toBe(false)
    expect(guard?.('http://example.com/paper', false, '', redirectedSourceFrame)).toBe(false)
    expect(guard?.('https://app.example.com/workspace', true, 'https://app.example.com/')).toBe(
      true
    )
    expect(guard?.('https://example.com/exfiltrate', true, 'https://app.example.com/')).toBe(false)
    expect(guard?.('file://remote-host/app/index.html', true, 'file:///app/index.html')).toBe(false)
  })

  it('applies the source-frame guard to server redirects', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    const initialNavigation = {
      url: 'https://citation.example/paper',
      isMainFrame: false,
      processId: 7,
      routingId: 8,
      frame: Object('https://citation.example/paper'),
      preventDefault: vi.fn()
    }
    webFrameMainFromIdMock.mockReturnValue(sourceFrame)
    window.webContentsHandlers.get('will-frame-navigate')?.(initialNavigation)
    expect(webFrameMainFromIdMock).toHaveBeenCalledWith(7, 8)
    expect(initialNavigation.preventDefault).not.toHaveBeenCalled()

    const redirectedFrame = {
      frameTreeNodeId: 2,
      name: '',
      url: 'https://citation.example/paper',
      parent: { ...window.mainFrame }
    }
    const allowedRedirect = {
      url: 'https://publisher.example/paper',
      isMainFrame: false,
      frame: null,
      preventDefault: vi.fn()
    }
    webFrameMainFromIdMock.mockReturnValue(redirectedFrame)
    const redirectHandler = window.webContentsHandlers.get('will-redirect')
    redirectHandler?.(allowedRedirect, allowedRedirect.url, false, false, 7, 8)
    expect(webFrameMainFromIdMock).toHaveBeenCalledWith(7, 8)
    expect(allowedRedirect.preventDefault).not.toHaveBeenCalled()

    const blockedRedirect = {
      ...allowedRedirect,
      url: 'open-science-preview://resource/report.html',
      preventDefault: vi.fn()
    }
    redirectHandler?.(blockedRedirect, blockedRedirect.url, false, false, 7, 8)
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce()
  })

  it('removes only embedding response restrictions from a registered HTTPS source root', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    window.webContentsHandlers.get('will-frame-navigate')?.({
      url: 'https://citation.example/paper',
      isMainFrame: false,
      frame: sourceFrame,
      preventDefault: vi.fn()
    })

    expect(headersReceivedHandler).toBeDefined()
    const callback = vi.fn()
    const originalHeaders = {
      'Content-Security-Policy': [
        "default-src 'none'; frame-ancestors 'none'; script-src 'self'",
        'img-src https:; FRAME-ANCESTORS https://publisher.example'
      ],
      'X-Frame-Options': ['SAMEORIGIN'],
      'Cross-Origin-Embedder-Policy': ['require-corp']
    }
    headersReceivedHandler?.(
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: 'https://publisher.example/paper',
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: originalHeaders
      },
      callback
    )

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': ["default-src 'none'; script-src 'self'", 'img-src https:'],
        'Cross-Origin-Embedder-Policy': ['require-corp']
      }
    })
    expect(originalHeaders).toHaveProperty('X-Frame-Options')
  })

  it('upgrades an insecure redirect location for a registered HTTPS source root', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    window.webContentsHandlers.get('will-frame-navigate')?.({
      url: 'https://citation.example/paper',
      isMainFrame: false,
      frame: sourceFrame,
      preventDefault: vi.fn()
    })

    const callback = vi.fn()
    headersReceivedHandler?.(
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: 'https://citation.example/paper',
        statusCode: 302,
        statusLine: 'HTTP/1.1 302 Found',
        responseHeaders: {
          Location: ['http://biorxiv.org/lookup/doi/10.64898/2026.05.19.726291'],
          'Cache-Control': ['no-store']
        }
      },
      callback
    )

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        Location: ['https://biorxiv.org/lookup/doi/10.64898/2026.05.19.726291'],
        'Cache-Control': ['no-store']
      }
    })
  })

  it('preserves response headers outside the registered HTTPS source root', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    window.webContentsHandlers.get('will-frame-navigate')?.({
      url: 'https://citation.example/paper',
      isMainFrame: false,
      frame: sourceFrame,
      preventDefault: vi.fn()
    })
    const protectedHeaders = {
      'Content-Security-Policy': ["frame-ancestors 'none'; default-src 'self'"],
      'X-Frame-Options': ['DENY']
    }

    for (const details of [
      {
        webContentsId: 999,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: 'https://publisher.example/paper'
      },
      {
        webContentsId: 101,
        frame: { frameTreeNodeId: 3 },
        resourceType: 'subFrame',
        url: 'https://publisher.example/embed'
      },
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'script',
        url: 'https://publisher.example/app.js'
      },
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: 'http://publisher.example/paper'
      }
    ]) {
      const callback = vi.fn()
      headersReceivedHandler?.(
        {
          ...details,
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          responseHeaders: protectedHeaders
        },
        callback
      )
      expect(callback).toHaveBeenCalledWith({})
    }
  })

  it('reports source root loading and HTTP failures without observing unrelated subframes', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    const initialUrl = 'https://citation.example/missing'
    const initialNavigation = {
      url: initialUrl,
      isMainFrame: false,
      processId: 7,
      routingId: 8,
      frame: sourceFrame,
      preventDefault: vi.fn()
    }

    window.webContentsHandlers.get('will-frame-navigate')?.(initialNavigation)
    window.webContentsHandlers.get('did-start-navigation')?.({
      url: initialUrl,
      isSameDocument: false,
      isMainFrame: false,
      frame: sourceFrame
    })

    expect(window.sendMock).toHaveBeenLastCalledWith('source-preview:load-state', {
      navigationId: 1,
      sourceUrl: initialUrl,
      currentUrl: initialUrl,
      phase: 'loading'
    })

    const unrelatedFrame = {
      frameTreeNodeId: 3,
      name: '',
      url: 'https://unrelated.example/frame',
      parent: window.mainFrame
    }
    webFrameMainFromIdMock.mockReturnValue(unrelatedFrame)
    window.webContentsHandlers.get('did-frame-navigate')?.(
      {},
      unrelatedFrame.url,
      200,
      'OK',
      false,
      9,
      10
    )
    expect(window.sendMock).toHaveBeenCalledTimes(1)

    webFrameMainFromIdMock.mockReturnValue(sourceFrame)
    window.webContentsHandlers.get('did-frame-navigate')?.(
      {},
      initialUrl,
      404,
      'Not Found',
      false,
      7,
      8
    )

    expect(window.sendMock).toHaveBeenLastCalledWith('source-preview:load-state', {
      navigationId: 1,
      sourceUrl: initialUrl,
      currentUrl: initialUrl,
      phase: 'failed',
      failure: 'http',
      httpStatusCode: 404,
      httpStatusText: 'Not Found'
    })
  })

  it('releases source monitoring and embed-policy state when its renderer closes the tab', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      processId: 7,
      routingId: 8,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    const sourceUrl = 'https://citation.example/paper'
    window.webContentsHandlers.get('will-frame-navigate')?.({
      url: sourceUrl,
      isMainFrame: false,
      frame: sourceFrame,
      preventDefault: vi.fn()
    })
    const releaseHandler = ipcMainOnMock.mock.calls
      .filter(([channel]) => channel === SOURCE_PREVIEW_RELEASE_CHANNEL)
      .at(-1)?.[1] as ((event: { sender: unknown }, value: unknown) => void) | undefined

    expect(releaseHandler).toBeDefined()
    releaseHandler?.({ sender: window.webContents }, sourceUrl)
    window.sendMock.mockClear()

    const releasedFrame = { ...sourceFrame, name: '', url: sourceUrl }
    const releasedNavigation = {
      url: 'https://citation.example/after-close',
      isMainFrame: false,
      frame: releasedFrame,
      preventDefault: vi.fn()
    }
    window.webContentsHandlers.get('will-frame-navigate')?.(releasedNavigation)
    expect(releasedNavigation.preventDefault).toHaveBeenCalledOnce()

    webFrameMainFromIdMock.mockReturnValue(sourceFrame)
    window.webContentsHandlers.get('did-fail-load')?.(
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      sourceUrl,
      false,
      7,
      8
    )
    expect(window.sendMock).not.toHaveBeenCalled()

    const callback = vi.fn()
    headersReceivedHandler?.(
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: sourceUrl,
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: { 'x-frame-options': ['DENY'] }
      },
      callback
    )
    expect(callback).toHaveBeenCalledWith({})
  })

  it.each(['top-level navigation', 'renderer process exit'])(
    'clears all source-preview state after %s replaces the renderer document',
    (lifecycle) => {
      createMainWindow()
      const window = lastWindow!
      const sourceUrl = 'https://citation.example/paper'
      const sourceFrame = {
        frameTreeNodeId: 2,
        processId: 7,
        routingId: 8,
        name: 'open-science-source-preview',
        url: 'about:blank',
        parent: window.mainFrame
      }
      window.webContentsHandlers.get('will-frame-navigate')?.({
        url: sourceUrl,
        isMainFrame: false,
        frame: sourceFrame,
        preventDefault: vi.fn()
      })
      window.sendMock.mockClear()

      if (lifecycle === 'top-level navigation') {
        window.webContentsHandlers.get('did-start-navigation')?.({
          url: 'file:///app/index.html',
          isSameDocument: false,
          isMainFrame: true,
          frame: window.mainFrame
        })
      } else {
        window.webContentsHandlers.get('render-process-gone')?.(
          {},
          {
            reason: 'killed',
            exitCode: 1
          }
        )
      }

      const releasedFrame = { ...sourceFrame, name: '', url: sourceUrl }
      const releasedNavigation = {
        url: 'https://citation.example/after-reload',
        isMainFrame: false,
        frame: releasedFrame,
        preventDefault: vi.fn()
      }
      window.webContentsHandlers.get('will-frame-navigate')?.(releasedNavigation)
      expect(releasedNavigation.preventDefault).toHaveBeenCalledOnce()

      webFrameMainFromIdMock.mockReturnValue(releasedFrame)
      window.webContentsHandlers.get('did-fail-load')?.(
        {},
        -102,
        'ERR_CONNECTION_REFUSED',
        sourceUrl,
        false,
        7,
        8
      )
      expect(window.sendMock).not.toHaveBeenCalled()

      const callback = vi.fn()
      headersReceivedHandler?.(
        {
          webContentsId: 101,
          frame: releasedFrame,
          resourceType: 'subFrame',
          url: sourceUrl,
          statusCode: 200,
          statusLine: 'HTTP/1.1 200 OK',
          responseHeaders: { 'x-frame-options': ['DENY'] }
        },
        callback
      )
      expect(callback).toHaveBeenCalledWith({})
    }
  )

  it('reports a source HTTP failure as soon as its response headers arrive', () => {
    createMainWindow()
    const window = lastWindow!
    const sourceFrame = {
      frameTreeNodeId: 2,
      name: 'open-science-source-preview',
      url: 'about:blank',
      parent: window.mainFrame
    }
    const sourceUrl = 'https://citation.example/unavailable'
    window.webContentsHandlers.get('will-frame-navigate')?.({
      url: sourceUrl,
      isMainFrame: false,
      frame: sourceFrame,
      preventDefault: vi.fn()
    })
    window.sendMock.mockClear()

    headersReceivedHandler?.(
      {
        webContentsId: 101,
        frame: sourceFrame,
        resourceType: 'subFrame',
        url: sourceUrl,
        statusCode: 503,
        statusLine: 'HTTP/1.1 503 Service Unavailable',
        responseHeaders: { 'Content-Type': ['text/html'] }
      },
      vi.fn()
    )

    expect(window.sendMock).toHaveBeenCalledWith('source-preview:load-state', {
      navigationId: 1,
      sourceUrl,
      currentUrl: sourceUrl,
      phase: 'failed',
      failure: 'http',
      httpStatusCode: 503,
      httpStatusText: 'Service Unavailable'
    })
  })

  it.each([
    [-27, 'ERR_BLOCKED_BY_RESPONSE'],
    [-30, 'ERR_BLOCKED_BY_CSP']
  ])(
    'reports Chromium embedding failure %i for a blocked source root',
    (errorCode, errorDescription) => {
      createMainWindow()
      const window = lastWindow!
      const sourceFrame = {
        frameTreeNodeId: 2,
        processId: 7,
        routingId: 8,
        name: 'open-science-source-preview',
        url: 'about:blank',
        parent: window.mainFrame
      }
      const initialUrl = 'https://citation.example/blocked'
      window.webContentsHandlers.get('will-frame-navigate')?.({
        url: initialUrl,
        isMainFrame: false,
        frame: sourceFrame,
        preventDefault: vi.fn()
      })
      window.webContentsHandlers.get('did-start-navigation')?.({
        url: initialUrl,
        isSameDocument: false,
        isMainFrame: false,
        frame: sourceFrame
      })
      window.sendMock.mockClear()
      webFrameMainFromIdMock.mockReturnValue(undefined)

      window.webContentsHandlers.get('did-fail-load')?.(
        {},
        errorCode,
        errorDescription,
        initialUrl,
        false,
        7,
        8
      )

      expect(window.sendMock).toHaveBeenCalledWith('source-preview:load-state', {
        navigationId: 1,
        sourceUrl: initialUrl,
        currentUrl: initialUrl,
        phase: 'failed',
        failure: 'blocked',
        errorCode,
        errorDescription
      })
    }
  )

  it('denies sensitive Chromium permissions regardless of frame', () => {
    createMainWindow()
    const window = lastWindow!

    expect(permissionRequestHandler).toBeDefined()
    expect(permissionCheckHandler).toBeDefined()
    const subframeDecision = vi.fn()
    permissionRequestHandler?.({}, 'geolocation', subframeDecision, {
      isMainFrame: false,
      requestingUrl: 'https://example.com/paper'
    })
    expect(subframeDecision).toHaveBeenCalledWith(false)
    expect(
      permissionCheckHandler?.({}, 'geolocation', 'https://example.com', {
        isMainFrame: false
      })
    ).toBe(false)

    const mainFrameDecision = vi.fn()
    permissionRequestHandler?.(window.webContents, 'media', mainFrameDecision, {
      isMainFrame: true,
      requestingUrl: 'file:///app/index.html'
    })
    expect(mainFrameDecision).toHaveBeenCalledWith(false)
    expect(
      permissionCheckHandler?.(window.webContents, 'geolocation', 'file://', {
        isMainFrame: true,
        requestingUrl: 'file:///app/index.html'
      })
    ).toBe(false)
  })

  it('allows sanitized clipboard writes only from the trusted main renderer document', () => {
    createMainWindow()
    const window = lastWindow!

    const trustedDecision = vi.fn()
    permissionRequestHandler?.(window.webContents, 'clipboard-sanitized-write', trustedDecision, {
      isMainFrame: true,
      requestingUrl: 'file:///app/index.html'
    })
    expect(trustedDecision).toHaveBeenCalledWith(true)
    expect(
      permissionCheckHandler?.(window.webContents, 'clipboard-sanitized-write', 'file://', {
        isMainFrame: true,
        requestingUrl: 'file:///app/index.html'
      })
    ).toBe(true)

    const untrustedDecision = vi.fn()
    permissionRequestHandler?.(window.webContents, 'clipboard-sanitized-write', untrustedDecision, {
      isMainFrame: true,
      requestingUrl: 'https://example.com/'
    })
    expect(untrustedDecision).toHaveBeenCalledWith(false)
    expect(
      permissionCheckHandler?.(
        window.webContents,
        'clipboard-sanitized-write',
        'https://example.com',
        {
          isMainFrame: true,
          requestingUrl: 'https://example.com/'
        }
      )
    ).toBe(false)

    const otherWindowDecision = vi.fn()
    permissionRequestHandler?.({}, 'clipboard-sanitized-write', otherWindowDecision, {
      isMainFrame: true,
      requestingUrl: 'file:///app/index.html'
    })
    expect(otherWindowDecision).toHaveBeenCalledWith(false)

    const subframeDecision = vi.fn()
    permissionRequestHandler?.(window.webContents, 'clipboard-sanitized-write', subframeDecision, {
      isMainFrame: false,
      requestingUrl: 'file:///app/index.html'
    })
    expect(subframeDecision).toHaveBeenCalledWith(false)
  })
})

describe('window-open external handler', () => {
  beforeEach(() => {
    windowOpenHandler = undefined
    openExternalMock.mockClear()
    windowLogSpies.warn.mockClear()
  })

  // Regression: app links use rel="noreferrer" and the packaged app runs on a file:// origin, so the
  // referrer arrives empty. The handler must still open allowlisted URLs.
  it('opens an allowlisted URL even when the referrer is empty', () => {
    createMainWindow()
    const result = windowOpenHandler!({
      url: 'https://example.com/report',
      referrer: { url: '' }
    })

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/report')
    expect(result).toEqual({ action: 'deny' })
  })

  it('refuses to open a dangerous protocol', () => {
    createMainWindow()
    windowOpenHandler!({ url: 'javascript:alert(1)', referrer: { url: '' } })

    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('records a rejected operating-system open without leaving an unhandled rejection', async () => {
    openExternalMock.mockRejectedValueOnce(new Error('no protocol handler'))
    createMainWindow()

    windowOpenHandler!({ url: 'https://example.com/report', referrer: { url: '' } })

    await vi.waitFor(() =>
      expect(windowLogSpies.warn).toHaveBeenCalledWith(
        'external link open failed',
        expect.objectContaining({ errorCategory: 'error' })
      )
    )
  })
})

describe('close chord interception', () => {
  beforeEach(() => {
    currentWindow = undefined
    loadRendererDocument = () => Promise.resolve()
    ipcMainOnMock.mockReset()
    ipcMainRemoveListenerMock.mockReset()
    findOverlayMock.open.mockClear()
    findOverlayMock.close.mockClear()
    findOverlayMock.destroy.mockClear()
    findOverlayMock.updateAppearance.mockClear()
    findOverlayMock.isOpen.mockReturnValue(false)
    windowLogSpies.info.mockClear()
    windowLogSpies.warn.mockClear()
    windowLogSpies.error.mockClear()
    showMessageBoxMock.mockReset()
    showMessageBoxMock.mockResolvedValue({ response: 0 })
  })

  // Fires an ipcMain handshake signal that main registered via ipcMain.on, spoofing the sender as this
  // window's webContents so the readiness flag flips for it.
  const fireHandshake = (window: FakeBrowserWindow, channel: string): void => {
    const handler = ipcMainOnMock.mock.calls.find(([registered]) => registered === channel)?.[1] as
      ((event: { sender: unknown }) => void) | undefined
    expect(handler).toBeDefined()
    handler!({ sender: window.webContents })
  }

  const fireAppearance = (sender: unknown, appearance: unknown): void => {
    const handler = ipcMainOnMock.mock.calls.find(
      ([registered]) => registered === WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL
    )?.[1] as ((event: { sender: unknown }, payload: unknown) => void) | undefined
    expect(handler).toBeDefined()
    handler!({ sender }, appearance)
  }

  const signalRendererReady = (window: FakeBrowserWindow): void =>
    fireHandshake(window, CLOSE_ACTIVE_PANE_READY_CHANNEL)

  const signalRendererGone = (window: FakeBrowserWindow): void =>
    fireHandshake(window, CLOSE_ACTIVE_PANE_UNREADY_CHANNEL)

  const signalWindowFindReady = (window: FakeBrowserWindow): void =>
    fireHandshake(window, WINDOW_FIND_READY_CHANNEL)

  const signalWindowFindGone = (window: FakeBrowserWindow): void =>
    fireHandshake(window, WINDOW_FIND_UNREADY_CHANNEL)

  const signalWindowFindContentReady = (window: FakeBrowserWindow): void =>
    fireHandshake(window, WINDOW_FIND_CONTENT_READY_CHANNEL)

  // Drives one of the captured webContents lifecycle handlers (render-process-gone, unresponsive, ...).
  const fireWebContentsEvent = (
    window: FakeBrowserWindow,
    event: string,
    ...args: unknown[]
  ): void => {
    const handler = window.webContentsHandlers.get(event)
    expect(handler).toBeDefined()
    handler!(...args)
  }

  // A top-level document swap (reload or new URL): main frame, real document change.
  const mainFrameNavigation = { isMainFrame: true, isSameDocument: false }

  const fireInput = (window: FakeBrowserWindow, input: KeyChordInput): (() => void) => {
    const preventDefault = vi.fn()
    const handler = window.webContentsHandlers.get('before-input-event')
    expect(handler).toBeDefined()
    handler!({ preventDefault }, input)
    return preventDefault
  }

  it('closes the window directly when the chord fires before the renderer is ready', () => {
    createMainWindow()
    const window = currentWindow!

    const preventDefault = fireInput(window, closeChord())

    // Default Close is suppressed and the window closes directly, so the chord is never a no-op.
    expect(preventDefault).toHaveBeenCalled()
    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()
  })

  it('forwards the chord to the renderer once its listener is ready', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    const preventDefault = fireInput(window, closeChord())

    expect(preventDefault).toHaveBeenCalled()
    expect(window.sendMock).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_CHANNEL)
    expect(window.closeMock).not.toHaveBeenCalled()
  })

  it('opens the find overlay only after the full Workspace transcript is mounted', () => {
    createMainWindow()
    const window = currentWindow!

    signalWindowFindReady(window)
    const preventDefault = fireInput(window, findChord())

    expect(preventDefault).toHaveBeenCalled()
    expect(findOverlayMock.open).not.toHaveBeenCalled()
    expect(window.sendMock).toHaveBeenCalledWith(WINDOW_FIND_SHOW_CHANNEL, {
      theme: 'light',
      followsSystem: true
    })

    signalWindowFindContentReady(window)
    expect(findOverlayMock.open).toHaveBeenCalledTimes(1)

    // A Session switch commits a new full transcript while the same overlay remains open. Re-open is
    // intentional: the overlay re-runs its remembered query against the new Session DOM.
    findOverlayMock.isOpen.mockReturnValue(true)
    signalWindowFindContentReady(window)
    expect(findOverlayMock.open).toHaveBeenCalledTimes(2)
    expect(window.closeMock).not.toHaveBeenCalled()
  })

  it('forwards valid theme changes from this renderer to the overlay manager', () => {
    const onAppearanceChanged = vi.fn()
    createMainWindow({
      classifyClose: () => 'close',
      resolveCloseAction: () => Promise.resolve('cancel'),
      requestQuit: vi.fn(),
      onAppearanceChanged
    })
    const window = currentWindow!
    const appearance = { theme: 'dark', followsSystem: false }

    fireAppearance(window.webContents, appearance)

    expect(findOverlayMock.updateAppearance).toHaveBeenCalledWith(appearance)
    expect(onAppearanceChanged).toHaveBeenCalledWith(appearance)
  })

  it('rejects malformed theme changes and messages from another renderer', () => {
    const onAppearanceChanged = vi.fn()
    createMainWindow({
      classifyClose: () => 'close',
      resolveCloseAction: () => Promise.resolve('cancel'),
      requestQuit: vi.fn(),
      onAppearanceChanged
    })
    const window = currentWindow!

    fireAppearance(window.webContents, { theme: 'sepia', followsSystem: false })
    fireAppearance({}, { theme: 'dark', followsSystem: false })

    expect(findOverlayMock.updateAppearance).not.toHaveBeenCalled()
    expect(onAppearanceChanged).not.toHaveBeenCalled()
  })

  it('unregisters the window-scoped theme listener with the same handler on close', () => {
    createMainWindow()
    const window = currentWindow!
    const registeredHandler = ipcMainOnMock.mock.calls.find(
      ([registered]) => registered === WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL
    )?.[1]
    const closedHandlers = window.handlers.get('closed') ?? []

    expect(registeredHandler).toBeDefined()
    expect(closedHandlers.length).toBeGreaterThan(0)
    for (const closedHandler of closedHandlers) {
      closedHandler({ preventDefault: vi.fn(), defaultPrevented: false })
    }

    expect(ipcMainRemoveListenerMock).toHaveBeenCalledWith(
      WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL,
      registeredHandler
    )
  })

  it('closes the find overlay when the searchable Workspace unmounts', () => {
    createMainWindow()
    const window = currentWindow!
    signalWindowFindReady(window)
    fireInput(window, findChord())
    findOverlayMock.close.mockClear()

    signalWindowFindGone(window)

    expect(findOverlayMock.close).toHaveBeenCalledTimes(1)
  })

  it('closes the find overlay on Escape while it is open, regardless of input focus', () => {
    createMainWindow()
    const window = currentWindow!
    findOverlayMock.isOpen.mockReturnValue(true)

    const preventDefault = fireInput(window, {
      type: 'keyDown',
      key: 'Escape',
      control: false,
      meta: false,
      alt: false,
      shift: false,
      isAutoRepeat: false
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(findOverlayMock.close).toHaveBeenCalledTimes(1)
  })

  it('re-arms the direct-close fallback after a top-level navigation clears renderer readiness', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // A top-level reload navigates the main frame before the fresh document re-subscribes.
    fireWebContentsEvent(window, 'did-start-navigation', mainFrameNavigation)

    fireInput(window, closeChord())

    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()
  })

  it('closes the find overlay before a top-level document navigation', () => {
    createMainWindow()
    const window = currentWindow!
    signalWindowFindReady(window)
    fireInput(window, findChord())
    findOverlayMock.close.mockClear()

    fireWebContentsEvent(window, 'did-start-navigation', mainFrameNavigation)

    expect(findOverlayMock.close).toHaveBeenCalledTimes(1)
  })

  it('keeps forwarding when a subframe or same-document navigation fires', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // A dynamic preview iframe load (subframe) and a hash / pushState change (same document) both
    // navigate the WebContents without remounting the hook, so readiness must survive them.
    fireWebContentsEvent(window, 'did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false
    })
    fireWebContentsEvent(window, 'did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true
    })

    fireInput(window, closeChord())

    expect(window.sendMock).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_CHANNEL)
    expect(window.closeMock).not.toHaveBeenCalled()
  })

  it('re-arms the direct-close fallback when the renderer tears its listener down', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // The hook unmounted, so its listener is gone even though the document did not reload.
    signalRendererGone(window)

    fireInput(window, closeChord())

    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()
  })

  it('re-arms the direct-close fallback after the render process is gone', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // The renderer crashed; its listener died with the process until a fresh one re-handshakes.
    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

    fireInput(window, closeChord())

    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()
  })

  it('records why the renderer process terminated', () => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    expect(windowLogSpies.error).toHaveBeenCalledWith('renderer process gone', {
      reason: 'crashed',
      exitCode: 139,
      wasUnresponsive: false
    })
  })

  it('records a main-frame load failure without logging its URL', () => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(
      window,
      'did-fail-load',
      {},
      -105,
      'NAME_NOT_RESOLVED',
      'file:///private/session-content/index.html',
      true
    )

    expect(windowLogSpies.error).toHaveBeenCalledWith('renderer document failed to load', {
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED'
    })
    expect(JSON.stringify(windowLogSpies.error.mock.calls)).not.toContain('session-content')
  })

  it('destroys an unusable window when the initial renderer load promise rejects', async () => {
    loadRendererDocument = () => Promise.reject(new Error('renderer entry unavailable'))

    createMainWindow()
    const window = currentWindow!
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/index.html',
      frame: window.mainFrame
    })

    await vi.waitFor(() => expect(window.destroyMock).toHaveBeenCalledTimes(1))
  })

  it('keeps the window when a stale initial load rejects after crash recovery starts', async () => {
    let rejectInitial!: (error: Error) => void
    let loadAttempt = 0
    loadRendererDocument = () => {
      loadAttempt += 1
      if (loadAttempt === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectInitial = reject
        })
      }
      return Promise.resolve()
    }

    createMainWindow()
    const window = currentWindow!
    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    expect(window.loadFileMock).toHaveBeenCalledTimes(2)
    await Promise.resolve()

    rejectInitial(new Error('superseded initial load'))
    await vi.waitFor(() =>
      expect(windowLogSpies.error).toHaveBeenCalledWith('renderer document load rejected', {
        errorName: 'Error'
      })
    )

    expect(window.destroyMock).not.toHaveBeenCalled()
  })

  it('keeps the window when a newer top-level reload supersedes the initial load', async () => {
    let rejectInitial!: (error: Error) => void
    loadRendererDocument = () =>
      new Promise<void>((_resolve, reject) => {
        rejectInitial = reject
      })

    createMainWindow()
    const window = currentWindow!
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/index.html',
      frame: window.mainFrame
    })
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/index.html',
      frame: window.mainFrame
    })

    rejectInitial(new Error('superseded initial load'))
    await vi.waitFor(() =>
      expect(windowLogSpies.error).toHaveBeenCalledWith('renderer document load rejected', {
        errorName: 'Error'
      })
    )

    expect(window.destroyMock).not.toHaveBeenCalled()
  })

  it('recovers a newer navigation failure while a stale explicit load is pending', () => {
    let loadAttempt = 0
    loadRendererDocument = () => {
      loadAttempt += 1
      return loadAttempt === 1 ? new Promise<void>(() => undefined) : Promise.resolve()
    }

    createMainWindow()
    const window = currentWindow!
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/index.html',
      frame: window.mainFrame
    })
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/reloaded.html',
      frame: window.mainFrame
    })

    fireWebContentsEvent(
      window,
      'did-fail-load',
      {},
      -105,
      'NAME_NOT_RESOLVED',
      'file:///app/reloaded.html',
      true
    )

    expect(window.loadFileMock).toHaveBeenCalledTimes(2)
    expect(windowLogSpies.warn).toHaveBeenCalledWith(
      'reloading renderer after document load failure',
      { automaticRecoveryAttempt: 1 }
    )
  })

  it('ignores an aborted load failure from a superseded main-frame navigation', async () => {
    createMainWindow()
    const window = currentWindow!
    await Promise.resolve()

    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/old.html',
      frame: window.mainFrame
    })
    fireWebContentsEvent(window, 'did-start-navigation', {
      ...mainFrameNavigation,
      url: 'file:///app/current.html',
      frame: window.mainFrame
    })
    fireWebContentsEvent(
      window,
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      'file:///app/old.html',
      true
    )

    expect(window.loadFileMock).toHaveBeenCalledTimes(1)
    expect(windowLogSpies.warn).not.toHaveBeenCalledWith(
      'reloading renderer after document load failure',
      expect.anything()
    )
  })

  it('recovers a main-frame document load failure within the renderer retry budget', async () => {
    showMessageBoxMock.mockReturnValueOnce(new Promise(() => undefined))
    createMainWindow()
    const window = currentWindow!
    await Promise.resolve()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireWebContentsEvent(
        window,
        'did-fail-load',
        {},
        -105,
        'NAME_NOT_RESOLVED',
        'file:///app/index.html',
        true
      )
      await Promise.resolve()
    }

    expect(window.loadFileMock).toHaveBeenCalledTimes(3)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('records a preload failure without logging its path or error text', () => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(
      window,
      'preload-error',
      {},
      'C:\\Users\\person\\private-preload.js',
      new Error('secret from local data')
    )

    expect(windowLogSpies.error).toHaveBeenCalledWith('renderer preload failed', {
      errorName: 'Error'
    })
    expect(JSON.stringify(windowLogSpies.error.mock.calls)).not.toContain('private-preload')
    expect(JSON.stringify(windowLogSpies.error.mock.calls)).not.toContain('secret from local data')
  })

  it('reloads the safe renderer entry after an unexpected renderer exit', () => {
    createMainWindow()
    const window = currentWindow!
    expect(window.loadFileMock).toHaveBeenCalledTimes(1)

    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    expect(window.loadFileMock).toHaveBeenCalledTimes(2)
    expect(windowLogSpies.warn).toHaveBeenCalledWith('reloading renderer after process exit', {
      reason: 'crashed',
      automaticRecoveryAttempt: 1
    })
  })

  it.each(['clean-exit', 'killed'])('does not reload after an intentional %s', (reason) => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(window, 'render-process-gone', {}, { reason, exitCode: 0 })

    expect(window.loadFileMock).toHaveBeenCalledTimes(1)
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('stops automatic reloads and asks before retrying a renderer crash loop', async () => {
    createMainWindow()
    const window = currentWindow!

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    }

    expect(window.loadFileMock).toHaveBeenCalledTimes(3)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        type: 'error',
        buttons: ['Reload', 'Close window'],
        defaultId: 0,
        cancelId: 1
      })
    )
    await vi.waitFor(() => expect(window.loadFileMock).toHaveBeenCalledTimes(4))
  })

  it('counts rejected renderer recovery loads toward the retry dialog', async () => {
    createMainWindow()
    const window = currentWindow!
    await Promise.resolve()
    loadRendererDocument = () => Promise.reject(new Error('renderer entry unavailable'))
    showMessageBoxMock.mockReturnValueOnce(new Promise(() => undefined))

    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalledTimes(1))
    expect(window.loadFileMock).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['before', false],
    ['after', true]
  ])(
    'counts a renderer crash and its recovery load rejection only once %s navigation starts',
    async (_timing, navigationStarted) => {
      let rejectRecoveryLoad!: (error: Error) => void
      let loadAttempt = 0
      loadRendererDocument = () => {
        loadAttempt += 1
        if (loadAttempt === 2) {
          return new Promise<void>((_resolve, reject) => {
            rejectRecoveryLoad = reject
          })
        }
        return Promise.resolve()
      }

      createMainWindow()
      const window = currentWindow!
      await Promise.resolve()

      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
      if (navigationStarted) {
        fireWebContentsEvent(window, 'did-start-navigation', {
          ...mainFrameNavigation,
          url: 'file:///app/index.html',
          frame: window.mainFrame
        })
      }
      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

      rejectRecoveryLoad(new Error('renderer exited during recovery'))
      await vi.waitFor(() =>
        expect(windowLogSpies.error).toHaveBeenCalledWith('renderer document load rejected', {
          errorName: 'Error'
        })
      )

      expect(window.loadFileMock).toHaveBeenCalledTimes(3)
      expect(showMessageBoxMock).not.toHaveBeenCalled()
    }
  )

  it('destroys the blank window when the user closes a renderer crash-loop prompt', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })
    createMainWindow({
      classifyClose: () => 'hide',
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const window = currentWindow!

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'oom', exitCode: 5 })
    }

    await vi.waitFor(() => expect(window.destroyMock).toHaveBeenCalledTimes(1))
    expect(window.hidden).toBe(false)
  })

  it('records the known hang duration when an unresponsive renderer terminates', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(6_500)
    try {
      createMainWindow()
      const window = currentWindow!

      fireWebContentsEvent(window, 'unresponsive')
      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'oom', exitCode: 5 })

      expect(windowLogSpies.error).toHaveBeenCalledWith('renderer process gone', {
        reason: 'oom',
        exitCode: 5,
        wasUnresponsive: true,
        unresponsiveDurationMs: 4_500
      })
    } finally {
      now.mockRestore()
    }
  })

  it.each([
    ['close listener', signalRendererReady],
    ['find listener', signalWindowFindReady]
  ])('clears stale hang context when the %s READY handshake arrives', (_label, signalReady) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      createMainWindow()
      const window = currentWindow!

      fireWebContentsEvent(window, 'unresponsive')
      signalReady(window)
      fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

      expect(windowLogSpies.error).toHaveBeenCalledWith('renderer process gone', {
        reason: 'crashed',
        exitCode: 1,
        wasUnresponsive: false
      })
    } finally {
      now.mockRestore()
    }
  })

  it('does not carry unresponsive state into a replacement renderer process', () => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(window, 'unresponsive')
    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    windowLogSpies.error.mockClear()
    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'killed', exitCode: 2 })

    expect(windowLogSpies.error).toHaveBeenCalledWith('renderer process gone', {
      reason: 'killed',
      exitCode: 2,
      wasUnresponsive: false
    })
  })

  it('closes the find overlay when the renderer process is gone', () => {
    createMainWindow()
    const window = currentWindow!
    signalWindowFindReady(window)
    fireInput(window, findChord())
    findOverlayMock.close.mockClear()

    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 1 })

    expect(findOverlayMock.close).toHaveBeenCalledTimes(1)
  })

  it('closes directly while the renderer is unresponsive, then forwards again once responsive', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    fireWebContentsEvent(window, 'unresponsive')

    // A hung renderer would never process the forwarded chord, so main closes directly instead.
    fireInput(window, closeChord())
    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()

    // Recovery restores forwarding without requiring the renderer to re-handshake.
    fireWebContentsEvent(window, 'responsive')
    fireInput(window, closeChord())
    expect(window.sendMock).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_CHANNEL)
    expect(window.closeMock).toHaveBeenCalledTimes(1)
  })

  it('closes the find overlay when the renderer becomes unresponsive', () => {
    createMainWindow()
    const window = currentWindow!
    signalWindowFindReady(window)
    fireInput(window, findChord())
    findOverlayMock.close.mockClear()

    fireWebContentsEvent(window, 'unresponsive')

    expect(findOverlayMock.close).toHaveBeenCalledTimes(1)
  })

  it('records when the renderer becomes unresponsive', () => {
    createMainWindow()
    const window = currentWindow!

    fireWebContentsEvent(window, 'unresponsive')

    expect(windowLogSpies.warn).toHaveBeenCalledWith('renderer became unresponsive')
  })

  it('records renderer recovery with the unresponsive duration', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(3_750)
    try {
      createMainWindow()
      const window = currentWindow!

      fireWebContentsEvent(window, 'unresponsive')
      fireWebContentsEvent(window, 'responsive')

      expect(windowLogSpies.info).toHaveBeenCalledWith('renderer became responsive', {
        unresponsiveDurationMs: 2_750
      })
    } finally {
      now.mockRestore()
    }
  })

  it('forwards again after unresponsive -> crash -> reload -> ready, with no responsive event', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // The renderer hangs, then its process dies, then a fresh one loads and re-handshakes. A brand-new
    // process never emits 'responsive' (that is a same-process recovery signal), so READY alone must
    // clear the stale unresponsive state or the chord stays a direct close forever.
    fireWebContentsEvent(window, 'unresponsive')
    fireWebContentsEvent(window, 'render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    fireWebContentsEvent(window, 'did-start-navigation', mainFrameNavigation)
    signalRendererReady(window)

    fireInput(window, closeChord())

    expect(window.sendMock).toHaveBeenCalledWith(CLOSE_ACTIVE_PANE_CHANNEL)
    expect(window.closeMock).not.toHaveBeenCalled()
  })

  it('ignores keys that are not the close chord', () => {
    createMainWindow()
    const window = currentWindow!
    signalRendererReady(window)

    const preventDefault = fireInput(window, closeChord({ key: 'q' }))

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.sendMock).not.toHaveBeenCalled()
    expect(window.closeMock).not.toHaveBeenCalled()
  })

  it('routes the Cmd/Ctrl+W direct-close fallback through classifyClose', () => {
    // Renderer not ready, so the chord falls back to window.close(); with the tray resident that must
    // hide the window (via the 'close' interceptor) instead of actually closing it.
    createMainWindow({
      classifyClose: () => 'hide',
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const window = currentWindow!

    fireInput(window, closeChord())

    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.hidden).toBe(true)
    expect(window.hideCalls).toBe(1)
    expect(window.isDestroyed()).toBe(false)
  })
})

describe('createMainWindow close-to-tray interceptor', () => {
  beforeEach(() => {
    lastWindow = undefined
  })

  it('hides instead of closing when classifyClose returns "hide"', () => {
    createMainWindow({
      classifyClose: () => 'hide',
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const window = lastWindow!
    expect(window).toBeDefined()

    const event = emitClose(window)

    expect(event.defaultPrevented).toBe(true)
    expect(window.hideCalls).toBe(1)
    expect(window.hidden).toBe(true)
    expect(window.isDestroyed()).toBe(false)
  })

  it('evaluates classifyClose at close time so a flipped flag allows a real quit', () => {
    let quitting = false
    createMainWindow({
      classifyClose: () => (quitting ? 'close' : 'hide'),
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const window = lastWindow!

    emitClose(window)
    expect(window.hideCalls).toBe(1)
    expect(window.isDestroyed()).toBe(false)

    quitting = true
    const event = emitClose(window)
    expect(event.defaultPrevented).toBe(false)
    expect(window.hideCalls).toBe(1)
    expect(window.isDestroyed()).toBe(true)
  })

  it('lets the window close when classifyClose returns "close"', () => {
    createMainWindow({
      classifyClose: () => 'close',
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const window = lastWindow!

    const event = emitClose(window)

    expect(event.defaultPrevented).toBe(false)
    expect(window.hideCalls).toBe(0)
    expect(window.isDestroyed()).toBe(true)
  })

  it('requests app quit without destroying the renderer when classifyClose returns "quit"', () => {
    const requestQuit = vi.fn()
    createMainWindow({ classifyClose: () => 'quit', resolveCloseAction: vi.fn(), requestQuit })
    const window = lastWindow!

    const event = emitClose(window)

    expect(event.defaultPrevented).toBe(true)
    expect(requestQuit).toHaveBeenCalledWith(false)
    expect(window.isDestroyed()).toBe(false)
  })

  it('lets the window close when no options are provided', () => {
    createMainWindow()
    const window = lastWindow!

    const event = emitClose(window)

    expect(event.defaultPrevented).toBe(false)
    expect(window.hideCalls).toBe(0)
    expect(window.isDestroyed()).toBe(true)
  })
})

describe('createMainWindow close handling', () => {
  it('lets the window close when classifyClose returns "close"', () => {
    const requestQuit = vi.fn()
    createMainWindow({ classifyClose: () => 'close', resolveCloseAction: vi.fn(), requestQuit })
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    currentWindow!.handlers.get('close')![0](event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(currentWindow!.hideCalls).toBe(0)
  })

  it('hides to tray when classifyClose returns "hide"', () => {
    createMainWindow({
      classifyClose: () => 'hide',
      resolveCloseAction: vi.fn(),
      requestQuit: vi.fn()
    })
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    currentWindow!.handlers.get('close')![0](event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(currentWindow!.hideCalls).toBe(1)
  })

  it('confirm -> minimize hides the window', async () => {
    const resolveCloseAction = vi.fn(async () => 'minimize' as const)
    createMainWindow({ classifyClose: () => 'confirm', resolveCloseAction, requestQuit: vi.fn() })
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    currentWindow!.handlers.get('close')![0](event)
    expect(event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(currentWindow!.hideCalls).toBe(1))
  })

  it('keeps interruption confirmation pending when the titlebar action resolves to quit', async () => {
    const requestQuit = vi.fn()
    const resolveCloseAction = vi.fn(async () => 'quit' as const)
    createMainWindow({ classifyClose: () => 'confirm', resolveCloseAction, requestQuit })
    currentWindow!.handlers.get('close')![0]({ preventDefault: vi.fn(), defaultPrevented: false })
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledWith(false))
  })

  it('does not stack confirmations while one is in flight', () => {
    let resolveFn: (c: 'cancel') => void = () => undefined
    const resolveCloseAction = vi.fn(() => new Promise<'cancel'>((r) => (resolveFn = r)))
    createMainWindow({ classifyClose: () => 'confirm', resolveCloseAction, requestQuit: vi.fn() })
    const close = currentWindow!.handlers.get('close')![0]
    close({ preventDefault: vi.fn(), defaultPrevented: false })
    close({ preventDefault: vi.fn(), defaultPrevented: false })
    expect(resolveCloseAction).toHaveBeenCalledTimes(1)
    resolveFn('cancel')
  })
})
