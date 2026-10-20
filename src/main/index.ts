import type { PackageOperationSnapshot } from '../shared/session-package'
import { randomUUID } from 'node:crypto'
import {
  inspectOwnedCrashpadProcesses,
  inspectOwnedLinuxAppImageLauncher,
  inspectOwnedLinuxZygoteProcesses
} from './update/installation-occupancy'
import type { ChildProcess } from 'node:child_process'
import {
  assertInstallationChannelCertified,
  installationChannelFor,
  usesSupervisedInstall
} from './update/channel-certification'
import { verifyDesktopRecoveryReadiness } from './desktop-recovery-readiness'
import {
  acknowledgeWindowsUpdateReady,
  cleanupWindowsUpdateHandoffs,
  resolveWindowsUpdateStartup,
  waitForWindowsUpdateWindow
} from './update/windows-update-handoff'
import {
  DesktopRuntimeStartupError,
  connectDesktopRuntimeForStartup,
  resolveDesktopInstallationStartup
} from './desktop-startup-recovery'
import { RUNTIME_STARTUP_CHANNELS, type RuntimeStartupState } from '../shared/runtime-startup'
import { projectDiagnosticError } from './session-diagnostics/detail'
import { DesktopBackendStartupError } from './backend-startup'
import { recoverDesktopBackendStartup } from './backend-startup-recovery'
import { createDesktopRecoveryEventBuffer } from './desktop-recovery-event-buffer'
import { createDesktopRuntimeRecovery } from './desktop-runtime-recovery'
import { DESKTOP_RUNTIME_RECOVERY_CHANNELS } from '../shared/desktop-runtime-recovery'
import { deliverDesktopEvent } from './desktop-event-delivery'
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  session
} from 'electron'
import type { BaseWindow, MenuItem, MenuItemConstructorOptions, WebContents } from 'electron'
import { dirname, join } from 'node:path'
import type { InterfaceScaleShortcut } from '../shared/interface-scale'
import type { DatabaseStartupState } from '../shared/database-startup'
import { DATABASE_STARTUP_CHANNELS } from '../shared/database-startup'
import type { SettingsSnapshot } from '../shared/settings'
import type { LocalePreferenceSnapshot } from '../shared/locale'
import { acquireCredentialBootstrapLease, type RuntimeDirectoryLease } from './runtime-ownership'
import { createDesktopUpdateIntegration } from './desktop-update-integration'
import { prefetchSystemBootIdentity } from './system-boot-identity'
import { installationRootForEntry } from './update/installation-protection'
import {
  discardPreparedMacInstallation,
  prepareSupervisedMacInstallation,
  prepareSupervisedAppImageInstallation,
  prepareSupervisedDebInstallation,
  launchPreparedMacInstaller,
  type PreparedMacInstallation
} from './update/installation-executor'
import { cancelDebSystemdGate, inspectDebSystemdGate } from './update/deb-systemd-gate'
import { UpdateLifecycleError } from '../shared/update'
import type { RuntimeStartupOptions } from './desktop-runtime-info'
import { CredentialIdentityError } from './credential-identity/selection'
import { credentialRecoveryMessage } from './credential-identity/recovery'
import { currentApplicationShutdownTrigger } from './application-shutdown-trigger'
import { configureRuntimeMetadata } from './runtime-metadata'
import { configureIpcHandlerRegistry, ipcMainHandle } from './ipc-handler-registry'
import { configureCredentialStore, getCredentialStore } from './settings/credential-store-mode'
import {
  selectStartupCredentialIdentity,
  prepareCredentialValidation
} from './credential-identity/bootstrap'
import { readCredentialCiphertexts } from './credential-identity/ciphertext-inventory'
import { initializeNodeWindowsProfileKey } from './credential-identity/node-cipher'
import { resolveBootstrapConfigRoot, resolveElectronProfile } from './storage/electron-profile'
import { startOrAttachDesktopBackend, desktopBackendPaths } from './desktop-runtime-launcher'
import { connectDesktopRuntime, type DesktopRuntimeClient } from './desktop-runtime-client'
import { installDesktopRuntimeElectronAdapter } from './desktop-runtime-electron-adapter'
import { createDesktopNativeHandler } from './desktop-native-electron'
import { parseWebModeOptions } from './web-service/options'
import { createDesktopPreviewProxy } from './desktop-preview-proxy'
import type { DesktopShutdownWork } from './desktop-runtime-lifecycle'
import { PackageFileOpenRelay, packagePathsFromArgv } from './session-package/file-open'
import { BrowserImportLaunchRelay } from './session-package/browser-import-protocol'
import { MANAGED_PREVIEW_SCHEME } from './managed-preview-resources'
import {
  OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG,
  registerOfficePreviewRuntimeProtocol
} from './office-preview/office-preview-runtime-protocol'
import { createNativeI18n } from './locale/main-process-messages'
import {
  createLogger,
  diagnosticErrorFields,
  flushLogs,
  initLogger,
  writeFatalLogSync
} from '@aipoch/diagnostics/node'
import {
  initializeApplicationDiagnostics,
  reportApplicationStartupFailure
} from './diagnostics/startup'
import { installChildProcessGoneLogging, startLocalCrashReporting } from './crash-diagnostics'
import {
  createRendererFailureReporter,
  registerRendererDiagnosticsIpc
} from './renderer-diagnostics'
import type { DiagnosticOperation } from '@aipoch/diagnostics/node'

const APP_NAME = 'Open-Science'
const APP_USER_MODEL_ID = 'com.aipoch.open-science'
const bootstrapLog = createLogger('desktop-bootstrap')
const webServiceLog = createLogger('web-service')
// macOS can deliver a launch URL before ready or any asynchronous backend initialization.
const browserImports = new BrowserImportLaunchRelay()
app.on('open-url', (event, url) => {
  browserImports.receiveOpenUrl(event, url)
})
let startupDiagnostics: DiagnosticOperation | undefined
let cleanupStartupClient: (() => Promise<void>) | undefined
let bootstrapPhase = 'credential-preflight'
const shortcutForZoomMenuRole = (role: string | undefined): InterfaceScaleShortcut | undefined => {
  switch (role?.toLowerCase()) {
    case 'zoomin':
      return 'increase'
    case 'zoomout':
      return 'decrease'
    case 'resetzoom':
      return 'reset'
    default:
      return undefined
  }
}

const menuItemToConstructorOptions = (item: MenuItem): MenuItemConstructorOptions => ({
  ...(item.role ? { role: item.role as MenuItemConstructorOptions['role'] } : { type: item.type }),
  ...(item.type !== 'separator' ? { label: item.label } : {}),
  ...(item.accelerator ? { accelerator: item.accelerator } : {}),
  enabled: item.enabled,
  visible: item.visible,
  ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: item.checked } : {}),
  registerAccelerator: item.registerAccelerator,
  ...(item.submenu ? { submenu: item.submenu.items.map(menuItemToConstructorOptions) } : {}),
  ...(item.click && !item.role ? { click: item.click as MenuItemConstructorOptions['click'] } : {})
})

const buildZoomSafeApplicationMenu = (
  applicationMenu: Menu | null,
  MenuConstructor: typeof import('electron').Menu,
  isMainWindow: (window: BrowserWindow) => boolean,
  applyInterfaceScaleShortcut: (
    webContents: Pick<BrowserWindow['webContents'], 'getZoomFactor' | 'setZoomFactor' | 'send'>,
    shortcut: InterfaceScaleShortcut
  ) => void
): Menu | undefined => {
  if (!applicationMenu) return undefined

  const template: MenuItemConstructorOptions[] = applicationMenu.items.map((item) => {
    if (item.role?.toLowerCase() !== 'viewmenu' || !item.submenu)
      return menuItemToConstructorOptions(item)

    const submenu = MenuConstructor.buildFromTemplate(
      item.submenu.items.map((viewItem) => {
        const shortcut = shortcutForZoomMenuRole(viewItem.role)
        if (!shortcut) return menuItemToConstructorOptions(viewItem)

        return {
          label: viewItem.label,
          accelerator: viewItem.accelerator ?? undefined,
          click: (_menuItem: MenuItem, focusedWindow?: BaseWindow) => {
            if (!focusedWindow) return
            const browserWindow = focusedWindow as BrowserWindow

            if (isMainWindow(browserWindow)) {
              applyInterfaceScaleShortcut(browserWindow.webContents, shortcut)
              return
            }

            const webContents = browserWindow.webContents
            if (shortcut === 'reset') {
              webContents.setZoomLevel(0)
            } else {
              // Electron's zoomIn/zoomOut roles advance by 10%, which is half a Chromium
              // zoom level. Keep secondary windows aligned with their native menu behavior.
              const direction = shortcut === 'increase' ? 0.5 : -0.5
              webContents.setZoomLevel(webContents.getZoomLevel() + direction)
            }
          }
        }
      })
    )

    return {
      label: item.label,
      submenu
    }
  })

  return MenuConstructor.buildFromTemplate(template)
}

