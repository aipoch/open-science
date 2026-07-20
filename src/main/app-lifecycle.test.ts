import { describe, expect, it, vi } from 'vitest'

import { installAppLifecycle, type AppLifecycleDeps, type TrayHandlers } from './app-lifecycle'

type QuitEvent = { preventDefault: () => void; defaultPrevented: boolean }
type Handler = (event: QuitEvent) => void

type FakeApp = {
  on: (event: string, handler: Handler) => void
  exit: ReturnType<typeof vi.fn>
  // Fires every listener for an event with a fresh preventable event, returning it for assertions.
  emit: (event: string) => QuitEvent
}

// Minimal Electron app double: records lifecycle listeners so tests can fire them, and captures exit.
const makeFakeApp = (): FakeApp => {
  const handlers = new Map<string, Handler[]>()
  return {
    on(event, handler): void {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    exit: vi.fn(),
    emit(event): QuitEvent {
      const evt: QuitEvent = {
        defaultPrevented: false,
        preventDefault(): void {
          evt.defaultPrevented = true
        }
      }
      for (const handler of handlers.get(event) ?? []) handler(evt)
      return evt
    }
  }
}

type FakeWindow = {
  destroyed: boolean
  minimized: boolean
  visible: boolean
  focused: boolean
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isVisible: () => boolean
  restore: () => void
  show: () => void
  hide: () => void
  focus: () => void
}

// A fake BrowserWindow tracking visibility/focus/destroyed state.
const makeFakeWindow = (): FakeWindow => ({
  destroyed: false,
  minimized: false,
  visible: true,
  focused: false,
  isDestroyed(): boolean {
    return this.destroyed
  },
  isMinimized(): boolean {
    return this.minimized
  },
  isVisible(): boolean {
    return this.visible
  },
  restore(): void {
    this.minimized = false
  },
  show(): void {
    this.visible = true
  },
  hide(): void {
    this.visible = false
  },
  focus(): void {
    this.focused = true
  }
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const asWindow = (w: FakeWindow): import('electron').BrowserWindow =>
  w as unknown as import('electron').BrowserWindow

type Harness = {
  app: FakeApp
  windows: FakeWindow[]
  tray: { destroy: ReturnType<typeof vi.fn> } | undefined
  trayHandlers: TrayHandlers | undefined
  shutdownBackends: () => Promise<void>
  quit: ReturnType<typeof vi.fn>
  showMainWindow: () => void
}

const setup = (
  overrides: Partial<
    Pick<
      AppLifecycleDeps,
      'shutdownBackends' | 'isMigrationInProgress' | 'platform' | 'createInitialWindow'
    >
  > & {
    trayHost?: boolean
  } = {}
): Harness => {
  const app = makeFakeApp()
  const windows: FakeWindow[] = []
  const trayHost = overrides.trayHost ?? true
  const tray = trayHost ? { destroy: vi.fn() } : undefined
  let trayHandlers: TrayHandlers | undefined
  const shutdownBackends = overrides.shutdownBackends ?? vi.fn(async () => undefined)
  const quit = vi.fn()

  const { showMainWindow } = installAppLifecycle({
    app: app as unknown as AppLifecycleDeps['app'],
    createMainWindow: () => {
      const w = makeFakeWindow()
      windows.push(w)
      return asWindow(w)
    },
    createTray: (handlers) => {
      trayHandlers = handlers
      return tray as unknown as import('electron').Tray | undefined
    },
    shutdownBackends,
    isMigrationInProgress: overrides.isMigrationInProgress ?? ((): boolean => false),
    quit,
    countWindows: () => windows.filter((w) => !w.destroyed).length,
    createInitialWindow: overrides.createInitialWindow,
    platform: overrides.platform ?? 'linux'
  })

  return { app, windows, tray, trayHandlers, shutdownBackends, quit, showMainWindow }
}

describe('installAppLifecycle', () => {
  it('creates the first window and tray on install', () => {
    const { windows, trayHandlers } = setup()
    expect(windows).toHaveLength(1)
    expect(trayHandlers).toBeDefined()
  })

  it('starts headless and creates a window only when requested', () => {
    const { windows, trayHandlers } = setup({ createInitialWindow: false })
    expect(windows).toHaveLength(0)
    trayHandlers?.onShow()
    expect(windows).toHaveLength(1)
  })

  it('runs an awaited backend teardown then exits on a normal quit', async () => {
    const { app, tray, shutdownBackends } = setup()

    const event = app.emit('before-quit')
    expect(event.defaultPrevented).toBe(true)
    expect(app.exit).not.toHaveBeenCalled() // still awaiting shutdown

    await flush()
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(tray?.destroy).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('defers to the migration guard when a migration is in progress', async () => {
    const { app, shutdownBackends } = setup({ isMigrationInProgress: (): boolean => true })

    app.emit('before-quit')
    await flush()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('respects a quit an earlier handler already cancelled (defaultPrevented)', async () => {
    // Mirror index.ts ordering: the migration guard registers a before-quit BEFORE the lifecycle, so
    // when it prevents the quit our handler must see defaultPrevented and not start a teardown.
    const app = makeFakeApp()
    app.on('before-quit', (event) => event.preventDefault())

    const shutdownBackends = vi.fn(async () => undefined)
    installAppLifecycle({
      app: app as unknown as AppLifecycleDeps['app'],
      createMainWindow: () => asWindow(makeFakeWindow()),
      createTray: () => ({ destroy: vi.fn() }) as unknown as import('electron').Tray,
      shutdownBackends,
      isMigrationInProgress: (): boolean => false,
      quit: vi.fn(),
      countWindows: (): number => 1,
      platform: 'linux'
    })

    app.emit('before-quit')
    await flush()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('holds a re-issued quit while cleanup is in flight and only tears down once', async () => {
    let release: (() => void) | undefined
    const shutdownBackends = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const { app } = setup({ shutdownBackends })

    app.emit('before-quit') // starts cleanup (pending)
    const second = app.emit('before-quit') // re-issued while running
    expect(second.defaultPrevented).toBe(true)
    expect(shutdownBackends).toHaveBeenCalledTimes(1)

    release?.()
    await flush()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('quits on window-all-closed only when non-darwin and no tray host', () => {
    const noTray = setup({ trayHost: false, platform: 'linux' })
    noTray.app.emit('window-all-closed')
    expect(noTray.quit).toHaveBeenCalledTimes(1)

    const withTray = setup({ trayHost: true, platform: 'linux' })
    withTray.app.emit('window-all-closed')
    expect(withTray.quit).not.toHaveBeenCalled()

    const darwinNoTray = setup({ trayHost: false, platform: 'darwin' })
    darwinNoTray.app.emit('window-all-closed')
    expect(darwinNoTray.quit).not.toHaveBeenCalled()
  })

  it('recreates the window on show when the last one was closed (macOS)', () => {
    const { windows, trayHandlers } = setup({ platform: 'darwin' })
    expect(windows).toHaveLength(1)

    // Model macOS: the window is closed/destroyed but the app stays resident.
    windows[0].destroyed = true

    trayHandlers?.onShow()
    expect(windows).toHaveLength(2)
    expect(windows[1].destroyed).toBe(false)
  })

  it('restores and focuses an existing hidden/minimized window on show', () => {
    const { windows, trayHandlers } = setup()
    windows[0].minimized = true
    windows[0].visible = false

    trayHandlers?.onShow()
    expect(windows).toHaveLength(1) // no new window
    expect(windows[0].minimized).toBe(false)
    expect(windows[0].visible).toBe(true)
    expect(windows[0].focused).toBe(true)
  })

  it('hides the window from the tray Hide item', () => {
    const { windows, trayHandlers } = setup()
    expect(windows[0].visible).toBe(true)
    trayHandlers?.onHide()
    expect(windows[0].visible).toBe(false)
  })

  it('quits from the tray Quit item', () => {
    const { trayHandlers, quit } = setup()
    trayHandlers?.onQuit()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('recreates a window on macOS activate when none are open', () => {
    const { app, windows } = setup({ platform: 'darwin' })
    windows[0].destroyed = true
    app.emit('activate')
    expect(windows).toHaveLength(2)
  })
})
