import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  webFrameMain,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type WebFrameMain
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import iconPng from '../../resources/icon.png?asset'
import iconWindows from '../../resources/icon-light.ico?asset'
import { createFrameNavigationGuard, isAllowedExternalNavigation } from './navigation-policy'
import { createFindOverlayManager, type FindOverlayDeps } from './find-overlay'
import { registerFindOverlayOwner } from './find-overlay-registry'
import { createLogger } from './logger'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL,
  WINDOW_FIND_READY_CHANNEL,
  WINDOW_FIND_UNREADY_CHANNEL,
  isCloseWindowChord,
  isFindInPageChord,
  isWindowFindAppearance,
  type CloseClassification,
  type CloseConfirmChoice,
  type WindowFindAppearance
} from '../shared/window-controls'

const rendererEntry = join(__dirname, '../renderer/index.html')
const preloadEntry = join(__dirname, '../preload/index.js')
const findOverlayPreloadEntry = join(__dirname, '../preload/find-overlay.js')
const icon = process.platform === 'win32' ? iconWindows : iconPng
// The find overlay is a static page (no bundler entry) shipped under resources/, so it resolves the
// same way in dev (project root) and packaged (asar root) via app.getAppPath().
const findOverlayEntry = join(app.getAppPath(), 'resources/find-overlay/index.html')
const log = createLogger('window')
const E2E_WINDOW_MODE_ENV = 'OPEN_SCIENCE_E2E_WINDOW_MODE'
const RENDERER_RECOVERY_WINDOW_MS = 60_000
const MAX_AUTOMATIC_RENDERER_RECOVERIES = 2
const RECOVERABLE_RENDERER_EXIT_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure'
])

const loadRenderer = (window: BrowserWindow): void => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
    return
  }

  void window.loadFile(rendererEntry)
}

const createAppWindow = (options: BrowserWindowConstructorOptions): BrowserWindow => {
  const e2eWindowMode = process.env[E2E_WINDOW_MODE_ENV]
  const window = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    ...(process.platform !== 'darwin' ? { icon } : {}),
    ...options,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...options.webPreferences
    }
  })

  window.on('ready-to-show', () => {
    if (e2eWindowMode === 'hidden') return
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalNavigation(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })
  // Remote source pages share the main window Session but never need device, media, location, or
  // storage permissions. Keep trusted main-frame behavior intact and fail every subframe closed.
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback, details) => callback(details.isMainFrame)
  )
  window.webContents.session.setPermissionCheckHandler(
    (_webContents, _permission, _requestingOrigin, details) => details.isMainFrame
  )
  const isAllowedFrameNavigation = createFrameNavigationGuard(window.webContents.mainFrame)
  type FrameNavigationDetails = {
    url: string
    isMainFrame: boolean
    frame: unknown
    processId?: number
    routingId?: number
    preventDefault: () => void
  }
  const resolveNavigationFrame = (
    details: FrameNavigationDetails,
    fallbackProcessId?: number,
    fallbackRoutingId?: number
  ): WebFrameMain | null => {
    if (
      details.frame &&
      typeof details.frame !== 'string' &&
      typeof (details.frame as WebFrameMain).frameTreeNodeId === 'number'
    ) {
      return details.frame as WebFrameMain
    }

    const processId = details.processId ?? fallbackProcessId
    const routingId = details.routingId ?? fallbackRoutingId
    if (processId === undefined || routingId === undefined) return null

    return webFrameMain.fromId(processId, routingId) ?? null
  }
  const enforceFrameNavigationPolicy = (
    details: FrameNavigationDetails,
    frame: WebFrameMain | null
  ): void => {
    if (
      !isAllowedFrameNavigation(
        details.url,
        details.isMainFrame,
        window.webContents.getURL(),
        frame
      )
    ) {
      details.preventDefault()
    }
  }
  window.webContents.on('will-frame-navigate', (details) => {
    enforceFrameNavigationPolicy(details, resolveNavigationFrame(details))
  })
  window.webContents.on(
    'will-redirect',
    (details, _url, _isInPlace, _isMainFrame, frameProcessId, frameRoutingId) => {
      const frame = resolveNavigationFrame(details, frameProcessId, frameRoutingId)
      enforceFrameNavigationPolicy(details, frame)
    }
  )

  return window
}

