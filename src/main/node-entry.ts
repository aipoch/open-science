import { withRuntimeShutdownLifetime } from './runtime-shutdown-lifetime'
import {
  installationRootForEntry,
  registerInstallationRuntime
} from './update/installation-protection'
import { randomUUID } from 'node:crypto'
import { writeRuntimeExit } from './runtime-stop-confirmation'
import { resolveDataRoot } from './storage-root'
import { backendStartupAttemptId, createBackendStartupReporter } from './backend-startup'
import {
  buildStartupDiagnostics,
  createLogger,
  diagnosticErrorFields,
  errorLogFields,
  flushLogs,
  initLogger
} from '@aipoch/diagnostics/node'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ApplicationCommandByNameDispatcher } from './application-command-composition-contract'
import type { ApplicationEvent } from './application-events'
import { requireDesktopCaller } from './caller-context'
import {
  prepareCredentialValidation,
  selectStartupCredentialIdentity
} from './credential-identity/bootstrap'
import { consumeCredentialInventoryFromEnv } from './credential-identity/inventory-handoff'
import {
  createNodeSecureStorageCipher,
  initializeNodeWindowsProfileKey
} from './credential-identity/node-cipher'
import { CredentialIdentityError } from './credential-identity/selection'
import { createDatabaseStartupLogging } from './database/database-startup-logging'
import {
  createDatabaseStartupOwner,
  waitForVerifiedDatabaseStartup
} from './database/database-startup-owner'
import {
  configureDesktopFileInteraction,
  configureDesktopShellInteraction,
  createRemoteDesktopFileInteraction,
  createRemoteDesktopShellInteraction,
  DesktopCapabilityUnavailable
} from './desktop-interaction'
import { currentDesktopCaller } from './desktop-native-contract'
import { createDesktopRuntimeLifecycle } from './desktop-runtime-lifecycle'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import { initializeApplicationDiagnostics } from './diagnostics/startup'
import { LocalePreferenceOwner } from './locale/owner'
import { createNetworkCommandOwner } from './network-ipc'
import { createRemoteNotificationDelivery } from './notifications/desktop-delivery'
import {
  configureOfficePreviewHost,
  createRemoteOfficePreviewHost
} from './office-preview/application-commands'
import { RemoteAccessService } from './remote-access/service'
import { addRendererBroadcastSink, broadcastToRenderers } from './renderer-broadcast'
import {
  configureDesktopReviewer,
  createRemoteReviewerResolver
} from './reviewer/paged-preview-host'
import { startRuntimeControl } from './runtime-control'
import { isRuntimeHelper, runRuntimeHelper } from './runtime-helper'
import { configureRuntimeLifecycle } from './runtime-lifecycle'
import { configureRuntimeMetadata } from './runtime-metadata'
import { configureRuntimeNetwork } from './runtime-network'
import { createNodeRuntimeNetwork } from './runtime-network-node'
import {
  acquireCredentialBootstrapLease,
  configureRuntimeDirectoryOwnership,
  RuntimeDirectoryOwnership,
  RuntimeOwnershipConflict
} from './runtime-ownership'
import { configureSecureStorageCipher } from './secure-storage'
import { configureCredentialStore, getCredentialStore } from './settings/credential-store-mode'
import { resolveBootstrapConfigRoot } from './storage/config-root'
import { resolveElectronProfile } from './storage/electron-profile'
import { cancelMigrationForQuit, isMigrationInProgress } from './storage/migration-state'
import { parseWebModeOptions } from './web-service/options'

const startupReporter = createBackendStartupReporter()

