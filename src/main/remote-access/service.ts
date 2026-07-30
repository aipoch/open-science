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
import { RemoteBrowserPairingManager } from './pairing'
import {
  detectRemoteIt,
  disableRemoteItConnectLink,
  enableRemoteItServices,
  ensureRemoteItConnectLink
} from './remoteit'
import { RemoteAccessRepository } from './repository'

type RemoteAccessServiceDeps = {
  repository?: RemoteAccessRepository
  detectRemoteIt?: typeof detectRemoteIt
  enableRemoteIt?: typeof enableRemoteItServices
  ensureRemoteItLink?: typeof ensureRemoteItConnectLink
  disableRemoteItLink?: typeof disableRemoteItConnectLink
  broadcast?: (channel: string, payload: unknown) => void
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
  private webController: WebServiceController | undefined
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly log = createLogger('remote-access')

  private constructor(
    private readonly pairing: RemoteBrowserPairingManager,
    private readonly deps: Required<
      Pick<
        RemoteAccessServiceDeps,
        | 'detectRemoteIt'
        | 'enableRemoteIt'
        | 'ensureRemoteItLink'
        | 'disableRemoteItLink'
        | 'broadcast'
      >
    >
  ) {
    this.remoteItAppServiceId = pairing.preferences.remoteItAppServiceId
    this.remoteItBrowserServiceId = pairing.preferences.remoteItBrowserServiceId
  }

  static async create(options: RemoteAccessServiceDeps = {}): Promise<RemoteAccessService> {
    const repository = options.repository ?? new RemoteAccessRepository(resolveConfigRoot())
    const context: { service?: RemoteAccessService } = {}
    const pairing = await RemoteBrowserPairingManager.create({
      repository,
      isAllowedRemoteHost: (hostname) => context.service?.isAllowedRemoteHost(hostname) === true,
      isEnabled: () => context.service?.runtimeEnabled === true,
      requiresPairing: () => context.service?.requiresBrowserPairing() !== false,
      onChanged: () => context.service?.notifyChanged()
    })
    const service = new RemoteAccessService(pairing, {
      detectRemoteIt: options.detectRemoteIt ?? detectRemoteIt,
      enableRemoteIt: options.enableRemoteIt ?? enableRemoteItServices,
      ensureRemoteItLink: options.ensureRemoteItLink ?? ensureRemoteItConnectLink,
      disableRemoteItLink: options.disableRemoteItLink ?? disableRemoteItConnectLink,
      broadcast: options.broadcast ?? broadcastToRenderers
    })
    context.service = service
    return service
  }

  get webAccess(): ExternalWebAccess {
    return this.pairing.webAccess
  }

  attachWebController(controller: WebServiceController): void {
    this.webController = controller
  }

  snapshot(canManage: boolean, canManagePairing = canManage): RemoteAccessSnapshot {
    return {
      canManage,
      canManagePairing,
      mode: this.activeMode,
      enabled: this.runtimeEnabled,
      lifecycle: this.lifecycle,
      accessUrl: this.accessUrl,
      remoteItPublicUrl: this.pairing.preferences.remoteItPublicUrl,
      error: this.error,
      remoteIt: this.remoteIt,
      pendingRequests:
        canManagePairing && this.showsBrowserPairingManagement() ? this.pairing.pendingViews() : [],
      trustedBrowsers:
        canManagePairing && this.showsBrowserPairingManagement() ? this.pairing.trustedViews() : []
    }
  }

  async restore(): Promise<void> {
    if (this.pairing.preferences.mode === 'off') return
    await this.setMode(this.pairing.preferences.mode, {
      persistPreference: false,
      forceReconcile: true
    })
  }

  async detect(): Promise<RemoteAccessSnapshot> {
    await this.refreshInstallation()

    if (this.activeMode === 'off') {
      this.runtimeEnabled = false
      this.lifecycle = 'disabled'
      this.remoteHost = undefined
      this.accessUrl = undefined
      this.error = undefined
      this.notifyChanged()
      return this.snapshot(true)
    }

    try {
      this.assertProviderReady()
    } catch (error) {
      this.runtimeEnabled = false
      this.lifecycle = 'error'
      this.remoteHost = undefined
      this.accessUrl = undefined
      this.pairing.clearTransientAccess()
      this.error = error instanceof Error ? error.message : String(error)
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
      this.runtimeEnabled = false
      this.lifecycle = 'starting'
      return this.setMode(this.activeMode, {
        forceReconcile: browserRouteNeedsRefresh
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
    return this.serialize(async () => {
      if (
        mode === this.activeMode &&
        this.lifecycle === 'running' &&
        options.forceReconcile !== true
      ) {
        return this.snapshot(true)
      }
      if (mode === 'off') return this.stopActiveRoute(options.persistPreference !== false)
      if (!this.webController) throw new Error('Remote access is not initialized yet.')

      this.lifecycle = 'starting'
      this.runtimeEnabled = false
      this.remoteHost = undefined
      this.accessUrl = undefined
      this.pairing.clearTransientAccess()
      this.error = undefined
      this.notifyChanged()

      try {
        await this.refreshInstallation()
        this.assertProviderReady()

        const web = await this.webController.ensureStarted(DEFAULT_WEB_PORT, { attached: true })
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
        this.remoteIt = enabled.installation
        await this.rememberRemoteItServiceIds(enabled)
        // The App entry is always private, including when Browser access was initialized first.
        // This cloud-only mutation does not need administrator approval.
        await this.deps.disableRemoteItLink(binaryPath, enabled.appServiceId)

        if (mode === 'remoteit-public') {
          const connectLinkUrl = normalizeRemoteItPublicUrl(
            await this.deps.ensureRemoteItLink(binaryPath, enabled.browserServiceId)
          )
          if (this.pairing.preferences.remoteItPublicUrl !== connectLinkUrl) {
            await this.pairing.setRemoteItPublicUrl(connectLinkUrl)
          }
          this.accessUrl = connectLinkUrl
          this.remoteHost = new URL(connectLinkUrl).hostname.toLowerCase()
        }

        this.activeMode = mode
        this.runtimeEnabled = true
        if (options.persistPreference !== false) await this.pairing.setModePreference(mode)
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
        this.runtimeEnabled = false
        this.activeMode = mode
        this.remoteHost = undefined
        this.accessUrl = undefined
        if (options.persistPreference !== false) {
          await this.pairing.setModePreference('off').catch(() => undefined)
        }
        this.lifecycle = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        this.log.error(`Remote access ${mode} enable failed`, error)
        this.notifyChanged()
        return this.snapshot(true)
      }
    })
  }

  disable(): Promise<RemoteAccessSnapshot> {
    return this.setMode('off')
  }

  async approve(
    request: ApproveRemotePairingRequest,
    canManage = true,
    canManagePairing = canManage
  ): Promise<RemoteAccessSnapshot> {
    await this.pairing.approve(request.requestId, request.decision)
    return this.snapshot(canManage, canManagePairing)
  }

  reject(requestId: string, canManage = true, canManagePairing = canManage): RemoteAccessSnapshot {
    this.pairing.reject(requestId)
    return this.snapshot(canManage, canManagePairing)
  }

  async revoke(
    browserId: string,
    canManage = true,
    canManagePairing = canManage
  ): Promise<RemoteAccessSnapshot> {
    await this.pairing.revoke(browserId)
    return this.snapshot(canManage, canManagePairing)
  }

  shutdown(): Promise<void> {
    this.runtimeEnabled = false
    this.remoteHost = undefined
    this.pairing.clearTransientAccess()
    return Promise.resolve()
  }

  private notifyChanged(): void {
    this.deps.broadcast(REMOTE_ACCESS_CHANGED_CHANNEL, {})
  }

  private async stopActiveRoute(persistPreference: boolean): Promise<RemoteAccessSnapshot> {
    this.lifecycle = 'stopping'
    this.runtimeEnabled = false
    this.remoteHost = undefined
    this.pairing.clearTransientAccess()
    this.notifyChanged()

    if (this.activeMode !== 'off') {
      this.log.info('Provider route kept configured while local remote access is disabled', {
        mode: this.activeMode
      })
    }
    this.activeMode = 'off'
    this.accessUrl = undefined
    if (persistPreference) await this.pairing.setModePreference('off')
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
    if (this.activeMode === 'remoteit') return isRemoteItAppHost(hostname)
    return Boolean(this.remoteHost && hostname === this.remoteHost)
  }

  private requiresBrowserPairing(): boolean {
    return this.activeMode === 'remoteit-public'
  }

  private showsBrowserPairingManagement(): boolean {
    return this.activeMode === 'remoteit-public'
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
