import { afterEach, describe, expect, it, vi } from 'vitest'

import { installAppLifecycle, type AppLifecycleDeps, type TrayHandlers } from './app-lifecycle'
import {
  clearApplicationShutdownTrigger,
  currentApplicationShutdownTrigger,
  markApplicationShutdownTrigger
} from './application-shutdown-trigger'
import type { ActiveSessionInfo } from '../shared/storage'
import type { RendererSessionPersistenceFlushOutcome } from './session-persistence/renderer-flush'
import type { ShutdownStepOutcome } from './lifecycle-shutdown'
import type {
  CloseClassification,
  CloseConfirmChoice,
  CloseConfirmVariant,
  WindowFindAppearance
} from '../shared/window-controls'

type QuitEvent = { preventDefault: () => void; defaultPrevented: boolean }
type Handler = (event: QuitEvent) => void

const makeQuitEvent = (): QuitEvent => {
  const event: QuitEvent = {
    defaultPrevented: false,
    preventDefault(): void {
      event.defaultPrevented = true
    }
  }
  return event
}

afterEach(() => clearApplicationShutdownTrigger())

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
      const evt = makeQuitEvent()
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
  on: (event: string, handler: Handler) => void
  emit: (event: string) => QuitEvent
}

// A fake BrowserWindow tracking visibility/focus/destroyed state.
const makeFakeWindow = (): FakeWindow => {
  const handlers = new Map<string, Handler[]>()

  return {
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
      for (const handler of handlers.get('show') ?? []) handler(makeQuitEvent())
    },
    hide(): void {
      this.visible = false
      for (const handler of handlers.get('hide') ?? []) handler(makeQuitEvent())
    },
    focus(): void {
      this.focused = true
    },
    on(event, handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    emit(event): QuitEvent {
      const evt = makeQuitEvent()
      for (const handler of handlers.get(event) ?? []) handler(evt)
      return evt
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const asWindow = (w: FakeWindow): import('electron').BrowserWindow =>
  w as unknown as import('electron').BrowserWindow

type CapturedCloseOpts = {
  classifyClose: () => CloseClassification
  resolveCloseAction: () => Promise<CloseConfirmChoice>
  requestQuit: (confirmed?: boolean) => void
  onAppearanceChanged?: (appearance: WindowFindAppearance) => void
}

type Harness = {
  app: FakeApp
  windows: FakeWindow[]
  tray: { destroy: ReturnType<typeof vi.fn> } | undefined
  trayHandlers: TrayHandlers | undefined
  shutdownBackends: () => Promise<ShutdownStepOutcome | void>
  prepareForQuit: () => Promise<ShutdownStepOutcome | void>
  abortQuitPreparation: (
    reason: import('../shared/session-persistence-flush').SessionPersistenceFlushAbortReason
  ) => Promise<void> | void
  flushSessionPersistence: (
    timeoutMs?: number
  ) => Promise<RendererSessionPersistenceFlushOutcome | void>
  quit: ReturnType<typeof vi.fn>
  showMainWindow: () => void
  getMainWindow: () => import('electron').BrowserWindow | undefined
  isMainWindowHidden: () => boolean
  onSystemShutdown: () => void
  closeOpts: CapturedCloseOpts[]
  confirmClose: ReturnType<typeof vi.fn>
}

const setup = (
  overrides: Partial<
    Pick<
      AppLifecycleDeps,
      | 'shutdownBackends'
      | 'prepareForQuit'
      | 'abortQuitPreparation'
      | 'flushSessionPersistence'
      | 'log'
      | 'flushLogs'
      | 'logFlushTimeoutMs'
      | 'rendererFlushTimeoutMs'
      | 'shutdownTrigger'
      | 'isMigrationInProgress'
      | 'platform'
      | 'createInitialWindow'
      | 'onAppearanceChanged'
      | 'initialWindow'
      | 'configureMainWindow'
    >
  > & {
    holdSettingsInstallAdmission?: () => () => void
    trayHost?: boolean
    detectActiveSessions?: () => ActiveSessionInfo[]
    hasActiveReviewerWork?: () => boolean
    hasActiveSettingsWork?: () => boolean
    getActiveSettingsInstallId?: () => string | undefined
    confirmClose?: (
      variant: CloseConfirmVariant,
      sessions: ActiveSessionInfo[],
      unlistedWorkActive?: boolean
    ) => Promise<CloseConfirmChoice>
  } = {}
): Harness => {
  const app = makeFakeApp()
  const windows: FakeWindow[] = []
  const trayHost = overrides.trayHost ?? true
  const tray = trayHost ? { destroy: vi.fn() } : undefined
  let trayHandlers: TrayHandlers | undefined
  const shutdownBackends = overrides.shutdownBackends ?? vi.fn(async () => undefined)
  const prepareForQuit = overrides.prepareForQuit ?? vi.fn(async () => undefined)
  const abortQuitPreparation = overrides.abortQuitPreparation ?? vi.fn()
  const flushSessionPersistence =
    overrides.flushSessionPersistence ?? vi.fn(async () => 'completed' as const)
  const quit = vi.fn()
  const closeOpts: CapturedCloseOpts[] = []
  const confirmClose = vi.fn(
    overrides.confirmClose ?? ((): Promise<CloseConfirmChoice> => Promise.resolve('quit'))
  )
  const detectActiveSessions = overrides.detectActiveSessions ?? ((): ActiveSessionInfo[] => [])

  const { showMainWindow, getMainWindow, isMainWindowHidden, onSystemShutdown } =
    installAppLifecycle({
      app: app as unknown as AppLifecycleDeps['app'],
      createMainWindow: (opts) => {
        closeOpts.push(opts)
        const w = makeFakeWindow()
        windows.push(w)
        return asWindow(w)
      },
      initialWindow: overrides.initialWindow,
      configureMainWindow: overrides.configureMainWindow,
      createTray: (handlers) => {
        trayHandlers = handlers
        return tray as unknown as import('electron').Tray | undefined
      },
      shutdownBackends,
      prepareForQuit,
      holdSettingsInstallAdmission:
        overrides.holdSettingsInstallAdmission ?? (() => () => undefined),
      abortQuitPreparation,
      flushSessionPersistence,
      log: overrides.log,
      flushLogs: overrides.flushLogs,
      logFlushTimeoutMs: overrides.logFlushTimeoutMs,
      rendererFlushTimeoutMs: overrides.rendererFlushTimeoutMs,
      shutdownTrigger: overrides.shutdownTrigger,
      isMigrationInProgress: overrides.isMigrationInProgress ?? ((): boolean => false),
      quit,
      countWindows: () => windows.filter((w) => !w.destroyed).length,
      createInitialWindow: overrides.createInitialWindow,
      onAppearanceChanged: overrides.onAppearanceChanged,
      platform: overrides.platform ?? 'linux',
      detectActiveSessions,
      hasActiveReviewerWork: overrides.hasActiveReviewerWork ?? (() => false),
      getActiveSettingsInstallId:
        overrides.getActiveSettingsInstallId ??
        (() => (overrides.hasActiveSettingsWork?.() ? 'settings-install' : undefined)),
      createConfirmClose: () => confirmClose
    })
  return {
    app,
    windows,
    tray,
    trayHandlers,
    shutdownBackends,
    prepareForQuit,
    abortQuitPreparation,
    flushSessionPersistence,
    quit,
    showMainWindow,
    getMainWindow,
    isMainWindowHidden,
    onSystemShutdown,
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

  it('adopts and reconfigures an existing database-startup window', () => {
    const initialWindow = makeFakeWindow()
    const configureMainWindow = vi.fn()
    const { windows, getMainWindow } = setup({
      initialWindow: asWindow(initialWindow),
      configureMainWindow
    })

    expect(windows).toHaveLength(0)
    expect(getMainWindow()).toBe(asWindow(initialWindow))
    expect(configureMainWindow).toHaveBeenCalledOnce()
    expect(configureMainWindow).toHaveBeenCalledWith(initialWindow, expect.any(Object))
  })

  it('passes native appearance synchronization to every recreated main window', () => {
    const onAppearanceChanged = vi.fn()
    const { app, closeOpts, windows } = setup({ platform: 'darwin', onAppearanceChanged })

    expect(closeOpts[0].onAppearanceChanged).toBe(onAppearanceChanged)
    windows[0].destroyed = true
    app.emit('activate')
    expect(closeOpts[1].onAppearanceChanged).toBe(onAppearanceChanged)
  })

  it('starts headless and creates a window only when requested', () => {
    const { windows, trayHandlers } = setup({ createInitialWindow: false })
    expect(windows).toHaveLength(0)
    trayHandlers?.onShow()
    expect(windows).toHaveLength(1)
  })

  it('exposes the current main window without showing or focusing it', () => {
    const { app, windows, getMainWindow } = setup({ platform: 'darwin' })
    const original = windows[0]
    original.visible = false

    expect(getMainWindow()).toBe(original)
    expect(original.visible).toBe(false)
    expect(original.focused).toBe(false)

    original.destroyed = true
    app.emit('activate')

    expect(getMainWindow()).toBe(windows[1])
  })

  it('distinguishes a hidden-to-tray window from a minimized window', () => {
    const { windows, trayHandlers, isMainWindowHidden } = setup({ platform: 'win32' })
    windows[0].minimized = true

    expect(isMainWindowHidden()).toBe(false)

    trayHandlers?.onHide()
    expect(isMainWindowHidden()).toBe(true)

    trayHandlers?.onShow()
    expect(isMainWindowHidden()).toBe(false)
  })

  it('clears hidden state when restore makes the window visible without a show event', () => {
    const { windows, trayHandlers, isMainWindowHidden } = setup({ platform: 'win32' })
    const window = windows[0]
    window.minimized = true
    window.restore = (): void => {
      window.minimized = false
      window.visible = true
    }

    trayHandlers?.onHide()
    expect(isMainWindowHidden()).toBe(true)

    trayHandlers?.onShow()
    expect(isMainWindowHidden()).toBe(false)
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

  it('routes a system request through the existing shutdown owner', async () => {
    const { app, onSystemShutdown, shutdownBackends, flushSessionPersistence, quit, confirmClose } =
      setup()

    onSystemShutdown()
    expect(quit).toHaveBeenCalledTimes(1)

    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('does not block a system shutdown on active work or renderer persistence conflicts', async () => {
    const flushSessionPersistence = vi.fn(async () => 'conflict' as const)
    const { app, onSystemShutdown, shutdownBackends, confirmClose } = setup({
      detectActiveSessions: () => [
        { projectId: 'project-1', sessionId: 'session-1', kind: 'delegated' }
      ],
      flushSessionPersistence
    })

    onSystemShutdown()
    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('replays a system shutdown that arrives while an ordinary quit is aborting', async () => {
    let resolvePreflight: ((outcome: 'conflict') => void) | undefined
    const flushSessionPersistence = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<'conflict'>((resolve) => {
            resolvePreflight = resolve
          })
      )
      .mockResolvedValue('conflict' as const)
    const { app, closeOpts, onSystemShutdown, quit, confirmClose, shutdownBackends } = setup({
      flushSessionPersistence
    })

    closeOpts[0].requestQuit()
    app.emit('before-quit')
    expect(flushSessionPersistence).toHaveBeenCalledOnce()

    onSystemShutdown()
    resolvePreflight?.('conflict')
    await flush()

    expect(quit).toHaveBeenCalledTimes(2)
    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(shutdownBackends).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('defers to the migration guard when a migration is in progress', async () => {
    const { app, shutdownBackends } = setup({ isMigrationInProgress: (): boolean => true })

    app.emit('before-quit')
    await flush()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('preserves system shutdown intent until the migration guard reissues quit', async () => {
    let migrationInProgress = true
    const { app, onSystemShutdown, shutdownBackends, confirmClose } = setup({
      isMigrationInProgress: () => migrationInProgress
    })

    onSystemShutdown()
    app.emit('before-quit')
    expect(shutdownBackends).not.toHaveBeenCalled()

    migrationInProgress = false
    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(shutdownBackends).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
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
      prepareForQuit: async () => undefined,
      abortQuitPreparation: vi.fn(),
      flushSessionPersistence: async () => undefined,
      isMigrationInProgress: (): boolean => false,
      quit: vi.fn(),
      countWindows: (): number => 1,
      platform: 'linux',
      detectActiveSessions: (): ActiveSessionInfo[] => [],
      hasActiveReviewerWork: () => false,
      getActiveSettingsInstallId: () => undefined,
      holdSettingsInstallAdmission: () => () => undefined,
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
    await flush()
    expect(shutdownBackends).toHaveBeenCalledTimes(1)

    release?.()
    await flush()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('keeps the renderer alive when the window is closed again during quit cleanup', async () => {
    let release: (() => void) | undefined
    const prepareForQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const { app, closeOpts } = setup({
      platform: 'linux',
      trayHost: false,
      prepareForQuit
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')

    expect(closeOpts[0].classifyClose()).toBe('quit')

    release?.()
    await flush()
  })

  it('waits for ACP cancellation and Session persistence before backend teardown', async () => {
    const calls: string[] = []
    const { app, closeOpts } = setup({
      prepareForQuit: vi.fn(async () => {
        calls.push('prepare')
      }),
      flushSessionPersistence: vi.fn(async () => {
        calls.push('flush')
      }),
      shutdownBackends: vi.fn(async () => {
        calls.push('shutdown')
      })
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(calls).toEqual(['flush', 'prepare', 'flush', 'shutdown'])
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('continues degraded quit when the renderer disappears and drains terminal logs before exit', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const flushLogs = vi.fn(async () => undefined)
    const flushSessionPersistence = vi.fn(async () => 'renderer-gone' as const)
    const { app, closeOpts } = setup({
      log,
      flushLogs,
      flushSessionPersistence
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(log.info).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'application-shutdown',
        outcome: 'completed',
        degraded: true,
        usageDrainResult: 'completed',
        rendererFlushResult: 'degraded',
        backendTeardownResult: 'completed'
      })
    )
    expect(flushLogs).toHaveBeenCalledOnce()
    expect(flushSessionPersistence.mock.calls).toEqual([[2_500], [2_500]])
    expect(flushLogs.mock.invocationCallOrder[0]).toBeLessThan(app.exit.mock.invocationCallOrder[0])
  })

  it.each(['migration-relaunch', 'update'] as const)(
    'classifies a %s handoff without changing shutdown ordering',
    async (trigger) => {
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      markApplicationShutdownTrigger(trigger)
      const { app, confirmClose } = setup({
        log,
        detectActiveSessions: () => [
          { projectId: 'project-1', sessionId: 'session-1', kind: 'agent' }
        ]
      })

      app.emit('before-quit')
      await flush()

      expect(confirmClose).not.toHaveBeenCalled()
      expect(log.info).toHaveBeenCalledWith(
        'operation completed',
        expect.objectContaining({
          operation: 'application-shutdown',
          trigger,
          outcome: 'completed'
        })
      )
    }
  )

  it('does not cancel a committed data-root handoff when delegated work is still active', async () => {
    markApplicationShutdownTrigger('migration-relaunch')
    const { app, confirmClose, shutdownBackends } = setup({
      detectActiveSessions: () => [
        { projectId: 'project-1', sessionId: 'session-1', kind: 'delegated' }
      ]
    })

    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(shutdownBackends).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('does not cancel a committed update handoff when delegated work becomes active', async () => {
    markApplicationShutdownTrigger('update')
    const { app, confirmClose, shutdownBackends } = setup({
      detectActiveSessions: () => [
        { projectId: 'project-1', sessionId: 'session-1', kind: 'delegated' }
      ]
    })

    app.emit('before-quit')
    await flush()

    expect(confirmClose).not.toHaveBeenCalled()
    expect(shutdownBackends).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it.each(['conflict', 'renderer-failed'] as const)(
    'does not cancel a committed data-root handoff when renderer persistence returns %s',
    async (outcome) => {
      markApplicationShutdownTrigger('migration-relaunch')
      const flushSessionPersistence = vi.fn(async () => outcome)
      const { app, abortQuitPreparation, shutdownBackends } = setup({
        flushSessionPersistence
      })

      app.emit('before-quit')
      await flush()

      expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
      expect(abortQuitPreparation).not.toHaveBeenCalled()
      expect(shutdownBackends).toHaveBeenCalledOnce()
      expect(app.exit).toHaveBeenCalledWith(0)
    }
  )

  it('completes an update handoff after quitAndInstall has already closed the renderer', async () => {
    markApplicationShutdownTrigger('update')
    const flushSessionPersistence = vi.fn(async () => 'send-failed' as const)
    const { app, abortQuitPreparation } = setup({ flushSessionPersistence })

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(abortQuitPreparation).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('records fixed outcomes for every shutdown step and never reports a degraded shutdown as clean', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { app, closeOpts } = setup({
      log,
      prepareForQuit: vi.fn(async () => 'timeout' as const),
      flushSessionPersistence: vi
        .fn()
        .mockResolvedValueOnce('completed' as const)
        .mockResolvedValueOnce('renderer-gone' as const),
      shutdownBackends: vi.fn(async () => 'degraded' as const)
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(log.info).toHaveBeenCalledWith(
      'operation phase',
      expect.objectContaining({ phase: 'usage-drain', result: 'timeout' })
    )
    expect(log.info).toHaveBeenCalledWith(
      'operation phase',
      expect.objectContaining({ phase: 'renderer-session-flush', result: 'degraded' })
    )
    expect(log.info).toHaveBeenCalledWith(
      'operation phase',
      expect.objectContaining({ phase: 'backend-teardown', result: 'degraded' })
    )
    expect(log.info).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'application-shutdown',
        degraded: true,
        usageDrainResult: 'timeout',
        rendererFlushResult: 'degraded',
        backendTeardownResult: 'degraded'
      })
    )
  })

  it.each(['completed', 'conflict'] as const)(
    'holds installation admission during quit preparation and handles %s persistence',
    async (outcome) => {
      let held = false
      const release = vi.fn(() => {
        held = false
      })
      const hold = vi.fn(() => {
        held = true
        return release
      })
      const persistence = Promise.withResolvers<RendererSessionPersistenceFlushOutcome>()
      const { app, closeOpts } = setup({
        holdSettingsInstallAdmission: hold,
        flushSessionPersistence: () => persistence.promise,
        // A failed rollback must still restore Settings admission.
        abortQuitPreparation: async () => {
          throw new Error('rollback failed')
        }
      })
      closeOpts[0].requestQuit()
      app.emit('before-quit')
      const admissionClosedBeforePersistence = held
      app.emit('before-quit')
      persistence.resolve(outcome)
      await flush()

      expect(admissionClosedBeforePersistence).toBe(true)
      expect(hold).toHaveBeenCalledOnce()
      if (outcome === 'conflict') {
        expect(release).toHaveBeenCalledOnce()
        expect(held).toBe(false)
        expect(app.exit).not.toHaveBeenCalled()
      } else {
        expect(release).not.toHaveBeenCalled()
        expect(held).toBe(true)
        expect(app.exit).toHaveBeenCalledWith(0)
      }
    }
  )

  it('keeps the app open when the renderer reports an unresolved Session revision conflict', async () => {
    const flushSessionPersistence = vi.fn(async () => 'conflict' as const)
    const {
      app,
      closeOpts,
      prepareForQuit,
      abortQuitPreparation,
      shutdownBackends,
      tray,
      windows
    } = setup({
      flushSessionPersistence
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledOnce()
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(abortQuitPreparation).toHaveBeenCalledWith('conflict')
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(tray?.destroy).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
    expect(windows[0].visible).toBe(true)
    expect(windows[0].focused).toBe(true)
  })

  it('keeps the app open when the renderer persistence preflight reports a failed flush', async () => {
    const flushSessionPersistence = vi.fn(async () => 'renderer-failed' as const)
    const {
      app,
      closeOpts,
      prepareForQuit,
      abortQuitPreparation,
      shutdownBackends,
      tray,
      windows
    } = setup({ flushSessionPersistence })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledOnce()
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(abortQuitPreparation).toHaveBeenCalledWith('renderer-failed')
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(tray?.destroy).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
    expect(windows[0].visible).toBe(true)
    expect(windows[0].focused).toBe(true)
  })

  it.each(['send-failed', 'timeout'] as const)(
    'aborts ordinary quit and asks for consent when the renderer persistence preflight returns %s',
    async (outcome) => {
      const flushSessionPersistence = vi.fn(async () => outcome)
      const confirmClose = vi.fn(async () => 'cancel' as const)
      const { app, closeOpts, prepareForQuit, abortQuitPreparation, shutdownBackends, windows } =
        setup({ flushSessionPersistence, confirmClose })
      closeOpts[0].requestQuit()

      app.emit('before-quit')
      await flush()

      expect(flushSessionPersistence).toHaveBeenCalledOnce()
      expect(prepareForQuit).not.toHaveBeenCalled()
      expect(abortQuitPreparation).toHaveBeenCalledOnce()
      expect(confirmClose).toHaveBeenCalledWith('persistence-failed', [])
      expect(shutdownBackends).not.toHaveBeenCalled()
      expect(app.exit).not.toHaveBeenCalled()
      expect(windows[0].visible).toBe(true)
      expect(windows[0].focused).toBe(true)
    }
  )

  it('retries an ordinary quit after the user chooses to retry saving', async () => {
    const confirmClose = vi.fn(async () => 'retry' as never)
    const { app, closeOpts, quit } = setup({
      flushSessionPersistence: vi.fn(async () => 'timeout' as const),
      confirmClose
    })
    closeOpts[0].requestQuit()
    expect(quit).toHaveBeenCalledOnce()

    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('persistence-failed', [])
    expect(quit).toHaveBeenCalledTimes(2)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('uses the current degraded shutdown only after the user explicitly chooses force quit', async () => {
    const flushSessionPersistence = vi.fn(async () => 'timeout' as const)
    const confirmClose = vi.fn(async () => 'force-quit' as never)
    const { app, closeOpts, quit, prepareForQuit, abortQuitPreparation, shutdownBackends } = setup({
      flushSessionPersistence,
      confirmClose
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(quit).toHaveBeenCalledTimes(2)
    expect(app.exit).not.toHaveBeenCalled()

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledTimes(3)
    expect(prepareForQuit).toHaveBeenCalledOnce()
    expect(abortQuitPreparation).toHaveBeenCalledOnce()
    expect(shutdownBackends).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('requires persistence consent again after delegated work interrupts a force-quit attempt', async () => {
    let active: ActiveSessionInfo[] = []
    const flushSessionPersistence = vi.fn(async () => 'timeout' as const)
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> =>
      confirmClose.mock.calls.length === 1 ? 'force-quit' : 'cancel'
    )
    const { app, closeOpts, prepareForQuit, shutdownBackends } = setup({
      detectActiveSessions: () => active,
      flushSessionPersistence,
      confirmClose
    })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()
    expect(confirmClose).toHaveBeenCalledWith('persistence-failed', [])

    active = [{ projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }]
    app.emit('before-quit')
    await flush()
    expect(confirmClose).toHaveBeenLastCalledWith('quit', active)

    active = []
    closeOpts[0].requestQuit()
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenLastCalledWith('persistence-failed', [])
    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('keeps the app open when the terminal renderer flush conflicts', async () => {
    const flushSessionPersistence = vi
      .fn()
      .mockResolvedValueOnce('completed' as const)
      .mockResolvedValueOnce('conflict' as const)
    const {
      app,
      closeOpts,
      prepareForQuit,
      abortQuitPreparation,
      shutdownBackends,
      tray,
      windows
    } = setup({ flushSessionPersistence })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(prepareForQuit).toHaveBeenCalledOnce()
    expect(abortQuitPreparation).toHaveBeenCalledWith('conflict')
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(tray?.destroy).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
    expect(windows[0].visible).toBe(true)
    expect(windows[0].focused).toBe(true)
  })

  it('keeps the app open when the terminal renderer flush reports a failed write', async () => {
    const flushSessionPersistence = vi
      .fn()
      .mockResolvedValueOnce('completed' as const)
      .mockResolvedValueOnce('renderer-failed' as const)
    const {
      app,
      closeOpts,
      prepareForQuit,
      abortQuitPreparation,
      shutdownBackends,
      tray,
      windows
    } = setup({ flushSessionPersistence })
    closeOpts[0].requestQuit()

    app.emit('before-quit')
    await flush()

    expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
    expect(prepareForQuit).toHaveBeenCalledOnce()
    expect(abortQuitPreparation).toHaveBeenCalledWith('renderer-failed')
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(tray?.destroy).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
    expect(windows[0].visible).toBe(true)
    expect(windows[0].focused).toBe(true)
  })

  it.each(['send-failed', 'timeout'] as const)(
    'aborts ordinary quit and asks for consent when the terminal renderer flush returns %s',
    async (outcome) => {
      const flushSessionPersistence = vi
        .fn()
        .mockResolvedValueOnce('completed' as const)
        .mockResolvedValueOnce(outcome)
      const confirmClose = vi.fn(async () => 'cancel' as const)
      const { app, closeOpts, prepareForQuit, abortQuitPreparation, shutdownBackends, windows } =
        setup({ flushSessionPersistence, confirmClose })
      closeOpts[0].requestQuit()

      app.emit('before-quit')
      await flush()

      expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
      expect(prepareForQuit).toHaveBeenCalledOnce()
      expect(abortQuitPreparation).toHaveBeenCalledOnce()
      expect(confirmClose).toHaveBeenCalledWith('persistence-failed', [])
      expect(shutdownBackends).not.toHaveBeenCalled()
      expect(app.exit).not.toHaveBeenCalled()
      expect(windows[0].visible).toBe(true)
      expect(windows[0].focused).toBe(true)
    }
  )

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

  it('classifyClose returns "quit" when no tray so the renderer survives through flush', () => {
    const captured = installWithCapturedOpts({ platform: 'win32', hasTray: false })
    expect(captured.classifyClose()).toBe('quit')
  })

  it('resolveCloseAction resolves via confirmClose("close-to-tray", sessions)', async () => {
    const sessions: ActiveSessionInfo[] = [{ projectId: 'demo', sessionId: 's1', kind: 'agent' }]
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

  it('keeps a no-tray close unconfirmed so active work still prompts before quit', async () => {
    const sessions: ActiveSessionInfo[] = [{ projectId: 'demo', sessionId: 's1', kind: 'agent' }]
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'cancel')
    const { app, closeOpts } = setup({
      trayHost: false,
      detectActiveSessions: () => sessions,
      confirmClose
    })

    closeOpts[0].requestQuit(false)
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', sessions)
  })

  it('rechecks an active Settings install after a pre-confirmed window close', async () => {
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'cancel')
    const { app, closeOpts, shutdownBackends } = setup({
      hasActiveSettingsWork: () => true,
      confirmClose
    })

    closeOpts[0].requestQuit()
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', [], true)
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('rechecks a Settings install admitted after an empty-work quit fast path', async () => {
    let settingsWorkActive = false
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => {
      if (confirmClose.mock.calls.length === 1) {
        settingsWorkActive = true
        return 'quit'
      }
      return 'cancel'
    })
    const { app, quit, shutdownBackends } = setup({
      hasActiveSettingsWork: () => settingsWorkActive,
      confirmClose
    })

    app.emit('before-quit')
    await flush()
    expect(quit).toHaveBeenCalledOnce()

    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenLastCalledWith('quit', [], true)
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('requires confirmation when the active Settings install changes before reissued quit', async () => {
    let activeInstallId = 'install-1'
    const confirmClose = vi
      .fn<() => Promise<CloseConfirmChoice>>()
      .mockResolvedValueOnce('quit')
      .mockResolvedValueOnce('cancel')
    const { app, quit, shutdownBackends } = setup({
      getActiveSettingsInstallId: () => activeInstallId,
      confirmClose
    })

    app.emit('before-quit')
    await flush()
    expect(quit).toHaveBeenCalledOnce()

    activeInstallId = 'install-2'
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
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

  it('warns before ordinary quit when only Reviewer work is active', async () => {
    const confirmClose = vi.fn(
      (
        _variant: CloseConfirmVariant,
        sessions: ActiveSessionInfo[],
        reviewerActive = false
      ): Promise<CloseConfirmChoice> =>
        Promise.resolve(sessions.length === 0 && !reviewerActive ? 'quit' : 'cancel')
    )
    const { app, quit, shutdownBackends } = setup({
      hasActiveReviewerWork: () => true,
      confirmClose
    })

    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', [], true)
    expect(quit).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('warns before ordinary quit when only a Settings install is active', async () => {
    const confirmClose = vi.fn(
      (
        _variant: CloseConfirmVariant,
        sessions: ActiveSessionInfo[],
        unlistedWorkActive = false
      ): Promise<CloseConfirmChoice> =>
        Promise.resolve(sessions.length === 0 && !unlistedWorkActive ? 'quit' : 'cancel')
    )
    const { app, quit, shutdownBackends } = setup({
      hasActiveSettingsWork: () => true,
      confirmClose
    })

    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', [], true)
    expect(quit).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('before-quit with delegated work + blocked choice keeps the app alive without interruption', async () => {
    const sessions: ActiveSessionInfo[] = [
      { projectId: 'demo', sessionId: 's1', kind: 'delegated' }
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

  const cancelSessions: ActiveSessionInfo[] = [
    { projectId: 'demo', sessionId: 's1', kind: 'agent' }
  ]

  it.each(['win32', 'linux'] as const)(
    'recreates the destroyed window on cancel when there is no tray (%s)',
    async (platform) => {
      // No-tray orphan guard: X destroyed the window, window-all-closed issued the quit, the user
      // cancelled — without recreating, the kept app would have no tray and no window (no UI).
      const { app, windows } = setup({
        platform,
        trayHost: false,
        detectActiveSessions: () => cancelSessions,
        confirmClose: async (): Promise<CloseConfirmChoice> => 'cancel'
      })
      expect(windows).toHaveLength(1)
      windows[0].destroyed = true // X destroyed it before the window-all-closed quit

      app.emit('before-quit')
      await flush()

      expect(windows).toHaveLength(2)
      expect(windows[1].destroyed).toBe(false)
    }
  )

  it('does not fabricate a window on cancel in headless mode (window never existed)', async () => {
    // Regression: headless web mode runs with createInitialWindow:false and no tray; the orphan guard
    // must key off a destroyed *existing* window, not platform+tray, or it would conjure a window here.
    const { app, windows } = setup({
      platform: 'win32',
      trayHost: false,
      createInitialWindow: false,
      detectActiveSessions: () => cancelSessions,
      confirmClose: async (): Promise<CloseConfirmChoice> => 'cancel'
    })
    expect(windows).toHaveLength(0)

    app.emit('before-quit')
    await flush()

    expect(windows).toHaveLength(0)
  })

  it('does not recreate the window on cancel when a tray is present', async () => {
    const { app, windows } = setup({
      platform: 'win32',
      trayHost: true,
      detectActiveSessions: () => cancelSessions,
      confirmClose: async (): Promise<CloseConfirmChoice> => 'cancel'
    })
    windows[0].destroyed = true

    app.emit('before-quit')
    await flush()

    expect(windows).toHaveLength(1) // no new window created
  })

  it('does not recreate the window on cancel on macOS (resident is its convention)', async () => {
    const { app, windows } = setup({
      platform: 'darwin',
      trayHost: false,
      detectActiveSessions: () => cancelSessions,
      confirmClose: async (): Promise<CloseConfirmChoice> => 'cancel'
    })
    windows[0].destroyed = true

    app.emit('before-quit')
    await flush()

    expect(windows).toHaveLength(1)
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

  it('clears an update shutdown trigger when migration aborts the quit', async () => {
    markApplicationShutdownTrigger('update')
    const { app, shutdownBackends } = setup({
      isMigrationInProgress: (): boolean => true
    })

    app.emit('before-quit')
    await flush()

    expect(currentApplicationShutdownTrigger()).toBe('quit')
    expect(shutdownBackends).not.toHaveBeenCalled()
  })

  it('re-confirms a later Windows X after a confirmed quit was aborted by migration', async () => {
    // A confirmed quit (Windows X -> Quit sets quitConfirmed) that the migration guard then aborts must
    // not leave quitConfirmed latched — otherwise classifyClose would return 'close' and the next X
    // would destroy the window without asking. The abort resets it so the next X re-confirms.
    let migrating = false
    const { app, closeOpts } = setup({
      platform: 'win32',
      trayHost: true,
      isMigrationInProgress: (): boolean => migrating
    })
    const opts = closeOpts[0]

    opts.requestQuit() // quitConfirmed = true
    migrating = true
    app.emit('before-quit') // aborted by migration -> resets quitConfirmed
    migrating = false

    expect(opts.classifyClose()).toBe('confirm')
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

  it('rechecks after an ordinary quit confirmation and blocks a child that started meanwhile', async () => {
    let active: ActiveSessionInfo[] = []
    let resolveFirst: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn((variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => {
      if (confirmClose.mock.calls.length === 1) {
        return new Promise<CloseConfirmChoice>((resolve) => {
          resolveFirst = resolve
        })
      }
      expect(variant).toBe('quit')
      expect(sessions).toEqual(active)
      return Promise.resolve('cancel' as const)
    })
    const { app, quit, prepareForQuit, flushSessionPersistence, shutdownBackends } = setup({
      detectActiveSessions: () => active,
      confirmClose
    })

    app.emit('before-quit')
    active = [{ projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }]
    resolveFirst?.('quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(quit).not.toHaveBeenCalled()
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(flushSessionPersistence).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('reissues quit when delegated and Settings work are confirmed', async () => {
    let active: ActiveSessionInfo[] = []
    let resolveFirst: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn(() => {
      if (confirmClose.mock.calls.length === 1) {
        return new Promise<CloseConfirmChoice>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve('quit' as const)
    })
    const { app, quit, shutdownBackends } = setup({
      detectActiveSessions: () => active,
      hasActiveSettingsWork: () => true,
      confirmClose
    })

    app.emit('before-quit')
    active = [{ projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }]
    resolveFirst?.('quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(quit).toHaveBeenCalledTimes(1)

    app.emit('before-quit')
    await flush()
    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('rechecks delegated work added after the delegated confirmation', async () => {
    let active: ActiveSessionInfo[] = []
    let resolveFirst: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn(() => {
      if (confirmClose.mock.calls.length === 1) {
        return new Promise<CloseConfirmChoice>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve<CloseConfirmChoice>(
        confirmClose.mock.calls.length === 2 ? 'quit' : 'cancel'
      )
    })
    const { app, quit, prepareForQuit, flushSessionPersistence, shutdownBackends } = setup({
      detectActiveSessions: () => active,
      confirmClose
    })

    app.emit('before-quit')
    active = [{ projectId: 'demo', sessionId: 'child-1', kind: 'delegated' }]
    resolveFirst?.('quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(quit).toHaveBeenCalledTimes(1)

    active = [...active, { projectId: 'demo', sessionId: 'child-2', kind: 'delegated' }]
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledTimes(3)
    expect(confirmClose).toHaveBeenLastCalledWith('quit', active)
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(flushSessionPersistence).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('rechecks after a saved close preference resolves and safely minimizes for new delegated work', async () => {
    let active: ActiveSessionInfo[] = []
    let resolveSavedPreference: ((choice: CloseConfirmChoice) => void) | undefined
    const confirmClose = vi.fn((variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => {
      if (confirmClose.mock.calls.length === 1) {
        return new Promise<CloseConfirmChoice>((resolve) => {
          resolveSavedPreference = resolve
        })
      }
      expect(variant).toBe('close-to-tray')
      expect(sessions).toEqual(active)
      return Promise.resolve('minimize' as const)
    })
    const { closeOpts, quit, prepareForQuit, flushSessionPersistence, shutdownBackends } = setup({
      detectActiveSessions: () => active,
      confirmClose
    })

    const pending = closeOpts[0].resolveCloseAction()
    active = [{ projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }]
    resolveSavedPreference?.('quit')

    await expect(pending).resolves.toBe('minimize')
    expect(confirmClose).toHaveBeenCalledTimes(2)
    expect(quit).not.toHaveBeenCalled()
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(flushSessionPersistence).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
  })

  it('blocks a confirmed Windows titlebar request at the final shutdown boundary', async () => {
    const delegated: ActiveSessionInfo[] = [
      { projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }
    ]
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'cancel')
    const { app, closeOpts, quit, prepareForQuit, flushSessionPersistence, shutdownBackends } =
      setup({
        platform: 'win32',
        detectActiveSessions: () => delegated,
        confirmClose
      })

    closeOpts[0].requestQuit(true)
    expect(quit).toHaveBeenCalledOnce()
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', delegated)
    expect(prepareForQuit).not.toHaveBeenCalled()
    expect(flushSessionPersistence).not.toHaveBeenCalled()
    expect(shutdownBackends).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('reissues a confirmed Windows titlebar quit after delegated and Settings work are confirmed', async () => {
    const delegated: ActiveSessionInfo[] = [
      { projectId: 'demo', sessionId: 'child-live', kind: 'delegated' }
    ]
    const confirmClose = vi.fn(async (): Promise<CloseConfirmChoice> => 'quit')
    const { app, closeOpts, quit, shutdownBackends } = setup({
      platform: 'win32',
      detectActiveSessions: () => delegated,
      hasActiveSettingsWork: () => true,
      confirmClose
    })

    closeOpts[0].requestQuit(true)
    app.emit('before-quit')
    await flush()

    expect(confirmClose).toHaveBeenCalledWith('quit', delegated, true)
    expect(quit).toHaveBeenCalledTimes(2)

    app.emit('before-quit')
    await flush()
    expect(confirmClose).toHaveBeenCalledTimes(1)
    expect(shutdownBackends).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('a titlebar X close-to-tray does not dispatch a second confirm while a quit-confirm is open', async () => {
    // Cross-flow guard: tray/Ctrl+Q quit-confirm is already open (before-quit -> confirmClose('quit', ...)
    // pending) when the user clicks the titlebar X. Without the shared confirmInFlight guard this would
    // fire a second confirmClose('close-to-tray', ...) that overwrites the renderer's single request slot,
    // stranding the quit-confirm promise and permanently pinning confirmInFlight.
    let resolveConfirm: ((choice: CloseConfirmChoice) => void) | undefined
    const sessions: ActiveSessionInfo[] = [{ projectId: 'demo', sessionId: 's1', kind: 'agent' }]
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
