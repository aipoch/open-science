import type {
  ApproveRemotePairingRequest,
  RemoteAccessMode,
  RemoteAccessSnapshot,
  RemoteItInstallation,
  RemotePairingDecision
} from '../../shared/remote-access'
import { REMOTE_ACCESS_CHANGED_CHANNEL } from '../../shared/remote-access'
import type { ExternalWebAccess } from '../web-service/http-server'
import { DEFAULT_WEB_PORT, type WebServiceController } from '../web-service'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'
import { resolveConfigRoot } from '../storage-root'
import { RemoteSessionPairingManager } from './pairing'
import {
  detectRemoteIt,
  disableRemoteItConnectLink,
  enableRemoteItServices,
  ensureRemoteItConnectLink
} from './remoteit'
import { RemoteAccessRepository } from './repository'
import { toErrorMessage } from '../error-message'

type RemoteAccessServiceDeps = {
  repository?: RemoteAccessRepository
  detectRemoteIt?: typeof detectRemoteIt
  enableRemoteIt?: typeof enableRemoteItServices
  ensureRemoteItLink?: typeof ensureRemoteItConnectLink
  disableRemoteItLink?: typeof disableRemoteItConnectLink
  broadcast?: (
    channel: typeof REMOTE_ACCESS_CHANGED_CHANNEL,
    payload: Record<string, never>
  ) => void
}

const isRemoteItBrowserHost = (hostname: string): boolean =>
  hostname.endsWith('.r3proxy.com') ||
  hostname.endsWith('.rt3.io') ||
  hostname.endsWith('.at.remote.it') ||
  hostname.endsWith('.connect.remote.it')

const isRemoteItAppHost = (hostname: string): boolean =>
  hostname.endsWith('.r3proxy.com') ||
  hostname.endsWith('.rt3.io') ||
  hostname.endsWith('.at.remote.it')

const normalizeRemoteItPublicUrl = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('Remote access returned an invalid browser URL.')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'https:' ||
    !isRemoteItBrowserHost(hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Remote access returned an invalid HTTPS browser URL.')
  }
  return `${parsed.origin}/`
}

const configurationLoadError = (error: unknown): Error => {
  const detail = toErrorMessage(error)
  return new Error(
    `Remote access configuration could not be loaded. Fix or remove remote-access.json, then restart Open Science. ${detail}`
  )
}

const isAddressInUseError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'

export class RemoteAccessService {
  private lifecycle: RemoteAccessSnapshot['lifecycle'] = 'disabled'
  private remoteIt: RemoteItInstallation = {
    installed: false,
    loggedIn: false,
    registered: false
  }
  private activeMode: RemoteAccessMode = 'off'
  private accessUrl: string | undefined
  private remoteHost: string | undefined
  private remoteItAppServiceId: string | undefined
  private remoteItBrowserServiceId: string | undefined
  private error: string | undefined
  private runtimeEnabled = false
  private authorizationGeneration = 0
  private webStopGeneration = 0
  private webController: WebServiceController | undefined
  private detachWebController: (() => void) | undefined
  private mutationQueue: Promise<void> = Promise.resolve()
  private shutdownStarted = false
  private shutdownPromise: Promise<void> | undefined
  private readonly log = createLogger('remote-access')

  private constructor(
    private readonly pairing: RemoteSessionPairingManager,
    private readonly deps: Required<
      Pick<
        RemoteAccessServiceDeps,
        | 'detectRemoteIt'
        | 'enableRemoteIt'
        | 'ensureRemoteItLink'
        | 'disableRemoteItLink'
        | 'broadcast'
      >
    >,
    private readonly configurationError?: Error
  ) {
    this.remoteItAppServiceId = pairing.preferences.remoteItAppServiceId
    this.remoteItBrowserServiceId = pairing.preferences.remoteItBrowserServiceId
    if (configurationError) {
      this.lifecycle = 'error'
      this.error = configurationError.message
    }
  }

