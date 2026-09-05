import type { App, BrowserWindow, Tray } from 'electron'

import type { ActiveSessionInfo } from '../shared/storage'
import type { SessionPersistenceFlushAbortReason } from '../shared/session-persistence-flush'
import {
  rendererSessionPersistenceFlushBlocksShutdown,
  type RendererSessionPersistenceFlushOutcome
} from './session-persistence/renderer-flush'
import type { ShutdownStepOutcome } from './lifecycle-shutdown'
import { flushDiagnosticsWithTimeout } from './diagnostics/flush'
import { diagnosticErrorFields, type Logger } from './logger'
import { startDiagnosticOperation } from './diagnostics/operation'
import {
  clearApplicationShutdownTrigger,
  currentApplicationShutdownTrigger,
  markApplicationShutdownTrigger,
  type ApplicationShutdownTrigger
} from './application-shutdown-trigger'
import type {
  CloseClassification,
  CloseConfirmChoice,
  CloseConfirmVariant,
  WindowFindAppearance
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
    requestQuit: (confirmed?: boolean) => void
    onAppearanceChanged?: (appearance: WindowFindAppearance) => void
  }) => BrowserWindow
  // Rebinds close and appearance behavior when the startup loading shell becomes the normal window.
  configureMainWindow?: (
    window: BrowserWindow,
    opts: {
      classifyClose: () => CloseClassification
      resolveCloseAction: () => Promise<CloseConfirmChoice>
      requestQuit: (confirmed?: boolean) => void
      onAppearanceChanged?: (appearance: WindowFindAppearance) => void
    }
  ) => void
  // A database-startup shell that the lifecycle adopts instead of creating a second window.
  initialWindow?: BrowserWindow
  // Receives the resolved renderer Theme. Optional so headless/tests and older compositions remain
  // decoupled from platform icon behavior.
  onAppearanceChanged?: (appearance: WindowFindAppearance) => void
  // Builds the tray; returns undefined on hosts without a tray (e.g. some Linux desktops).
  createTray: (handlers: TrayHandlers) => Tray | undefined
  // Bounded, best-effort backend teardown (agent tree + notebook kernels); never throws.
  shutdownBackends: () => Promise<ShutdownStepOutcome | void>
  // Requests active ACP turns to cancel, then waits a bounded interval for terminal usage events.
  prepareForQuit: () => Promise<ShutdownStepOutcome | void>
  // Closes installation admission synchronously across asynchronous quit preparation.
  holdSettingsInstallAdmission: () => () => void
  // Reopens Main/renderer admission when persistence prevents an orderly quit from committing.
  abortQuitPreparation: (reason?: SessionPersistenceFlushAbortReason) => Promise<void> | void
  // Drains renderer runtime events and its ordered Session write queue before the window disappears.
  flushSessionPersistence: (
    timeoutMs?: number
  ) => Promise<RendererSessionPersistenceFlushOutcome | void>
  // Local structured diagnostics remain optional for the dependency-injected lifecycle tests.
  log?: Logger
  // Drains the logger's serialized write queue after the shutdown terminal record.
  flushLogs?: () => Promise<void>
  logFlushTimeoutMs?: number
  // Shared timeout budget for the preflight and post-drain renderer persistence attempts.
  rendererFlushTimeoutMs?: number
  // Classifies an orderly shutdown without changing its cleanup sequence.
  shutdownTrigger?: () => ApplicationShutdownTrigger
  // True while a data-root handoff is validating, preparing, or copying; its quit guard owns exits.
  isMigrationInProgress: () => boolean
  // Requests an app quit (app.quit); the before-quit handler below turns it into an awaited teardown.
  quit: () => void
  // Number of live BrowserWindows, used to decide whether to recreate on macOS activate.
  countWindows: () => number
  // Headless web mode starts the backend and tray without opening a renderer window.
  createInitialWindow?: boolean
  // Production binds the startup window before runtime composition and reuses the same tested,
  // idempotent adapter here for later windows.
  bindSystemShutdownWindow?: (window: BrowserWindow) => void
  // Overridable for tests; defaults to the host platform.
  platform?: NodeJS.Platform
  // Snapshot of sessions with running work (in-flight agent prompt or a notebook cell mid-execution),
  // used to populate the confirmation list and to skip the quit dialog when nothing is running.
  detectActiveSessions: () => ActiveSessionInfo[]
  // Reviewer activity has no ActiveSessionInfo row, but still requires the ordinary-quit warning.
  hasActiveReviewerWork: () => boolean
  // Runtime installation has no Session row and cannot be safely interrupted midway. Its stable ID
  // keeps a confirmation scoped to the exact install that the user observed.
  getActiveSettingsInstallId: () => string | undefined
  // Builds the close-confirm coordinator bound to the current main window (recreated on demand).
  createConfirmClose: (
    getWindow: () => BrowserWindow | undefined
  ) => (
    variant: CloseConfirmVariant,
    sessions: ActiveSessionInfo[],
    unlistedWorkActive?: boolean
  ) => Promise<CloseConfirmChoice>
}

