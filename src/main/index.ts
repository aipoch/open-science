import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

// Only lightweight, Electron-free bootstrap modules are imported statically here. The MCP server
// modules (and their heavy SDK graph) remain lazy inside the matching execution branch.
import {
  ARTIFACT_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_ARG,
  PLAN_MCP_SERVER_ARG,
  REVIEWER_MCP_PROXY_ARG,
  SKILL_IMPORT_MCP_SERVER_ARG,
  SKILL_RUNTIME_MCP_SERVER_ARG
} from './mcp-server-args'
import { createApplicationLifecycleShutdown } from './application-runtime'
import { installChildProcessGoneLogging, startLocalCrashReporting } from './crash-diagnostics'
import type { DiagnosticOperation } from './diagnostics/operation'
import {
  initializeApplicationDiagnostics,
  reportApplicationStartupFailure
} from './diagnostics/startup'
import { createLogger, diagnosticErrorFields, flushLogs, writeFatalLogSync } from './logger'
import { MANAGED_PREVIEW_SCHEME } from './managed-preview-resources'
import { OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG } from './office-preview/office-preview-runtime-protocol'
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
const shouldRunSkillRuntimeMcpServer = process.argv.includes(SKILL_RUNTIME_MCP_SERVER_ARG)
const shouldRunPlanMcpServer = process.argv.includes(PLAN_MCP_SERVER_ARG)
const bootstrapLog = createLogger('bootstrap')
let startupDiagnostics: DiagnosticOperation | undefined
let startupFlush = flushLogs

if (shouldRunArtifactMcpServer) {
  // Reuse the packaged entry point as a Node stdio MCP server; import it only in this mode.
  void import('./artifacts/mcp-server')
    .then(({ runArtifactMcpServer }) => runArtifactMcpServer())
    .catch((error: unknown) => {
      bootstrapLog.error('artifact MCP server failed', error)
      process.exitCode = 1
    })
} else if (shouldRunNotebookMcpServer) {
  // Keep notebook MCP mode as a Node stdio process that proxies to the app-owned runtime.
  void import('./notebook/mcp-server')
    .then(({ runNotebookMcpServer }) => runNotebookMcpServer())
    .catch((error: unknown) => {
      bootstrapLog.error('notebook MCP server failed', error)
      process.exitCode = 1
    })
} else if (shouldRunReviewerMcpProxy) {
  void import('./reviewer/mcp-stdio-proxy')
    .then(({ runReviewerMcpStdioProxy }) => runReviewerMcpStdioProxy())
    .catch((error: unknown) => {
      bootstrapLog.error('reviewer MCP proxy failed', error)
      process.exitCode = 1
    })
} else if (shouldRunSkillImportMcpServer) {
  void import('./skills/mcp-server')
    .then(({ runSkillImportMcpServer }) => runSkillImportMcpServer())
    .catch((error: unknown) => {
      bootstrapLog.error('skill import MCP server failed', error)
      process.exitCode = 1
    })
} else if (shouldRunSkillRuntimeMcpServer) {
  void import('./skills/runtime-mcp-server')
    .then(({ runSkillRuntimeMcpServer }) => runSkillRuntimeMcpServer())
    .catch((error: unknown) => {
      bootstrapLog.error('skill runtime MCP server failed', error)
      process.exitCode = 1
    })
} else if (shouldRunPlanMcpServer) {
  void import('./session-plan/plan-mcp-server')
    .then(({ runPlanMcpServer }) => runPlanMcpServer())
    .catch((error: unknown) => {
      bootstrapLog.error('plan MCP server failed', error)
      process.exitCode = 1
    })
} else {
  void startElectronApp(fileURLToPath(import.meta.url)).catch(async (error: unknown) => {
    bootstrapLog.error('application startup failed', diagnosticErrorFields(error))
    await reportApplicationStartupFailure({
      operation: startupDiagnostics,
      error,
      flush: startupFlush
    })
    const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')
    app.exit(1)
  })
}