async function startDesktop(): Promise<void> {
  const { headless } = parseWebModeOptions(process.argv)
  configureRuntimeMetadata(() => ({
    version: app.getVersion(),
    locale: app.getLocale(),
    packaged: app.isPackaged,
    applicationPath: app.getAppPath(),
    homePath: app.getPath('home'),
    downloadsPath: app.getPath('downloads'),
    resourcesPath: process.resourcesPath
  }))
  configureIpcHandlerRegistry(ipcMain)
  protocol.registerSchemesAsPrivileged([
    MANAGED_PREVIEW_SCHEME,
    OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG
  ])
  const initialBackendPaths = desktopBackendPaths({
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged
  })
  const crashReporterInstance = randomUUID()
  const allowedInstallationProcessIds = (): number[] => [
    process.pid,
    ...app.getAppMetrics().map((metric) => metric.pid),
    ...inspectOwnedLinuxAppImageLauncher(),
    ...inspectOwnedLinuxZygoteProcesses(),
    ...inspectOwnedCrashpadProcesses({
      installationRoot:
        process.platform === 'linux'
          ? dirname(process.execPath)
          : installationRootForEntry(initialBackendPaths.entry),
      crashDumpsPath: app.getPath('crashDumps'),
      instanceId: crashReporterInstance
    })
  ]
  let initialRecoveryError: DesktopRuntimeStartupError | undefined
  let startupCredentialCiphertexts: Buffer[] | undefined
  let startupCredentialInventoryCapturedAt: number | undefined
  let installationStartup: Awaited<ReturnType<typeof resolveDesktopInstallationStartup>>
  try {
    installationStartup = await resolveDesktopInstallationStartup({
      installationRoot: installationRootForEntry(initialBackendPaths.entry),
      allowedProcessIds: allowedInstallationProcessIds,
      version: app.getVersion()
    })
  } catch (error) {
    if (!(error instanceof DesktopRuntimeStartupError)) throw error
    initialRecoveryError = error
  }
  const completeVerifiedStartup = installationStartup?.completeAfterReady
  const verifiedStartupOutcome = installationStartup?.outcome
  let preservedStartupOptions = installationStartup?.startupOptions
  let windowsUpdateAlreadyConfirmed = false
  if (process.platform === 'win32') {
    // A supplied update identity selects data and credentials: missing/corrupt configuration must
    // fail startup, never silently fall back to a different profile.
    const windowsUpdateStartup = await resolveWindowsUpdateStartup({
      appData: app.getPath('appData'),
      args: process.argv,
      version: app.getVersion(),
      applicationPath: process.execPath
    })
    preservedStartupOptions ??= windowsUpdateStartup?.startupOptions
    windowsUpdateAlreadyConfirmed = windowsUpdateStartup?.confirmed ?? false
  }
  const credentialArgs = preservedStartupOptions
    ? [
        `--credential-store=${preservedStartupOptions.credentialStore}`,
        ...(preservedStartupOptions.passwordStore
          ? [`--password-store=${preservedStartupOptions.passwordStore}`]
          : [])
      ]
    : process.argv.filter(
        (arg) => arg.startsWith('--credential-store=') || arg.startsWith('--password-store=')
      )
  if (preservedStartupOptions?.passwordStore)
    app.commandLine.appendSwitch('password-store', preservedStartupOptions.passwordStore)
  configureCredentialStore(credentialArgs, process.platform, false)
  const configRoot =
    preservedStartupOptions?.configRoot ??
    resolveBootstrapConfigRoot(app.getPath('home'), app.isPackaged)
  const profilePath = resolveElectronProfile({
    appData: app.getPath('appData'),
    configRoot,
    packaged: app.isPackaged,
    ...(preservedStartupOptions
      ? { env: { ...process.env, OPEN_SCIENCE_USER_DATA: preservedStartupOptions.profilePath } }
      : {})
  })
  // Selecting paths does not open Chromium databases; scope the lock before credential preflight.
  app.setPath('userData', profilePath)
  app.setPath('sessionData', profilePath)
  if (
    !(!app.isPackaged && process.env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE === '1') &&
    !app.requestSingleInstanceLock()
  ) {
    app.quit()
    return
  }
  // Verified handoff configuration selects the credential identity before Chromium starts.
  // An incomplete installation opens only the recovery shell and never reads application secrets.
  // Configure the existing sink before credential preflight; full diagnostics start after ready.
  initLogger({ logDir: join(profilePath, 'desktop-logs') })
  if (!initialRecoveryError) {
    const bootstrapLease = acquireCredentialBootstrapLease({
      home: app.getPath('home'),
      profilePath,
      platform: process.platform
    })
    try {
      const identity = selectStartupCredentialIdentity({
        platform: process.platform,
        packaged: app.isPackaged,
        credentialStore: getCredentialStore(),
        linuxPasswordStore: app.commandLine.getSwitchValue('password-store')
      })
      app.setName(identity.appName)
      startupCredentialCiphertexts =
        identity.backend === 'file'
          ? undefined
          : readCredentialCiphertexts({ configRoot, profilePath })
      startupCredentialInventoryCapturedAt = Date.now()
      prepareCredentialValidation(
        identity,
        { configRoot, profilePath },
        startupCredentialCiphertexts
      )
      if (identity.backend === 'windows-dpapi') initializeNodeWindowsProfileKey(profilePath)
    } finally {
      bootstrapLease.release()
    }
  }
  const BLOCKED_QUIT_DEADLINE_MS = 8_000
  let startupQuitRequested = false
  let startupBlocked = false
  // The backend this Desktop spawned (detached) while startup is not yet attached; a blocked-page quit
  // must stop it, otherwise it keeps the runtime lock after the app is gone.
  let startedBackend: ChildProcess | undefined
  let blockedExit: Promise<void> | undefined
  const exitFromBlockedStartup = (): Promise<void> =>
    (blockedExit ??= (async () => {
      try {
        const child = startedBackend
        if (client) {
          await Promise.race([
            client.quit().then((lease) => retainShutdownLease(lease)),
            new Promise((resolve) => setTimeout(resolve, BLOCKED_QUIT_DEADLINE_MS).unref())
          ])
        } else if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, BLOCKED_QUIT_DEADLINE_MS)
            timer.unref()
            child.once('exit', () => resolve())
            child.kill('SIGTERM')
          })
        }
      } catch {
        // Quit must always complete; a failed stop is reported by the next launch's recovery.
      } finally {
        app.exit(0)
      }
    })())
  const holdStartupQuit = (event: Electron.Event): void => {
    event.preventDefault()
    startupQuitRequested = true
    if (startupBlocked) void exitFromBlockedStartup()
  }
  app.on('before-quit', holdStartupQuit)
  const packageFiles = new PackageFileOpenRelay(() => {
    void client?.invokeHost('desktop:open-package', [null]).catch(reportError)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    packageFiles.receive(path)
  })
  let showMainWindow: (() => BrowserWindow) | undefined = undefined
  let secondInstancePending = false
  app.on('second-instance', (_event, argv, cwd) => {
    browserImports.receiveArgv(argv)
    for (const path of packagePathsFromArgv(argv, cwd)) packageFiles.receive(path)
    if (showMainWindow) showMainWindow()
    else secondInstancePending = true
  })
  for (const path of packagePathsFromArgv(process.argv, process.cwd())) packageFiles.receive(path)
  browserImports.receiveArgv(process.argv)
  let client: DesktopRuntimeClient | undefined = undefined
  const reportError = (error: unknown): void => {
    bootstrapLog.error('desktop operation failed', {
      error: projectDiagnosticError(error, { configRoot, home: app.getPath('home') })
    })
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error))
  }
  bootstrapPhase = 'electron-ready'
  await app.whenReady()
  if (process.platform === 'win32')
    prefetchSystemBootIdentity().catch((error: unknown) =>
      bootstrapLog.warn('boot identity prefetch failed', { error: String(error) })
    )
  app.setName(app.isPackaged ? APP_NAME : `${APP_NAME} (DEV)`)
  app.setAppLogsPath(join(profilePath, 'desktop-logs'))
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
  startupDiagnostics = diagnostics.operation
  bootstrapLog.info('desktop profile initialized', {
    actualPaths: {
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData')
    },
    requestedPaths: {
      configRoot,
      environmentUserData: process.env.OPEN_SCIENCE_USER_DATA ?? null,
      commandLineUserData: app.commandLine.getSwitchValue('user-data-dir')
    }
  })
  installChildProcessGoneLogging(
    (listener) => app.on('child-process-gone', listener),
    diagnostics.log
  )
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    writeFatalLogSync('main', origin, diagnosticErrorFields(error))
  )
  registerRendererDiagnosticsIpc(
    ipcMain,
    createRendererFailureReporter({ log: createLogger('renderer') })
  )
  startLocalCrashReporting({
    platform: process.platform,
    productName: APP_NAME,
    companyName: 'aipoch',
    appVersion: app.getVersion(),
    start: (options) =>
      crashReporter.start({
        ...options,
        globalExtra: { openScienceInstance: crashReporterInstance }
      })
  })
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

  startupDiagnostics?.phase('load-native-shell')
  const { createMainWindow, configureMainWindow, isMainWindow } = await import('./windows')
  const { applyInterfaceScaleShortcut, installWindowShortcuts } = await import('./window-shortcuts')
  const { registerWindowZoomIpcHandler, registerWindowCloseIpcHandler } =
    await import('./window-ipc')
  const { registerWindowsTitleBarIpc } = await import('./windows-titlebar')
  const { registerWindowFindIpcHandlers } = await import('./window-find-ipc')
  const { createAppIconController, buildAppIconPreviews } = await import('./app-icon')
  const { createAppTray, refreshAppTrayLocale, refreshAppTrayNavigation, setTrayIconVariant } =
    await import('./tray')
  const { createDesktopNotificationHandler } = await import('./notifications/electron-wiring')
  const { createDesktopAttentionController } = await import('./notifications/desktop-attention')
  const { createDesktopBadgeAdapter, createWindowsBadgeBitmap } =
    await import('./notifications/desktop-badge')
  const { registerUnreadTaskIpc } = await import('./notifications/unread-task-ipc')
  const { createElectronCloseConfirm } = await import('./window-close-confirm')
  const { installAppLifecycle } = await import('./app-lifecycle')
  const {
    createElectronSessionPersistenceFlush,
    notifyRendererSessionPersistenceFlushAborted,
    rendererSessionPersistenceFlushBlocksShutdown
  } = await import('./session-persistence/renderer-flush')
  const { installSystemLifecycleAdapters } = await import('./system-lifecycle-adapters')
  if (process.platform === 'darwin')
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { role: 'help', submenu: [] }
      ])
    )
  const menu = buildZoomSafeApplicationMenu(
    Menu.getApplicationMenu(),
    Menu,
    isMainWindow,
    applyInterfaceScaleShortcut
  )
  if (menu) Menu.setApplicationMenu(menu)
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)
  installWindowShortcuts(app, undefined, isMainWindow)
  registerWindowZoomIpcHandler()
  registerWindowsTitleBarIpc({ isMainWindow })
  registerWindowCloseIpcHandler()
  registerWindowFindIpcHandlers()
  startupDiagnostics?.phase('native-shell-configured')
  let requestSystemShutdown = (): void => app.quit()
  const system = installSystemLifecycleAdapters({
    windowSessionEndEvents: process.platform === 'win32',
    powerShutdownEvent: process.platform !== 'win32',
    headless: true,
    signalSource: process,
    powerMonitor,
    getWindows: () => BrowserWindow.getAllWindows(),
    requestSystemShutdown: () => requestSystemShutdown()
  })
  system.installPowerMonitorListeners()
  const isApplicationWindow = (sender: WebContents): boolean => {
    const window = BrowserWindow.fromWebContents(sender)
    return Boolean(window && isMainWindow(window))
  }
  let getMainWindow = (): BrowserWindow | undefined => undefined
  let isMainWindowHidden = (): boolean => false
  let relay: ReturnType<typeof installDesktopRuntimeElectronAdapter> | undefined
  let plannedRelaunch = false
  let relaunchConfirmation: Promise<void> | undefined
  let updateCommitted = false
  let runtimeStopped = false
  let shutdownLease: RuntimeDirectoryLease | undefined
  const retainShutdownLease = (lease: RuntimeDirectoryLease | undefined): void => {
    if (lease) shutdownLease = lease
  }
  app.once('will-quit', () => shutdownLease?.release())
  let preview: Awaited<ReturnType<typeof createDesktopPreviewProxy>> | undefined
  let tray: ReturnType<typeof createAppTray>
  let icons: ReturnType<typeof createAppIconController> | undefined = undefined
  const i18n = createNativeI18n('en')
  const translate = i18n.t.bind(i18n)
  const staleWindows = new Set<number>()
  const markStale = (sender: WebContents): void => {
    if (sender.isDestroyed()) return
    staleWindows.add(sender.id)
    try {
      sender.send(DESKTOP_RUNTIME_RECOVERY_CHANNELS.stateChanged, {
        ...recovery?.state(),
        phase: 'disconnected',
        epoch: (recovery?.state().epoch ?? 0) + 1,
        closing: false
      })
    } catch {
      /* A destroyed document has no recovery surface. */
    }
  }
  const broadcast = (channel: string, payload: unknown): void => {
    deliverDesktopEvent(
      BrowserWindow.getAllWindows(),
      isMainWindow,
      channel,
      payload,
      channel === DESKTOP_RUNTIME_RECOVERY_CHANNELS.stateChanged
        ? undefined
        : (window) => markStale(window.webContents)
    )
  }
  startupDiagnostics?.phase('notification-projection')
  const visibility = registerUnreadTaskIpc({
    getMainWindow: () => getMainWindow(),
    controller: {
      syncViewState: async (state) => client?.notificationView('view', state.visibleSessionId)
    },
    onError: reportError
  })
  const badge = createDesktopBadgeAdapter({
    platform: process.platform,
    setBadgeCount: (count) => app.setBadgeCount(count),
    isUnityRunning: () => app.isUnityRunning(),
    getMainWindow: () => getMainWindow(),
    createWindowsOverlay: (label) =>
      nativeImage.createFromBitmap(createWindowsBadgeBitmap(label), {
        width: 16,
        height: 16,
        scaleFactor: 1
      }),
    onError: reportError
  })
  const attention = createDesktopAttentionController({
    platform: process.platform,
    headless,
    isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    isMainWindowHidden: () => isMainWindowHidden(),
    getMainWindow: () => getMainWindow(),
    ...(process.platform === 'darwin' ? { dock: app.dock } : {}),
    onError: reportError
  })
  const makeNotifications = (): ReturnType<typeof createDesktopNotificationHandler> =>
    createDesktopNotificationHandler({
      delivery: {
        notificationCtor: Notification,
        liveNotifications: new Set(),
        log: diagnostics.log,
        headless,
        translate
      },
      isAppFocused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
      isMainWindowFocused: () => getMainWindow()?.isFocused() ?? false,
      confirmSessionVisible: visibility.confirmSessionVisible,
      setBadgeCount: (count) => badge.setCount(count),
      requestAttention: () => attention.request(),
      clearAttention: () => attention.clear(),
      activate: () => {
        showMainWindow?.().webContents.send('notifications:open-session')
      },
      onAction: (token, action) => client?.notificationAction(token, action)
    })
  let notifications = makeNotifications()
  let reconcileWait:
    | {
        epoch: number
        pending: Map<number, WebContents['mainFrame']>
        resolve(): void
        reject(error: Error): void
      }
    | undefined
  const recoveryEvents = createDesktopRecoveryEventBuffer()
  const native = createDesktopNativeHandler((id) => relay?.documentFor(id), isApplicationWindow)
  let state: DatabaseStartupState = { phase: 'checking' }
  let ready = false
  let acceptStartupEvents = false
  let readiness: Promise<void> = Promise.resolve()
  const nativeChannels = new Set([
    'settings:list-app-icons',
    'cli:get-status',
    'cli:install',
    'cli:uninstall',
    'update:get-app-info',
    'update:get-status',
    'update:check',
    'update:download',
    'update:cancel',
    'update:apply',
    'update:recheck',
    'update:recover'
  ])
  const recoveryReadChannels = new Set([
    'sessions:list',
    'sessions:load-all',
    'sessions:load-one',
    'sessions:list-runtime-terminal-failures',
    'projects:list',
    'projects:list-deletion-cleanup',
    'settings:get-settings',
    'settings:is-encryption-available',
    'settings:get-preflight',
    'settings:is-npm-available',
    'lifecycle:client-id',
    'acp:get-state',
    'compute:jobs:list',
    'compute:list',
    'notebook:state'
  ])
  const installRelay = (): void => {
    relay?.uninstall()
    const attached = client!
    relay = installDesktopRuntimeElectronAdapter(
      {
        commandNames: () => attached.commandNames().filter((name) => !nativeChannels.has(name)),
        invoke: (...args) => {
          if (
            ((recovery && recovery.state().phase !== 'connected') ||
              staleWindows.has(relay?.documentFor(args[0])?.id ?? -1)) &&
            !recoveryReadChannels.has(args[1])
          )
            return Promise.reject(
              new Error('Desktop is recovering. This operation was not submitted.')
            )
          return attached.invoke(...args)
        },
        release: (id) => attached.release(id)
      },
      isApplicationWindow
    )
  }
  const publishStartup = (next: DatabaseStartupState): void => {
    readiness = readiness
      .then(async () => {
        if (next.phase === 'blocked') browserImports.failPending()
        if (next.phase === 'ready' && !ready) {
          preview = await createDesktopPreviewProxy(configRoot, client!.processId())
          installRelay()
          ready = true
          // The web service lives in the Node backend (#3358) and logs to its own file; packaged
          // certification parses the app stdout for this readiness line, so main re-publishes it.
          webServiceLog.info(`Open-Science Web: http://127.0.0.1:${preview.port}/`, {
            host: '127.0.0.1',
            port: preview.port,
            source: 'node-backend'
          })
          const settings = (await client!.invokeHost('settings:get-settings')) as SettingsSnapshot
          icons?.setVariant(settings.appIconVariant)
          packageFiles.bind((path) => {
            showMainWindow?.()
            void client!.invokeHost('desktop:open-package', [path]).catch(reportError)
          })
          // The Node owner holds the receiver; only an authenticated desktop host enables discovery.
          await client!
            .invokeHost('desktop:browser-import-discovery', [
              Number(process.env.OPEN_SCIENCE_BROWSER_IMPORT_DISCOVERY_PORT ?? 49151)
            ])
            .catch(() => webServiceLog.warn('Browser import discovery is unavailable.'))
          const presentationRevision = browserImports.revision
          const initialOperation = await client!.invokeHost('desktop:package-operation-snapshot')
          if (browserImports.revision === presentationRevision)
            browserImports.update(initialOperation as PackageOperationSnapshot | null)
          browserImports.bind(
            async (url, cancelled) => {
              showMainWindow?.()
              const revision = browserImports.revision
              const snapshot = await client!.invokeHost('desktop:browser-import', [url, cancelled])
              if (browserImports.revision === revision)
                browserImports.update(snapshot as PackageOperationSnapshot | null)
            },
            () => showMainWindow?.(),
            async (id) => {
              await client!.invokeHost('desktop:browser-import-cancel', [id])
            }
          )
        }
        state = next
        broadcast(DATABASE_STARTUP_CHANNELS.stateChanged, state)
      })
      .catch((error: unknown) => {
        browserImports.failPending()
        reportError(error)
      })
  }
  let runtimeStartupState: RuntimeStartupState = { phase: 'idle' }
  let startupWindow: BrowserWindow | undefined
  let startupFailure: DesktopRuntimeStartupError | undefined
  let continueStartup: (() => void) | undefined
  let startupAction: Promise<RuntimeStartupState> | undefined
  const requireStartupFrame = (event: Electron.IpcMainInvokeEvent): void => {
    if (
      !isApplicationWindow(event.sender) ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Startup recovery requires the main application frame.')
  }
  const publishRuntimeStartup = (next: RuntimeStartupState): void => {
    runtimeStartupState = next
    if (next.phase === 'blocked') browserImports.failPending()
    broadcast(RUNTIME_STARTUP_CHANNELS.onStateChanged, next)
    if (next.phase === 'ready' && process.platform === 'win32' && !windowsUpdateAlreadyConfirmed) {
      // Also acknowledge a successful user-initiated startup repair after an initial failure.
      void acknowledgeWindowsUpdateReady({
        appData: app.getPath('appData'),
        args: process.argv,
        version: app.getVersion(),
        applicationPath: process.execPath,
        profilePath,
        waitForPresentation: () => waitForWindowsUpdateWindow(getMainWindow() ?? undefined),
        verifyReady: (expected) => verifyDesktopRecoveryReadiness(client!, expected)
      }).catch((error) =>
        bootstrapLog.warn(
          'Update readiness could not be acknowledged',
          diagnosticErrorFields(error)
        )
      )
    }
  }
  const waitForStartupRetry = async (failure: DesktopRuntimeStartupError): Promise<void> => {
    startupBlocked = true
    startupFailure = failure
    publishRuntimeStartup({ phase: 'blocked', issue: failure.issue })
    showStartupWindow()
    showMainWindow = showStartupWindow
    await new Promise<void>((resolve) => {
      continueStartup = resolve
    })
    continueStartup = undefined
  }
  // Keep the protocol presentation available before Node/DB readiness, with no secret in IPC.
  // Chromium may open its persistent session only after credential preflight has finished.
  let browserImportShellReady = false
  const showStartupWindow = (): BrowserWindow => {
    if (!startupWindow || startupWindow.isDestroyed()) {
      const window = createMainWindow(undefined, translate)
      startupWindow = window
      window.once('closed', () => {
        if (startupWindow !== window) return
        startupWindow = undefined
        if (startupBlocked) void exitFromBlockedStartup()
      })
    }
    startupWindow.show()
    return startupWindow
  }
  const showBrowserImportStartup = (): void => {
    if (!browserImportShellReady || !browserImports.snapshot) return
    if (showMainWindow) showMainWindow()
    else showStartupWindow()
  }
  browserImports.observe((snapshot) => {
    broadcast('package-presentation:changed', snapshot)
    if (snapshot?.browserTransfers?.some((transfer) => transfer.state === 'preparing'))
      showBrowserImportStartup()
  })
  ipcMainHandle('package-presentation:get-state', (event) => {
    requireStartupFrame(event)
    return browserImports.snapshot
  })
  ipcMainHandle('package-presentation:cancel-transfer', (event, id: unknown) => {
    requireStartupFrame(event)
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      throw new Error('Invalid transfer identity.')
    return browserImports.cancel(id)
  })
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.getState, () => state)
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.retry, async () => {
    await client?.retryStartup()
    await readiness
    return state
  })
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.quit, () => app.quit())
  const validatePreservedConfiguration = (config: RuntimeStartupOptions): void => {
    if (
      config.configRoot !== configRoot ||
      config.profilePath !== profilePath ||
      config.credentialStore !== getCredentialStore() ||
      (config.passwordStore ?? '') !== app.commandLine.getSwitchValue('password-store')
    )
      throw new Error(
        'The running service uses a different credential profile. Reopen Desktop with the original configuration before stopping it.'
      )
  }
  ipcMainHandle(RUNTIME_STARTUP_CHANNELS.getState, (event) => {
    requireStartupFrame(event)
    return runtimeStartupState
  })
  const performStartupAction = (recover: boolean): Promise<RuntimeStartupState> => {
    if (startupAction) return startupAction
    const failure = startupFailure
    if (!failure) return Promise.resolve(runtimeStartupState)
    startupAction = (async () => {
      publishRuntimeStartup({ phase: recover ? 'recovering' : 'stopping', issue: failure.issue })
      try {
        if (recover) await failure.recover()
        else {
          if (failure.startupOptions) validatePreservedConfiguration(failure.startupOptions)
          await failure.stopAndContinue()
          preservedStartupOptions = failure.startupOptions
        }
        if (initialRecoveryError) {
          app.relaunch()
          app.exit(0)
        } else continueStartup?.()
      } catch (error) {
        startupFailure =
          error instanceof DesktopRuntimeStartupError
            ? error
            : failure.withRetryDiagnostics(
                JSON.stringify(
                  projectDiagnosticError(error, { configRoot, home: app.getPath('home') })
                )
              )
        publishRuntimeStartup({ phase: 'blocked', issue: startupFailure.issue })
      }
      return runtimeStartupState
    })().finally(() => {
      startupAction = undefined
    })
    return startupAction
  }
  ipcMainHandle(RUNTIME_STARTUP_CHANNELS.stopAndContinue, (event) => {
    requireStartupFrame(event)
    return performStartupAction(false)
  })
  ipcMainHandle(RUNTIME_STARTUP_CHANNELS.recover, (event) => {
    requireStartupFrame(event)
    return performStartupAction(true)
  })
  ipcMainHandle(RUNTIME_STARTUP_CHANNELS.quit, (event) => {
    requireStartupFrame(event)
    app.exit(0)
  })
  startupDiagnostics?.phase('launch-node-runtime')
  let launch!: Awaited<ReturnType<typeof startOrAttachDesktopBackend>>
  // Shared by the first launch and the startup replacement of a stopping Runtime, so a replacement
  // keeps the preserved service port and credential arguments of the original launch.
  const launchInitialBackend = async (): Promise<void> => {
    launch = await startOrAttachDesktopBackend({
      onStatus: (status) => bootstrapLog.info('backend startup status', status),
      configRoot,
      profilePath,
      version: app.getVersion(),
      ...initialBackendPaths,
      packaged: app.isPackaged,
      credentialInventory: startupCredentialCiphertexts,
      credentialInventoryCapturedAt: startupCredentialInventoryCapturedAt,
      args: [
        ...credentialArgs,
        ...(preservedStartupOptions ? [`--serve=${preservedStartupOptions.port}`] : [])
      ]
    })
    startedBackend = launch.startedProcess
  }
  while (true) {
    try {
      if (initialRecoveryError) throw initialRecoveryError
      await installationStartup?.completeBeforeLaunch()
      installationStartup = undefined
      await launchInitialBackend()
      startupBlocked = false
      break
    } catch (error) {
      if (!(error instanceof DesktopRuntimeStartupError)) throw error
      startupFailure = error
      if (error.startupOptions) {
        try {
          validatePreservedConfiguration(error.startupOptions)
        } catch (configurationError) {
          startupFailure = new DesktopRuntimeStartupError(
            { ...error.issue, canStop: false, diagnostics: String(configurationError) },
            error.message
          )
        }
      }
      await waitForStartupRetry(startupFailure)
    }
  }
  // Let Node finish credential validation before Chromium opens its cookie databases. On Windows
  // native sessions lock those files, preventing the backend's fail-closed inventory snapshot.
  // Both protocol handlers must still be installed before the first preview window can exist.
  startupDiagnostics?.phase('preview-protocols')
  for (const target of [session.defaultSession, session.fromPartition('reviewer-paged-preview')]) {
    target.protocol.handle(MANAGED_PREVIEW_SCHEME.scheme, (request) =>
      preview
        ? preview.fetch(request)
        : Promise.resolve(new Response('Runtime unavailable', { status: 503 }))
    )
    registerOfficePreviewRuntimeProtocol(
      {
        runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html'),
        devServerUrl: process.env.ELECTRON_RENDERER_URL,
        fetchRuntime: (url) => net.fetch(url, { bypassCustomProtocolHandlers: true })
      },
      target.protocol
    )
  }
  browserImportShellReady = true
  showBrowserImportStartup()
  startupDiagnostics?.phase('connect-node-runtime')
  const deliverRuntimeEvent = ({
    channel,
    payload
  }: {
    channel: string
    payload: unknown
  }): void => {
    if (channel === 'sessions:package-operation-changed')
      browserImports.update(payload as PackageOperationSnapshot)
    if (channel === 'locale:changed') {
      void i18n
        .changeLanguage((payload as LocalePreferenceSnapshot).locale)
        .then(() => refreshAppTrayLocale(tray))
    }
    if (channel === 'settings:changed') {
      const variant = (payload as SettingsSnapshot).appIconVariant
      icons?.setVariant(variant)
      if (tray && trayVariantIconPaths) setTrayIconVariant(tray, trayVariantIconPaths, variant)
    }
    broadcast(channel, payload)
    if (/^(session:|project:|acp:state|side-chat:event|notebook:changed)/.test(channel))
      refreshAppTrayNavigation(tray)
  }
  const attach = async (signal?: AbortSignal): Promise<DesktopRuntimeClient> => {
    const attached = await connectDesktopRuntime({
      ...launch,
      signal,
      onStartupState: (next) => {
        if (acceptStartupEvents && attached === client) publishStartup(next)
      },
      onNativeResponseSent: (request, result) => {
        if (
          request.request.operation !== 'runtime-relaunch' ||
          result !== true ||
          attached !== client ||
          !plannedRelaunch
        )
          return
        relaunchConfirmation = attached
          .waitForStopped()
          .then((lease) => {
            retainShutdownLease(lease)
            app.relaunch()
            app.exit(0)
          })
          .catch((error) => {
            plannedRelaunch = false
            recovery?.setClosing(false)
            attached.close()
            recovery?.disconnect(attached)
            reportError(error)
          })
          .finally(() => {
            relaunchConfirmation = undefined
          })
      },
      onNativeRequest: async (request, signal) => {
        signal.throwIfAborted()
        if (request.request.operation === 'runtime-relaunch') {
          if (attached !== client || !attached.ownsRuntime() || plannedRelaunch) return false
          plannedRelaunch = true
          recovery?.setClosing(true)
          return true
        }
        if (request.request.operation === 'renderer-flush') {
          const outcome = await createElectronSessionPersistenceFlush(() => getMainWindow())()
          const blocked = rendererSessionPersistenceFlushBlocksShutdown(
            outcome,
            request.request.policy
          )
          if (blocked) notifyRendererSessionPersistenceFlushAborted(() => getMainWindow())
          return !blocked
        }
        if (request.request.operation === 'renderer-flush-aborted') {
          notifyRendererSessionPersistenceFlushAborted(() => getMainWindow())
          return null
        }
        return request.request.operation.startsWith('notification-')
          ? notifications.handle(request, signal)
          : native(request, signal)
      },
      onDocumentEvent: (event) => {
        if (attached === client)
          relay?.documentFor(event.clientId)?.send(event.channel, event.payload)
      },
      onUploadProgress: (id, progress) => {
        if (attached === client) relay?.documentFor(id)?.send('uploads:transfer-progress', progress)
      },
      onEvent: ({ channel, payload }) => {
        if (attached !== client) return
        if (recovery?.state().phase === 'reconciling') {
          try {
            recoveryEvents.push({ channel, payload })
          } catch (error) {
            reconcileWait?.reject(error as Error)
          }
          return
        }
        deliverRuntimeEvent({ channel, payload })
      },
      onDeliveryFailure: (failure) => {
        if (attached !== client || !attached) return
        const sender = failure.clientId ? relay?.documentFor(failure.clientId) : undefined
        if (sender) markStale(sender)
        else
          for (const window of BrowserWindow.getAllWindows())
            if (isMainWindow(window)) markStale(window.webContents)
      },
      onDisconnect: () => {
        if (attached !== client || !attached) return
        if (!ready) reportError(new Error('Desktop connection was lost during startup.'))
        preview?.dispose()
        notifications.dispose()
        reconcileWait?.reject(new Error('Desktop disconnected during recovery.'))
        if (plannedRelaunch && !relaunchConfirmation) {
          plannedRelaunch = false
          recovery?.setClosing(false)
          recovery?.disconnect(attached)
          reportError(
            new Error('The Runtime disconnected before its relaunch response could be delivered.')
          )
        } else if (!plannedRelaunch && !runtimeStopped && !updateCommitted)
          recovery?.disconnect(attached)
      }
    })
    return attached
  }
  while (true) {
    try {
      client = await connectDesktopRuntimeForStartup({
        connect: attach,
        version: app.getVersion(),
        // The old Runtime is waited out (or stopped after identity proof) by the launcher.
        replaceRuntime: launchInitialBackend
      })
      startupBlocked = false
      startupFailure = undefined
      break
    } catch (error) {
      if (!(error instanceof DesktopRuntimeStartupError)) throw error
      await waitForStartupRetry(error)
    }
  }
  const makeRecovery = (): ReturnType<typeof createDesktopRuntimeRecovery> =>
    createDesktopRuntimeRecovery({
      client: client!,
      startedProcess: launch.startedProcess,
      connect: attach,
      activate: async (candidate, signal, readyForSnapshots) => {
        preview?.dispose()
        notifications.dispose()
        client = candidate
        notifications = makeNotifications()
        const candidatePreview = await createDesktopPreviewProxy(configRoot, candidate.processId())
        if (signal.aborted) {
          candidatePreview.dispose()
          throw new Error('Desktop recovery canceled.')
        }
        preview = candidatePreview
        installRelay()
        const [locale, settings] = await Promise.all([
          candidate.invokeHost('locale:snapshot') as Promise<LocalePreferenceSnapshot>,
          candidate.invokeHost('settings:get-settings') as Promise<SettingsSnapshot>
        ])
        if (signal.aborted) throw new Error('Desktop recovery canceled.')
        await i18n.changeLanguage(locale.locale)
        signal.throwIfAborted()
        deliverRuntimeEvent({ channel: 'locale:changed', payload: locale })
        deliverRuntimeEvent({ channel: 'settings:changed', payload: settings })
        recoveryEvents.clear()
        // A completed import may have emitted its final event while this desktop was disconnected.
        const presentationRevision = browserImports.revision
        const packageOperation = await candidate.invokeHost('desktop:package-operation-snapshot')
        signal.throwIfAborted()
        if (browserImports.revision === presentationRevision)
          browserImports.update(packageOperation as PackageOperationSnapshot | null)
        const epoch = recovery!.state().epoch
        await new Promise<void>((resolve, reject) => {
          const windows = BrowserWindow.getAllWindows().filter(
            (window) => !window.isDestroyed() && isMainWindow(window)
          )
          const pending = new Map(
            windows.map((window) => [window.webContents.id, window.webContents.mainFrame])
          )
          const removals: (() => void)[] = []
          const cleanup = (): void => {
            for (const remove of removals) remove()
          }
          const aborted = (): void => {
            cleanup()
            reject(new Error('Desktop recovery canceled.'))
          }
          signal.addEventListener('abort', aborted, { once: true })
          removals.push(() => signal.removeEventListener('abort', aborted))
          reconcileWait = {
            epoch,
            pending,
            resolve: () => {
              cleanup()
              resolve()
            },
            reject: (error) => {
              cleanup()
              reject(error)
            }
          }
          for (const window of windows) {
            const sender = window.webContents
            const id = sender.id
            const closed = (): void => {
              pending.delete(id)
              if (pending.size === 0 && reconcileWait?.epoch === epoch) reconcileWait.resolve()
            }
            sender.once('destroyed', closed)
            removals.push(() => sender.removeListener('destroyed', closed))
          }
          readyForSnapshots()
          if (pending.size === 0) reconcileWait.resolve()
        }).finally(() => {
          if (reconcileWait?.epoch === epoch) reconcileWait = undefined
        })
        // Old snapshot failures are repaired; new replay failures must remain invalidated.
        staleWindows.clear()
        await recoveryEvents.drain({
          load: candidate.loadSessionForEvent,
          deliver: deliverRuntimeEvent,
          signal
        })
        candidate.notificationView('window-created')
        refreshAppTrayNavigation(tray)
      },
      discard: (candidate) => {
        if (client !== candidate) return
        preview?.dispose()
        notifications.dispose()
        relay?.uninstall()
      },
      onState: (next) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!isMainWindow(window) || window.webContents.isDestroyed()) continue
          const sender = window.webContents
          try {
            sender.send(
              DESKTOP_RUNTIME_RECOVERY_CHANNELS.stateChanged,
              next.phase === 'connected' && staleWindows.has(sender.id)
                ? { ...next, phase: 'disconnected', epoch: next.epoch + 1 }
                : next
            )
          } catch {
            markStale(sender)
          }
        }
      }
    })
  let recovery = makeRecovery()
  if (client.ownsRuntime())
    launch.startedProcess?.once('exit', () => {
      if (headless && !updateCommitted && !plannedRelaunch) app.exit(0)
      else if (client && !updateCommitted && !plannedRelaunch) recovery!.disconnect(client)
    })
  const requireRecoveryFrame = (event: import('electron').IpcMainInvokeEvent): void => {
    if (
      !isApplicationWindow(event.sender) ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Desktop recovery requires the main application frame.')
  }
  ipcMainHandle(DESKTOP_RUNTIME_RECOVERY_CHANNELS.getState, (event) => {
    requireRecoveryFrame(event)
    const state = recovery!.state()
    return state.phase === 'connected' && staleWindows.has(event.sender.id)
      ? { ...state, phase: 'disconnected', epoch: state.epoch + 1 }
      : state
  })
  ipcMainHandle(DESKTOP_RUNTIME_RECOVERY_CHANNELS.reconnect, (event) => {
    requireRecoveryFrame(event)
    if (staleWindows.has(event.sender.id) && recovery!.state().phase === 'connected') {
      client!.close()
      recovery!.disconnect(client!)
    }
    return recovery!.reconnect()
  })
  ipcMainHandle(
    DESKTOP_RUNTIME_RECOVERY_CHANNELS.reconciled,
    (event, epoch: number, success: boolean) => {
      requireRecoveryFrame(event)
      const waiting = reconcileWait
      if (
        !waiting ||
        waiting.epoch !== epoch ||
        waiting.pending.get(event.sender.id) !== event.senderFrame
      )
        return
      if (success !== true) {
        waiting.reject(new Error('Desktop state refresh failed.'))
        return
      }
      waiting.pending.delete(event.sender.id)
      if (waiting.pending.size === 0) waiting.resolve()
    }
  )
  let disconnectedQuit: Promise<void> | undefined
  const quitDisconnected = (): Promise<void> =>
    (disconnectedQuit ??= Promise.resolve()
      .then(async () => {
        recovery.setClosing(true)
        const result = await dialog.showMessageBox({
          type: 'warning',
          buttons: [translate('Cancel'), translate('Quit app')],
          defaultId: 0,
          cancelId: 0,
          message: translate('Quit while disconnected?'),
          detail: translate(
            'Unsaved changes may be lost. Submitted operations may have completed. The backend will not be stopped.'
          )
        })
        if (result.response !== 1) {
          // Match ordinary quit cancellation: a no-tray desktop must retain a reachable window.
          if (process.platform !== 'darwin' && !tray && getMainWindow()?.isDestroyed())
            showMainWindow?.()
          return
        }
        client?.close()
        app.exit(0)
      })
      .finally(() => {
        disconnectedQuit = undefined
        recovery.setClosing(false)
      }))
  const handleDisconnectedQuit = (): boolean => {
    if (
      updateCommitted ||
      runtimeStopped ||
      plannedRelaunch ||
      recovery.state().phase === 'connected'
    )
      return false
    void quitDisconnected().catch(reportError)
    return true
  }
  ipcMainHandle(DESKTOP_RUNTIME_RECOVERY_CHANNELS.quit, (event) => {
    requireRecoveryFrame(event)
    if (
      !disconnectedQuit &&
      recovery.state().phase === 'connected' &&
      !staleWindows.has(event.sender.id)
    ) {
      app.quit()
      return
    }
    return quitDisconnected().catch(reportError)
  })
  cleanupStartupClient = async () => {
    retainShutdownLease(await client!.quit())
  }
  if (startupQuitRequested) {
    retainShutdownLease(await client.quit())
    cleanupStartupClient = undefined
    app.exit(0)
    return
  }
  const locale = (await client.invokeHost('locale:snapshot')) as LocalePreferenceSnapshot
  await i18n.changeLanguage(locale.locale)
  installRelay()
  ipcMainHandle('settings:list-app-icons', () =>
    buildAppIconPreviews(nativeImage, iconVariantPaths)
  )
  icons = createAppIconController({
    electron: { app, getAllWindows: () => BrowserWindow.getAllWindows(), nativeImage, nativeTheme },
    variantPaths: iconVariantPaths,
    initialVariant: 'light'
  })
  const { createCliCommandOwner, registerCliInstallIpcHandlers } = await import('./cli-install/ipc')
  const backendPaths = desktopBackendPaths({
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged
  })
  const cliOwner = createCliCommandOwner(() => ({
    platform: process.platform,
    appExecPath: process.execPath,
    nodeExecPath: backendPaths.command,
    cliEntryPath: app.isPackaged
      ? join(process.resourcesPath, 'backend', 'cli.mjs')
      : join(app.getAppPath(), 'cli', 'index.mjs'),
    appImagePath: process.env.APPIMAGE,
    packaged: app.isPackaged,
    homeDir: app.getPath('home'),
    userDataDir: profilePath,
    pathVar: process.env.PATH ?? ''
  }))
  registerCliInstallIpcHandlers(cliOwner)
  void cliOwner.ensureCurrent()
  const { createUpdateStrategy } = await import('./update/create-strategy')
  const { registerUpdateIpcHandlers } = await import('./update/ipc')
  const { startUpdateScheduler } = await import('./update/scheduler')
  const { installElectronNetwork } = await import('./runtime-network-electron')
  const { installElectronBroadcast } = await import('./renderer-broadcast-electron')
  installElectronNetwork()
  const removeNativeBroadcast = installElectronBroadcast()
  let rendererPreparedForUpdate = false
  const flushUpdateRenderer = createElectronSessionPersistenceFlush(() => getMainWindow())
  let preparedMacInstallation: PreparedMacInstallation | undefined
  const isLegacyInstall = (status: { localPath?: string }): boolean =>
    !status.localPath || !usesSupervisedInstall(process.platform, status.localPath)
  const updateIntegration = createDesktopUpdateIntegration({
    location: { installationRoot: installationRootForEntry(backendPaths.entry) },
    client: () => client!,
    currentVersion: app.getVersion(),
    allowedProcessIds: allowedInstallationProcessIds,
    preparedDebGate: () => preparedMacInstallation?.debGate,
    verifyInstallerReady: async () => {
      const gate = preparedMacInstallation?.debGate
      if (gate && (await inspectDebSystemdGate(gate)) !== 'waiting')
        throw new Error(
          'The authorized package gate is no longer ready. Cancel this update and prepare it again.'
        )
    },
    legacyInstall: isLegacyInstall,
    flushRenderer: async (phase) => {
      const outcome = await flushUpdateRenderer()
      diagnostics.log.info('update renderer persistence', { phase, outcome })
      if (outcome !== 'completed')
        throw new UpdateLifecycleError(
          'install-failed',
          'Your changes could not be saved. The update was stopped; keep the app open and try again.'
        )
      rendererPreparedForUpdate = phase === 'final'
    },
    verifyArtifact: async (status, signal) => {
      if (!status.localPath || !status.latest)
        throw new UpdateLifecycleError(
          'installation-busy',
          'This update channel cannot verify the complete replacement installation.',
          {
            phase: 'preparing',
            runtime: 'running',
            installation: 'unchanged',
            canCancel: true,
            canRecover: false,
            canRetryInstall: false,
            detail: 'unsupported-channel'
          }
        )
      assertInstallationChannelCertified(
        installationChannelFor(process.platform, status.localPath) ?? 'linux-deb'
      )
      if (process.platform === 'darwin') {
        if (preparedMacInstallation) {
          await discardPreparedMacInstallation(preparedMacInstallation)
          preparedMacInstallation = undefined
        }
        preparedMacInstallation = await prepareSupervisedMacInstallation({
          archive: status.localPath,
          targetVersion: status.latest,
          installationRoot: installationRootForEntry(backendPaths.entry),
          sha512: status.artifactSha512,
          signal
        })
        return preparedMacInstallation.manifest
      }
      if (process.platform === 'linux' && process.env.APPIMAGE && status.artifactSha512) {
        if (preparedMacInstallation) {
          await discardPreparedMacInstallation(preparedMacInstallation)
          preparedMacInstallation = undefined
        }
        preparedMacInstallation = await prepareSupervisedAppImageInstallation({
          archive: status.localPath,
          targetVersion: status.latest,
          installationRoot: installationRootForEntry(backendPaths.entry),
          sha512: status.artifactSha512,
          runtimeNode: backendPaths.command,
          signal
        })
        return preparedMacInstallation.manifest
      }
      if (
        status.artifactSha512 &&
        process.platform === 'linux' &&
        status.localPath.toLowerCase().endsWith('.deb')
      ) {
        if (preparedMacInstallation) {
          await discardPreparedMacInstallation(preparedMacInstallation)
          preparedMacInstallation = undefined
        }
        const installerOptions = {
          archive: status.localPath,
          targetVersion: status.latest,
          installationRoot: installationRootForEntry(backendPaths.entry),
          sha512: status.artifactSha512,
          runtimeNode: backendPaths.command,
          currentExecutable: process.execPath,
          signal
        }
        preparedMacInstallation = await prepareSupervisedDebInstallation(installerOptions)
        return preparedMacInstallation.manifest
      }
      throw new UpdateLifecycleError(
        'installation-busy',
        'This installer channel does not yet provide a supervised completion receipt.',
        {
          phase: 'preparing',
          runtime: 'running',
          installation: 'unchanged',
          canCancel: true,
          canRecover: false,
          canRetryInstall: false,
          detail: 'unsupported-channel'
        }
      )
    },
    validateConfiguration: (config) => {
      // Attachment permits file-backed credentials, but an interactive replacement Desktop cannot
      // silently change their storage mode or the Chromium profile selected during preflight.
      if (
        config.credentialStore !== getCredentialStore() ||
        config.profilePath !== profilePath ||
        config.configRoot !== configRoot ||
        (config.passwordStore ?? '') !== app.commandLine.getSwitchValue('password-store')
      )
        throw new UpdateLifecycleError(
          'runtime-configuration-unsupported',
          'This Desktop cannot safely preserve the running service configuration.'
        )
    },
    setClosing: (closing) => {
      recovery.setClosing(closing)
      if (!closing) {
        rendererPreparedForUpdate = false
        notifyRendererSessionPersistenceFlushAborted(() => getMainWindow())
      }
    },
    retainLease: retainShutdownLease,
    onProgress: (status) => update.publishLifecycleStatus?.(status),
    onStopped: () => {
      runtimeStopped = true
    },
    onHandoff: () => {
      updateCommitted = true
    },
    reconnectOriginal: async () => {
      const previous = client!
      const identity = previous.runtimeInfo()
      recovery.setClosing(false)
      recovery.disconnect(previous)
      const result = await recovery.reconnect()
      if (
        result.phase !== 'connected' ||
        client!.processId() !== previous.processId() ||
        client!.runtimeInfo().generation !== identity.generation
      )
        throw new Error(
          'The original service could not be reconnected. Check its shutdown logs before recovery.'
        )
      await verifyDesktopRecoveryReadiness(client!, identity.startupOptions)
    },
    restart: async (config: RuntimeStartupOptions) => {
      shutdownLease?.release()
      shutdownLease = undefined
      client?.close()
      preview?.dispose()
      notifications.dispose()
      relay?.uninstall()
      ready = false
      launch = await startOrAttachDesktopBackend({
        configRoot: config.configRoot,
        profilePath: config.profilePath,
        version: app.getVersion(),
        ...backendPaths,
        packaged: app.isPackaged,
        args: [
          `--credential-store=${config.credentialStore}`,
          ...(config.passwordStore ? [`--password-store=${config.passwordStore}`] : []),
          `--serve=${config.port}`
        ]
      })
      startedBackend = launch.startedProcess
      client = await attach()
      notifications = makeNotifications()
      await verifyDesktopRecoveryReadiness(client, config)
      runtimeStopped = false
      updateCommitted = false
      recovery = makeRecovery()
      publishStartup(client.startupState())
      await readiness
      for (const window of BrowserWindow.getAllWindows())
        if (isMainWindow(window)) window.webContents.reload()
    }
  })
  const update = createUpdateStrategy(process.platform, {
    translate,
    getStartupOptions: () => client!.runtimeInfo().startupOptions,
    ...updateIntegration,
    cancelInstall: async () => {
      if (preparedMacInstallation?.debGate)
        await cancelDebSystemdGate(preparedMacInstallation.debGate)
      const result = await updateIntegration.cancelInstall!()
      if (preparedMacInstallation) {
        await discardPreparedMacInstallation(preparedMacInstallation)
        preparedMacInstallation = undefined
      }
      return result
    },
    ...(['darwin', 'linux', 'win32'].includes(process.platform)
      ? {
          executeInstall: async (status, options) => {
            const operationId = status.recovery?.operationId
            if (isLegacyInstall(status)) return 'legacy' as const
            if (!preparedMacInstallation || !operationId)
              throw new UpdateLifecycleError(
                'install-failed',
                'The prepared installer is unavailable.'
              )
            await launchPreparedMacInstaller(
              { installationRoot: installationRootForEntry(backendPaths.entry) },
              operationId,
              preparedMacInstallation,
              { desktopPid: process.pid, relaunch: options.relaunch ?? true }
            )
            app.exit(0)
            return undefined
          }
        }
      : {})
  })
  registerUpdateIpcHandlers(update, undefined, requireRecoveryFrame)
  const stopUpdates = startUpdateScheduler(update)
  app.once('will-quit', () => {
    stopUpdates()
    removeNativeBroadcast()
  })
  const settings = async (): Promise<SettingsSnapshot> =>
    client!.invokeHost('settings:get-settings') as Promise<SettingsSnapshot>
  let work: DesktopShutdownWork | undefined
  let admission: Promise<unknown> = Promise.resolve()
  app.removeListener('before-quit', holdStartupQuit)
  app.on('before-quit', (event) => {
    // Preserve committed teardown; an idle disconnected shell must also be quittable without a window.
    if (updateCommitted || runtimeStopped || plannedRelaunch) return
    const state = recovery.state()
    if (currentApplicationShutdownTrigger() === 'system' && state.phase !== 'connected') {
      // OS shutdown cannot wait for consent or an unreachable backend, including an open quit dialog.
      event.preventDefault()
      client?.close()
      app.exit(0)
      return
    }
    if (!disconnectedQuit && (state.phase === 'connected' || state.closing)) return
    event.preventDefault()
    void quitDisconnected().catch(reportError)
  })
  const finishedStartupWindow = startupWindow
  startupWindow = undefined
  const lifecycle = installAppLifecycle({
    app,
    createInitialWindow: !headless || Boolean(finishedStartupWindow),
    initialWindow: finishedStartupWindow,
    createMainWindow: (options) => createMainWindow(options, translate),
    configureMainWindow,
    createTray: (handlers) =>
      (tray = createAppTray({
        ...handlers,
        iconPath: trayIconPath,
        templateIconPath: process.platform === 'darwin' ? trayMacTemplate : undefined,
        variantIconPaths: trayVariantIconPaths,
        translate,
        getNavigationSessions: async () =>
          ready
            ? ((await client!.invokeHost(
                'desktop:tray-sessions'
              )) as import('./tray-navigation').TrayNavigationSession[])
            : [],
        getRunningSessions: () => work?.sessions ?? [],
        onOpenSession: (id) => {
          handlers.onShow()
          void client!
            .invokeHost('desktop:open-session', [id])
            .then(() => getMainWindow()?.webContents.send('notifications:open-session'))
            .catch(reportError)
        }
      })),
    quit: () => app.quit(),
    countWindows: () => BrowserWindow.getAllWindows().length,
    isMigrationInProgress: () => false,
    refreshQuitState: async () => {
      if (runtimeStopped) return false
      if (recovery!.state().phase !== 'connected')
        throw new Error('Use the connection notice to quit while disconnected.')
      if (!client!.ownsRuntime() || !ready) return false
      let next = (await client!.lifecycle({ operation: 'inspect' })) as DesktopShutdownWork
      if (next.migrationActive) {
        const confirmed =
          currentApplicationShutdownTrigger() === 'system' ||
          (
            await dialog.showMessageBox({
              type: 'warning',
              buttons: [translate('Keep waiting'), translate('Quit anyway')],
              defaultId: 0,
              cancelId: 0,
              title: translate('Move in progress'),
              message: translate('Open-Science is still moving your data.'),
              detail: translate(
                'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.'
              )
            })
          ).response === 1
        if (!confirmed) throw new Error('The data move is still running. The desktop remains open.')
        await client!.lifecycle({ operation: 'cancel-migration' })
        next = (await client!.lifecycle({ operation: 'inspect' })) as DesktopShutdownWork
      }
      const changed = work?.fingerprint !== next.fingerprint
      work = next
      return changed
    },
    detectActiveSessions: () => work?.sessions ?? [],
    hasActiveReviewerWork: () => work?.reviewerActive ?? false,
    getActiveSettingsInstallId: () => work?.settingsInstallId,
    holdSettingsInstallAdmission: () => {
      recovery!.setClosing(true)
      if (!runtimeStopped && client!.ownsRuntime() && ready)
        admission = client!.lifecycle({ operation: 'hold' })
      void admission.catch(() => undefined)
      return () => {
        recovery!.setClosing(false)
        if (!runtimeStopped && client!.ownsRuntime() && ready)
          void client!.lifecycle({ operation: 'release' }).catch((error) => {
            // Disconnected quit owns one decision; rollback errors must not stack native modals.
            if (
              currentApplicationShutdownTrigger() === 'system' ||
              recovery.state().phase !== 'connected'
            )
              bootstrapLog.error('quit admission release failed', {
                error: projectDiagnosticError(error, { configRoot, home: app.getPath('home') })
              })
            else reportError(error)
          })
      }
    },
    prepareForQuit: async () => {
      await admission
      if (!runtimeStopped && client!.ownsRuntime() && ready && work)
        return (await client!.lifecycle({
          operation: 'prepare',
          fingerprint: work.fingerprint
        })) as 'completed' | 'timeout' | 'failed'
      return undefined
    },
    abortQuitPreparation: async (reason) => {
      try {
        if (!runtimeStopped && client!.ownsRuntime() && ready)
          await client!.lifecycle({ operation: 'abort' })
      } finally {
        recovery!.setClosing(false)
        notifyRendererSessionPersistenceFlushAborted(() => getMainWindow(), reason)
      }
    },
    flushSessionPersistence: createElectronSessionPersistenceFlush(() => getMainWindow()),
    rendererPersistencePreparedForUpdate: () => rendererPreparedForUpdate && runtimeStopped,
    createConfirmClose: (getWindow) =>
      createElectronCloseConfirm(
        getWindow,
        {
          get: async () => (ready ? (await settings()).closePreference : undefined),
          set: async (preference) => {
            await client!.invokeHost('settings:set-close-preference', [preference])
          }
        },
        translate
      ),
    onAppearanceChanged: (appearance) => icons?.setAppearance(appearance),
    log: diagnostics.log,
    flushLogs,
    requireCleanBackendShutdown: true,
    handleDisconnectedQuit,
    onQuitError: (error) => {
      recovery!.setClosing(false)
      if (!handleDisconnectedQuit()) reportError(error)
    },
    shutdownBackends: async () => {
      if (!runtimeStopped) retainShutdownLease(await client!.quit())
      preview?.dispose()
      notifications.dispose()
      visibility.dispose()
      relay?.uninstall()
    },
    beforeExit: async () => {
      const { completeMacInstallationHandoff } = await import('./mac-installation')
      completeMacInstallationHandoff()
    }
  })
  // Install the normal lifecycle and its first window before closing the startup gate.
  // Otherwise Electron may quit on window-all-closed and orphan the newly started backend.
  showMainWindow = lifecycle.showMainWindow
  getMainWindow = lifecycle.getMainWindow
  isMainWindowHidden = lifecycle.isMainWindowHidden
  requestSystemShutdown = lifecycle.onSystemShutdown
  for (const window of BrowserWindow.getAllWindows()) system.bindWindow(window)
  app.on('browser-window-created', (_event, window) => {
    system.bindWindow(window)
    if (ready) client?.notificationView('window-created')
  })
  app.on('browser-window-focus', () => {
    if (ready) client?.notificationView('focus')
  })
  acceptStartupEvents = true
  publishStartup(client.startupState())
  await readiness
  if (preservedStartupOptions && !windowsUpdateAlreadyConfirmed) {
    try {
      await verifyDesktopRecoveryReadiness(client, preservedStartupOptions)
      await completeVerifiedStartup?.()
      // Stopping an older service is not an installation recovery; publish only a real outcome.
      if (verifiedStartupOutcome)
        update.publishLifecycleStatus?.({
          outcome: verifiedStartupOutcome,
          reason: undefined,
          recovery: undefined,
          error: undefined
        })
      publishRuntimeStartup({ phase: 'ready' })
    } catch (error) {
      const issue = {
        reason: 'startup-recovery-required' as const,
        desktopVersion: app.getVersion(),
        canStop: false,
        canRecover: true,
        diagnostics: JSON.stringify(
          projectDiagnosticError(error, { configRoot, home: app.getPath('home') })
        )
      }
      startupFailure = new DesktopRuntimeStartupError(
        issue,
        'The original data is not ready.',
        undefined,
        async () => {
          await verifyDesktopRecoveryReadiness(client!, preservedStartupOptions!, 60_000, true)
          await completeVerifiedStartup?.()
          publishRuntimeStartup({ phase: 'ready' })
        }
      )
      publishRuntimeStartup({ phase: 'blocked', issue })
    }
  } else publishRuntimeStartup({ phase: 'ready' })
  if (process.platform === 'win32') {
    const timer = setTimeout(() => {
      void cleanupWindowsUpdateHandoffs(app.getPath('appData')).catch((error) =>
        bootstrapLog.warn('Update presentation cleanup deferred', diagnosticErrorFields(error))
      )
    }, 5000)
    timer.unref()
  }
  if (secondInstancePending) showMainWindow()
  const { isReadOnlyMacInstallation, showMacInstallationGuidance } =
    await import('./mac-installation')
  if (isReadOnlyMacInstallation()) void showMacInstallationGuidance('startup')
  cleanupStartupClient = undefined
  diagnostics.operation.complete()
}
void startDesktop().catch(async (error: unknown) => {
  browserImports.failPending()
  const failureFields = {
    ...diagnosticErrorFields(error),
    phase: bootstrapPhase,
    ...(error instanceof CredentialIdentityError
      ? { recoveryReason: error.reason, validationDiagnostic: error.diagnostic }
      : {})
  }
  bootstrapLog.error('desktop startup failed', failureFields)
  const message =
    error instanceof CredentialIdentityError
      ? credentialRecoveryMessage(error, app.getPreferredSystemLanguages())
      : error instanceof Error
        ? error.message
        : String(error)
  // Failed identity preflight must not yield to Chromium's profile/key initialization.
  if (!app.isReady()) {
    // This path must not await: preserve the diagnostic before the immediate process exit.
    writeFatalLogSync('desktop-bootstrap', 'desktop startup failed', failureFields)
    dialog.showErrorBox(APP_NAME, message)
    app.exit(1)
    return
  }
  await reportApplicationStartupFailure({ operation: startupDiagnostics, error, flush: flushLogs })
  try {
    await cleanupStartupClient?.()
  } catch (cleanupError) {
    bootstrapLog.error('startup backend cleanup failed', diagnosticErrorFields(cleanupError))
    await flushLogs()
  }
  if (error instanceof DesktopBackendStartupError) {
    await recoverDesktopBackendStartup(error)
    return
  }
  dialog.showErrorBox(APP_NAME, message)
  app.exit(1)
})
