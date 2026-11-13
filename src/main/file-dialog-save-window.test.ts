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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
      setWindowOpenHandler: (): void => undefined
    })
    private visible = false
    private destroyed = false
    private bounds = { x: 0, y: 0, width: 600, height: 340 }

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
      return [this.bounds.width, this.bounds.height]
    }

    setContentSize(width: number, height: number): void {
      this.bounds.width = width
      this.bounds.height = height
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
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })
  }
}))

import { showInProcessFileDialog } from './file-dialog-save-window'

describe('in-process save file dialog window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeBrowserWindow.instances.length = 0
    mocks.windows.length = 0
    mocks.handler = undefined
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
    await mocks.handler!(senderEvent, { type: 'ready' })
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
      'renderer-ready',
      'shown',
      'cancelled',
      'closed'
    ])
  })
})
