import { fileURLToPath } from 'node:url'

// Only the lightweight argv flags are imported statically here. The MCP server modules (and their heavy
// SDK graph) are imported lazily inside the matching branch, and the Electron backend is imported only
// after the single-instance lock is held — so no backend module loads before the lock in UI mode.
import { ARTIFACT_MCP_SERVER_ARG, NOTEBOOK_MCP_SERVER_ARG } from './mcp-server-args'

const APP_NAME = 'Open Science'
const APP_USER_MODEL_ID = 'com.aipoch.open-science'
const shouldRunArtifactMcpServer = process.argv.includes(ARTIFACT_MCP_SERVER_ARG)
const shouldRunNotebookMcpServer = process.argv.includes(NOTEBOOK_MCP_SERVER_ARG)

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
} else {
  void startElectronApp(fileURLToPath(import.meta.url)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}

// Boots the Electron app only in normal UI mode, keeping artifact MCP mode free of Electron imports.
async function startElectronApp(mainEntryPath: string): Promise<void> {
  const [
    { app, BrowserWindow, nativeImage, protocol },
    { electronApp, optimizer },
    { default: icon },
    { acquireSingleInstanceLock },
    { orchestrateAppStartup }
  ] = await Promise.all([
    import('electron'),
    import('@electron-toolkit/utils'),
    import('../../resources/icon.png?asset'),
    import('./single-instance'),
    import('./app-startup')
  ])

  // Ordered startup: the single-instance lock is acquired FIRST (UI path only — the MCP stdio server
  // modes never reach startElectronApp), so a secondary launch quits before prepare() imports any
  // backend module or spawns a duplicate process tree. prepare() then does the heavy post-lock work and
  // returns the handles the migration guard and lifecycle need; the guard is installed before the
  // lifecycle so its before-quit runs first. A second launch that arrives mid-startup is recorded by the
  // relay and surfaced once the window exists.
  await orchestrateAppStartup({
    acquireSingleInstanceLock: (opts) => acquireSingleInstanceLock(opts),
    quit: () => app.quit(),
    prepare: async () => {
      const [
        { registerIpcHandlers },
        { createMainWindow },
        { MANAGED_PREVIEW_SCHEME },
        { installMigrationQuitGuard, isMigrationInProgress },
        { createAppTray },
        { shutdownBackends },
        { installAppLifecycle }
      ] = await Promise.all([
        import('./ipc'),
        import('./windows'),
        import('./managed-preview-resources'),
        import('./storage/migration-state'),
        import('./tray'),
        import('./lifecycle-shutdown'),
        import('./app-lifecycle')
      ])

      // Dev runs get a "(DEV)" suffix so the app name, macOS menu, and per-app paths (logs, userData)
      // are visibly distinct from an installed build — and don't collide with it.
      app.setName(app.isPackaged ? APP_NAME : `${APP_NAME} (DEV)`)

      protocol.registerSchemesAsPrivileged([MANAGED_PREVIEW_SCHEME])

      await app.whenReady()

      // Initialize file logging as early as possible so startup and agent-spawn issues are captured for
      // later troubleshooting (especially in packaged builds where console output is not visible).
      const { createLogger, getLogFilePath, initLogger } = await import('./logger')
      initLogger({ logDir: app.getPath('logs') })
      const log = createLogger('main')

      log.info('app starting', {
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        electron: process.versions.electron,
        node: process.versions.node,
        execPath: process.execPath,
        logFile: getLogFilePath()
      })

      // Capture otherwise-silent crashes so a hang or unexpected exit leaves a trail in the log file.
      process.on('uncaughtException', (error) => log.error('uncaughtException', error))
      process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))

      // Set app user model id for windows
      electronApp.setAppUserModelId(APP_USER_MODEL_ID)

      // Dev builds use the app icon for the macOS dock.
      if (process.platform === 'darwin') {
        const dockIcon = nativeImage.createFromPath(icon)
        if (!dockIcon.isEmpty()) {
          app.dock?.setIcon(dockIcon)
        }
      }

      // Default open or close DevTools by F12 in development
      // and ignore CommandOrControl + R in production.
      // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      // Pass the concrete main entry path so ACP can launch the artifact MCP server from the same bundle.
      const { runtime, notebook } = await registerIpcHandlers({ mainEntryPath })

      return {
        installMigrationQuitGuard,
        isMigrationInProgress,
        createMainWindow,
        createAppTray,
        shutdownBackends,
        installAppLifecycle,
        runtime,
        notebook,
        log
      }
    },
    // Warn (rather than silently tear down) if the user tries to quit mid data-root migration. Installed
    // BEFORE the lifecycle so its before-quit runs first: a migration it cancels leaves
    // event.defaultPrevented set, which the lifecycle's quit cleanup honors.
    installMigrationQuitGuard: (ctx) => ctx.installMigrationQuitGuard(app),
    // Install the tray, first window, and the quit/activate/window-all-closed handlers. shutdownBackends
    // is bound with the live backend handles; the agent teardown latches shutting-down and awaits the
    // process tree so a Windows taskkill /T completes before app.exit.
    installAppLifecycle: (ctx) =>
      ctx.installAppLifecycle({
        app,
        createMainWindow: ctx.createMainWindow,
        createTray: (handlers) => ctx.createAppTray({ iconPath: icon, ...handlers }),
        shutdownBackends: () =>
          ctx.shutdownBackends({ runtime: ctx.runtime, notebook: ctx.notebook, log: ctx.log }),
        isMigrationInProgress: ctx.isMigrationInProgress,
        quit: () => app.quit(),
        countWindows: () => BrowserWindow.getAllWindows().length
      })
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
