import type { BrowserWindow, Event as ElectronEvent } from 'electron'

import type { DiagnosticOperation } from './diagnostics/operation'

// Startup orchestration for the UI process, kept as a dependency-injected unit (no runtime Electron
// imports) so
// the single-instance gate, the second-instance-during-startup handoff, and the ordering of the
// migration quit-guard relative to the lifecycle can be exercised together in a unit test — the real
// combination, not just each helper in isolation.

// A late-bound relay for OS 'second-instance' events. The lock's handler must be supplied at lock time,
// but the handler a second launch needs (surface the window, or start the web service for a --serve
// request) does not exist until the lifecycle is installed. The relay queues the forwarded argv of any
// request that arrives during that window and drains it, in order, once a target is bound.
export type SecondInstanceRelay = {
  // Wired into the single-instance lock as its onSecondInstance handler; carries the launch's argv so the
  // bound handler can tell a plain re-launch (surface the window) from a CLI --serve request.
  signal: (argv: string[]) => void
  // Bind the second-instance handler once it exists; immediately drains any requests queued during startup.
  bind: (handler: (argv: string[]) => void) => void
}

type SystemShutdownRelay = {
  signal: () => void
  bind: (handler: () => void) => void
  cancel: () => void
}

const STARTUP_SYSTEM_SHUTDOWN_TIMEOUT_MS = 5_000
const STARTUP_SHELL_TIMEOUT_MS = 15_000

type StartupWindowSurface = {
  focus: () => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
}

export const createStartupWindowSecondInstanceHandler =
  (window: StartupWindowSurface, forward: (argv: string[]) => void): ((argv: string[]) => void) =>
  (argv) => {
    if (!window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    forward(argv)
  }

export const createStartupWindowCloseOptions = (
  quit: () => void
): {
  classifyClose: () => 'close' | 'quit'
  requestQuit: () => void
  resolveCloseAction: () => Promise<'quit'>
} => {
  let quitRequested = false
  return {
    classifyClose: (): 'close' | 'quit' => (quitRequested ? 'close' : 'quit'),
    resolveCloseAction: async (): Promise<'quit'> => 'quit',
    requestQuit: (): void => {
      quitRequested = true
      quit()
    }
  }
}

export const createSecondInstanceRelay = (): SecondInstanceRelay => {
  const pending: string[][] = []
  let handler: ((argv: string[]) => void) | undefined

  return {
    signal: (argv) => {
      if (handler) handler(argv)
      else pending.push(argv)
    },
    bind: (next) => {
      handler = next
      while (pending.length > 0) handler(pending.shift() as string[])
    }
  }
}

const createSystemShutdownRelay = (
  forceExit?: () => void,
  timeoutMs = STARTUP_SYSTEM_SHUTDOWN_TIMEOUT_MS
): SystemShutdownRelay => {
  let pending = false
  let handler: (() => void) | undefined
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false

  const clearForceExitTimer = (): void => {
    if (!forceExitTimer) return
    clearTimeout(forceExitTimer)
    forceExitTimer = undefined
  }

  return {
    signal: () => {
      if (cancelled) return
      if (handler) handler()
      else {
        pending = true
        // Startup preparation can block indefinitely before the bounded lifecycle owner exists.
        // Preserve a short handoff window, then stop delaying the OS rather than hanging shutdown.
        if (forceExit && !forceExitTimer) forceExitTimer = setTimeout(forceExit, timeoutMs)
      }
    },
    bind: (next) => {
      if (cancelled) return
      handler = next
      clearForceExitTimer()
      if (!pending) return
      pending = false
      handler()
    },
    cancel: () => {
      cancelled = true
      pending = false
      handler = undefined
      clearForceExitTimer()
    }
  }
}

export type AppStartupDeps<Context> = {
  // Acquires the OS single-instance lock, wiring the relay's signal as the second-instance handler.
  // Returns false for a secondary launch (the caller must quit) and true for the primary.
  acquireSingleInstanceLock: (opts: { onSecondInstance: (argv: string[]) => void }) => boolean
  // Quits this launch when it is a secondary instance.
  quit: () => void
  // Last-resort startup exit used only when preparation never reaches the bounded lifecycle owner.
  forceExit?: () => void
  startupSystemShutdownTimeoutMs?: number
  // Installs signal/native shutdown sources immediately after the primary-instance lock. The supplied
  // callback queues a request until the lifecycle's bounded shutdown owner exists.
  installSystemShutdownListeners?: (requestSystemShutdown: () => void) => void
  // Heavy post-lock preparation (backend module imports, app.whenReady, logger, IPC registration). Runs
  // ONLY after the lock is held so a doomed secondary instance never imports the backend or spawns a
  // duplicate process tree. Returns the context the guard/lifecycle installers need.
  prepare: () => Promise<Context>
  // Installs the migration quit-guard. Must run before the lifecycle so its before-quit fires first: a
  // migration-cancelled quit leaves defaultPrevented set, which the lifecycle's quit cleanup honors.
  installMigrationQuitGuard: (context: Context) => void
  // Installs the tray/window/quit lifecycle; returns the second-instance handler for the relay to drain.
  // The handler decides per forwarded argv whether to surface the window or start the web service.
  installAppLifecycle: (context: Context) => {
    onSecondInstance: (argv: string[]) => void
    onSystemShutdown?: () => void
  }
  // Best-effort, bounded cleanup for failures after prepare() has transferred runtime ownership.
  // The callback owns cleanup diagnostics; a cleanup failure must not replace the startup error.
  cleanupAfterStartupFailure?: (context: Context, error: unknown) => Promise<void> | void
  // Publishes renderer readiness only after lifecycle installation and adapter wiring complete.
  markReady?: (context: Context) => void
  diagnostics?: DiagnosticOperation
}

export type VisibleStartupRuntimeDeps<Shell, Modules, Runtime> = {
  // Builds only what is required to show the renderer's database-startup shell. Keeping this seam
  // deliberately small lets the user see useful UI before the full backend module graph is loaded.
  prepareShell: () => Promise<Shell>
  // Database verification and backend loading are independent after the shell exists, so both start
  // immediately. Runtime composition remains ordered behind both prerequisites.
  verifyDatabase: (shell: Shell) => Promise<void>
  loadApplicationModules: (shell: Shell) => Promise<Modules>
  composeRuntime: (shell: Shell, modules: Modules) => Promise<Runtime>
  rollbackShell?: (shell: Shell, error: unknown) => Promise<void> | void
}

export const prepareVisibleStartupRuntime = async <Shell, Modules, Runtime>(
  deps: VisibleStartupRuntimeDeps<Shell, Modules, Runtime>
): Promise<Runtime> => {
  const shell = await deps.prepareShell()

  try {
    const databaseVerification = deps.verifyDatabase(shell)
    const applicationModules = deps.loadApplicationModules(shell)
    const [modules] = await Promise.all([applicationModules, databaseVerification])
    return await deps.composeRuntime(shell, modules)
  } catch (error) {
    await deps.rollbackShell?.(shell, error)
    throw error
  }
}

// Resolve the first-paint barrier on terminal renderer/window events as well as success. The backend
// and lifecycle must keep initializing even when Chromium cannot produce the first frame. Main-frame
// load failure discards the unusable window; windows.ts owns renderer-process crash recovery.
export const waitForStartupShell = (
  window: Pick<BrowserWindow, 'destroy' | 'once' | 'removeListener' | 'webContents'>,
  options: {
    diagnostics?: Pick<DiagnosticOperation, 'phase'>
    timeoutMs?: number
  } = {}
): Promise<void> =>
  new Promise((resolve) => {
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeout)
      window.removeListener('ready-to-show', settle)
      window.removeListener('closed', settle)
      window.webContents.removeListener('did-fail-load', onDidFailLoad)
      window.webContents.removeListener('render-process-gone', settle)
    }
    const settle = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onDidFailLoad = (
      _event: ElectronEvent,
      _errorCode: number,
      _errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) return
      // windows.ts logs document load failures but deliberately does not retry them. Discard this
      // unusable hidden window so the lifecycle creates a fresh main window after composition.
      window.destroy()
      settle()
    }

    window.once('ready-to-show', settle)
    window.once('closed', settle)
    window.webContents.on('did-fail-load', onDidFailLoad)
    window.webContents.once('render-process-gone', settle)
    const timeoutMs = options.timeoutMs ?? STARTUP_SHELL_TIMEOUT_MS
    const timeout = setTimeout(() => {
      options.diagnostics?.phase('startup-shell-timeout', { timeoutMs })
      window.destroy()
      settle()
    }, timeoutMs)
  })