async function main(): Promise<void> {
  const mainEntryPath = fileURLToPath(import.meta.url)
  const applicationPath = resolve(dirname(mainEntryPath), '../..')
  const metadata = JSON.parse(readFileSync(join(applicationPath, 'package.json'), 'utf8')) as {
    version: string
  }
  const helper = isRuntimeHelper(process.argv)
  const home = helper ? (process.env.OPEN_SCIENCE_HOST_HOME ?? homedir()) : homedir()
  const packaged = helper
    ? process.env.OPEN_SCIENCE_HOST_PACKAGED === '1'
    : !process.argv.includes('--development')
  configureRuntimeMetadata(() => ({
    version: metadata.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    packaged,
    applicationPath,
    homePath: home,
    downloadsPath: join(home, 'Downloads'),
    resourcesPath: join(applicationPath, 'resources')
  }))
  // Helpers never acquire business ownership or construct a second application runtime.
  if (await runRuntimeHelper(process.argv)) return
  const configRoot = resolveBootstrapConfigRoot(home, packaged)
  const generation = randomUUID()
  const installationLease = registerInstallationRuntime({
    installationRoot: installationRootForEntry(mainEntryPath),
    configRoot,
    generation,
    pid: process.pid
  })
  const ownership = new RuntimeDirectoryOwnership()
  ownership.acquireSync(configRoot)
  configureRuntimeDirectoryOwnership(ownership)
  // Credential preflight can fail before full application diagnostics are initialized.
  initLogger({ logDir: join(configRoot, 'logs') })
  const network = createNodeRuntimeNetwork()
  configureRuntimeNetwork(network)
  let runtime: Awaited<ReturnType<typeof import('./core-runtime').createCoreRuntime>> | undefined
  let web: ReturnType<typeof import('./web-service').createWebServiceController> | undefined
  let control: Awaited<ReturnType<typeof startRuntimeControl>> | undefined
  let desktop: Awaited<ReturnType<typeof startDesktopRuntimeTransport>> | undefined
  let notificationDelivery: ReturnType<typeof createRemoteNotificationDelivery> | undefined
  let cipher: ReturnType<typeof createNodeSecureStorageCipher> | undefined
  let remoteAccess: RemoteAccessService | undefined
  let stopping: Promise<void> | undefined
  const startupCancellation = new AbortController()
  let unsubscribeLocale: (() => void) | undefined
  let restartRequested = false
  let desktopWillRestart = false
  let stopRequested = false
  let profilePath: string | undefined
  let credentialFailure: CredentialIdentityError | undefined
  let finishStartup!: () => void
  const startupFinished = new Promise<void>((resolve) => {
    finishStartup = resolve
  })
  const abortStartupIfStopping = (): void => {
    if (stopRequested) throw new Error('Node runtime startup was cancelled by a shutdown request.')
  }
  let disconnectDatabase: (() => Promise<void>) | undefined
  const stop = (): Promise<void> => {
    stopRequested = true
    startupCancellation.abort()
    return (stopping ??= withRuntimeShutdownLifetime(async () => {
      await startupFinished
      let failed = false
      try {
        const outcome = await runtime?.prepareForQuit()
        if (outcome && outcome !== 'completed') failed = true
      } catch (error) {
        failed = true
        createLogger('node-runtime').error(
          'shutdown preparation failed',
          diagnosticErrorFields(error)
        )
      }
      let shutdownStep = 0
      for (const close of [
        () => remoteAccess?.shutdown(),
        () => control?.close(),
        () => desktop?.close(),
        () => web?.dispose(),
        () => runtime?.dispose(),
        () => disconnectDatabase?.(),
        () => network.close(),
        () => flushLogs()
      ]) {
        try {
          createLogger('node-runtime').info('shutdown step started', { step: shutdownStep })
          await close()
          createLogger('node-runtime').info('shutdown step completed', { step: shutdownStep })
        } catch (error) {
          failed = true
          createLogger('node-runtime').error('shutdown failed', diagnosticErrorFields(error))
        } finally {
          shutdownStep += 1
        }
      }
      try {
        unsubscribeLocale?.()
        cipher?.dispose()
      } catch {
        failed = true
      }
      try {
        await writeRuntimeExit(configRoot, {
          generation,
          pid: process.pid,
          outcome: failed || credentialFailure ? 'failed' : 'clean'
        })
      } catch {
        failed = true
      }
      // A failed child-process drain must not release ownership while this process remains alive.
      if (!failed) {
        try {
          await ownership.close()
          installationLease.release()
        } catch (error) {
          failed = true
          createLogger('node-runtime').error(
            'shutdown ownership release failed',
            diagnosticErrorFields(error)
          )
          try {
            await writeRuntimeExit(configRoot, { generation, pid: process.pid, outcome: 'failed' })
          } catch (recordError) {
            createLogger('node-runtime').error(
              'shutdown failure record failed',
              diagnosticErrorFields(recordError)
            )
          }
        }
      }
      process.exitCode = failed || credentialFailure ? 1 : 0
      if (restartRequested && !desktopWillRestart && !failed) {
        const { spawn } = await import('node:child_process')
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          env: process.env
        })
        child.once('error', (error) => {
          createLogger('node-runtime').error('restart failed', diagnosticErrorFields(error))
          process.exitCode = 1
        })
        child.unref()
      }
    }))
  }
  process.once('SIGINT', () => {
    void stop()
  })
  process.once('SIGTERM', () => {
    void stop()
  })
  configureRuntimeLifecycle({
    relaunch: () => {
      restartRequested = true
    },
    quit: () => {
      void (async () => {
        if (restartRequested && desktop?.isConnected()) {
          try {
            desktopWillRestart =
              (await desktop.requestNative({ operation: 'runtime-relaunch' })) === true
          } catch (error) {
            createLogger('node-runtime').warn(
              'desktop relaunch notification failed',
              errorLogFields(error)
            )
          }
        }
        await stop()
      })()
    },
    exit: (code) => process.exit(code)
  })
  try {
    startupReporter.phase('credentials')
    configureCredentialStore(process.argv, process.platform, true)
    const passwordStore = process.argv
      .find((arg) => arg.startsWith('--password-store='))
      ?.slice('--password-store='.length)
    const appData =
      process.platform === 'win32'
        ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
        : process.platform === 'darwin'
          ? join(home, 'Library', 'Application Support')
          : process.env.XDG_CONFIG_HOME || join(home, '.config')
    profilePath = resolveElectronProfile({ appData, configRoot, packaged })
    const credentialBootstrapLease = acquireCredentialBootstrapLease({
      home,
      profilePath,
      platform: process.platform
    })
    let identity: ReturnType<typeof selectStartupCredentialIdentity>
    try {
      identity = selectStartupCredentialIdentity({
        platform: process.platform,
        packaged,
        credentialStore: getCredentialStore(),
        linuxPasswordStore: passwordStore
      })
      ownership.acquireSync(profilePath)
      const preloadedCiphertexts = await consumeCredentialInventoryFromEnv({
        attemptId: backendStartupAttemptId ?? '',
        configRoot,
        profilePath
      })
      const validateCredentials = prepareCredentialValidation(
        identity,
        { configRoot, profilePath },
        preloadedCiphertexts
      )
      if (identity.backend === 'windows-dpapi') await initializeNodeWindowsProfileKey(profilePath)
      cipher = createNodeSecureStorageCipher(identity, profilePath)
      configureSecureStorageCipher(cipher)
      validateCredentials(cipher, (error) => {
        credentialFailure = error
        createLogger('node-runtime').error('credential recovery required', { reason: error.reason })
        void stop()
      })
      if (identity.backend !== 'file') cipher.isEncryptionAvailable()
    } finally {
      credentialBootstrapLease.release()
    }
    const diagnostics = initializeApplicationDiagnostics({
      logDir: join(configRoot, 'logs'),
      consoleFormat: process.stdout.isTTY ? 'text' : 'json',
      version: metadata.version,
      isPackaged: packaged,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      cpuUsage: process.cpuUsage
    })
    startupReporter.phase('storage')
    const { prepareApplicationLocations } = await import('./storage/initialize-location')
    const { settingsStore, repository } = await prepareApplicationLocations(configRoot)
    const startupSettings = await repository.getSettings()
    const localeOwner = new LocalePreferenceOwner(
      [Intl.DateTimeFormat().resolvedOptions().locale],
      repository,
      startupSettings.localePreference
    )
    unsubscribeLocale = localeOwner.subscribe((snapshot) =>
      broadcastToRenderers('locale:changed', snapshot)
    )
    const networkCommands = createNetworkCommandOwner()
    const { getProjectDbClient, disconnectProjectDbClient } =
      await import('./projects/prisma-client')
    disconnectDatabase = disconnectProjectDbClient
    abortStartupIfStopping()
    const databaseLogging = createDatabaseStartupLogging(diagnostics.log, metadata.version)
    const databaseStartup = createDatabaseStartupOwner({
      reportBlocked: databaseLogging.reportBlocked,
      verifyDatabase: async (onProgress) => {
        await getProjectDbClient(configRoot, databaseLogging.migrationOptions(onProgress))
      },
      buildDiagnostics: (error) =>
        buildStartupDiagnostics(error, { configRoot, dataRoot: startupSettings.dataRoot }),
      environment: {
        appVersion: metadata.version,
        platform: process.platform,
        arch: process.arch,
        electron: 'not used (Node backend)',
        node: process.versions.node
      }
    })
    const earlyChannels = [
      'locale:initialize',
      'locale:set-preference',
      'network:get-info',
      'network:check-connectivity'
    ]
    const startupCommands: ApplicationCommandByNameDispatcher = {
      commandNames: () => runtime?.applicationCommands.desktop.commandNames() ?? earlyChannels,
      invoke: (name, invocation) => {
        if (runtime) return runtime.applicationCommands.desktop.invoke(name, invocation)
        requireDesktopCaller(invocation.callerContext)
        switch (name) {
          case 'locale:initialize':
            return localeOwner.initialize(
              (invocation.args[0] as { cachedPreference?: unknown })?.cachedPreference
            )
          case 'locale:set-preference':
            return localeOwner.setPreference(
              (invocation.args[0] as { preference?: unknown })?.preference
            )
          case 'network:get-info':
            return networkCommands.getInfo()
          case 'network:check-connectivity':
            return networkCommands.checkConnectivity()
          default:
            throw new Error('The runtime is still starting.')
        }
      }
    }
    const runtimeStartupOptions: import('./desktop-runtime-info').RuntimeStartupOptions = {
      configRoot,
      dataRoot: resolveDataRoot(),
      profilePath: profilePath!,
      port: parseWebModeOptions(process.argv).port,
      host: '127.0.0.1',
      credentialStore: getCredentialStore(),
      ...(passwordStore ? { passwordStore } : {})
    }
    desktop = await startDesktopRuntimeTransport({
      version: metadata.version,
      generation,
      launch: process.argv.includes('--desktop') ? 'desktop' : 'cli',
      entryPath: realpathSync(mainEntryPath),
      startupOptions: runtimeStartupOptions,
      createLifecycle: () => {
        let lifecycle: ReturnType<typeof createDesktopRuntimeLifecycle> | undefined
        return {
          request: (operation) => {
            if (!runtime) throw new Error('The runtime is still starting.')
            lifecycle ??= createDesktopRuntimeLifecycle({
              ...runtime,
              isMigrationInProgress,
              cancelMigrationForQuit
            })
            return lifecycle.request(operation)
          },
          disconnect: async () => {
            await lifecycle?.disconnect()
            runtime?.abortDesktopUpdate()
          }
        }
      },
      startup: databaseStartup,
      commands: startupCommands,
      events: {
        subscribe: (listener) =>
          addRendererBroadcastSink((channel, payload) =>
            listener({ channel, payload } as ApplicationEvent)
          )
      },
      // Native menus use the same command owners. Their attachment is not a renderer document
      // and therefore never counts as an approval UI merely because Electron is connected.
      hostCommands: {
        commandNames: () => [
          'desktop:update-gate',
          'desktop:update-inspect',
          'desktop:update-abort',
          'desktop:open-session',
          'locale:snapshot',
          'desktop:tray-sessions',
          'desktop:open-package',
          'desktop:browser-import',
          'desktop:browser-import-cancel',
          'desktop:package-operation-snapshot',
          'desktop:browser-import-discovery',
          'settings:get-settings',
          'storage:get-status',
          'sessions:list',
          'projects:list',
          'settings:set-close-preference'
        ],
        invoke: async (channel, invocation) => {
          if (channel === 'locale:snapshot') return localeOwner.snapshot()
          if (!runtime) throw new Error('The runtime is still starting.')
          if (channel === 'desktop:update-inspect') return runtime.inspectDesktopUpdate()
          if (channel === 'desktop:update-gate')
            return runtime.prepareDesktopUpdate(
              z
                .object({
                  force: z.boolean().optional(),
                  relaunch: z.boolean().optional(),
                  legacyShellRecoveryToken: z.string().min(1).max(512).optional()
                })
                .strict()
                .parse(invocation.args[0] ?? {})
            )
          if (channel === 'desktop:update-abort') {
            runtime.abortDesktopUpdate()
            return null
          }
          if (channel === 'desktop:open-session') {
            const [id] = invocation.args
            if (typeof id !== 'string' || !id || id.length > 512)
              throw new Error('Invalid Session identity.')
            runtime.taskNotifications.setPendingOpenSession(id)
            return null
          }
          if (channel === 'desktop:tray-sessions') return runtime.listTrayNavigationSessions()
          if (channel === 'desktop:open-package') {
            const [path] = invocation.args
            if (path !== null && (typeof path !== 'string' || path.length > 32768))
              throw new Error('Invalid Session package path.')
            runtime.openSessionPackageFile(path)
            return null
          }
          if (channel === 'desktop:browser-import-discovery') {
            await runtime.startBrowserPackageImportDiscovery(
              invocation.args[0] as number | undefined
            )
            return null
          }
          if (channel === 'desktop:package-operation-snapshot')
            return runtime.packageOperationSnapshot()
          if (channel === 'desktop:browser-import-cancel') {
            const id = invocation.args[0]
            if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
              throw new Error('Invalid transfer identity.')
            await runtime.cancelBrowserPackageImport(id)
            return null
          }
          if (channel === 'desktop:browser-import') {
            await runtime.beginBrowserPackageImport(invocation.args[0], invocation.args[1] === true)
            return runtime.packageOperationSnapshot()
          }
          if (
            ![
              'settings:get-settings',
              'settings:set-close-preference',
              'storage:get-status',
              'sessions:list',
              'projects:list'
            ].includes(channel)
          )
            throw new Error('Unknown desktop host command.')
          return runtime.applicationCommands.desktop.invoke(channel, invocation)
        }
      },
      permissionApprovalPresence: {
        acquire: () => {
          // Startup calls cannot answer research permissions before business owners exist.
          return runtime?.permissionApprovalPresence.acquire()
        }
      },
      onNotificationAction: (token, action) => notificationDelivery?.handleAction(token, action),
      onConnect: () => {
        if (notificationDelivery)
          runtime?.notificationInbox.configureDesktop(notificationDelivery.inbox)
      },
      onDisconnect: () => {
        notificationDelivery?.disconnect()
        runtime?.notificationInbox.configureDesktop()
      },
      onNotificationView: async (state) => {
        if (state.reason === 'view')
          await runtime?.notificationInbox.syncViewState({
            visibleSessionId: state.visibleSessionId
          })
        else if (state.reason === 'focus') await runtime?.notificationInbox.handleAppFocus()
        else runtime?.notificationInbox.handleWindowCreated()
      },
      onNotificationError: (error) =>
        createLogger('notifications').warn(
          'desktop visibility update failed',
          errorLogFields(error)
        ),
      isStopping: () => stopRequested,
      requestShutdown: () => {
        void stop()
      }
    })
    control = await startRuntimeControl(
      configRoot,
      'node',
      async (port) => {
        if (!web) throw new Error('The runtime is still starting.')
        return web.ensureStarted(port, { attached: false })
      },
      desktop.endpoint,
      runtimeStartupOptions,
      () => stopRequested
    )
    startupReporter.phase('database')
    const state = await databaseStartup.start()
    if (state.phase === 'blocked' && !process.argv.includes('--desktop'))
      throw Object.assign(new Error(state.error.message), state.error)
    await waitForVerifiedDatabaseStartup(databaseStartup, startupCancellation.signal)

    abortStartupIfStopping()
    startupReporter.phase('runtime')
    const { createCoreRuntime } = await import('./core-runtime')
    configureDesktopFileInteraction(
      createRemoteDesktopFileInteraction(async (request, callerId) => {
        if (!desktop) throw new DesktopCapabilityUnavailable(request.operation)
        const caller = currentDesktopCaller()
        return desktop.requestNative(request, callerId ?? caller?.clientId, caller?.signal)
      })
    )
    configureDesktopShellInteraction(
      createRemoteDesktopShellInteraction((request) => {
        if (!desktop) throw new DesktopCapabilityUnavailable(request.operation)
        const caller = currentDesktopCaller()
        return desktop.requestNative(request, caller?.clientId, caller?.signal)
      })
    )
    configureOfficePreviewHost(
      createRemoteOfficePreviewHost((request, clientId) => {
        if (!desktop) throw new DesktopCapabilityUnavailable(request.operation)
        return desktop.requestNative(request, clientId, currentDesktopCaller()?.signal)
      })
    )
    configureDesktopReviewer((resources) =>
      createRemoteReviewerResolver(resources, (operation, signal) => {
        if (!desktop?.isConnected())
          throw new DesktopCapabilityUnavailable('Reviewer DOCX/PPTX page rendering')
        return desktop.requestNative(operation, undefined, signal)
      })
    )
    runtime = await createCoreRuntime({
      confirmRendererDurability: async (policy) => {
        if (!desktop?.isConnected()) return true // No Electron document owns unsaved edits.
        return (await desktop.requestNative({ operation: 'renderer-flush', policy })) === true
      },
      notifyRendererDurabilityAborted: () => {
        if (desktop?.isConnected())
          void desktop
            .requestNative({ operation: 'renderer-flush-aborted' })
            .catch((error) =>
              createLogger('session-persistence').warn(
                'desktop flush rollback failed',
                errorLogFields(error)
              )
            )
      },
      canRequestDesktopCredential: () => desktop?.hasActiveDocuments() ?? false,
      mainEntryPath,
      settingsStore,
      localeOwner,
      headless: true,
      notificationDelivery: (translate) =>
        (notificationDelivery = createRemoteNotificationDelivery(
          async (request) => {
            if (!desktop?.isConnected()) {
              if (request.operation === 'notification-focus') return true
              if (
                request.operation === 'notification-main-focus' ||
                request.operation === 'notification-visible'
              )
                return false
              if (
                request.operation === 'notification-availability' ||
                request.operation === 'notification-test'
              )
                return 'unavailable'
              throw new DesktopCapabilityUnavailable('Desktop notifications')
            }
            return desktop.requestNative(request)
          },
          translate,
          (error) =>
            createLogger('notifications').warn(
              'desktop notification delivery failed',
              errorLogFields(error)
            )
        )),
      reportOfficePreviewState: (clientId, state) =>
        desktop?.reportOfficePreviewState(clientId, state),
      reportMarketplaceProgress: (clientId, progress) =>
        desktop?.reportMarketplaceProgress(clientId, progress),
      reportReproducibilityCheck: (clientId, state) =>
        desktop?.reportReproducibilityCheck(clientId, state),
      reportUploadProgress: (clientId, progress) =>
        desktop?.reportUploadProgress(clientId, progress)
    })
    if (notificationDelivery) {
      const delivery = notificationDelivery
      if (desktop?.isConnected()) runtime.notificationInbox.configureDesktop(delivery.inbox)
      runtime.taskNotifications.setAttentionHandlers({
        request: delivery.requestAttention,
        clear: delivery.clearAttention
      })
      runtime.taskNotifications.setActivationHandler((sessionId) => {
        if (sessionId) runtime?.taskNotifications.setPendingOpenSession(sessionId)
        delivery.activate(sessionId)
      })
    }
    abortStartupIfStopping()
    const { createWebServiceController } = await import('./web-service')
    remoteAccess = await RemoteAccessService.create()
    runtime.bindRemoteAccess(remoteAccess)
    web = createWebServiceController({
      ...runtime,
      externalAccess: remoteAccess.webAccess,
      requestQuit: () => {
        void stop()
      }
    })
    remoteAccess.attachWebController(web)
    startupReporter.phase('endpoint')
    const serving = await web.ensureStarted(parseWebModeOptions(process.argv).port, {
      attached: false
    })
    process.stdout.write(`Open-Science is listening on http://127.0.0.1:${serving.port}\n`)
    void remoteAccess.restore()
    databaseStartup.complete()
    diagnostics.operation.complete()
    startupReporter.ready()
    finishStartup()
    if (stopRequested) await stop()
  } catch (error) {
    const cancelled = stopRequested
    if (credentialFailure || !cancelled) startupReporter.failed(credentialFailure ?? error)
    finishStartup()
    await stop()
    if (credentialFailure) throw credentialFailure
    if (!cancelled) throw error
  }
}
void main().catch((error: unknown) => {
  startupReporter.failed(error)
  createLogger('node-runtime').error('startup failed', {
    ...diagnosticErrorFields(error),
    ...errorLogFields(error),
    ...(error instanceof CredentialIdentityError
      ? {
          recoveryReason: error.reason,
          identityProbe: error.probe,
          validationDiagnostic: error.diagnostic
        }
      : {})
  })
  process.exitCode = error instanceof RuntimeOwnershipConflict ? 75 : 1
})
