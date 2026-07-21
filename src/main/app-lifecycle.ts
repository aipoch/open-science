import type { App, BrowserWindow, Tray } from 'electron'

import type { ActiveSessionInfo } from '../shared/storage'
import type {
  CloseClassification,
  CloseConfirmChoice,
  CloseConfirmVariant
} from '../shared/window-controls'

// Menu action callbacks the tray is wired to.
export type TrayHandlers = { onShow: () => void; onHide: () => void; onQuit: () => void }

// Wires the window/tray/quit lifecycle for the UI process. Kept as a dependency-injected unit (no direct
// electron imports beyond types) so the event ordering, migration-guard interaction, tray-quit cleanup,
// and window recreation are unit-testable without a real Electron runtime.
export type AppLifecycleDeps = {
  // Only the event/exit surface is used; injectable so tests can drive the handlers directly.
  app: Pick<App, 'on' | 'exit'>
  // Creates the main window; the lifecycle supplies the close classification + confirm callbacks.
  createMainWindow: (opts: {
    classifyClose: () => CloseClassification
    resolveCloseAction: () => Promise<CloseConfirmChoice>
    requestQuit: () => void
  }) => BrowserWindow
  // Builds the tray; returns undefined on hosts without a tray (e.g. some Linux desktops).
  createTray: (handlers: TrayHandlers) => Tray | undefined
  // Bounded, best-effort backend teardown (agent tree + notebook kernels); never throws.
  shutdownBackends: () => Promise<void>
  // True while a data-root migration is copying; a quit during it is owned by the migration guard.
  isMigrationInProgress: () => boolean
  // Requests an app quit (app.quit); the before-quit handler below turns it into an awaited teardown.
  quit: () => void
  // Number of live BrowserWindows, used to decide whether to recreate on macOS activate.
  countWindows: () => number
  // Headless web mode starts the backend and tray without opening a renderer window.
  createInitialWindow?: boolean
  // Overridable for tests; defaults to the host platform.
  platform?: NodeJS.Platform
  // Snapshot of sessions with running work (in-flight agent prompt or a notebook cell mid-execution),
  // used to populate the confirmation list and to skip the quit dialog when nothing is running.
  detectActiveSessions: () => ActiveSessionInfo[]
  // Builds the close-confirm coordinator bound to the current main window (recreated on demand).
  createConfirmClose: (
    getWindow: () => BrowserWindow | undefined
  ) => (variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => Promise<CloseConfirmChoice>
}

// Installs the tray, the first window, and the quit/activate/window-all-closed handlers. Returns
// showMainWindow so the single-instance second-instance hook can surface the window (creating one when
// none exists — e.g. macOS after the last window was closed but the app stayed resident).
export const installAppLifecycle = (deps: AppLifecycleDeps): { showMainWindow: () => void } => {
  const platform = deps.platform ?? process.platform

  let mainWindow: BrowserWindow | undefined
  // Held in a box (not a plain `let`) so the close classification defined below can read it before
  // it is assigned — the tray, window, and predicate reference each other cyclically.
  const trayBox: { current: Tray | undefined } = { current: undefined }
  // Latches make the async quit cleanup idempotent: once started, further quits are held until exit.
  let shutdownStarted = false
  let shutdownFinished = false
  // Set once the user has confirmed a quit (via the dialog or a prior 'confirm' close), so a re-issued
  // before-quit skips straight to teardown instead of asking again.
  let quitConfirmed = false
  // Shared across both confirm-dispatching paths (titlebar X and tray/Ctrl+Q quit) so only one
  // confirmation modal is ever open at a time. The renderer holds a single request slot; a second
  // dispatch would silently overwrite the first and strand its promise forever (see app-lifecycle.test.ts).
  let confirmInFlight = false

  const confirmClose = deps.createConfirmClose(() => mainWindow)

  // Synchronous close classification, evaluated at close time. darwin keeps its dock convention (real
  // close); a mid-quit or no-tray close proceeds; Windows asks (confirm); Linux keeps silent hide-to-tray.
  const classifyClose = (): CloseClassification => {
    if (platform === 'darwin') return 'close'
    if (!trayBox.current || shutdownStarted || quitConfirmed) return 'close'
    if (platform === 'win32') return 'confirm'
    return 'hide'
  }

  // Only one confirmation modal at a time: if a quit-confirm (or another close-confirm) is already
  // open, do nothing for this X press so the in-flight decision stays authoritative.
  const resolveCloseAction = async (): Promise<CloseConfirmChoice> => {
    if (confirmInFlight) return 'cancel'
    confirmInFlight = true
    try {
      return await confirmClose('close-to-tray', deps.detectActiveSessions())
    } finally {
      confirmInFlight = false
    }
  }

  const openWindow = (): BrowserWindow =>
    deps.createMainWindow({
      classifyClose,
      resolveCloseAction,
      requestQuit: () => {
        quitConfirmed = true
        deps.quit()
      }
    })

  // Surfaces the main window, creating a fresh one when none exists or the last was closed (macOS keeps
  // the app alive with no window; the tray Show item and a second launch must be able to bring it back).
  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = openWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }

  const hideMainWindow = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  }

  trayBox.current = deps.createTray({
    onShow: showMainWindow,
    onHide: hideMainWindow,
    onQuit: () => deps.quit()
  })

  // Authoritative quit cleanup: stop the agent process tree (awaited, so Windows taskkill /T finishes)
  // and every notebook kernel before exiting. app.on (not once) plus latches: a re-issued quit while
  // cleanup runs is held until app.exit(0), which itself skips before-quit/will-quit. Gated on the
  // migration guard (registered earlier) via defaultPrevented + isMigrationInProgress so a
  // migration-cancelled quit is respected. #177's will-quit guard remains a synchronous backstop for a
  // committed quit that never reaches this path.
  deps.app.on('before-quit', (event) => {
    if (shutdownFinished) return
    if (shutdownStarted) {
      // Cleanup already running; hold the quit until it calls app.exit(0).
      event.preventDefault()
      return
    }
    if (event.defaultPrevented || deps.isMigrationInProgress()) {
      // This quit is being aborted (e.g. the migration guard cancelled it). Clear any prior
      // confirmation so it doesn't leak into a later close: otherwise classifyClose would return
      // 'close' and the next Windows X would bypass the dialog and destroy the window.
      quitConfirmed = false
      return
    }

    // Confirmation gate: unless the user already confirmed (e.g. Windows X -> Quit), confirm the
    // quit. An empty active-session list makes confirmClose('quit', []) resolve 'quit' with no modal.
    if (!quitConfirmed) {
      event.preventDefault()
      if (confirmInFlight) return
      confirmInFlight = true
      void confirmClose('quit', deps.detectActiveSessions())
        .then((choice) => {
          if (choice === 'quit') {
            quitConfirmed = true
            deps.quit()
          }
        })
        .finally(() => {
          confirmInFlight = false
        })
      return
    }

    event.preventDefault()
    shutdownStarted = true
    void (async () => {
      try {
        await deps.shutdownBackends()
      } finally {
        trayBox.current?.destroy()
        shutdownFinished = true
        deps.app.exit(0)
      }
    })()
  })

  // macOS: recreate a window when the dock icon is clicked with no windows open.
  deps.app.on('activate', () => {
    if (deps.countWindows() === 0) mainWindow = openWindow()
  })

  // With a tray the app stays resident (windows only hide), so window-all-closed shouldn't quit. Without
  // a tray, keep the platform convention: quit on Windows/Linux, stay alive on macOS (dock + menu bar).
  deps.app.on('window-all-closed', () => {
    if (platform !== 'darwin' && !trayBox.current) deps.quit()
  })

  if (deps.createInitialWindow !== false) mainWindow = openWindow()

  return { showMainWindow }
}
