import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, action: unknown) => Promise<unknown>) | undefined,
  windows: [] as Array<{
    options: Record<string, unknown>
    webContents: {
      mainFrame: { url: string }
    }
  }>,
  operation: {
    phase: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    fail: vi.fn()
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  workArea: { x: 0, y: 0, width: 1200, height: 800 }
}))

class FakeParent {
  destroyed = false
  minimized = true
  visible = false
  readonly restore = vi.fn(() => {
    this.minimized = false
  })
  readonly show = vi.fn(() => {
    this.visible = true
  })
  readonly focus = vi.fn()
  readonly once = vi.fn()
  readonly removeListener = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isVisible(): boolean {
    return this.visible
  }
}

const FakeBrowserWindow = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class Events {
    private readonly listeners = new Map<string, Set<Listener>>()

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(listener)
      this.listeners.set(event, listeners)
    }

    once(event: string, listener: Listener): void {
      const wrapped: Listener = (...args) => {
        this.listeners.get(event)?.delete(wrapped)
        listener(...args)
      }
      this.on(event, wrapped)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }
  }
  class FakeBrowserWindow extends Events {
    static instances: FakeBrowserWindow[] = []
    readonly options: Record<string, unknown>
    readonly webContents = Object.assign(new Events(), {
      mainFrame: { url: '' },
      session: { setPermissionRequestHandler: (): void => undefined },
      getZoomFactor: () => this.zoom,
      setWindowOpenHandler: (): void => undefined
    })
    private visible = false
    private destroyed = false
    private bounds = { x: 0, y: 0, width: 600, height: 340 }
    frameHeight = 0
    zoom = 1
    private minimumSize: [number, number] = [480, 252]

    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    setMenu(): void {
      return undefined
    }

    loadURL(url: string): Promise<void> {
      this.webContents.mainFrame.url = url
      return Promise.resolve()
    }

    show(): void {
      this.visible = true
    }

    focus(): void {
      return undefined
    }

    isVisible(): boolean {
      return this.visible
    }

    isFocused(): boolean {
      return this.visible
    }

    isMinimized(): boolean {
      return false
    }

    restore(): void {
      return undefined
    }

    moveTop(): void {
      return undefined
    }

    setAlwaysOnTop(): void {
      return undefined
    }

    getBounds(): typeof this.bounds {
      return this.bounds
    }

    getContentSize(): [number, number] {
      return [this.bounds.width, this.bounds.height - this.frameHeight]
    }

    setContentSize(width: number, height: number): void {
      this.bounds.width = width
      this.bounds.height = height + this.frameHeight
    }

    getMinimumSize(): [number, number] {
      return this.minimumSize
    }

    setMinimumSize(width: number, height: number): void {
      this.minimumSize = [width, height]
    }

    setPosition(x: number, y: number): void {
      this.bounds.x = x
      this.bounds.y = y
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }
  return FakeBrowserWindow
})

vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => mocks.logger,
  startDiagnosticOperation: () => mocks.operation
}))
vi.mock('electron', () => ({
  app: {
    getLocale: () => 'en-US',
    getPath: (kind: string) => `/tmp/${kind}`,
    focus: vi.fn(),
    dock: { isVisible: () => false }
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: vi.fn((_channel, handler) => {
      mocks.handler = handler
    }),
    removeHandler: vi.fn()
  },
  nativeTheme: { themeSource: 'light' },
  screen: {
    getDisplayMatching: () => ({ workArea: mocks.workArea }),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

import { showInProcessFileDialog } from './file-dialog-save-window'

describe('in-process save file dialog window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeBrowserWindow.instances.length = 0
    mocks.windows.length = 0
    mocks.handler = undefined
    mocks.workArea = { x: 0, y: 0, width: 1200, height: 800 }
  })

  it('creates a modal child and restores a hidden parent after cancel', async () => {
    const parent = new FakeParent()
    const pending = showInProcessFileDialog(
      {
        kind: 'save',
        options: { defaultPath: '/tmp/output.txt' },
        operationId: 'operation-1',
        appearance: { theme: 'light', followsSystem: false, locale: 'en' }
      },
      parent as never
    )
    await vi.waitFor(() => expect(mocks.handler).toBeDefined())
    const window = FakeBrowserWindow.instances[0]
    const senderEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await mocks.handler!(senderEvent, { type: 'ready', height: 252 })
    await mocks.handler!(senderEvent, { type: 'cancel' })

    await expect(pending).resolves.toEqual({ canceled: true, filePath: '' })
    expect(window.options).toMatchObject({
      parent,
      modal: true,
      show: false,
      height: 252,
      minHeight: 252
    })
    expect(parent.restore).toHaveBeenCalledOnce()
    expect(parent.show).toHaveBeenCalledOnce()
    expect(parent.focus).toHaveBeenCalledOnce()
    expect(mocks.operation.phase.mock.calls.map(([phase]) => phase)).toEqual([
      'created',
      'resized',
      'renderer-ready',
      'shown',
      'cancelled',
      'closed'
    ])
  })

  it('fits zoomed content inside the full work area including the native window frame', async () => {
    const pending = showInProcessFileDialog(
      {
        kind: 'save',
        options: { defaultPath: '/tmp/output.txt' },
        operationId: 'operation-size',
        appearance: { theme: 'light', followsSystem: false, locale: 'en' }
      },
      new FakeParent() as never
    )
    const window = FakeBrowserWindow.instances[0]
    window.frameHeight = 32
    window.zoom = 1.5
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await mocks.handler!(event, { type: 'ready', height: 260 })
    expect(window.getContentSize()[1]).toBe(390)

    window.setPosition(10, 700)
    await mocks.handler!(event, { type: 'resize', height: 600 })
    expect(window.getBounds()).toMatchObject({ y: 0, height: 800 })
    expect(window.getContentSize()[1]).toBe(768)

    // An invalid renderer measurement must not poison future display-change callbacks.
    await expect(mocks.handler!(event, { type: 'resize', height: Infinity })).rejects.toThrow()
    mocks.workArea.height = 180
    window.emit('moved')
    expect(window.getBounds().height).toBe(180)
    expect(window.getMinimumSize()[1]).toBe(180)

    mocks.workArea.height = 800
    await mocks.handler!(event, { type: 'resize', height: 100 })
    expect(window.getContentSize()[1]).toBe(252)
    await mocks.handler!(event, { type: 'cancel' })
    await expect(pending).resolves.toMatchObject({ canceled: true })
  })
})