// Installs the tray, the first window, and the quit/activate/window-all-closed handlers. Returns
// showMainWindow so the single-instance second-instance hook can surface the window (creating one when
// none exists — e.g. macOS after the last window was closed but the app stayed resident). The returned
// window reference and explicit hidden state let callers target or inspect it without re-deriving
// either value from focus, window order, or minimized visibility semantics.
export const installAppLifecycle = (
  deps: AppLifecycleDeps
): {
  showMainWindow: () => BrowserWindow
  getMainWindow: () => BrowserWindow | undefined
  isMainWindowHidden: () => boolean
  onSystemShutdown: () => void
} => {
  const platform = deps.platform ?? process.platform
  const logFlushTimeoutMs = deps.logFlushTimeoutMs ?? 1_000
  const rendererFlushTimeoutMs = Math.max(2, deps.rendererFlushTimeoutMs ?? 5_000)
  const rendererPreflightTimeoutMs = Math.floor(rendererFlushTimeoutMs / 2)
  const rendererFinalFlushTimeoutMs = rendererFlushTimeoutMs - rendererPreflightTimeoutMs

  let mainWindow: BrowserWindow | undefined
  const hiddenWindows = new WeakSet<BrowserWindow>()
  // Held in a box (not a plain `let`) so the close classification defined below can read it before
  // it is assigned — the tray, window, and predicate reference each other cyclically.
  const trayBox: { current: Tray | undefined } = { current: undefined }
  // Latches make the async quit cleanup idempotent: once started, further quits are held until exit.
  let shutdownStarted = false
  let shutdownFinished = false
  let systemShutdownRequested = false
  // Set once the user has confirmed a quit (via the dialog or a prior 'confirm' close), so a re-issued
  // before-quit skips straight to teardown instead of asking again.
  let quitConfirmed = false
  let confirmedSettingsInstallId: string | undefined
  // A delegated confirmation authorizes only the Sessions visible in that dialog. The final
  // before-quit boundary rechecks this snapshot so work admitted between confirmation and the
  // re-issued quit cannot inherit an unrelated confirmation.
  let confirmedDelegatedSessionKeys = new Set<string>()
  // Shared across both confirm-dispatching paths (titlebar X and tray/Ctrl+Q quit) so only one
  // confirmation modal is ever open at a time. The renderer holds a single request slot; a second
  // dispatch would silently overwrite the first and strand its promise forever (see app-lifecycle.test.ts).
  let confirmInFlight = false
  // Set only after the persistence-failure dialog's explicit destructive choice. The next before-quit
  // attempt consumes it once; an intervening guard or confirmation cannot leak it to a later attempt.
  let forceQuitAfterPersistenceFailure = false

  const normalizeStepOutcome = (outcome: ShutdownStepOutcome | void): ShutdownStepOutcome =>
    outcome ?? 'completed'
  const rendererStepOutcome = (
    outcome: RendererSessionPersistenceFlushOutcome
  ): ShutdownStepOutcome => {
    if (outcome === 'timeout') return 'timeout'
    if (outcome === 'send-failed' || outcome === 'renderer-failed' || outcome === 'conflict')
      return 'failed'
    if (outcome === 'renderer-gone') return 'degraded'
    return 'completed'
  }
  const rendererPersistenceAbortReason = (
    outcome: RendererSessionPersistenceFlushOutcome
  ): SessionPersistenceFlushAbortReason | undefined =>
    outcome === 'conflict' || outcome === 'renderer-failed' ? outcome : undefined
  const rendererPersistenceNeedsConsent = (
    outcome: RendererSessionPersistenceFlushOutcome
  ): boolean => outcome === 'timeout' || outcome === 'send-failed'
  const shutdownTrigger = (): ApplicationShutdownTrigger => {
    try {
      return deps.shutdownTrigger?.() ?? currentApplicationShutdownTrigger()
    } catch {
      return 'quit'
    }
  }

  const confirmClose = deps.createConfirmClose(() => mainWindow)
  const activeSettingsInstallId = (): string | undefined => deps.getActiveSettingsInstallId()
  const confirmResearchClose = (
    variant: CloseConfirmVariant,
    sessions: ActiveSessionInfo[]
  ): Promise<CloseConfirmChoice> =>
    deps.hasActiveReviewerWork() || activeSettingsInstallId() !== undefined
      ? confirmClose(variant, sessions, true)
      : confirmClose(variant, sessions)
  const detectDelegatedWork = (): ActiveSessionInfo[] =>
    deps.detectActiveSessions().filter((session) => session.kind === 'delegated')
  const delegatedSessionKey = (session: ActiveSessionInfo): string =>
    JSON.stringify([session.projectId, session.sessionId])
  const requestConfirmedQuit = (
    delegated: readonly ActiveSessionInfo[] = [],
    settingsInstallId?: string
  ): void => {
    quitConfirmed = true
    confirmedSettingsInstallId = settingsInstallId
    confirmedDelegatedSessionKeys = new Set(delegated.map(delegatedSessionKey))
    deps.quit()
  }
  const requestSystemShutdown = (): void => {
    if (systemShutdownRequested || shutdownFinished) return
    systemShutdownRequested = true
    const rollbackTrigger = markApplicationShutdownTrigger('system')
    // An ordinary quit may already be inside its abortable Renderer preflight. Keep the stronger
    // system intent latched; its abort path will reissue quit through the same lifecycle owner.
    if (shutdownStarted) return
    try {
      deps.quit()
    } catch (error) {
      systemShutdownRequested = false
      rollbackTrigger()
      throw error
    }
  }

  // Synchronous close classification, evaluated at close time. A mid-quit close is held so the
  // renderer survives persistence flushing; otherwise darwin keeps its dock convention (real close),
  // no-tray hosts retain the renderer while requesting app quit, Windows asks (confirm), and Linux
  // keeps silent hide-to-tray.
  const classifyClose = (): CloseClassification => {
    if (shutdownStarted) return 'quit'
    if (platform === 'darwin') return 'close'
    if (quitConfirmed) return 'close'
    if (!trayBox.current) return 'quit'
    if (platform === 'win32') return 'confirm'
    return 'hide'
  }

  // Only one confirmation modal at a time: if a quit-confirm (or another close-confirm) is already
  // open, do nothing for this X press so the in-flight decision stays authoritative.
  const resolveCloseAction = async (): Promise<CloseConfirmChoice> => {
    if (confirmInFlight) return 'cancel'
    confirmInFlight = true
    try {
      const choice = await confirmResearchClose('close-to-tray', deps.detectActiveSessions())
      if (choice !== 'quit') return choice
      const delegated = detectDelegatedWork()
      return delegated.length > 0 ? await confirmResearchClose('close-to-tray', delegated) : choice
    } finally {
      confirmInFlight = false
    }
  }

  const mainWindowOptions = (): Parameters<AppLifecycleDeps['createMainWindow']>[0] => ({
    classifyClose,
    resolveCloseAction,
    requestQuit: (confirmed = true) => {
      // A caller's earlier confirmation cannot authorize delegated work that is already live at the
      // final boundary. Leave that case unconfirmed so before-quit performs the delegated-work recheck.
      quitConfirmed =
        confirmed && detectDelegatedWork().length === 0 && activeSettingsInstallId() === undefined
      confirmedSettingsInstallId = undefined
      confirmedDelegatedSessionKeys = new Set()
      deps.quit()
    },
    ...(deps.onAppearanceChanged ? { onAppearanceChanged: deps.onAppearanceChanged } : {})
  })

  const bindWindow = (window: BrowserWindow): BrowserWindow => {
    deps.configureMainWindow?.(window, mainWindowOptions())

    // isVisible() is also false for minimized Windows windows. Track explicit hide/show events so
    // taskbar attention can distinguish a legitimate minimized window from one hidden to the tray.
    window.on('hide', () => hiddenWindows.add(window))
    window.on('show', () => hiddenWindows.delete(window))
    deps.bindSystemShutdownWindow?.(window)
    return window
  }

  const openWindow = (): BrowserWindow => {
    const window = deps.createMainWindow(mainWindowOptions())
    return bindWindow(window)
  }

  // Surfaces the main window, creating a fresh one when none exists or the last was closed (macOS keeps
  // the app alive with no window; the tray Show item and a second launch must be able to bring it back).
  // Returns the window so callers can target it directly instead of guessing by focus or window order.
  const showMainWindow = (): BrowserWindow => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = openWindow()
      return mainWindow
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    // Some native restore paths become visible without emitting show; the explicit show command is
    // authoritative, so clear a stale tray-hidden marker before attention checks can observe it.
    hiddenWindows.delete(mainWindow)
    mainWindow.focus()
    return mainWindow
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
    const trigger = shutdownTrigger()
    const persistenceFailureIsForced = forceQuitAfterPersistenceFailure
    forceQuitAfterPersistenceFailure = false
    if (event.defaultPrevented || deps.isMigrationInProgress()) {
      // This quit is being aborted (e.g. the migration guard cancelled it). Clear any prior
      // confirmation and shutdown trigger so neither leaks into a later close: otherwise a later
      // ordinary quit could bypass its active-session confirmation. A system request remains latched
      // because the migration guard owns cancelling/joining the move and then reissues app.quit().
      if (trigger !== 'system') {
        clearApplicationShutdownTrigger()
        systemShutdownRequested = false
      }
      quitConfirmed = false
      confirmedSettingsInstallId = undefined
      confirmedDelegatedSessionKeys = new Set()
      return
    }
    // Renderer persistence may cancel only an ordinary quit. Update and data-root relaunches pass a
    // producer-teardown + renderer-durability gate before committing their handoff; once app.quit()
    // runs, cancellation would leave the old process alive after the external pointer changed.
    const ordinaryQuit = trigger === 'quit'
    const delegatedWorkBlocksShutdown = ordinaryQuit

    // A Settings install can start after an earlier empty-work fast path resolved. Only a warning
    // that actually observed active installation work may authorize interrupting it.
    const settingsInstallAtShutdownBoundary = activeSettingsInstallId()
    if (
      ordinaryQuit &&
      quitConfirmed &&
      settingsInstallAtShutdownBoundary !== undefined &&
      settingsInstallAtShutdownBoundary !== confirmedSettingsInstallId
    ) {
      quitConfirmed = false
      confirmedSettingsInstallId = undefined
    }

    // Final synchronous delegated-work safety boundary. A delegated Attempt may start after an earlier
    // confirmation snapshot (or after a saved close preference was read). Storage commands quiesce and
    // await all producers before marking migration-relaunch, and the updater does the same before
    // quitAndInstall. Once either committed handoff invokes app.quit(), it must continue; cancelling
    // there would strand the already-started installer or a process cached on the old data root.
    const delegatedAtShutdownBoundary = detectDelegatedWork()
    const hasUnconfirmedDelegatedWork = delegatedAtShutdownBoundary.some(
      (session) => !confirmedDelegatedSessionKeys.has(delegatedSessionKey(session))
    )
    if (delegatedWorkBlocksShutdown && hasUnconfirmedDelegatedWork) {
      event.preventDefault()
      quitConfirmed = false
      confirmedSettingsInstallId = undefined
      confirmedDelegatedSessionKeys = new Set()
      clearApplicationShutdownTrigger()
      if (confirmInFlight) return
      confirmInFlight = true
      const settingsInstallAtDelegatedConfirmation = activeSettingsInstallId()
      void confirmResearchClose('quit', delegatedAtShutdownBoundary)
        .then((choice) => {
          if (choice === 'quit') {
            requestConfirmedQuit(
              delegatedAtShutdownBoundary,
              settingsInstallAtDelegatedConfirmation
            )
          }
        })
        .finally(() => {
          confirmInFlight = false
        })
      return
    }

    // Confirmation gate: unless the user already confirmed (e.g. Windows X -> Quit), confirm the
    // quit. An empty active-session list with no unlisted work resolves 'quit' with no modal.
    if (!quitConfirmed && ordinaryQuit) {
      event.preventDefault()
      if (confirmInFlight) return
      confirmInFlight = true
      const settingsInstallAtConfirmation = activeSettingsInstallId()
      void confirmResearchClose('quit', deps.detectActiveSessions())
        .then(async (choice) => {
          if (choice === 'quit') {
            const delegated = detectDelegatedWork()
            if (delegated.length > 0) {
              quitConfirmed = false
              confirmedSettingsInstallId = undefined
              const settingsInstallAtDelegatedConfirmation = activeSettingsInstallId()
              const delegatedChoice = await confirmResearchClose('quit', delegated)
              if (delegatedChoice === 'quit') {
                requestConfirmedQuit(delegated, settingsInstallAtDelegatedConfirmation)
              }
              return
            }
            requestConfirmedQuit([], settingsInstallAtConfirmation)
            return
          }
          // Cancel with no tray and no surviving window would strand the app with no UI (no-tray
          // Windows/Linux: X destroys the window -> window-all-closed quit -> Cancel): recreate the
          // window so the app the user chose to keep stays reachable. Gate on a window that existed
          // and is now destroyed, NOT on platform+tray alone — headless web mode legitimately runs
          // with no window (mainWindow never created) and must not have one fabricated here. macOS is
          // exempt: window-closed-but-resident is its dock convention. The non-darwin/no-tray pair
          // mirrors the window-all-closed quit path that produced this quit.
          if (platform !== 'darwin' && !trayBox.current && mainWindow && mainWindow.isDestroyed()) {
            showMainWindow()
          }
        })
        .finally(() => {
          confirmInFlight = false
        })
      return
    }

    event.preventDefault()
    shutdownStarted = true
    const releaseSettingsInstallAdmission = deps.holdSettingsInstallAdmission()
    void (async () => {
      const diagnostics = deps.log
        ? startDiagnosticOperation(deps.log, {
            operation: 'application-shutdown',
            fields: { trigger }
          })
        : undefined
      let usageDrainResult: ShutdownStepOutcome
      let rendererPreflightOutcome: RendererSessionPersistenceFlushOutcome
      let rendererPreflightResult: ShutdownStepOutcome
      let rendererFlushOutcome: RendererSessionPersistenceFlushOutcome
      let rendererFlushResult: ShutdownStepOutcome
      let backendTeardownResult: ShutdownStepOutcome
      let shutdownAbortReason: SessionPersistenceFlushAbortReason | undefined
      let persistenceFailureNeedsConsent = false
      const flushRendererSessionPersistence = async (
        phase: 'renderer-session-preflight' | 'renderer-session-flush',
        timeoutMs: number
      ): Promise<{
        outcome: RendererSessionPersistenceFlushOutcome
        result: ShutdownStepOutcome
      }> => {
        diagnostics?.phase(phase)
        try {
          const outcome = (await deps.flushSessionPersistence(timeoutMs)) ?? 'completed'
          const result = rendererStepOutcome(outcome)
          diagnostics?.phase(phase, { result })
          return { outcome, result }
        } catch (error) {
          diagnostics?.phase(phase, { result: 'failed', ...diagnosticErrorFields(error) })
          return { outcome: 'send-failed', result: 'failed' }
        }
      }
      try {
        const preflight = await flushRendererSessionPersistence(
          'renderer-session-preflight',
          rendererPreflightTimeoutMs
        )
        rendererPreflightOutcome = preflight.outcome
        rendererPreflightResult = preflight.result
        const preflightAbortReason = rendererPersistenceAbortReason(rendererPreflightOutcome)
        const preflightNeedsConsent = rendererPersistenceNeedsConsent(rendererPreflightOutcome)
        const preflightBlocksShutdown =
          rendererSessionPersistenceFlushBlocksShutdown(rendererPreflightOutcome)
        if (ordinaryQuit && !persistenceFailureIsForced && preflightBlocksShutdown) {
          shutdownAbortReason = preflightAbortReason
          persistenceFailureNeedsConsent = preflightNeedsConsent
          diagnostics?.complete({
            degraded: true,
            rendererPreflightOutcome,
            rendererPreflightResult,
            usageDrainResult: 'degraded',
            rendererFlushResult: 'degraded',
            backendTeardownResult: 'degraded'
          })
          if (deps.flushLogs) {
            await flushDiagnosticsWithTimeout(deps.flushLogs, logFlushTimeoutMs)
          }
          return
        }

        diagnostics?.phase('usage-drain')
        try {
          usageDrainResult = normalizeStepOutcome(await deps.prepareForQuit())
          diagnostics?.phase('usage-drain', { result: usageDrainResult })
        } catch (error) {
          usageDrainResult = 'failed'
          diagnostics?.phase('usage-drain', {
            result: usageDrainResult,
            ...diagnosticErrorFields(error)
          })
        }

        const finalFlush = await flushRendererSessionPersistence(
          'renderer-session-flush',
          rendererFinalFlushTimeoutMs
        )
        rendererFlushOutcome = finalFlush.outcome
        rendererFlushResult = finalFlush.result
        const finalAbortReason = rendererPersistenceAbortReason(rendererFlushOutcome)
        const finalNeedsConsent = rendererPersistenceNeedsConsent(rendererFlushOutcome)
        const finalBlocksShutdown =
          rendererSessionPersistenceFlushBlocksShutdown(rendererFlushOutcome)
        if (ordinaryQuit && !persistenceFailureIsForced && finalBlocksShutdown) {
          shutdownAbortReason = finalAbortReason
          persistenceFailureNeedsConsent = finalNeedsConsent
          diagnostics?.complete({
            degraded: true,
            rendererPreflightResult,
            rendererPreflightOutcome,
            usageDrainResult,
            rendererFlushResult,
            rendererFlushOutcome,
            backendTeardownResult: 'degraded'
          })
          if (deps.flushLogs) {
            await flushDiagnosticsWithTimeout(deps.flushLogs, logFlushTimeoutMs)
          }
          return
        }

        diagnostics?.phase('backend-teardown')
        try {
          backendTeardownResult = normalizeStepOutcome(await deps.shutdownBackends())
          diagnostics?.phase('backend-teardown', { result: backendTeardownResult })
        } catch (error) {
          backendTeardownResult = 'failed'
          diagnostics?.phase('backend-teardown', {
            result: backendTeardownResult,
            ...diagnosticErrorFields(error)
          })
        }
        const degraded =
          usageDrainResult !== 'completed' ||
          rendererFlushResult !== 'completed' ||
          backendTeardownResult !== 'completed'
        diagnostics?.complete({
          degraded,
          rendererPreflightResult,
          rendererPreflightOutcome,
          usageDrainResult,
          rendererFlushResult,
          rendererFlushOutcome,
          backendTeardownResult
        })

        if (deps.flushLogs) {
          const result = await flushDiagnosticsWithTimeout(deps.flushLogs, logFlushTimeoutMs)
          if (result === 'timeout') deps.log?.warn('final log flush timed out')
        }
      } finally {
        if (shutdownAbortReason || persistenceFailureNeedsConsent) {
          try {
            await deps.abortQuitPreparation(shutdownAbortReason)
          } catch (error) {
            try {
              deps.log?.error('quit preparation rollback failed', diagnosticErrorFields(error))
            } catch {
              // Restoring the visible app remains authoritative; rollback diagnostics are best-effort.
            }
          }
          releaseSettingsInstallAdmission()
          shutdownStarted = false
          quitConfirmed = false
          confirmedSettingsInstallId = undefined
          if (systemShutdownRequested) {
            // A preventable OS shutdown arrived after this ordinary attempt began. Do not restore an
            // interactive app: replay it with the already-latched system trigger so persistence is
            // best-effort and cannot cancel the OS-owned exit.
            deps.quit()
          } else {
            clearApplicationShutdownTrigger()
            showMainWindow()
            if (persistenceFailureNeedsConsent && !confirmInFlight) {
              confirmInFlight = true
              try {
                const choice = await confirmClose('persistence-failed', [])
                if (choice === 'retry') requestConfirmedQuit()
                else if (choice === 'force-quit') {
                  forceQuitAfterPersistenceFailure = true
                  requestConfirmedQuit()
                }
              } catch (error) {
                try {
                  deps.log?.error(
                    'persistence failure confirmation failed',
                    diagnosticErrorFields(error)
                  )
                } catch {
                  // A failed confirmation keeps the app open; diagnostics remain best-effort.
                }
              } finally {
                confirmInFlight = false
              }
            }
          }
        } else {
          trayBox.current?.destroy()
          shutdownFinished = true
          deps.app.exit(0)
        }
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

  if (deps.createInitialWindow !== false) {
    mainWindow =
      deps.initialWindow && !deps.initialWindow.isDestroyed()
        ? bindWindow(deps.initialWindow)
        : openWindow()
  }

  return {
    showMainWindow,
    // Attention effects may inspect the current window, but must never surface it as a side effect.
    getMainWindow: () => mainWindow,
    isMainWindowHidden: () => Boolean(mainWindow && hiddenWindows.has(mainWindow)),
    onSystemShutdown: requestSystemShutdown
  }
}
