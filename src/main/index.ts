import { fileURLToPath } from 'node:url'

// Only lightweight, Electron-free diagnostics and argv flags are imported statically here. The MCP
// server modules (and their heavy SDK graph) remain lazy inside the matching execution branch.
import {
  ARTIFACT_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_ARG,
  PLAN_MCP_SERVER_ARG,
  REVIEWER_MCP_PROXY_ARG,
  SKILL_IMPORT_MCP_SERVER_ARG
} from './mcp-server-args'
import { withApplicationRuntimeShutdown } from './application-runtime'
import { installChildProcessGoneLogging, startLocalCrashReporting } from './crash-diagnostics'
import type { DiagnosticOperation } from './diagnostics/operation'
import {
  initializeApplicationDiagnostics,
  reportApplicationStartupFailure
} from './diagnostics/startup'
import { createLogger, diagnosticErrorFields, flushLogs } from './logger'
import {
  createRendererFailureReporter,
  registerRendererDiagnosticsIpc
} from './renderer-diagnostics'

const APP_NAME = 'Open Science'
const APP_USER_MODEL_ID = 'com.aipoch.open-science'
const shouldRunArtifactMcpServer = process.argv.includes(ARTIFACT_MCP_SERVER_ARG)
const shouldRunNotebookMcpServer = process.argv.includes(NOTEBOOK_MCP_SERVER_ARG)
const shouldRunReviewerMcpProxy = process.argv.includes(REVIEWER_MCP_PROXY_ARG)
const shouldRunSkillImportMcpServer = process.argv.includes(SKILL_IMPORT_MCP_SERVER_ARG)
const shouldRunPlanMcpServer = process.argv.includes(PLAN_MCP_SERVER_ARG)
let startupDiagnostics: DiagnosticOperation | undefined
let startupFlush = flushLogs

if (shouldRunArtifactMcpServer) {
  // Reuse the packaged entry point as a Node stdio MCP server; import it only in this mode.
  void import('./artifacts/mcp-server')
    .then(({ runArtifactMcpServer }) => runArtifactMcpServer())
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
} else if (shouldRunNotebookMcpServer) {
  // Keep notebook MCP mode as a Node stdio process that proxies to the app-owned runtime.
  void import('./notebook/mcp-server')
    .then(({ runNotebookMcpServer }) => runNotebookMcpServer())
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
} else if (shouldRunReviewerMcpProxy) {
  void import('./reviewer/mcp-stdio-proxy')
    .then(({ runReviewerMcpStdioProxy }) => runReviewerMcpStdioProxy())
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
} else if (shouldRunSkillImportMcpServer) {
  void import('./skills/mcp-server')
    .then(({ runSkillImportMcpServer }) => runSkillImportMcpServer())
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
} else if (shouldRunPlanMcpServer) {
  void import('./session-plan/plan-mcp-server')
    .then(({ runPlanMcpServer }) => runPlanMcpServer())
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
} else {
  void startElectronApp(fileURLToPath(import.meta.url)).catch(async (error: unknown) => {
    await reportApplicationStartupFailure({
      operation: startupDiagnostics,
      error,
      flush: startupFlush
    })
    console.error(error)
    process.exitCode = 1
  })
}

