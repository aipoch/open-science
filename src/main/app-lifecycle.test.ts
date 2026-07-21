import { describe, expect, it, vi } from 'vitest'

import { installAppLifecycle, type AppLifecycleDeps, type TrayHandlers } from './app-lifecycle'
import type { ActiveSessionInfo } from '../shared/storage'
import type { CloseConfirmChoice, CloseConfirmVariant } from '../shared/window-controls'

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

type CapturedCloseOpts = {
  classifyClose: () => 'close' | 'hide' | 'confirm'
  resolveCloseAction: () => Promise<CloseConfirmChoice>
  requestQuit: () => void
}

type Harness = {
  app: FakeApp
  windows: FakeWindow[]
  tray: { destroy: ReturnType<typeof vi.fn> } | undefined
  trayHandlers: TrayHandlers | undefined
  shutdownBackends: () => Promise<void>
  quit: ReturnType<typeof vi.fn>
  showMainWindow: () => void
  closeOpts: CapturedCloseOpts[]
  confirmClose: ReturnType<typeof vi.fn>
}

const setup = (
  overrides: Partial<
    Pick<
      AppLifecycleDeps,
      'shutdownBackends' | 'isMigrationInProgress' | 'platform' | 'createInitialWindow'
    >
  > & {
    trayHost?: boolean
    detectActiveSessions?: () => ActiveSessionInfo[]
    confirmClose?: (
      variant: CloseConfirmVariant,
      sessions: ActiveSessionInfo[]
    ) => Promise<CloseConfirmChoice>
  } = {}
): Harness => {
  const app = makeFakeApp()
  const windows: FakeWindow[] = []
  const trayHost = overrides.trayHost ?? true
  const tray = trayHost ? { destroy: vi.fn() } : undefined
  let trayHandlers: TrayHandlers | undefined
  const shutdownBackends = overrides.shutdownBackends ?? vi.fn(async () => undefined)
  const quit = vi.fn()
  const closeOpts: CapturedCloseOpts[] = []
  const confirmClose = vi.fn(
    overrides.confirmClose ?? ((): Promise<CloseConfirmChoice> => Promise.resolve('quit'))
  )
  const detectActiveSessions = overrides.detectActiveSessions ?? ((): ActiveSessionInfo[] => [])

  const { showMainWindow } = installAppLifecycle({
    app: app as unknown as AppLifecycleDeps['app'],
    createMainWindow: (opts) => {
      closeOpts.push(opts)
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
    platform: overrides.platform ?? 'linux',
    detectActiveSessions,
    createConfirmClose: () => confirmClose
  })

  return {
    app,
    windows,
    tray,
    trayHandlers,
    shutdownBackends,
    quit,
    showMainWindow,
    closeOpts,
    confirmClose
  }
}

// Sets up with a single captured createMainWindow opts, for classifyClose assertions.
const installWithCapturedOpts = (opts: {
  platform: NodeJS.Platform
  hasTray: boolean
}): CapturedCloseOpts => {
  const { closeOpts } = setup({ platform: opts.platform, trayHost: opts.hasTray })
  return closeOpts[0]
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
    // Default confirmClose resolves 'quit'; a normal quit goes through the confirm gate first,
    // then the real Electron re-issues before-quit once requestQuit's quit() lands.
    const { app, tray, shutdownBackends, quit } = setup()

    const event = app.emit('before-quit')
    expect(event.defaultPrevented).toBe(true)
    expect(app.exit).not.toHaveBeenCalled() // still awaiting confirmation

    await flush()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled() // still awaiting shutdown

    app.emit('before-quit') // re-issued quit, now confirmed
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
      platform: 'linux',
      detectActiveSessions: (): ActiveSessionInfo[] => [],
      createConfirmClose: () => (): Promise<CloseConfirmChoice> => Promise.resolve('quit')
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
    const { app, closeOpts } = setup({ shutdownBackends })
    closeOpts[0].requestQuit() // pre-confirm, so the next before-quit goes straight to cleanup

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

  it('classifyClose returns "close" on darwin', () => {
    const captured = installWithCapturedOpts({ platform: 'darwin', hasTray: true })
    expect(captured.classifyClose()).toBe('close')
  })

  it('classifyClose returns "confirm" on win32 with a tray', () => {
    const captured = installWithCapturedOpts({ platform: 'win32', hasTray: true })
    expect(captured.classifyClose()).toBe('confirm')
  })

  it('classifyClose returns "hide" on linux with a tray', () => {
    const captured = installWithCapturedOpts({ platform: 'linux', hasTray: true })
    expect(captured.classifyClose()).toBe('hide')
  })

  it('classifyClose returns "close" when no tray', () => {
    const captured = installWithCapturedOpts({ platform: 'win32', hasTray: false })
    expect(captured.classifyClose()).toBe('close')
  })

  it('resolveCloseAction resolves via confirmClose("close-to-tray", sessions)', async () => {
    const sessions: ActiveSessionInfo[] = [{ projectName: 'demo', sessionId: 's1', kind: 'agent' }]
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'minimize')
    const { closeOpts } = setup({ detectActiveSessions: () => sessions, confirmClose })

    const choice = await closeOpts[0].resolveCloseAction()
    expect(confirmClose).toHaveBeenCalledWith('close-to-tray', sessions)
    expect(choice).toBe('minimize')
  })

  it('requestQuit sets quitConfirmed and calls quit', () => {
    const { closeOpts, quit } = setup()
    closeOpts[0].requestQuit()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('before-quit with no active work proceeds to shutdown (confirmClose resolves quit)', async () => {
    const confirmClose = vi.fn(
      (_variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]): Promise<CloseConfirmChoice> =>
        Promise.resolve(sessions.length === 0 ? 'quit' : 'cancel')
    )
    const { app, tray, shutdownBackends, quit } = setup({ confirmClose })

    const event = app.emit('before-quit')
    expect(event.defaultPrevented).toBe(true)
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', [])
    expect(quit).toHaveBeenCalledTimes(1)

    // requestQuit -> quit() drove by the app; simulate the resulting re-issued before-quit.
    app.emit('before-quit')
    await flush()

    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(tray?.destroy).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('before-quit with active work + cancel keeps the app alive (no shutdown, no exit)', async () => {
    const sessions: ActiveSessionInfo[] = [
      { projectName: 'demo', sessionId: 's1', kind: 'notebook' }
    ]
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'cancel')
    const { app, shutdownBackends, quit } = setup({
      detectActiveSessions: () => sessions,
      confirmClose
    })

    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', sessions)
    expect(quit).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('before-quit skips confirmation once quit is already confirmed (no double dialog)', async () => {
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'quit')
    const { app, closeOpts, shutdownBackends } = setup({ confirmClose })

    closeOpts[0].requestQuit() // sets quitConfirmed then calls quit()
    app.emit('before-quit') // the re-entered before-quit that quit() triggers

    await flush()
    expect(confirmClose).not.toHaveBeenCalled()
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('migration in progress bypasses the confirm gate', async () => {
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'quit')
    const { app, quit, shutdownBackends } = setup({
      isMigrationInProgress: (): boolean => true,
      confirmClose
    })

    const event = app.emit('before-quit')
    await flush()

    expect(event.defaultPrevented).toBe(false)
    expect(confirmClose).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
  })

  it('holds a re-issued quit while a confirm is already in flight', async () => {
    let resolveConfirm: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn(
      () =>
        new Promise<CloseConfirmChoice>((resolve) => {
          resolveConfirm = resolve
        })
    )
    const { app, quit } = setup({ confirmClose })

    app.emit('before-quit') // starts the confirm (pending)
    app.emit('before-quit') // re-issued while the confirm is in flight
    expect(confirmClose).toHaveBeenCalledTimes(1)

    resolveConfirm?.('quit')
    await flush()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('a titlebar X close-to-tray does not dispatch a second confirm while a quit-confirm is open', async () => {
    // Cross-flow guard: tray/Ctrl+Q quit-confirm is already open (before-quit -> confirmClose('quit', ...)
    // pending) when the user clicks the titlebar X. Without the shared confirmInFlight guard this would
    // fire a second confirmClose('close-to-tray', ...) that overwrites the renderer's single request slot,
    // stranding the quit-confirm promise and permanently pinning quitConfirmInFlight (see defect writeup).
    let resolveConfirm: ((choice: CloseConfirmChoice) => void) | undefined
    const sessions: ActiveSessionInfo[] = [{ projectName: 'demo', sessionId: 's1', kind: 'agent' }]
    const confirmClose = vi.fn(
      () =>
        new Promise<CloseConfirmChoice>((resolve) => {
          resolveConfirm = resolve
        })
    )
    const { app, closeOpts } = setup({ detectActiveSessions: () => sessions, confirmClose })

    app.emit('before-quit') // opens the quit-confirm modal, confirmClose('quit', ...) pending
    expect(confirmClose).toHaveBeenCalledTimes(1)
    expect(confirmClose).toHaveBeenCalledWith('quit', sessions)

    const choice = await closeOpts[0].resolveCloseAction() // titlebar X pressed while quit-confirm is open
    expect(choice).toBe('cancel')
    expect(confirmClose).toHaveBeenCalledTimes(1) // no second (close-to-tray) dispatch

    resolveConfirm?.('cancel')
    await flush()
  })

  it('tray Quit is a no-op (preventDefault only) while a close-to-tray confirm is open', async () => {
    // Mirror of the above: titlebar X close-to-tray confirm is open when the user hits tray Quit /
    // Ctrl+Q. The before-quit handler must preventDefault and return without starting a second
    // confirmClose('quit', ...) dispatch, leaving the open close-to-tray confirm authoritative.
    let resolveConfirm: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn(
      () =>
        new Promise<CloseConfirmChoice>((resolve) => {
          resolveConfirm = resolve
        })
    )
    const { app, closeOpts } = setup({ confirmClose })

    const resolveCloseActionPromise = closeOpts[0].resolveCloseAction() // titlebar X, confirm pending
    expect(confirmClose).toHaveBeenCalledTimes(1)
    expect(confirmClose).toHaveBeenCalledWith('close-to-tray', [])

    const event = app.emit('before-quit') // tray Quit / Ctrl+Q while the X confirm is open
    expect(event.defaultPrevented).toBe(true)
    expect(confirmClose).toHaveBeenCalledTimes(1) // no second (quit) dispatch

    resolveConfirm?.('minimize')
    await expect(resolveCloseActionPromise).resolves.toBe('minimize')
    await flush()
  })
})