// How the main window resolves a close: classifyClose decides synchronously at close time
// ('close' = let it close, 'hide' = minimize to tray, 'quit' = retain the renderer while app quit
// flushes it, 'confirm' = ask via resolveCloseAction).
// resolveCloseAction is awaited only for 'confirm'; requestQuit is called when the choice is quit.
type MainWindowCloseOptions = {
  classifyClose: () => CloseClassification
  resolveCloseAction: () => Promise<CloseConfirmChoice>
  requestQuit: (confirmed?: boolean) => void
  // The renderer's resolved Theme also drives native platform appearance (notably the macOS Dock).
  onAppearanceChanged?: (appearance: WindowFindAppearance) => void
}

const mainWindowCloseOptions = new WeakMap<BrowserWindow, MainWindowCloseOptions>()

const configureMainWindow = (window: BrowserWindow, opts: MainWindowCloseOptions): void => {
  mainWindowCloseOptions.set(window, opts)
}

const createMainWindow = (
  opts?: MainWindowCloseOptions,
  translate: NativeTranslator = englishNativeTranslator
): BrowserWindow => {
  const window = createAppWindow({
    width: 1280,
    // The first-run environment summary needs enough vertical space to keep its Continue action
    // visible at the default size. Electron still clamps this to the display work area on smaller
    // screens, where the onboarding surface provides its own vertical scroll fallback.
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'Open Science'
  })
  if (opts) configureMainWindow(window, opts)

  // The renderer decides pane-vs-window, but only once it has a live, responsive listener. If main
  // forwards the chord to a renderer that cannot handle it, preventDefault() has already suppressed the
  // menu Close accelerator, so Cmd/Ctrl+W becomes a silent no-op. Two independent conditions gate the
  // forward:
  //   - listener readiness: the renderer mounted its listener (READY) and has not torn it down (UNREADY),
  //     been replaced by a fresh top-level document (did-start-navigation), or died (render-process-gone).
  //   - responsiveness: a hung renderer receives the send but never processes it, so treat unresponsive
  //     as not-forwardable and restore on recovery — tracked separately so a recovered renderer keeps
  //     its subscription instead of having to re-handshake.
  // When either fails, main closes the window itself so the chord always does something.
  let rendererListenerReady = false
  let windowFindListenerReady = false
  let rendererResponsive = true
  let rendererUnresponsiveAt: number | undefined
  let rendererRecoveryTimes: number[] = []
  let rendererRecoveryDialogOpen = false
  const clearRendererHangState = (): void => {
    rendererResponsive = true
    rendererUnresponsiveAt = undefined
  }
  const onListenerReady = (event: IpcMainEvent): void => {
    if (event.sender !== window.webContents) return
    rendererListenerReady = true
    // A renderer that just handshook is by definition running and processing IPC. Clear any stale
    // unresponsive state here too: after unresponsive -> render-process-gone -> reload, the fresh
    // process never emits 'responsive' (that only fires as recovery on the *same* process), so READY
    // is the only signal that the new renderer can act on the chord.
    clearRendererHangState()
  }
  const onListenerGone = (event: IpcMainEvent): void => {
    if (event.sender === window.webContents) rendererListenerReady = false
  }
  const onWindowFindReady = (event: IpcMainEvent): void => {
    if (event.sender !== window.webContents) return
    windowFindListenerReady = true
    clearRendererHangState()
  }
  const onWindowFindGone = (event: IpcMainEvent): void => {
    if (event.sender !== window.webContents) return
    windowFindListenerReady = false
    findOverlay.close()
  }
  const onWindowFindAppearanceChanged = (event: IpcMainEvent, appearance: unknown): void => {
    if (event.sender !== window.webContents || !isWindowFindAppearance(appearance)) return
    findOverlay.updateAppearance(appearance)
    mainWindowCloseOptions.get(window)?.onAppearanceChanged?.(appearance)
  }
  ipcMain.on(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
  ipcMain.on(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL, onListenerGone)
  ipcMain.on(WINDOW_FIND_READY_CHANNEL, onWindowFindReady)
  ipcMain.on(WINDOW_FIND_UNREADY_CHANNEL, onWindowFindGone)
  ipcMain.on(WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL, onWindowFindAppearanceChanged)
  // A top-level document swap replaces the mounted hook, which must re-subscribe; a dead render process
  // took its listener with it. Both revoke readiness until the next READY handshake. Gate on the main
  // frame and a real document change so a dynamic preview iframe loading (or a same-document hash /
  // pushState navigation) — neither of which remounts the hook — does not falsely disarm the forward.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      rendererListenerReady = false
      windowFindListenerReady = false
      findOverlay.close()
    }
  })
  // Keep renderer bootstrap failures diagnosable without persisting the failed URL, preload path, or
  // error message (all of which can contain local paths or Session-derived data).
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      log.error('renderer document failed to load', { errorCode, errorDescription })
    }
  )
  window.webContents.on('preload-error', (_event, _preloadPath, error) => {
    log.error('renderer preload failed', { errorName: error.name })
  })
  // Persist only fixed Electron lifecycle vocabulary and numeric timing/exit metadata. Current URLs,
  // Session content, renderer console output, process arguments, and local paths stay out of main.log.
  window.webContents.on('render-process-gone', (_event, details) => {
    const wasUnresponsive = !rendererResponsive
    log.error('renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      wasUnresponsive,
      ...(rendererUnresponsiveAt === undefined
        ? {}
        : { unresponsiveDurationMs: Math.max(0, Date.now() - rendererUnresponsiveAt) })
    })
    rendererListenerReady = false
    windowFindListenerReady = false
    clearRendererHangState()
    findOverlay.close()

    if (!RECOVERABLE_RENDERER_EXIT_REASONS.has(details.reason) || window.isDestroyed()) return

    const now = Date.now()
    rendererRecoveryTimes = rendererRecoveryTimes.filter(
      (recoveryAt) => now - recoveryAt < RENDERER_RECOVERY_WINDOW_MS
    )
    if (rendererRecoveryTimes.length < MAX_AUTOMATIC_RENDERER_RECOVERIES) {
      rendererRecoveryTimes.push(now)
      log.warn('reloading renderer after process exit', {
        reason: details.reason,
        automaticRecoveryAttempt: rendererRecoveryTimes.length
      })
      loadRenderer(window)
      return
    }

    if (rendererRecoveryDialogOpen) return
    rendererRecoveryDialogOpen = true
    log.error('renderer automatic recovery paused after repeated exits', {
      reason: details.reason,
      automaticRecoveries: rendererRecoveryTimes.length,
      recoveryWindowMs: RENDERER_RECOVERY_WINDOW_MS
    })
    void dialog
      .showMessageBox(window, {
        type: 'error',
        buttons: [translate('Reload'), translate('Close window')],
        defaultId: 0,
        cancelId: 1,
        title: 'Open Science',
        message: translate('The app window stopped responding repeatedly.'),
        detail: translate(
          'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.'
        )
      })
      .then(
        ({ response }) => {
          rendererRecoveryDialogOpen = false
          if (window.isDestroyed()) return
          if (response === 0) {
            rendererRecoveryTimes = []
            log.warn('reloading renderer after user confirmation')
            loadRenderer(window)
            return
          }
          // Bypass the normal Windows close-to-tray interception: the user explicitly chose to close
          // this unrecoverable blank window, not leave it hidden and alive in the tray.
          window.destroy()
        },
        () => {
          rendererRecoveryDialogOpen = false
          log.error('renderer recovery dialog failed')
          if (!window.isDestroyed()) window.destroy()
        }
      )
  })
  window.webContents.on('unresponsive', () => {
    if (rendererResponsive) {
      rendererUnresponsiveAt = Date.now()
      log.warn('renderer became unresponsive')
    }
    rendererResponsive = false
    findOverlay.close()
  })
  window.webContents.on('responsive', () => {
    if (!rendererResponsive && rendererUnresponsiveAt !== undefined) {
      log.info('renderer became responsive', {
        unresponsiveDurationMs: Math.max(0, Date.now() - rendererUnresponsiveAt)
      })
    }
    clearRendererHangState()
  })
  window.on('closed', () => {
    ipcMain.removeListener(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
    ipcMain.removeListener(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL, onListenerGone)
    ipcMain.removeListener(WINDOW_FIND_READY_CHANNEL, onWindowFindReady)
    ipcMain.removeListener(WINDOW_FIND_UNREADY_CHANNEL, onWindowFindGone)
    ipcMain.removeListener(WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL, onWindowFindAppearanceChanged)
    findOverlay.destroy()
  })

  // The whole-window find bar lives in its own WebContentsView overlay, so its own query text is never
  // part of the main window's page search. The overlay talks to main via the window-find IPC channels;
  // main opens/closes it here in response to the chord and Escape.
  const findOverlay = createFindOverlayManager({
    // The structural dep narrows BrowserWindow to just the find-overlay surface; Electron's
    // contentView.addChildView is typed against the base View (no webContents), so bridge the gap here.
    mainWindow: window as unknown as FindOverlayDeps['mainWindow'],
    createView: (opts) => new WebContentsView(opts),
    preloadPath: findOverlayPreloadEntry,
    overlayHtmlPath: findOverlayEntry,
    registerOwner: registerFindOverlayOwner
  })

  // Intercept Cmd+W / Ctrl+W before the default menu "Close" role fires. preventDefault here also
  // suppresses the menu accelerator (electron/electron#19279), so the chord never closes the window
  // behind the renderer's back. Forward to the renderer only when it can act on it, otherwise close.
  //
  // Accepted residual: send() is fire-and-forget, so a renderer that crashes or hangs in the gap
  // between this send and its handler running drops this one chord. It is self-correcting — that same
  // crash/hang revokes readiness, so the next press falls back to the direct close below. A per-chord
  // ack + timeout would close that gap but risks a worse bug: if a slow-but-healthy renderer collapses
  // the pane and its ack lands after the timeout, main would then also close the window. We accept one
  // lost keystroke during a renderer crash over that regression.
  window.webContents.on('before-input-event', (event, input) => {
    if (isFindInPageChord(input, process.platform)) {
      if (windowFindListenerReady && rendererResponsive) {
        event.preventDefault()
        findOverlay.open()
      }
      return
    }

    // Escape closes an open find bar even when focus has wandered into the main content — the overlay's
    // own handler covers the input-focused case, this covers the rest.
    if (input.type === 'keyDown' && input.key === 'Escape' && findOverlay.isOpen()) {
      event.preventDefault()
      findOverlay.close()
      return
    }

    if (!isCloseWindowChord(input, process.platform)) return

    event.preventDefault()
    if (rendererListenerReady && rendererResponsive) {
      window.webContents.send(CLOSE_ACTIVE_PANE_CHANNEL)
    } else {
      // The chord's window-close fallback now routes through classifyClose below: Windows surfaces the
      // confirm dialog, Linux hides to tray, and everyone else closes.
      window.close()
    }
  })

  // Close handling. classifyClose decides synchronously: darwin and mid-quit close instantly; 'hide'
  // minimizes to tray (Linux); 'quit' retains a no-tray renderer through app teardown; 'confirm'
  // (Windows X) asks the user. The
  // Cmd/Ctrl+W fallback window.close() routes through here unchanged.
  let awaitingChoice = false
  window.on('close', (event) => {
    const closeOptions = mainWindowCloseOptions.get(window)
    const action = closeOptions?.classifyClose() ?? 'close'
    if (action === 'close') return
    event.preventDefault()
    if (action === 'hide') {
      window.hide()
      return
    }
    if (action === 'quit') {
      closeOptions!.requestQuit(false)
      return
    }
    if (awaitingChoice) return
    awaitingChoice = true
    void closeOptions!
      .resolveCloseAction()
      .then((choice) => {
        if (choice === 'minimize') window.hide()
        else if (choice === 'quit') closeOptions!.requestQuit()
      })
      .finally(() => {
        awaitingChoice = false
      })
  })

  // In dev, mirror the "(DEV)" app suffix in the title bar. The renderer's <title> overwrites the
  // constructor title on load, so append the suffix whenever the page updates its title.
  if (!app.isPackaged) {
    window.on('page-title-updated', (event, pageTitle) => {
      event.preventDefault()
      window.setTitle(`${pageTitle} (DEV)`)
    })
  }

  loadRenderer(window)
  return window
}

export { configureMainWindow, createMainWindow }
export type { MainWindowCloseOptions }