  static async create(options: RemoteAccessServiceDeps = {}): Promise<RemoteAccessService> {
    const repository = options.repository ?? new RemoteAccessRepository(resolveConfigRoot())
    const context: { service?: RemoteAccessService } = {}
    const pairingOptions: Parameters<typeof RemoteSessionPairingManager.create>[0] = {
      repository,
      isAllowedRemoteHost: (hostname) => context.service?.isAllowedRemoteHost(hostname) === true,
      isEnabled: () => context.service?.runtimeEnabled === true,
      authorizationGeneration: () => context.service?.authorizationGeneration ?? 0,
      onChanged: () => context.service?.notifyChanged(),
      onAuthorizationExpired: (principalId) =>
        context.service?.webController?.closeExternalConnections(principalId)
    }
    let configurationError: Error | undefined
    let loadFailure: unknown
    let pairing: RemoteSessionPairingManager
    try {
      pairing = await RemoteSessionPairingManager.create(pairingOptions)
    } catch (error) {
      loadFailure = error
      configurationError = configurationLoadError(error)
      pairing = RemoteSessionPairingManager.createUnavailable(pairingOptions)
    }
    const service = new RemoteAccessService(
      pairing,
      {
        detectRemoteIt: options.detectRemoteIt ?? detectRemoteIt,
        enableRemoteIt: options.enableRemoteIt ?? enableRemoteItServices,
        ensureRemoteItLink: options.ensureRemoteItLink ?? ensureRemoteItConnectLink,
        disableRemoteItLink: options.disableRemoteItLink ?? disableRemoteItConnectLink,
        broadcast: options.broadcast ?? broadcastToRenderers
      },
      configurationError
    )
    context.service = service
    if (configurationError) {
      service.log.error('Remote access configuration load failed', loadFailure)
    }
    return service
  }

  get webAccess(): ExternalWebAccess {
    return this.pairing.webAccess
  }

  attachWebController(controller: WebServiceController): void {
    this.detachWebController?.()
    this.webController = controller
    this.detachWebController = controller.onStopped(() => {
      this.webStopGeneration += 1
      if (this.shutdownStarted) return
      const shouldReportFailure = this.runtimeEnabled && this.activeMode !== 'off'
      void this.invalidateExternalAccess(false).catch((error) => {
        this.log.error('Remote access invalidation cleanup failed', error)
      })
      if (!shouldReportFailure) return
      this.lifecycle = 'error'
      this.error = 'The local web service stopped. Detect again to restore remote access.'
      this.notifyChanged()
    })
  }

  snapshot(canManage: boolean, canManagePairing = canManage): RemoteAccessSnapshot {
    const configurationAvailable = this.configurationError === undefined
    return {
      canManage: configurationAvailable && canManage,
      canManagePairing: configurationAvailable && canManagePairing,
      mode: this.activeMode,
      enabled: this.runtimeEnabled,
      lifecycle: this.lifecycle,
      accessUrl: this.accessUrl,
      remoteItPublicUrl: this.pairing.preferences.remoteItPublicUrl,
      error: this.error,
      remoteIt: this.remoteIt,
      pendingRequests:
        canManagePairing && this.showsPairingManagement() ? this.pairing.pendingViews() : [],
      trustedBrowsers: canManagePairing ? this.pairing.trustedViews() : []
    }
  }

  async restore(): Promise<void> {
    if (this.configurationError) return
    if (this.pairing.preferences.mode === 'off') return
    await this.setMode(this.pairing.preferences.mode, {
      persistPreference: false,
      forceReconcile: true
    })
  }

  detect(): Promise<RemoteAccessSnapshot> {
    return this.serialize(() => this.detectSerialized())
  }

  probe(): Promise<RemoteAccessSnapshot> {
    return this.serialize(async () => {
      if (this.shutdownStarted || this.configurationError) return this.snapshot(true)
      try {
        this.remoteIt = await this.deps.detectRemoteIt(this.preferredServiceId())
      } catch (error) {
        this.remoteIt = { ...this.remoteIt, error: toErrorMessage(error) }
      }
      return this.snapshot(true)
    })
  }

