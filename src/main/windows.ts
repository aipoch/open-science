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
  type WebContents,
  type WebFrameMain
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import iconPng from '../../resources/icon.png?asset'
import iconWindows from '../../resources/icon-light.ico?asset'
import { createFrameNavigationGuard, isAllowedExternalNavigation } from './navigation-policy'
import { createFindOverlayManager, type FindOverlayDeps } from './find-overlay'
import { registerFindOverlayOwner } from './find-overlay-registry'
import { createLogger, diagnosticErrorFields } from './logger'
import { createSourcePreviewLoadMonitor } from './source-preview-load-monitor'
import { createSourcePreviewEmbedPolicy } from './source-preview-embed-policy'
import { registerSourcePreviewWebRequestOwner } from './source-preview-web-request-owner'
import {
  installPreviewContextMenuBridge,
  type PreviewContextMenuWebContents
} from './preview-context-menu'
import { englishNativeTranslator, type NativeTranslator } from './locale/main-process-messages'
import {
  SOURCE_PREVIEW_LOAD_STATE_CHANNEL,
  SOURCE_PREVIEW_RELEASE_CHANNEL,
  parseHttpsSourceUrl
} from '../shared/source-preview'
import {
  CLOSE_ACTIVE_PANE_CHANNEL,
  CLOSE_ACTIVE_PANE_READY_CHANNEL,
  CLOSE_ACTIVE_PANE_UNREADY_CHANNEL,
  WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL,
  WINDOW_FIND_CONTENT_READY_CHANNEL,
  WINDOW_FIND_HIDE_CHANNEL,
  WINDOW_FIND_READY_CHANNEL,
  WINDOW_FIND_SHOW_CHANNEL,
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
const CHROMIUM_ERR_ABORTED = -3
const ALLOWED_RENDERER_PERMISSIONS = new Set(['clipboard-sanitized-write'])
const RECOVERABLE_RENDERER_EXIT_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure'
])
const sourcePreviewLoadMonitors = new WeakMap<BrowserWindow, SourcePreviewLoadMonitor>()
const sourcePreviewEmbedPolicies = new WeakMap<BrowserWindow, SourcePreviewEmbedPolicy>()
const sourcePreviewNavigationGuards = new WeakMap<BrowserWindow, SourcePreviewNavigationGuard>()

type SourcePreviewLoadMonitor = ReturnType<typeof createSourcePreviewLoadMonitor>
type SourcePreviewEmbedPolicy = ReturnType<typeof createSourcePreviewEmbedPolicy>
type SourcePreviewNavigationGuard = ReturnType<typeof createFrameNavigationGuard>

const clearSourcePreviewState = (window: BrowserWindow): void => {
  sourcePreviewLoadMonitors.get(window)?.clearAll()
  sourcePreviewEmbedPolicies.get(window)?.clearAll()
  sourcePreviewNavigationGuards.get(window)?.clearAll()
}

const loadRenderer = (window: BrowserWindow): Promise<void> => {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  }

  return window.loadFile(rendererEntry)
}

