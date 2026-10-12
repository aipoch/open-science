import { stringifyRpcJson } from './rpc-json'
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
import { join } from 'node:path'
import type { InterfaceScaleShortcut } from '../shared/interface-scale'
import type { DatabaseStartupState } from '../shared/database-startup'
import { DATABASE_STARTUP_CHANNELS } from '../shared/database-startup'
import type { SettingsSnapshot } from '../shared/settings'
import type { LocalePreferenceSnapshot } from '../shared/locale'
import { acquireRuntimeDirectorySync } from './runtime-ownership'
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
  configureCredentialStore(process.argv, process.platform, false)
  const configRoot = resolveBootstrapConfigRoot(app.getPath('home'), app.isPackaged)
  const profilePath = resolveElectronProfile({
    appData: app.getPath('appData'),
    configRoot,
    packaged: app.isPackaged
  })
  // Only credential identity/profile preflight runs here. Node owns all business directories and
  // credential reads/writes. Finish Windows key creation before Chromium can initialize OSCrypt.
  const bootstrapLease = acquireRuntimeDirectorySync(
    join(app.getPath('home'), '.open-science-credential-bootstrap')
  )
  try {
    const identity = selectStartupCredentialIdentity({
      platform: process.platform,
      packaged: app.isPackaged,
      credentialStore: getCredentialStore(),
      linuxPasswordStore: app.commandLine.getSwitchValue('password-store')
    })
    app.setName(identity.appName)
    app.setPath('userData', profilePath)
    app.setPath('sessionData', profilePath)
    // A second shell must notify the owner before inspecting its Chromium-locked files.
    if (
      !(!app.isPackaged && process.env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE === '1') &&
      !app.requestSingleInstanceLock()
    ) {
      app.quit()
      return
    }
    prepareCredentialValidation(identity, { configRoot, profilePath })
    if (identity.backend === 'windows-dpapi') initializeNodeWindowsProfileKey(profilePath)
  } finally {
    bootstrapLease.release()
  }
  let startupQuitRequested = false
  const holdStartupQuit = (event: Electron.Event): void => {
    event.preventDefault()
    startupQuitRequested = true
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
    for (const path of packagePathsFromArgv(argv, cwd)) packageFiles.receive(path)
    if (showMainWindow) showMainWindow()
    else secondInstancePending = true
  })
  for (const path of packagePathsFromArgv(process.argv, process.cwd())) packageFiles.receive(path)
  let client: DesktopRuntimeClient | undefined = undefined
  const reportError = (error: unknown): void => {
    bootstrapLog.error('desktop operation failed', diagnosticErrorFields(error))
    dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error))
  }
  bootstrapPhase = 'electron-ready'
  await app.whenReady()
  app.setName(app.isPackaged ? APP_NAME : `${APP_NAME} (DEV)`)
  app.setAppLogsPath(join(profilePath, 'logs'))
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
    start: (options) => crashReporter.start(options)
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
  let updateCommitted = false
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
  let bufferedEventBytes = 0
  let bufferedEvents: { channel: string; payload: unknown }[] = []
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
    'update:apply'
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
        }
        state = next
        broadcast(DATABASE_STARTUP_CHANNELS.stateChanged, state)
      })
      .catch(reportError)
  }
  startupDiagnostics?.phase('launch-node-runtime')
  const launch = await startOrAttachDesktopBackend({
    configRoot,
    profilePath,
    version: app.getVersion(),
    ...desktopBackendPaths({
      applicationPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged
    }),
    packaged: app.isPackaged,
    args: process.argv.filter(
      (arg) => arg.startsWith('--credential-store=') || arg.startsWith('--password-store=')
    )
  })
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
  startupDiagnostics?.phase('connect-node-runtime')
  const deliverRuntimeEvent = ({
    channel,
    payload
  }: {
    channel: string
    payload: unknown
  }): void => {
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
      onNativeRequest: async (request, signal) => {
        signal.throwIfAborted()
        if (request.request.operation === 'runtime-relaunch') {
          if (!client!.ownsRuntime()) return false
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
          const eventBytes = Buffer.byteLength(stringifyRpcJson({ channel, payload }))
          if (bufferedEvents.length >= 2048 || bufferedEventBytes + eventBytes > 16 * 1024 * 1024) {
            reconcileWait?.reject(new Error('Desktop recovery event budget exceeded.'))
            return
          }
          bufferedEventBytes += eventBytes
          bufferedEvents.push({ channel, payload })
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
        if (plannedRelaunch) {
          const restart = (): void => {
            app.relaunch()
            app.exit(0)
          }
          if (launch.startedProcess && launch.startedProcess.exitCode === null)
            launch.startedProcess.once('exit', restart)
          else restart()
        } else if (!updateCommitted) recovery?.disconnect(attached)
      }
    })
    return attached
  }
  client = await attach()
  const recovery = createDesktopRuntimeRecovery({
    client,
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
      bufferedEvents = []
      bufferedEventBytes = 0
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
      for (const event of bufferedEvents) deliverRuntimeEvent(event)
      bufferedEvents = []
      bufferedEventBytes = 0
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
  ipcMainHandle(DESKTOP_RUNTIME_RECOVERY_CHANNELS.quit, async (event) => {
    requireRecoveryFrame(event)
    if (recovery!.state().phase === 'connected' && !staleWindows.has(event.sender.id)) {
      app.quit()
      return
    }
    recovery!.setClosing(true)
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
      recovery!.setClosing(false)
      return
    }
    client?.close()
    app.exit(0)
  })
  cleanupStartupClient = () => client!.quit()
  if (startupQuitRequested) {
    await client.quit()
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
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.getState, () => state)
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.retry, async () => {
    await client!.retryStartup()
    await readiness
    return state
  })
  ipcMainHandle(DATABASE_STARTUP_CHANNELS.quit, () => app.quit())
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
  const update = createUpdateStrategy(process.platform, {
    translate,
    installGate: async (options) => {
      recovery!.setClosing(true)
      try {
        if (!client!.ownsRuntime())
          throw new Error(
            'Stop the independently started server with open-science stop before updating this desktop installation.'
          )
        const result = (await client!.invokeHost('desktop:update-gate', [
          options ?? {}
        ])) as import('./update/strategy').InstallReadiness
        if (!result.completed || !result.reaped) return result
        await client!.quit()
        updateCommitted = true
        return result
      } finally {
        if (!updateCommitted) recovery!.setClosing(false)
      }
    },
    releaseInstallHandoff: () => {
      if (!updateCommitted) recovery!.setClosing(false)
      if (!updateCommitted) void client!.invokeHost('desktop:update-abort').catch(reportError)
    }
  })
  registerUpdateIpcHandlers(update)
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
  const lifecycle = installAppLifecycle({
    app,
    createInitialWindow: !headless,
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
      if (client!.ownsRuntime() && ready) admission = client!.lifecycle({ operation: 'hold' })
      void admission.catch(() => undefined)
      return () => {
        recovery!.setClosing(false)
        if (client!.ownsRuntime() && ready)
          void client!.lifecycle({ operation: 'release' }).catch(reportError)
      }
    },
    prepareForQuit: async () => {
      await admission
      if (client!.ownsRuntime() && ready && work)
        return (await client!.lifecycle({
          operation: 'prepare',
          fingerprint: work.fingerprint
        })) as 'completed' | 'timeout' | 'failed'
      return undefined
    },
    abortQuitPreparation: async (reason) => {
      try {
        if (client!.ownsRuntime() && ready) await client!.lifecycle({ operation: 'abort' })
      } finally {
        recovery!.setClosing(false)
        notifyRendererSessionPersistenceFlushAborted(() => getMainWindow(), reason)
      }
    },
    flushSessionPersistence: createElectronSessionPersistenceFlush(() => getMainWindow()),
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
    onQuitError: (error) => {
      recovery!.setClosing(false)
      reportError(error)
    },
    shutdownBackends: async () => {
      await client!.quit()
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
  if (secondInstancePending) showMainWindow()
  const { isReadOnlyMacInstallation, showMacInstallationGuidance } =
    await import('./mac-installation')
  if (isReadOnlyMacInstallation()) void showMacInstallationGuidance('startup')
  cleanupStartupClient = undefined
  diagnostics.operation.complete()
}
void startDesktop().catch(async (error: unknown) => {
  bootstrapLog.error('desktop startup failed', {
    ...diagnosticErrorFields(error),
    phase: bootstrapPhase,
    ...(error instanceof CredentialIdentityError ? { recoveryReason: error.reason } : {})
  })
  const message =
    error instanceof CredentialIdentityError
      ? credentialRecoveryMessage(error, app.getPreferredSystemLanguages())
      : error instanceof Error
        ? error.message
        : String(error)
  // Failed identity preflight must not yield to Chromium's profile/key initialization.
  if (!app.isReady()) {
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
  dialog.showErrorBox(APP_NAME, message)
  app.exit(1)
})