  private async detectSerialized(): Promise<RemoteAccessSnapshot> {
    if (this.shutdownStarted || this.configurationError) return this.snapshot(true)
    try {
      await this.refreshInstallation()
      if (this.shutdownStarted) return this.snapshot(true)
      if (this.activeMode !== 'off') this.assertProviderReady()
    } catch (error) {
      if (this.shutdownStarted) return this.snapshot(true)
      let failure = error
      try {
        await this.invalidateExternalAccess()
      } catch (cleanupError) {
        failure = cleanupError
      }
      this.lifecycle = 'error'
      this.error = toErrorMessage(failure)
      this.notifyChanged()
      return this.snapshot(true)
    }

    if (this.activeMode === 'off') {
      try {
        await this.invalidateExternalAccess()
        this.lifecycle = 'disabled'
        this.error = undefined
      } catch (error) {
        this.lifecycle = 'error'
        this.error = toErrorMessage(error)
      }
      this.notifyChanged()
      return this.snapshot(true)
    }

    const routeNeedsRepair = !this.remoteIt.service?.enabled || !this.remoteIt.service.ready
    const browserRouteNeedsRefresh = this.activeMode === 'remoteit-public'
    if (
      !this.runtimeEnabled ||
      this.lifecycle === 'error' ||
      routeNeedsRepair ||
      browserRouteNeedsRefresh
    ) {
      return this.setModeSerialized(this.activeMode, {
        forceReconcile: routeNeedsRepair || browserRouteNeedsRefresh
      })
    }

    this.lifecycle = 'running'
    this.error = undefined
    this.notifyChanged()
    return this.snapshot(true)
  }

  setMode(
    mode: RemoteAccessMode,
    options: {
      persistPreference?: boolean
      forceReconcile?: boolean
    } = {}
  ): Promise<RemoteAccessSnapshot> {
    return this.serialize(() => this.setModeSerialized(mode, options))
  }