const createAppWindow = (options: BrowserWindowConstructorOptions): BrowserWindow => {
  const e2eWindowMode = process.env[E2E_WINDOW_MODE_ENV]
  const window = new BrowserWindow({
    show: false,
    autoHideMenuBar: process.platform !== 'linux',
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
      void shell.openExternal(details.url).catch((error) => {
        log.warn('external link open failed', diagnosticErrorFields(error))
      })
    }
    return { action: 'deny' }
  })
  const isAllowedRendererPermission = (
    requestingWebContents: WebContents | null,
    permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string }
  ): boolean => {
    const rendererUrl = window.webContents.getURL()
    return (
      rendererUrl !== '' &&
      requestingWebContents === window.webContents &&
      details.isMainFrame &&
      details.requestingUrl === rendererUrl &&
      ALLOWED_RENDERER_PERMISSIONS.has(permission)
    )
  }
  // Remote source pages share the main window Session but never need Chromium permissions. The
  // trusted renderer only needs sanitized clipboard writes; fail every other capability closed.
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) =>
      callback(isAllowedRendererPermission(webContents, permission, details))
  )
  window.webContents.session.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) =>
      isAllowedRendererPermission(webContents, permission, details)
  )
  const sourcePreviewLoadMonitor = createSourcePreviewLoadMonitor((state) => {
    window.webContents.send(SOURCE_PREVIEW_LOAD_STATE_CHANNEL, state)
  })
  const sourcePreviewEmbedPolicy = createSourcePreviewEmbedPolicy(window.webContents.id)
  const unregisterSourcePreviewWebRequestOwner = registerSourcePreviewWebRequestOwner(
    window.webContents.session,
    window.webContents.id,
    sourcePreviewLoadMonitor,
    sourcePreviewEmbedPolicy
  )
  const unregisterPreviewContextMenuBridge = installPreviewContextMenuBridge(
    window.webContents as unknown as PreviewContextMenuWebContents
  )
  window.on('closed', () => {
    clearSourcePreviewState(window)
    unregisterSourcePreviewWebRequestOwner()
    unregisterPreviewContextMenuBridge()
  })
  sourcePreviewLoadMonitors.set(window, sourcePreviewLoadMonitor)
  sourcePreviewEmbedPolicies.set(window, sourcePreviewEmbedPolicy)
  const isAllowedFrameNavigation = createFrameNavigationGuard(
    window.webContents.mainFrame,
    (frame, sourceUrl) => {
      sourcePreviewLoadMonitor.registerRoot(frame, sourceUrl)
      sourcePreviewEmbedPolicy.registerRoot(frame, sourceUrl)
    }
  )
  sourcePreviewNavigationGuards.set(window, isAllowedFrameNavigation)
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
  window.webContents.on(
    'did-frame-navigate',
    (_event, url, httpResponseCode, httpStatusText, _isMainFrame, processId, routingId) => {
      sourcePreviewLoadMonitor.finishNavigation(
        webFrameMain.fromId(processId, routingId) ?? { processId, routingId },
        url,
        httpResponseCode,
        httpStatusText
      )
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
  let windowFindOpenPending = false
  let windowFindAppearance: WindowFindAppearance = { theme: 'light', followsSystem: true }
  let rendererResponsive = true
  let rendererUnresponsiveAt: number | undefined
  let rendererRecoveryTimes: number[] = []
  let rendererRecoveryDialogOpen = false
  type PendingRendererLoad = { failureHandledByProcessExit: boolean }
  const pendingRendererLoadsByNavigationGeneration = new Map<number, Set<PendingRendererLoad>>()
  let mainFrameNavigationGeneration = 0
  const clearRendererHangState = (): void => {
    rendererResponsive = true
    rendererUnresponsiveAt = undefined
  }
  const rendererLoadErrorName = (error: unknown): string =>
    error instanceof Error ? error.name : 'UnknownError'
  function observeRendererLoad(initial: boolean): void {
    // The explicit load is expected to start one top-level navigation. Any later generation means a
    // reload or replacement navigation superseded this Promise before it settled.
    const ownedNavigationGeneration = mainFrameNavigationGeneration + 1
    const pendingLoad: PendingRendererLoad = { failureHandledByProcessExit: false }
    const loadsForGeneration =
      pendingRendererLoadsByNavigationGeneration.get(ownedNavigationGeneration) ??
      new Set<PendingRendererLoad>()
    loadsForGeneration.add(pendingLoad)
    pendingRendererLoadsByNavigationGeneration.set(ownedNavigationGeneration, loadsForGeneration)
    const releasePendingLoad = (): void => {
      loadsForGeneration.delete(pendingLoad)
      if (loadsForGeneration.size === 0) {
        pendingRendererLoadsByNavigationGeneration.delete(ownedNavigationGeneration)
      }
    }
    void loadRenderer(window).then(
      () => {
        releasePendingLoad()
      },
      (error) => {
        releasePendingLoad()
        log.error('renderer document load rejected', { errorName: rendererLoadErrorName(error) })
        if (window.isDestroyed()) return
        if (pendingLoad.failureHandledByProcessExit) return
        if (mainFrameNavigationGeneration > ownedNavigationGeneration) return
        if (initial) {
          // The startup shell waits for the resulting closed event and then lets the lifecycle create a
          // fresh window. A rejected load Promise is not guaranteed to reach its did-fail-load listener.
          // If crash recovery has already started, this is a stale rejection from the superseded initial
          // attempt; leave the recovery-owned window intact.
          if (rendererRecoveryTimes.length === 0) window.destroy()
          return
        }
        recoverRenderer('load-failed', true)
      }
    )
  }
  function recoverRenderer(reason: string, loadFailed = false): void {
    if (window.isDestroyed()) return

    const now = Date.now()
    rendererRecoveryTimes = rendererRecoveryTimes.filter(
      (recoveryAt) => now - recoveryAt < RENDERER_RECOVERY_WINDOW_MS
    )
    if (rendererRecoveryTimes.length < MAX_AUTOMATIC_RENDERER_RECOVERIES) {
      rendererRecoveryTimes.push(now)
      if (loadFailed) {
        log.warn('reloading renderer after document load failure', {
          automaticRecoveryAttempt: rendererRecoveryTimes.length
        })
      } else {
        log.warn('reloading renderer after process exit', {
          reason,
          automaticRecoveryAttempt: rendererRecoveryTimes.length
        })
      }
      observeRendererLoad(false)
      return
    }

    if (rendererRecoveryDialogOpen) return
    rendererRecoveryDialogOpen = true
    log.error('renderer automatic recovery paused after repeated exits', {
      reason,
      automaticRecoveries: rendererRecoveryTimes.length,
      recoveryWindowMs: RENDERER_RECOVERY_WINDOW_MS
    })
    void dialog
      .showMessageBox(window, {
        type: 'error',
        buttons: [translate('Reload', { context: 'window' }), translate('Close window')],
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
            observeRendererLoad(false)
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
    windowFindOpenPending = false
    findOverlay.close()
  }
  const onWindowFindContentReady = (event: IpcMainEvent): void => {
    if (
      event.sender !== window.webContents ||
      !windowFindListenerReady ||
      !rendererResponsive ||
      (!windowFindOpenPending && !findOverlay.isOpen())
    )
      return
    windowFindOpenPending = false
    findOverlay.open()
  }
  const onWindowFindAppearanceChanged = (event: IpcMainEvent, appearance: unknown): void => {
    if (event.sender !== window.webContents || !isWindowFindAppearance(appearance)) return
    windowFindAppearance = appearance
    findOverlay.updateAppearance(appearance)
    mainWindowCloseOptions.get(window)?.onAppearanceChanged?.(appearance)
  }
  const onSourcePreviewRelease = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== window.webContents || typeof value !== 'string') return
    const sourceUrl = parseHttpsSourceUrl(value)
    if (!sourceUrl) return

    sourcePreviewLoadMonitors.get(window)?.releaseSource(sourceUrl.href)
    sourcePreviewEmbedPolicies.get(window)?.releaseSource(sourceUrl.href)
    sourcePreviewNavigationGuards.get(window)?.releaseSource(sourceUrl.href)
  }
  ipcMain.on(CLOSE_ACTIVE_PANE_READY_CHANNEL, onListenerReady)
  ipcMain.on(CLOSE_ACTIVE_PANE_UNREADY_CHANNEL, onListenerGone)
  ipcMain.on(WINDOW_FIND_READY_CHANNEL, onWindowFindReady)
  ipcMain.on(WINDOW_FIND_UNREADY_CHANNEL, onWindowFindGone)
  ipcMain.on(WINDOW_FIND_CONTENT_READY_CHANNEL, onWindowFindContentReady)
  ipcMain.on(WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL, onWindowFindAppearanceChanged)
  ipcMain.on(SOURCE_PREVIEW_RELEASE_CHANNEL, onSourcePreviewRelease)
  // A top-level document swap replaces the mounted hook, which must re-subscribe; a dead render process
  // took its listener with it. Both revoke readiness until the next READY handshake. Gate on the main
  // frame and a real document change so a dynamic preview iframe loading (or a same-document hash /
  // pushState navigation) — neither of which remounts the hook — does not falsely disarm the forward.
  window.webContents.on('did-start-navigation', (details) => {
    sourcePreviewLoadMonitors
      .get(window)
      ?.startNavigation(details.frame, details.url, details.isSameDocument)
    if (details.isMainFrame && !details.isSameDocument) {
      mainFrameNavigationGeneration += 1
      clearSourcePreviewState(window)
      rendererListenerReady = false
      windowFindListenerReady = false
      windowFindOpenPending = false
      findOverlay.close()
    }
  })
  // Keep renderer bootstrap failures diagnosable without persisting the failed URL, preload path, or
  // error message (all of which can contain local paths or Session-derived data).
  window.webContents.on(
    'did-fail-load',
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId
    ) => {
      sourcePreviewLoadMonitors.get(window)?.failNavigation(
        webFrameMain.fromId(frameProcessId, frameRoutingId) ?? {
          processId: frameProcessId,
          routingId: frameRoutingId
        },
        validatedURL,
        errorCode,
        errorDescription
      )
      if (!isMainFrame) return
      log.error('renderer document failed to load', { errorCode, errorDescription })
      // Chromium reports a superseded navigation as ERR_ABORTED after the replacement navigation may
      // already be current. Recovering that canceled document would overwrite the valid replacement.
      if (errorCode === CHROMIUM_ERR_ABORTED) return
      // Explicit loadRenderer attempts are observed through their Promise so one Chromium failure only
      // consumes one recovery slot. A later top-level navigation has no pending Promise owner, so route
      // its failure through the same bounded recovery used for renderer process exits.
      if (!pendingRendererLoadsByNavigationGeneration.has(mainFrameNavigationGeneration)) {
        recoverRenderer('load-failed', true)
      }
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
    windowFindOpenPending = false
    clearRendererHangState()
    findOverlay.close()
    clearSourcePreviewState(window)

    if (!RECOVERABLE_RENDERER_EXIT_REASONS.has(details.reason) || window.isDestroyed()) return

    // The load can own the current generation (navigation already started) or the next generation
    // (the process exited before did-start-navigation). In both cases this process-exit path owns the
    // recovery decision, so a later rejection from that same load must not consume another slot.
    for (const generation of [mainFrameNavigationGeneration, mainFrameNavigationGeneration + 1]) {
      for (const pendingLoad of pendingRendererLoadsByNavigationGeneration.get(generation) ?? []) {
        pendingLoad.failureHandledByProcessExit = true
      }
    }
    recoverRenderer(details.reason)
  })
  window.webContents.on('unresponsive', () => {
    if (rendererResponsive) {
      rendererUnresponsiveAt = Date.now()
      log.warn('renderer became unresponsive')
    }
    rendererResponsive = false
    windowFindOpenPending = false
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
    ipcMain.removeListener(WINDOW_FIND_CONTENT_READY_CHANNEL, onWindowFindContentReady)
    ipcMain.removeListener(WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL, onWindowFindAppearanceChanged)
    ipcMain.removeListener(SOURCE_PREVIEW_RELEASE_CHANNEL, onSourcePreviewRelease)
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
        windowFindOpenPending = true
        window.webContents.send(WINDOW_FIND_SHOW_CHANNEL, windowFindAppearance)
      }
      return
    }

    // Escape closes an open find bar even when focus has wandered into the main content — the overlay's
    // own handler covers the input-focused case, this covers the rest.
    if (
      input.type === 'keyDown' &&
      input.key === 'Escape' &&
      (windowFindOpenPending || findOverlay.isOpen())
    ) {
      event.preventDefault()
      if (windowFindOpenPending) {
        windowFindOpenPending = false
        if (findOverlay.isOpen()) findOverlay.close()
        else window.webContents.send(WINDOW_FIND_HIDE_CHANNEL)
      } else findOverlay.close()
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
        else if (choice === 'quit') closeOptions!.requestQuit(false)
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

  observeRendererLoad(true)
  return window
}

export { configureMainWindow, createMainWindow }
export type { MainWindowCloseOptions }
