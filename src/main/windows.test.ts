import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  type KeyChordInput
} from '../shared/window-controls'

// Hoisted so the electron mock and the test body share the same spies.
const { openExternalMock, ipcMainOnMock, ipcMainRemoveListenerMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn()
}))

// Captured window-open handler so tests can drive it directly, mirroring how Electron invokes it on a
// target="_blank" click or window.open() from the main app frame.
type WindowOpenDetails = { url: string; referrer: { url: string } }
let windowOpenHandler: ((details: WindowOpenDetails) => unknown) | undefined

// The most recently constructed window and its captured handlers, so tests can drive the
// before-input-event / lifecycle listeners and the 'close' interceptor the way Electron would.
type WebContentsHandler = (...args: unknown[]) => void
// Fake close event mirroring Electron's: preventDefault records that the close was intercepted.
type CloseEvent = { preventDefault: () => void; defaultPrevented: boolean }

// currentWindow and lastWindow both point at the latest window; two describe blocks, one shared fake.
let currentWindow: FakeBrowserWindow | undefined
let lastWindow: FakeBrowserWindow | undefined

class FakeBrowserWindow {
  closeMock = vi.fn()
  sendMock = vi.fn()
  webContentsHandlers = new Map<string, WebContentsHandler>()
  handlers = new Map<string, Array<(event: CloseEvent) => void>>()
  hidden = false
  destroyed = false
  hideCalls = 0
  webContents = {
    setWindowOpenHandler: (handler: (details: WindowOpenDetails) => unknown): void => {
      windowOpenHandler = handler
    },
    on: (event: string, handler: WebContentsHandler): void => {
      this.webContentsHandlers.set(event, handler)
    },
    send: (...args: unknown[]): void => this.sendMock(...args),
    getURL: (): string => 'file:///app/index.html'
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

  show(): void {
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
    return Promise.resolve()
  }
}

vi.mock('electron', () => ({
  // isPackaged=true skips the dev title-suffix branch, keeping the fake focused on the open + close handlers.
  app: { isPackaged: true },
  BrowserWindow: class {
    constructor() {
      currentWindow = new FakeBrowserWindow()
      lastWindow = currentWindow
      return currentWindow as unknown as object
    }
  },
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock },
  shell: { openExternal: openExternalMock }
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

describe('window navigation policy', () => {
  it('allows only explicit external URL protocols', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(policy?.isAllowedExternalUrl('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalUrl('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalUrl('file:///Users/example/private.txt')).toBe(false)
    expect(policy?.isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    // External-open is gated on the protocol allowlist alone: the initiating referrer is unreliable
    // (rel="noreferrer" and file:-origin cross-origin suppression both empty it), and window-open can
    // only originate from the trusted main frame anyway (see navigation-policy.ts).
    expect(policy?.isAllowedExternalNavigation('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('javascript:alert(1)')).toBe(false)
    expect(policy?.isAllowedExternalNavigation('file:///Users/example/private.txt')).toBe(false)
  })

  it('keeps subframe navigation inside the managed preview protocol', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(
      policy?.isAllowedFrameNavigation('open-science-preview://resource/report.html', false)
    ).toBe(true)
    expect(
      policy?.isAllowedFrameNavigation(
        'open-science-office-preview://runtime/office-preview.html?sessionId=session-1',
        false
      )
    ).toBe(true)
    expect(policy?.isAllowedFrameNavigation('https://example.com/exfiltrate', false)).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://app.example.com/workspace',
        true,
        'https://app.example.com/'
      )
    ).toBe(true)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://example.com/exfiltrate',
        true,
        'https://app.example.com/'
      )
    ).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'file://remote-host/app/index.html',
        true,
        'file:///app/index.html'
      )
    ).toBe(false)
  })
})

describe('window-open external handler', () => {
  beforeEach(() => {
    windowOpenHandler = undefined
    openExternalMock.mockClear()
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
})

describe('close chord interception', () => {
  beforeEach(() => {
    currentWindow = undefined
    ipcMainOnMock.mockReset()
    ipcMainRemoveListenerMock.mockReset()
  })

  // Fires an ipcMain handshake signal that main registered via ipcMain.on, spoofing the sender as this
  // window's webContents so the readiness flag flips for it.
  const fireHandshake = (window: FakeBrowserWindow, channel: string): void => {
    const handler = ipcMainOnMock.mock.calls.find(([registered]) => registered === channel)?.[1] as
      ((event: { sender: unknown }) => void) | undefined
    expect(handler).toBeDefined()
    handler!({ sender: window.webContents })
  }

  const signalRendererReady = (window: FakeBrowserWindow): void =>
    fireHandshake(window, CLOSE_ACTIVE_PANE_READY_CHANNEL)

  const signalRendererGone = (window: FakeBrowserWindow): void =>
    fireHandshake(window, CLOSE_ACTIVE_PANE_UNREADY_CHANNEL)

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
    fireWebContentsEvent(window, 'render-process-gone')

    fireInput(window, closeChord())

    expect(window.closeMock).toHaveBeenCalledTimes(1)
    expect(window.sendMock).not.toHaveBeenCalled()
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

  it('forwards again after unresponsive -> crash -> reload -> ready, with no responsive event', () => {
    createMainWindow()
    const window = currentWindow!

    signalRendererReady(window)
    // The renderer hangs, then its process dies, then a fresh one loads and re-handshakes. A brand-new
    // process never emits 'responsive' (that is a same-process recovery signal), so READY alone must
    // clear the stale unresponsive state or the chord stays a direct close forever.
    fireWebContentsEvent(window, 'unresponsive')
    fireWebContentsEvent(window, 'render-process-gone')
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

  it('confirm -> quit calls requestQuit', async () => {
    const requestQuit = vi.fn()
    const resolveCloseAction = vi.fn(async () => 'quit' as const)
    createMainWindow({ classifyClose: () => 'confirm', resolveCloseAction, requestQuit })
    currentWindow!.handlers.get('close')![0]({ preventDefault: vi.fn(), defaultPrevented: false })
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledTimes(1))
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