// Runs the ordered startup sequence: gate on the single-instance lock (quitting a secondary launch
// before any backend work), prepare the backend, install the migration guard, then the lifecycle, and
// finally bind the second-instance relay to the window — draining any handoff that arrived mid-startup.
export const orchestrateAppStartup = async <Context>(
  deps: AppStartupDeps<Context>
): Promise<void> => {
  const relay = createSecondInstanceRelay()
  const systemShutdownRelay = createSystemShutdownRelay(
    deps.forceExit,
    deps.startupSystemShutdownTimeoutMs
  )
  let preparedContext: { value: Context } | undefined

  try {
    deps.diagnostics?.phase('single-instance-lock')
    if (!deps.acquireSingleInstanceLock({ onSecondInstance: relay.signal })) {
      deps.quit()
      deps.diagnostics?.complete({ instance: 'secondary' })
      return
    }

    deps.installSystemShutdownListeners?.(systemShutdownRelay.signal)
    deps.diagnostics?.phase('prepare-runtime')
    const context = await deps.prepare()
    preparedContext = { value: context }
    deps.diagnostics?.phase('install-lifecycle')
    deps.installMigrationQuitGuard(context)
    const { onSecondInstance, onSystemShutdown } = deps.installAppLifecycle(context)
    deps.markReady?.(context)
    if (onSystemShutdown) systemShutdownRelay.bind(onSystemShutdown)
    relay.bind(onSecondInstance)
    deps.diagnostics?.complete({ instance: 'primary' })
  } catch (error) {
    systemShutdownRelay.cancel()
    deps.diagnostics?.fail(error)
    if (preparedContext && deps.cleanupAfterStartupFailure) {
      try {
        await deps.cleanupAfterStartupFailure(preparedContext.value, error)
      } catch {
        // The original startup failure remains authoritative; cleanup owns its own diagnostics.
      }
    }
    throw error
  }
}