// Boots the Electron app only in normal UI mode, keeping artifact MCP mode free of Electron imports.
async function startElectronApp(mainEntryPath: string): Promise<void> {
  const { app, BrowserWindow, crashReporter, ipcMain, nativeImage, protocol } =
    await import('electron')

  // Establish identity and single-writer ownership before opening main.log. A secondary launch must
  // never rotate or append to the primary process's file sink. These two modules are lightweight; all
  // backend imports remain behind the lock.
  app.setName(app.isPackaged ? APP_NAME : `${APP_NAME} (DEV)`)
  const [{ acquireSingleInstanceLock }, { createSecondInstanceRelay, orchestrateAppStartup }] =
    await Promise.all([import('./single-instance'), import('./app-startup')])
  const preStartupSecondInstanceRelay = createSecondInstanceRelay()
  if (
    !acquireSingleInstanceLock({
      onSecondInstance: (argv) => preStartupSecondInstanceRelay.signal(argv)
    })
  ) {
    app.quit()
    return
  }

  // Initialize the file sink after the primary lock but before assets, the backend graph, and
  // app.whenReady so packaged startup failures remain locally diagnosable.
  const diagnostics = initializeApplicationDiagnostics({
    logDir: app.getPath('logs'),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node
  })
  const { log } = diagnostics
  startupDiagnostics = diagnostics.operation
  startupFlush = diagnostics.flush

  // Register process-level failure capture before loading the application modules. Keep renderer
  // diagnostics on a separate, one-way channel while the central IPC registry is being refactored.
  installChildProcessGoneLogging((listener) => app.on('child-process-gone', listener), log)
  process.on('uncaughtException', (error) =>
    log.error('uncaughtException', diagnosticErrorFields(error))
  )
  process.on('unhandledRejection', (reason) =>
    log.error('unhandledRejection', diagnosticErrorFields(reason))
  )
  registerRendererDiagnosticsIpc(
    ipcMain,
    createRendererFailureReporter({ log: createLogger('renderer') })
  )

  startupDiagnostics.phase('load-bootstrap-modules')
  const [
    { electronApp },
    { default: icon },
    { default: iconDark },
    { default: iconWindows },
    { default: iconDarkWindows },
    { default: trayMacTemplate },
    { default: trayLightWindows },
    { default: trayDarkWindows },
    { default: trayLinux }
  ] = await Promise.all([
    import('@electron-toolkit/utils'),
    import('../../resources/icon.png?asset'),
    import('../../resources/icon-dark.png?asset'),
    import('../../resources/icon-light.ico?asset'),
    import('../../resources/icon-dark.ico?asset'),
    import('../../resources/trayTemplate.png?asset'),
    import('../../resources/tray-light.ico?asset'),
    import('../../resources/tray-dark.ico?asset'),
    import('../../resources/tray.png?asset')
  ])

  // Windows gets multi-resolution ICOs for title-bar and Alt-Tab fidelity; macOS Dock and Linux use
  // lossless 1024px PNGs. The settings preview is built from the same platform-specific source.
  const iconVariantPaths =
    process.platform === 'win32'
      ? { light: iconWindows, dark: iconDarkWindows }
      : { light: icon, dark: iconDark }
  // The static fallback on Windows stays the dark tile: it is byte-identical to the legacy tray.ico,
  // so a missing/unreadable variant asset degrades to the pre-change appearance.
  const trayIconPath =
    process.platform === 'win32' ? trayDarkWindows : process.platform === 'linux' ? trayLinux : icon
  // Windows keeps one tray tile per app-icon variant so the tray glyph can follow the variant the
  // user picks in settings (setTrayIconVariant); other platforms use a single static tray icon.
  const trayVariantIconPaths =
    process.platform === 'win32' ? { light: trayLightWindows, dark: trayDarkWindows } : undefined

  // Ordered startup: the single-instance lock is acquired FIRST (UI path only — the MCP stdio server
  // modes never reach startElectronApp), so a secondary launch quits before prepare() imports any
  // backend module or spawns a duplicate process tree. prepare() then does the heavy post-lock work and
  // returns the handles the migration guard and lifecycle need; the guard is installed before the
  // lifecycle so its before-quit runs first. A second launch that arrives mid-startup is recorded by the
  // relay and surfaced once the window exists.
  await orchestrateAppStartup({
    diagnostics: startupDiagnostics,
    // The OS lock is already held. Bind the orchestrator's relay to the pre-logger relay so any
    // second-instance signal received during bootstrap is preserved until the lifecycle is ready.
    acquireSingleInstanceLock: ({ onSecondInstance }) => {
      preStartupSecondInstanceRelay.bind(onSecondInstance)
      return true
    },
    quit: () => app.quit(),
    prepare: async () => {
      // Start Windows Crashpad after the single-instance lock but before any BrowserWindow can create
      // a renderer. Upload stays disabled: dumps remain local for explicit support collection. Without
      // this initialization the affected Windows renderer failures surface only as
      // Crashpad_NotConnectedToHandler, which masks the native crash that caused the white window.
      const crashReporting = startLocalCrashReporting({
        platform: process.platform,
        productName: APP_NAME,
        companyName: 'aipoch',
        appVersion: app.getVersion(),
        start: (options) => crashReporter.start(options)
      })
      startupDiagnostics?.phase('crash-reporting', { enabled: crashReporting.enabled })

      startupDiagnostics?.phase('load-application-modules')
      const [
        { registerIpcHandlers },
        { createMainWindow },
        { MANAGED_PREVIEW_SCHEME },
        { OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG },
        { installMigrationQuitGuard, isMigrationInProgress },
        { createAppTray, setTrayIconVariant },
        { installAppLifecycle },
        { disposeIpcHandlerRegistry },
        { parseWebModeOptions, createWebServiceController, buildAuthenticatedWebUrl },
        { routeSecondInstance },
        { createElectronCloseConfirm },
        { createElectronSessionPersistenceFlush },
        { installWindowShortcuts },
        { createAppIconController, buildAppIconPreviews },
        { RemoteAccessService, registerRemoteAccessIpcHandlers },
        { createDesktopAttentionController, wireDesktopAttention },
        { createDesktopBadgeAdapter, createWindowsBadgeBitmap },
        { UnreadTaskDbRepository },
        { createUnreadTaskController, wireUnreadTaskController },
        { bindUnreadTaskDeletionRuntime },
        { registerUnreadTaskIpc },
        { getProjectDbClient },
        { resolveStorageRoot }
      ] = await Promise.all([
        import('./ipc'),
        import('./windows'),
        import('./managed-preview-resources'),
        import('./office-preview/office-preview-runtime-protocol'),
        import('./storage/migration-state'),
        import('./tray'),
        import('./app-lifecycle'),
        import('./ipc-handler-registry'),
        import('./web-service'),
        import('./second-instance-router'),
        import('./window-close-confirm'),
        import('./session-persistence/renderer-flush'),
        import('./window-shortcuts'),
        import('./app-icon'),
        import('./remote-access'),
        import('./notifications/desktop-attention'),
        import('./notifications/desktop-badge'),
        import('./notifications/unread-task-repository'),
        import('./notifications/unread-task-controller'),
        import('./notifications/task-notification-runtime'),
        import('./notifications/unread-task-ipc'),
        import('./projects/prisma-client'),
        import('./storage-root')
      ])

      protocol.registerSchemesAsPrivileged([
        MANAGED_PREVIEW_SCHEME,
        OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG
      ])

      startupDiagnostics?.phase('electron-ready')
      await app.whenReady()
      startupDiagnostics?.phase('compose-runtime')

      // Set app user model id for windows
      electronApp.setAppUserModelId(APP_USER_MODEL_ID)

      // Forward F12 / Cmd-R blocking from `@electron-toolkit/utils`' `optimizer.watchWindowShortcuts`
      // to every window (main + future preview windows). The helper is invoked with `zoom: true` so
      // Cmd/Ctrl+=, Cmd/Ctrl+-, and Cmd/Ctrl+0 reach Electron's built-in zoomIn / zoomOut /
      // resetZoom menu accelerators — without that, its before-input-event listener calls
      // preventDefault() on Cmd+- and Cmd+= and silently disables zoom out / reset (issue #336).
      installWindowShortcuts(app)

      // Held in a box (not a bare let) so the settings IPC callback registered below can reach the icon
      // controller, which itself needs the persisted variant that only exists once settingsService is
      // constructed. The change callback only fires on a user action (well after startup), so the
      // controller is always set by then. Mirrors the trayBox late-binding pattern in app-lifecycle.ts.
      const appIconControllerBox: {
        current: ReturnType<typeof createAppIconController> | undefined
      } = { current: undefined }
      // Late-bound tray handle so the settings IPC below can restyle the tray when the user switches
      // the app icon variant — the tray only exists once the lifecycle is installed (assigned in the
      // createTray callback). Mirrors the trayBox late-binding pattern in app-lifecycle.ts.
      const appTrayBox: { current: ReturnType<typeof createAppTray> } = { current: undefined }
      // Unread state restores before the main-window lifecycle is installed. Late-bind its getter so
      // restoration remains window-independent while later badge/probe calls always target the live window.
      const mainWindowGetterBox: {
        current: (() => InstanceType<typeof BrowserWindow> | undefined) | undefined
      } = { current: undefined }

      const webMode = parseWebModeOptions(process.argv)
      // Pass the concrete main entry path so ACP can launch the artifact MCP server from the same bundle.
      const {
        applicationCommands,
        applicationEvents,
        bindRemoteAccess,
        taskNotifications,
        settingsService,
        taskAgent,
        sessionDeletionCapability,
        detectActiveSessions,
        prepareForQuit,
        dispose: disposeApplicationRuntime
      } = await registerIpcHandlers({
        mainEntryPath,
        handoffRuntime: 'production',
        headless: webMode.headless,
        onAppIconVariantChanged: (variant) => {
          appIconControllerBox.current?.setVariant(variant)
          // Keep the tray glyph on the same variant as the window icon. No-op before the lifecycle
          // installs the tray, or off Windows (single static tray asset there).
          if (appTrayBox.current && trayVariantIconPaths) {
            setTrayIconVariant(appTrayBox.current, trayVariantIconPaths, variant)
          }
        },
        listAppIconPreviews: () => buildAppIconPreviews(nativeImage, iconVariantPaths)
      })

      // The controller must exist before its IPC responder, while the responder calls back into the
      // controller. This box breaks that startup cycle without exposing unread ownership to renderer.
      const visibilityProbeBox: {
        current: ReturnType<typeof registerUnreadTaskIpc> | undefined
      } = { current: undefined }
      const unreadTaskRepository = new UnreadTaskDbRepository(() =>
        getProjectDbClient(resolveStorageRoot())
      )
      const unreadTaskController = createUnreadTaskController({
        headless: webMode.headless,
        // Only the main conversation window can acknowledge a visible session. A focused preview
        // window must not clear unread state for the conversation underneath it.
        isAppFocused: () => mainWindowGetterBox.current?.()?.isFocused() ?? false,
        repository: unreadTaskRepository,
        confirmSessionVisible: (sessionId) =>
          visibilityProbeBox.current?.confirmSessionVisible(sessionId) ?? Promise.resolve(false),
        badge: createDesktopBadgeAdapter({
          platform: process.platform,
          setBadgeCount: (count) => app.setBadgeCount(count),
          isUnityRunning: () => app.isUnityRunning(),
          getMainWindow: () => mainWindowGetterBox.current?.(),
          createWindowsOverlay: (label) =>
            nativeImage.createFromBitmap(createWindowsBadgeBitmap(label), {
              width: 16,
              height: 16,
              scaleFactor: 1
            }),
          onError: (error) => log.warn('desktop unread badge failed', error)
        }),
        onError: (error) => log.warn('unread task state failed', error)
      })
      await unreadTaskController.restore()
      // Bind deletion recovery before a window can load Sessions. A complete main-process scan is
      // the sole authority for pruning unread rows; renderer hydration never projects its catalog.
      bindUnreadTaskDeletionRuntime({
        headless: webMode.headless,
        unreadController: unreadTaskController,
        unreadTaskRepository,
        sessionPersistenceCoordinator: sessionDeletionCapability
      })
      visibilityProbeBox.current = registerUnreadTaskIpc({
        getMainWindow: () => mainWindowGetterBox.current?.(),
        controller: unreadTaskController,
        onError: (error) => log.warn('unread task IPC failed', error)
      })
      // Apply the persisted icon variant now and keep it in sync as windows come and go. Created
      // unconditionally — even a headless launch can later surface a desktop window on a plain second
      // launch (routeSecondInstance -> showMainWindow), and that window plus any live icon-setting
      // change must still pick up the variant. Construction is safe headless: the dock is set on macOS
      // (as the pre-existing startup code did unconditionally) and the window loop is a no-op until the
      // browser-window-created listener sees the first window. The controller owns the macOS dock icon.
      const initialVariant = await settingsService.getAppIconVariant()
      appIconControllerBox.current = createAppIconController({
        electron: { app, getAllWindows: () => BrowserWindow.getAllWindows(), nativeImage },
        variantPaths: iconVariantPaths,
        initialVariant
      })
      const remoteAccess = await RemoteAccessService.create()
      bindRemoteAccess(remoteAccess)
      const webController = createWebServiceController({
        applicationCommands,
        requestQuit: () => app.quit(),
        externalAccess: remoteAccess.webAccess,
        applicationEvents,
        taskAgent
      })
      remoteAccess.attachWebController(webController)
      registerRemoteAccessIpcHandlers(remoteAccess)
      // A launch that itself requested serving (a dedicated headless daemon, or an explicit --serve) is
      // not attached: stopping it quits the process. On-demand starts for a running instance are attached.
      if (webMode.enabled) await webController.ensureStarted(webMode.port, { attached: false })
      // Restore a persisted remote-access preference only after the normal IPC/web surfaces exist.
      // A missing or signed-out third-party remote-access installation must never delay the desktop window.
      void remoteAccess.restore()

      return {
        installMigrationQuitGuard,
        isMigrationInProgress,
        createMainWindow,
        createAppTray,
        buildAuthenticatedWebUrl,
        routeSecondInstance,
        taskNotifications,
        unreadTaskController,
        mainWindowGetterBox,
        settingsService,
        appTrayBox,
        // Read through the controller (not a snapshot) so a tray created after a settings change —
        // e.g. a headless web client flipping the variant mid-startup — starts on the live value.
        getAppIconVariant: () => appIconControllerBox.current?.getVariant() ?? initialVariant,
        disposeApplicationRuntime,
        detectActiveSessions,
        prepareForQuit,
        createSessionPersistenceFlush: (
          getWindow: () => InstanceType<typeof BrowserWindow> | undefined
        ) => createElectronSessionPersistenceFlush(getWindow),
        createConfirmClose: (getWindow: () => InstanceType<typeof BrowserWindow> | undefined) =>
          createElectronCloseConfirm(getWindow, {
            get: () => settingsService.getClosePreference(),
            set: async (preference) => {
              await settingsService.setClosePreference(preference)
            }
          }),
        installAppLifecycle,
        createDesktopAttentionController,
        wireDesktopAttention,
        wireUnreadTaskController,
        log,
        webMode,
        webController,
        remoteAccess,
        disposeIpcHandlerRegistry
      }
    },
    // Warn (rather than silently tear down) if the user tries to quit mid data-root migration. Installed
    // BEFORE the lifecycle so its before-quit runs first: a migration it cancels leaves
    // event.defaultPrevented set, which the lifecycle's quit cleanup honors.
    installMigrationQuitGuard: (ctx) => ctx.installMigrationQuitGuard(app),
    // Install the tray, first window, and the quit/activate/window-all-closed handlers. shutdownBackends
    // is bound with the live backend handles; the agent teardown latches shutting-down and awaits the
    // process tree so a Windows taskkill /T completes before app.exit.
    installAppLifecycle: (ctx) => {
      const { showMainWindow, getMainWindow, isMainWindowHidden } = ctx.installAppLifecycle(
        withApplicationRuntimeShutdown(
          {
            app,
            createMainWindow: ctx.createMainWindow,
            createTray: (handlers) => {
              const webPort = ctx.webController.runningPort()
              const headlessWeb = ctx.webMode.headless && webPort !== undefined
              const tray = ctx.createAppTray({
                iconPath: trayIconPath,
                variantIconPaths: trayVariantIconPaths,
                initialVariant: ctx.getAppIconVariant(),
                templateIconPath: process.platform === 'darwin' ? trayMacTemplate : undefined,
                ...handlers,
                ...(headlessWeb
                  ? {
                      headless: true,
                      onOpenWeb: async () => {
                        const { shell } = await import('electron')
                        await shell.openExternal(await ctx.buildAuthenticatedWebUrl(webPort))
                      },
                      onCopyWebUrl: async () => {
                        const { clipboard } = await import('electron')
                        clipboard.writeText(await ctx.buildAuthenticatedWebUrl(webPort))
                      }
                    }
                  : {})
              })
              // Publish the tray so a later settings change can restyle it (onAppIconVariantChanged).
              ctx.appTrayBox.current = tray
              return tray
            },
            isMigrationInProgress: ctx.isMigrationInProgress,
            quit: () => app.quit(),
            countWindows: () => BrowserWindow.getAllWindows().length,
            createInitialWindow: !ctx.webMode.headless,
            detectActiveSessions: ctx.detectActiveSessions,
            prepareForQuit: ctx.prepareForQuit,
            flushSessionPersistence: ctx.createSessionPersistenceFlush(() =>
              ctx.mainWindowGetterBox.current?.()
            ),
            createConfirmClose: ctx.createConfirmClose,
            log: ctx.log,
            flushLogs
          },
          {
            // Application composition owns the one bounded ACP/Notebook shutdown. Remaining surfaces
            // close afterward in their established order, even when an earlier disposer rejects.
            disposeApplicationRuntime: ctx.disposeApplicationRuntime,
            remoteAccess: ctx.remoteAccess,
            webController: ctx.webController,
            disposeIpcHandlers: ctx.disposeIpcHandlerRegistry,
            log: ctx.log
          }
        )
      )

      // Window lifecycle now exists: expose it to the restored controller, reapply any Windows
      // overlay to the first window, then attach completion/focus/window-recreation events.
      ctx.mainWindowGetterBox.current = getMainWindow
      ctx.unreadTaskController.refreshBadge()

      const desktopAttention = ctx.createDesktopAttentionController({
        platform: process.platform,
        headless: ctx.webMode.headless,
        isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
        isMainWindowHidden,
        getMainWindow,
        ...(process.platform === 'darwin' ? { dock: app.dock } : {}),
        onError: (error) => ctx.log.warn('desktop attention failed', error)
      })
      ctx.wireUnreadTaskController({
        app,
        taskNotifications: ctx.taskNotifications,
        controller: ctx.unreadTaskController
      })
      ctx.wireDesktopAttention({
        app,
        taskNotifications: ctx.taskNotifications,
        controller: desktopAttention
      })

      // Clicking a task notification surfaces the app and records which conversation to open. The
      // renderer pulls the target once its sessions are hydrated (take-pending-open-session), so a
      // click that recreates the window cannot lose the navigation — the send below is only a
      // nudge for an already-running renderer and may safely be lost otherwise.
      ctx.taskNotifications.setActivationHandler((sessionId) => {
        const window = showMainWindow()
        if (!sessionId) return

        // The renderer pulls the click target once its sessions are hydrated.
        ctx.taskNotifications.setPendingOpenSession(sessionId)
        window.webContents.send('notifications:open-session')
      })

      // Route each second launch by its forwarded argv (see second-instance-router): a CLI
      // `open-science start` forwards --serve/--open-science-headless → start the web service on demand
      // here (attached); a plain re-launch (double-click) → surface the existing window as before.
      const onSecondInstance = (argv: string[]): void =>
        ctx.routeSecondInstance(argv, {
          ensureWebService: ctx.webController.ensureStarted,
          showMainWindow,
          onError: (error) => ctx.log.error('on-demand web service start failed', error)
        })
      return { onSecondInstance }
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