// Boots the Electron app only in normal UI mode, keeping artifact MCP mode free of Electron imports.
async function startElectronApp(mainEntryPath: string): Promise<void> {
  const {
    app,
    BrowserWindow,
    crashReporter,
    ipcMain,
    nativeImage,
    nativeTheme,
    powerMonitor,
    protocol
  } = createRequire(import.meta.url)('electron') as typeof import('electron')

  // Electron accepts privileged schemes only before app ready. Keep this in the synchronous UI
  // bootstrap before any awaited import can yield to the ready event.
  protocol.registerSchemesAsPrivileged([
    MANAGED_PREVIEW_SCHEME,
    OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG
  ])

  // Establish identity and single-writer ownership before opening main.log. A secondary launch must
  // never rotate or append to the primary process's file sink. These two modules are lightweight; all
  // backend imports remain behind the lock.
  app.setName(app.isPackaged ? APP_NAME : `${APP_NAME} (DEV)`)
  // Unpackaged isolate: a second electron-vite from a worktree would otherwise lose the
  // macOS bundle-id lock and attach to an already-running main `npm run dev`.
  if (!app.isPackaged) {
    const isolateUserData = process.env.OPEN_SCIENCE_USER_DATA?.trim()
    if (isolateUserData) {
      if (!isAbsolute(isolateUserData)) {
        throw new Error('OPEN_SCIENCE_USER_DATA must be an absolute path.')
      }
      app.setPath('userData', isolateUserData)
    }
  }
  const allowMultiInstance =
    !app.isPackaged && process.env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE === '1'
  const [
    { acquireSingleInstanceLock },
    {
      createSecondInstanceRelay,
      createStartupWindowCloseOptions,
      createStartupWindowSecondInstanceHandler,
      orchestrateAppStartup,
      prepareVisibleStartupRuntime,
      waitForStartupShell
    },
    { parseWebModeOptions },
    { installSystemLifecycleAdapters }
  ] = await Promise.all([
    import('./single-instance'),
    import('./app-startup'),
    import('./web-service/options'),
    import('./system-lifecycle-adapters')
  ])
  const preStartupSecondInstanceRelay = createSecondInstanceRelay()
  if (
    !allowMultiInstance &&
    !acquireSingleInstanceLock({
      onSecondInstance: (argv) => preStartupSecondInstanceRelay.signal(argv)
    })
  ) {
    app.quit()
    return
  }
  const webMode = parseWebModeOptions(process.argv)
  let bindSystemShutdownWindow = (window: InstanceType<typeof BrowserWindow>): void => {
    void window
  }
  let installPowerMonitorListeners = (): void => {}

  // Initialize the file sink after the primary lock but before assets, the backend graph, and
  // app.whenReady so packaged startup failures remain locally diagnosable.
  const diagnostics = initializeApplicationDiagnostics({
    logDir: app.getPath('logs'),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    cpuUsage: process.cpuUsage
  })
  const { log } = diagnostics
  startupDiagnostics = diagnostics.operation
  startupFlush = diagnostics.flush
  // Disk classification is diagnostic only. Do not await it on the path to failure capture,
  // bootstrap assets, or the first window; log the result whenever the probe settles.
  void import('./diagnostics/startup-storage-probe')
    .then(({ timedStartupStorageProbe }) =>
      timedStartupStorageProbe({ probeDir: app.getPath('logs') }, 1_500)
    )
    .then((storageProbe) => {
      log.info('startup storage probe', storageProbe)
    })
    .catch(() => undefined)

  // Register process-level failure capture before loading the application modules. Keep renderer
  // diagnostics on a separate, one-way channel while the central IPC registry is being refactored.
  installChildProcessGoneLogging((listener) => app.on('child-process-gone', listener), log)
  // Observe fatal JavaScript failures without consuming Node's default non-zero termination. A
  // consuming uncaughtException/unhandledRejection listener would leave Electron serving IPC and
  // mutating durable state after application invariants became unknown. The monitor also receives
  // unhandled rejections promoted by Node's default `throw` mode, preserving their distinct origin.
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    writeFatalLogSync('main', origin, diagnosticErrorFields(error))
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

  // Windows gets multi-resolution ICOs for title-bar and Alt-Tab fidelity; the macOS runtime Dock
  // Theme override and Linux use matching lossless 1024px PNGs. The installed macOS icon itself is
  // build/icon.icon (electron-builder.yml), not either runtime PNG.
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
  let forwardSecondInstanceDuringStartup: ((argv: string[]) => void) | undefined
  await orchestrateAppStartup({
    diagnostics: startupDiagnostics,
    // The OS lock is already held. Bind the orchestrator's relay to the pre-logger relay so any
    // second-instance signal received during bootstrap is preserved until the lifecycle is ready.
    acquireSingleInstanceLock: ({ onSecondInstance }) => {
      forwardSecondInstanceDuringStartup = onSecondInstance
      preStartupSecondInstanceRelay.bind(onSecondInstance)
      return true
    },
    quit: () => app.quit(),
    forceExit: () => app.exit(0),
    installSystemShutdownListeners: (requestSystemShutdown) => {
      const adapters = installSystemLifecycleAdapters({
        windowSessionEndEvents: process.platform === 'win32',
        powerShutdownEvent: process.platform !== 'win32',
        headless: webMode.headless,
        signalSource: process,
        powerMonitor,
        getWindows: () => BrowserWindow.getAllWindows(),
        requestSystemShutdown
      })
      bindSystemShutdownWindow = adapters.bindWindow
      installPowerMonitorListeners = adapters.installPowerMonitorListeners
    },
    prepare: async () => {
      // Start local-only Crashpad after the single-instance lock but before any BrowserWindow can
      // create a renderer. Upload stays disabled: dumps remain local for explicit support collection.
      // Without this initialization, native failures can terminate a process without leaving the dump
      // needed to distinguish a renderer, utility, or main-process crash.
      const crashReporting = startLocalCrashReporting({
        platform: process.platform,
        productName: APP_NAME,
        companyName: 'aipoch',
        appVersion: app.getVersion(),
        start: (options) => crashReporter.start(options)
      })
      startupDiagnostics?.phase('crash-reporting', { enabled: crashReporting.enabled })

      startupDiagnostics?.phase('electron-ready')
      await app.whenReady()
      installPowerMonitorListeners()

      startupDiagnostics?.phase('load-startup-shell-modules')
      const [
        { createManagedPreviewProtocolBridge },
        { configureMainWindow, createMainWindow },
        { LocalePreferenceOwner },
        { registerLocalePreferenceIpc },
        { installWindowShortcuts },
        { registerNetworkIpcHandlers },
        { createDatabaseStartupLogging },
        { createDatabaseStartupOwner },
        { installDatabaseStartupQuitGuard, registerDatabaseStartupIpc },
        { buildStartupDiagnostics },
        { getProjectDbClient },
        { resolveConfigRoot },
        { SettingsDocumentStore },
        { SettingsRepository }
      ] = await Promise.all([
        import('./managed-preview-protocol'),
        import('./windows'),
        import('./locale/owner'),
        import('./locale/ipc'),
        import('./window-shortcuts'),
        import('./network-ipc'),
        import('./database/database-startup-logging'),
        import('./database/database-startup-owner'),
        import('./database/database-startup-ipc'),
        import('./database/startup-diagnostics'),
        import('./projects/prisma-client'),
        import('./storage-root'),
        import('./settings/document-store'),
        import('./settings/repository')
      ])

      startupDiagnostics?.phase('prepare-shell')
      // The bridge is lightweight, but its protocol handler must exist before the first BrowserWindow
      // creates the default session. macOS otherwise treats later managed-preview requests as an
      // unknown scheme even though the privileged scheme itself was registered before app ready.
      const managedPreviewProtocolBridge = createManagedPreviewProtocolBridge(protocol)
      // Create the settings document owner before any native surface. The startup locale repository
      // and the later application Settings repository share this store, so every settings.json
      // mutation uses one serialization queue and one atomic-write implementation.
      const settingsStore = new SettingsDocumentStore(resolveConfigRoot())
      const startupSettingsRepository = new SettingsRepository(settingsStore)
      const startupSettings = await startupSettingsRepository.getSettings()
      const localeOwner = new LocalePreferenceOwner(
        app.getPreferredSystemLanguages(),
        startupSettingsRepository,
        startupSettings.localePreference
      )
      const translate = localeOwner.t.bind(localeOwner)
      const disposeLocalePreferenceIpc = registerLocalePreferenceIpc(localeOwner)

      // Set app user model id for windows
      electronApp.setAppUserModelId(APP_USER_MODEL_ID)

      // Forward F12 / Cmd-R blocking from `@electron-toolkit/utils`' `optimizer.watchWindowShortcuts`
      // to every window (main + future preview windows). The helper is invoked with `zoom: true` so
      // Cmd/Ctrl+=, Cmd/Ctrl+-, and Cmd/Ctrl+0 reach Electron's built-in zoomIn / zoomOut /
      // resetZoom menu accelerators — without that, its before-input-event listener calls
      // preventDefault() on Cmd+- and Cmd+= and silently disables zoom out / reset (issue #336).
      installWindowShortcuts(app)

      const databaseStartupLogging = createDatabaseStartupLogging(log, app.getVersion())
      const databaseStartupOwner = createDatabaseStartupOwner({
        reportBlocked: databaseStartupLogging.reportBlocked,
        buildDiagnostics: (error) =>
          buildStartupDiagnostics(error, {
            configRoot: resolveConfigRoot(),
            dataRoot: startupSettings.dataRoot
          }),
        environment: {
          appVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron ?? 'unknown',
          node: process.versions.node ?? 'unknown'
        },
        verifyDatabase: async (onProgress) => {
          await getProjectDbClient(
            resolveConfigRoot(),
            databaseStartupLogging.migrationOptions(onProgress)
          )
        }
      })
      const startupWindowCloseOptions = createStartupWindowCloseOptions(() => app.quit())
      // The renderer probes connectivity as soon as it mounts, before the full application runtime
      // is composed. Install these handlers before creating the first BrowserWindow so that startup
      // probe cannot race the desktop utility adapter installation.
      registerNetworkIpcHandlers()
      const disposeDatabaseStartupIpc = registerDatabaseStartupIpc({
        ipcMain,
        owner: databaseStartupOwner,
        quit: startupWindowCloseOptions.requestQuit,
        getWindows: () => BrowserWindow.getAllWindows()
      })
      const databaseStartupQuitGuard = installDatabaseStartupQuitGuard({
        app,
        owner: databaseStartupOwner
      })
      const startupWindow = webMode.headless
        ? undefined
        : createMainWindow(startupWindowCloseOptions, translate)
      if (startupWindow) bindSystemShutdownWindow(startupWindow)
      // Yield the main-process event loop until Chromium has painted the startup shell. Evaluating the
      // 5 MB backend chunk immediately after BrowserWindow construction can otherwise delay
      // ready-to-show even though the window no longer depends on that chunk.
      const startupShellRendered = startupWindow
        ? waitForStartupShell(startupWindow, { diagnostics: startupDiagnostics })
        : Promise.resolve()
      if (startupWindow) {
        if (!forwardSecondInstanceDuringStartup) {
          throw new Error('Second-instance startup relay is not initialized.')
        }
        preStartupSecondInstanceRelay.bind(
          createStartupWindowSecondInstanceHandler(
            startupWindow,
            forwardSecondInstanceDuringStartup
          )
        )
      }

      startupDiagnostics?.phase('database-and-application-modules')
      const initialDatabaseAttempt = databaseStartupOwner.start()
      return prepareVisibleStartupRuntime({
        // The shell and its first BrowserWindow already exist before this orchestration begins. The
        // async seam keeps the ordering explicit and lets database verification and backend loading
        // start together on the next step.
        prepareShell: async () => undefined,
        verifyDatabase: async () => {
          if (webMode.headless) {
            const state = await initialDatabaseAttempt
            if (state.phase === 'blocked') {
              throw Object.assign(new Error(state.error.message), state.error)
            }
            return
          }
          await Promise.race([
            databaseStartupOwner.whenVerified(),
            initialDatabaseAttempt.then((state) =>
              state.phase === 'blocked' ? new Promise<void>(() => undefined) : undefined
            )
          ])
        },
        loadApplicationModules: async () => {
          await startupShellRendered
          startupDiagnostics?.phase('load-application-modules')
          const loaded = await Promise.all([
            import('./ipc'),
            import('./storage/migration-state'),
            import('./tray'),
            import('./app-lifecycle'),
            import('./ipc-handler-registry'),
            import('./web-service'),
            import('./second-instance-router'),
            import('./window-close-confirm'),
            import('./session-persistence/renderer-flush'),
            import('./app-icon'),
            import('./remote-access'),
            import('./notifications/desktop-attention'),
            import('./notifications/desktop-badge'),
            import('./notifications/notification-inbox-controller'),
            import('./notifications/unread-task-ipc')
          ])
          startupDiagnostics?.phase('application-modules-loaded')
          return loaded
        },
        composeRuntime: async (
          _,
          [
            { registerIpcHandlers },
            { installMigrationQuitGuard, isMigrationInProgress },
            { createAppTray, refreshAppTrayLocale, setTrayIconVariant },
            { installAppLifecycle },
            { disposeIpcHandlerRegistry },
            { createWebServiceController, buildAuthenticatedWebUrl },
            { routeSecondInstance },
            { createElectronCloseConfirm },
            {
              createElectronSessionPersistenceFlush,
              notifyRendererSessionPersistenceFlushAborted,
              rendererSessionPersistenceFlushBlocksShutdown
            },
            { createAppIconController, buildAppIconPreviews },
            { RemoteAccessService, registerRemoteAccessIpcHandlers },
            { createDesktopAttentionController, wireDesktopAttention },
            { createDesktopBadgeAdapter, createWindowsBadgeBitmap },
            { wireNotificationInboxController },
            { registerUnreadTaskIpc }
          ]
        ) => {
          startupDiagnostics?.phase('compose-runtime')

          try {
            startupDiagnostics?.phase('register-application-ipc')
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
            const disposeTrayLocaleSubscription = localeOwner.subscribe(() =>
              refreshAppTrayLocale(appTrayBox.current)
            )
            // Unread state restores before the main-window lifecycle is installed. Late-bind its getter so
            // restoration remains window-independent while later badge/probe calls always target the live window.
            const mainWindowGetterBox: {
              current: (() => InstanceType<typeof BrowserWindow> | undefined) | undefined
            } = { current: undefined }

            // Pass the concrete main entry path so ACP can launch the artifact MCP server from the same bundle.
            const {
              applicationCommands,
              applicationEvents,
              permissionApprovalPresence,
              bindRemoteAccess,
              taskNotifications,
              notificationInbox,
              settingsService,
              commitClosePreference,
              taskAgent,
              taskControls,
              computePreferences,
              detectActiveSessions,
              hasActiveReviewerWork,
              prepareForQuit,
              abortQuitPreparation,
              dispose: disposeApplicationRuntime
            } = await registerIpcHandlers({
              mainEntryPath,
              settingsStore,
              translate,
              managedPreviewProtocol: managedPreviewProtocolBridge.registrar,
              handoffRuntime: 'production',
              headless: webMode.headless,
              confirmRendererDurability: async (policy) => {
                const getWindow = (): InstanceType<typeof BrowserWindow> | undefined =>
                  mainWindowGetterBox.current?.()
                const outcome = await createElectronSessionPersistenceFlush(getWindow)()
                if (!rendererSessionPersistenceFlushBlocksShutdown(outcome, policy)) {
                  return true
                }
                notifyRendererSessionPersistenceFlushAborted(getWindow)
                return false
              },
              notifyRendererDurabilityAborted: () =>
                notifyRendererSessionPersistenceFlushAborted(() => mainWindowGetterBox.current?.()),
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
            startupDiagnostics?.phase('compose-desktop-surfaces')

            // The controller must exist before its IPC responder, while the responder calls back into the
            // controller. This box breaks that startup cycle without exposing unread ownership to renderer.
            const visibilityProbeBox: {
              current: ReturnType<typeof registerUnreadTaskIpc> | undefined
            } = { current: undefined }
            notificationInbox.configureDesktop({
              // Only the main conversation window can acknowledge a visible session. A focused preview
              // window must not clear unread state for the conversation underneath it.
              isAppFocused: () => mainWindowGetterBox.current?.()?.isFocused() ?? false,
              confirmSessionVisible: (sessionId) =>
                visibilityProbeBox.current?.confirmSessionVisible(sessionId) ??
                Promise.resolve(false),
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
              })
            })
            visibilityProbeBox.current = registerUnreadTaskIpc({
              getMainWindow: () => mainWindowGetterBox.current?.(),
              controller: notificationInbox,
              onError: (error) => log.warn('message center visibility IPC failed', error)
            })
            // Restore the independent icon variant off macOS and create the macOS Theme/Dock controller.
            // macOS deliberately leaves the packaged Icon Composer icon untouched until a renderer announces
            // its Theme; after that, nativeTheme keeps System mode live even with no BrowserWindow open.
            const initialVariant = await settingsService.getAppIconVariant()
            appIconControllerBox.current = createAppIconController({
              electron: {
                app,
                getAllWindows: () => BrowserWindow.getAllWindows(),
                nativeImage,
                nativeTheme
              },
              variantPaths: iconVariantPaths,
              initialVariant
            })
            startupDiagnostics?.phase('compose-remote-access')
            const remoteAccess = await RemoteAccessService.create()
            bindRemoteAccess(remoteAccess)
            const webController = createWebServiceController({
              applicationCommands,
              requestQuit: () => app.quit(),
              externalAccess: remoteAccess.webAccess,
              applicationEvents,
              permissionApprovalPresence,
              taskAgent,
              taskControls,
              computePreferences,
              detectActiveSessions
            })
            remoteAccess.attachWebController(webController)
            registerRemoteAccessIpcHandlers(remoteAccess)
            // A launch that itself requested serving (a dedicated headless daemon, or an explicit --serve) is
            // not attached: stopping it quits the process. On-demand starts for a running instance are attached.
            if (webMode.enabled)
              await webController.ensureStarted(webMode.port, { attached: false })
            // Restore a persisted remote-access preference only after the normal IPC/web surfaces exist.
            // A missing or signed-out third-party remote-access installation must never delay the desktop window.
            void remoteAccess.restore()

            const disposeApplicationIpcHandlers = (): void => {
              disposeTrayLocaleSubscription()
              disposeLocalePreferenceIpc()
              managedPreviewProtocolBridge.dispose()
              disposeDatabaseStartupIpc()
              disposeIpcHandlerRegistry()
            }
            const shutdownApplicationSurfaces = createApplicationLifecycleShutdown({
              disposeApplicationRuntime,
              remoteAccess,
              webController,
              disposeIpcHandlers: disposeApplicationIpcHandlers,
              log
            })

            return {
              installMigrationQuitGuard,
              isMigrationInProgress,
              createMainWindow: (options: Parameters<typeof createMainWindow>[0]) =>
                createMainWindow(options, translate),
              configureMainWindow,
              startupWindow,
              createAppTray,
              translate,
              buildAuthenticatedWebUrl,
              routeSecondInstance,
              taskNotifications,
              notificationInbox,
              mainWindowGetterBox,
              settingsService,
              appIconControllerBox,
              appTrayBox,
              // Read through the controller (not a snapshot) so a tray created after a settings change —
              // e.g. a headless web client flipping the variant mid-startup — starts on the live value.
              getAppIconVariant: () => appIconControllerBox.current?.getVariant() ?? initialVariant,
              disposeApplicationRuntime,
              detectActiveSessions,
              hasActiveReviewerWork,
              prepareForQuit,
              abortQuitPreparation,
              createSessionPersistenceFlush: (
                getWindow: () => InstanceType<typeof BrowserWindow> | undefined
              ) => createElectronSessionPersistenceFlush(getWindow),
              notifySessionPersistenceFlushAborted: (
                getWindow: () => InstanceType<typeof BrowserWindow> | undefined,
                reason?: Parameters<typeof notifyRendererSessionPersistenceFlushAborted>[1]
              ) => notifyRendererSessionPersistenceFlushAborted(getWindow, reason),
              createConfirmClose: (
                getWindow: () => InstanceType<typeof BrowserWindow> | undefined
              ) =>
                createElectronCloseConfirm(
                  getWindow,
                  {
                    get: () => settingsService.getClosePreference(),
                    set: async (preference) => {
                      await commitClosePreference(preference)
                    }
                  },
                  translate
                ),
              installAppLifecycle,
              createDesktopAttentionController,
              wireDesktopAttention,
              wireNotificationInboxController,
              log,
              webMode,
              webController,
              remoteAccess,
              shutdownApplicationSurfaces,
              databaseStartupOwner,
              databaseStartupQuitGuard
            }
          } catch (error) {
            // Invalidate caller leases immediately if composition fails after registering IPC. The
            // outer shell rollback destroys the window and quits, but renderer calls can still arrive
            // while that shutdown is in flight.
            disposeIpcHandlerRegistry()
            managedPreviewProtocolBridge.dispose()
            throw error
          }
        },
        rollbackShell: async () => {
          // Module loading can fail while verification is actively migrating. Keep the quit guard
          // installed until that attempt settles so app.quit cannot interrupt database writes.
          await databaseStartupOwner.whenAttemptSettled()
          disposeLocalePreferenceIpc()
          databaseStartupQuitGuard.dispose()
          managedPreviewProtocolBridge.dispose()
          disposeDatabaseStartupIpc()
          if (startupWindow && !startupWindow.isDestroyed()) startupWindow.destroy()
          app.quit()
        }
      })
    },
    // Warn (rather than silently tear down) if the user tries to quit mid data-root migration. Installed
    // BEFORE the lifecycle so its before-quit runs first: a migration it cancels leaves
    // event.defaultPrevented set, which the lifecycle's quit cleanup honors.
    installMigrationQuitGuard: (ctx) =>
      ctx.installMigrationQuitGuard(app, undefined, ctx.translate),
    // Install the tray, first window, and the quit/activate/window-all-closed handlers. shutdownBackends
    // is bound with the live backend handles; the agent teardown latches shutting-down and awaits the
    // process tree so a Windows taskkill /T completes before app.exit.
    installAppLifecycle: (ctx) => {
      const lifecycle = ctx.installAppLifecycle({
        app,
        createMainWindow: ctx.createMainWindow,
        configureMainWindow: ctx.configureMainWindow,
        initialWindow: ctx.startupWindow,
        createTray: (handlers) => {
          const webPort = ctx.webController.runningPort()
          const headlessWeb = ctx.webMode.headless && webPort !== undefined
          const tray = ctx.createAppTray({
            iconPath: trayIconPath,
            variantIconPaths: trayVariantIconPaths,
            initialVariant: ctx.getAppIconVariant(),
            translate: ctx.translate,
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
        bindSystemShutdownWindow,
        detectActiveSessions: ctx.detectActiveSessions,
        hasActiveReviewerWork: ctx.hasActiveReviewerWork,
        prepareForQuit: ctx.prepareForQuit,
        abortQuitPreparation: (reason) => {
          ctx.abortQuitPreparation()
          ctx.notifySessionPersistenceFlushAborted(
            () => ctx.mainWindowGetterBox.current?.(),
            reason
          )
        },
        flushSessionPersistence: ctx.createSessionPersistenceFlush(() =>
          ctx.mainWindowGetterBox.current?.()
        ),
        createConfirmClose: ctx.createConfirmClose,
        onAppearanceChanged: (appearance) =>
          ctx.appIconControllerBox.current?.setAppearance(appearance),
        log: ctx.log,
        flushLogs,
        // Application composition owns the one bounded ACP/Notebook shutdown. Startup failures
        // after composition and ordinary lifecycle shutdown reuse this exact ordered owner.
        shutdownBackends: ctx.shutdownApplicationSurfaces
      })
      const { showMainWindow, getMainWindow, isMainWindowHidden, onSystemShutdown } = lifecycle

      // Window lifecycle now exists: expose it to the restored controller, reapply any Windows
      // overlay to the first window, then attach completion/focus/window-recreation events.
      ctx.mainWindowGetterBox.current = getMainWindow
      ctx.notificationInbox.refreshBadge()

      const desktopAttention = ctx.createDesktopAttentionController({
        platform: process.platform,
        headless: ctx.webMode.headless,
        isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
        isMainWindowHidden,
        getMainWindow,
        ...(process.platform === 'darwin' ? { dock: app.dock } : {}),
        onError: (error) => ctx.log.warn('desktop attention failed', error)
      })
      ctx.wireNotificationInboxController({
        app,
        controller: ctx.notificationInbox
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
      preStartupSecondInstanceRelay.bind(onSecondInstance)
      return { onSecondInstance, onSystemShutdown }
    },
    cleanupAfterStartupFailure: async (ctx) => {
      await ctx.shutdownApplicationSurfaces()
    },
    markReady: (ctx) => {
      ctx.databaseStartupOwner.complete()
      ctx.databaseStartupQuitGuard.release()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