  private async setModeSerialized(
    mode: RemoteAccessMode,
    options: {
      persistPreference?: boolean
      forceReconcile?: boolean
    }
  ): Promise<RemoteAccessSnapshot> {
    if (this.shutdownStarted) return this.snapshot(true)
    this.assertConfigurationAvailable()
    if (
      mode === this.activeMode &&
      this.lifecycle === 'running' &&
      options.forceReconcile !== true
    ) {
      return this.snapshot(true)
    }
    if (mode === 'off') return this.stopActiveRoute(options.persistPreference !== false)
    if (!this.webController) throw new Error('Remote access is not initialized yet.')
    const webStopGeneration = this.webStopGeneration

    this.lifecycle = 'starting'
    const invalidation = this.invalidateExternalAccess(this.runtimeEnabled)
    this.error = undefined
    this.notifyChanged()

    try {
      await invalidation
      await this.refreshInstallation()
      if (this.shutdownStarted) return this.snapshot(true)
      this.assertProviderReady()

      let web: Awaited<ReturnType<WebServiceController['ensureStarted']>>
      try {
        web = await this.webController.ensureStarted(DEFAULT_WEB_PORT, { attached: true })
      } catch (error) {
        if (!isAddressInUseError(error)) throw error
        web = await this.webController.ensureStarted(0, { attached: true })
      }
      if (this.shutdownStarted) return this.snapshot(true)
      const binaryPath = this.remoteIt.binaryPath
      if (!binaryPath) throw new Error('The remote access app is unavailable.')

      const enabled = await this.deps.enableRemoteIt(binaryPath, web.port, {
        active: mode === 'remoteit' ? 'app' : 'browser',
        appServiceId: this.remoteItAppServiceId,
        browserServiceId: this.remoteItBrowserServiceId,
        onServiceIdsDiscovered: async (services) => {
          await this.rememberRemoteItServiceIds(services)
        }
      })
      if (this.shutdownStarted) return this.snapshot(true)
      this.remoteIt = enabled.installation
      await this.rememberRemoteItServiceIds(enabled)
      if (this.shutdownStarted) return this.snapshot(true)
      // App is always private. App mode also closes Browser's Persistent Public URL so a link
      // issued by an earlier Browser session cannot keep reaching the loopback service.
      await this.deps.disableRemoteItLink(binaryPath, enabled.appServiceId)
      if (this.shutdownStarted) return this.snapshot(true)

      if (mode === 'remoteit-public') {
        const connectLinkUrl = normalizeRemoteItPublicUrl(
          await this.deps.ensureRemoteItLink(binaryPath, enabled.browserServiceId)
        )
        if (this.shutdownStarted) return this.snapshot(true)
        if (this.pairing.preferences.remoteItPublicUrl !== connectLinkUrl) {
          await this.pairing.setRemoteItPublicUrl(connectLinkUrl)
          if (this.shutdownStarted) return this.snapshot(true)
        }
        this.accessUrl = connectLinkUrl
        this.remoteHost = new URL(connectLinkUrl).hostname.toLowerCase()
      } else {
        await this.deps.disableRemoteItLink(binaryPath, enabled.browserServiceId)
        if (this.shutdownStarted) return this.snapshot(true)
      }

      if (options.persistPreference !== false) await this.pairing.setModePreference(mode)
      if (this.shutdownStarted) return this.snapshot(true)
      if (webStopGeneration !== this.webStopGeneration || !this.webController.isRunning()) {
        throw new Error('The local web service stopped. Detect again to restore remote access.')
      }
      this.activeMode = mode
      this.runtimeEnabled = true
      this.lifecycle = 'running'
      this.log.info('Remote access enabled', {
        mode,
        accessUrl: this.accessUrl,
        remoteItAppServiceId: enabled.appServiceId,
        remoteItBrowserServiceId: enabled.browserServiceId,
        port: web.port
      })
      this.notifyChanged()
      return this.snapshot(true)
    } catch (error) {
      if (this.shutdownStarted) return this.snapshot(true)
      this.runtimeEnabled = false
      this.activeMode = mode
      this.remoteHost = undefined
      this.accessUrl = undefined
      if (options.persistPreference !== false) {
        await this.pairing.setModePreference('off').catch(() => undefined)
      }
      this.lifecycle = 'error'
      this.error = toErrorMessage(error)
      this.log.error(`Remote access ${mode} enable failed`, error)
      this.notifyChanged()
      return this.snapshot(true)
    }
  }

  disable(): Promise<RemoteAccessSnapshot> {
    return this.setMode('off')
  }

  approve(
    request: ApproveRemotePairingRequest,
    canManage = true,
    canManagePairing = canManage
  ): Promise<RemoteAccessSnapshot> {
    return this.serialize(async () => {
      this.assertConfigurationAvailable()
      await this.pairing.approve(request.requestId, request.decision)
      return this.snapshot(canManage, canManagePairing)
    })
  }

  reject(
    requestId: string,
    canManage = true,
    canManagePairing = canManage
  ): Promise<RemoteAccessSnapshot> {
    return this.serialize(async () => {
      this.assertConfigurationAvailable()
      this.pairing.reject(requestId)
      return this.snapshot(canManage, canManagePairing)
    })
  }

  async revoke(
    browserId: string,
    canManage = true,
    canManagePairing = canManage
  ): Promise<RemoteAccessSnapshot> {
    return this.serialize(async () => {
      this.assertConfigurationAvailable()
      const revocation = this.pairing.revoke(browserId)
      this.webController?.closeExternalConnections(browserId)
      await revocation
      return this.snapshot(canManage, canManagePairing)
    })
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownStarted = true
    this.detachWebController?.()
    this.detachWebController = undefined
    const invalidation = this.invalidateExternalAccess()
    this.activeMode = 'off'
    this.lifecycle = 'disabled'
    this.error = undefined
    this.notifyChanged()
    this.shutdownPromise = this.serialize(async () => {
      try {
        await invalidation
      } finally {
        this.pairing.dispose()
        this.webController = undefined
      }
    })
    return this.shutdownPromise
  }

