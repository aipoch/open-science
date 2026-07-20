import type { App, BrowserWindow, Tray } from 'electron'

// Menu action callbacks the tray is wired to.
export type TrayHandlers = { onShow: () => void; onHide: () => void; onQuit: () => void }

// Wires the window/tray/quit lifecycle for the UI process. Kept as a dependency-injected unit (no direct
// electron imports beyond types) so the event ordering, migration-guard interaction, tray-quit cleanup,
// and window recreation are unit-testable without a real Electron runtime.
export type AppLifecycleDeps = {
  // Only the event/exit surface is used; injectable so tests can drive the handlers directly.
  app: Pick<App, 'on' | 'exit'>
  // Creates the main window; the lifecycle supplies the close-to-tray predicate it should honor.
  createMainWindow: (opts: { shouldHideOnClose: () => boolean }) => BrowserWindow
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
}

// Installs the tray, the first window, and the quit/activate/window-all-closed handlers. Returns
// showMainWindow so the single-instance second-instance hook can surface the window (creating one when
// none exists — e.g. macOS after the last window was closed but the app stayed resident).
export const installAppLifecycle = (deps: AppLifecycleDeps): { showMainWindow: () => void } => {
  const platform = deps.platform ?? process.platform

  let mainWindow: BrowserWindow | undefined
  // Held in a box (not a plain `let`) so the close-to-tray predicate defined below can read it before
  // it is assigned — the tray, window, and predicate reference each other cyclically.
  const trayBox: { current: Tray | undefined } = { current: undefined }
  // Latches make the async quit cleanup idempotent: once started, further quits are held until exit.
  let shutdownStarted = false
  let shutdownFinished = false

  // Close-to-tray predicate, evaluated at close time: hide (stay resident) on Windows/Linux while the
  // tray is active, unless a quit is already underway. macOS keeps its dock convention (real close).
  const shouldHideOnClose = (): boolean =>
    platform !== 'darwin' && Boolean(trayBox.current) && !shutdownStarted

  const openWindow = (): BrowserWindow => deps.createMainWindow({ shouldHideOnClose })

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
    if (event.defaultPrevented || deps.isMigrationInProgress()) return

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