  private notifyChanged(): void {
    this.deps.broadcast(REMOTE_ACCESS_CHANGED_CHANNEL, {})
  }

  private assertConfigurationAvailable(): void {
    if (this.configurationError) throw this.configurationError
  }

  private invalidateExternalAccess(closeConnections = true): Promise<void> {
    this.authorizationGeneration += 1
    this.runtimeEnabled = false
    this.remoteHost = undefined
    this.accessUrl = undefined
    if (closeConnections) this.webController?.closeExternalConnections()
    return this.pairing.clearTransientAccess()
  }

  private async stopActiveRoute(persistPreference: boolean): Promise<RemoteAccessSnapshot> {
    this.lifecycle = 'stopping'
    const invalidation = this.invalidateExternalAccess()
    this.notifyChanged()

    let failure: unknown
    try {
      await invalidation
    } catch (error) {
      failure = error
    }

    if (this.activeMode !== 'off') {
      this.log.info('Provider route kept configured while local remote access is disabled', {
        mode: this.activeMode
      })
    }
    this.activeMode = 'off'
    this.accessUrl = undefined
    if (persistPreference) {
      try {
        await this.pairing.setModePreference('off')
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) {
      this.lifecycle = 'error'
      this.error = toErrorMessage(failure)
      this.log.error('Remote access disable failed', failure)
      this.notifyChanged()
      return this.snapshot(true)
    }
    this.lifecycle = 'disabled'
    this.error = undefined
    this.log.info('Remote access disabled locally')
    this.notifyChanged()
    return this.snapshot(true)
  }

  private preferredServiceId(): string | undefined {
    return this.activeMode === 'remoteit-public'
      ? this.remoteItBrowserServiceId
      : this.remoteItAppServiceId
  }

  private async rememberRemoteItServiceIds(services: {
    appServiceId?: string
    browserServiceId?: string
  }): Promise<void> {
    this.remoteItAppServiceId = services.appServiceId ?? this.remoteItAppServiceId
    this.remoteItBrowserServiceId = services.browserServiceId ?? this.remoteItBrowserServiceId
    await this.pairing.setRemoteItServiceIds({
      appServiceId: this.remoteItAppServiceId,
      browserServiceId: this.remoteItBrowserServiceId
    })
  }

  private async refreshInstallation(): Promise<void> {
    this.remoteIt = await this.deps.detectRemoteIt(this.preferredServiceId())
  }

  private assertProviderReady(): void {
    if (!this.remoteIt.installed || !this.remoteIt.binaryPath) {
      throw new Error(
        'The remote access app is not installed. Install the desktop app, sign in, then detect again.'
      )
    }
    if (this.remoteIt.error) throw new Error(this.remoteIt.error)
  }

  private isAllowedRemoteHost(hostname: string): boolean {
    if (this.activeMode === 'remoteit') {
      const publicBrowserUrl = this.pairing.preferences.remoteItPublicUrl
      let publicBrowserHost: string | undefined
      try {
        publicBrowserHost = publicBrowserUrl
          ? new URL(publicBrowserUrl).hostname.toLowerCase()
          : undefined
      } catch {
        // Older or manually edited preferences must not break private App access authorization.
      }
      return hostname !== publicBrowserHost && isRemoteItAppHost(hostname)
    }
    return Boolean(this.remoteHost && hostname === this.remoteHost)
  }

  private showsPairingManagement(): boolean {
    return this.activeMode !== 'off'
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export { isRemoteItBrowserHost, normalizeRemoteItPublicUrl }
export type { RemotePairingDecision }
