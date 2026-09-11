import { McpClientManager } from '../../connectors/mcp-client-manager'
import {
  classifyCustomMcpFailure,
  hasUsableCustomMcpCredentials,
  isCustomMcpServerRouteSafe,
  toCustomMcpConfig
} from '../../connectors/custom-mcp-bootstrap'
import type {
  AuthenticateCustomServerRequest,
  CreateDeviceCredentialRequest,
  DeviceCredentialAuthenticationRequest,
  DisconnectCustomServerRequest,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  RemoveDeviceCredentialRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  SetToolPermissionRequest,
  UpdateCustomServerRequest,
  UpdateDeviceCredentialRequest,
  ValidateOpenAlexCredentialRequest
} from '../../../shared/settings'
import { wireConnectorReload } from '../../connector-reload'
import type { CustomServerSecurityChangeGuard } from '../connector-settings'
import type { SettingsService } from '../service'

type ConnectorSettingsWorkflowStore = Pick<
  SettingsService,
  | 'getConnectors'
  | 'saveCustomServerOAuthState'
  | 'listConnectors'
  | 'listDeviceCredentials'
  | 'deviceCredentialConsumerIds'
  | 'createDeviceCredential'
  | 'updateDeviceCredential'
  | 'removeDeviceCredential'
  | 'authenticateDeviceCredential'
  | 'cancelDeviceCredentialAuthentication'
  | 'disconnectDeviceCredential'
  | 'setConnectorEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'setOpenAlexCredential'
  | 'validateOpenAlexCredential'
  | 'addCustomServer'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'updateCustomServer'
  | 'authenticateCustomServer'
  | 'cancelCustomServerAuthentication'
  | 'disconnectCustomServer'
>

type ConnectorSettingsWorkflowEffects = {
  invalidatePermissionProjection: () => void
  refreshConnectorSkillDocs: (customServerId?: string) => Promise<unknown>
  requestSkillsReload: () => void
  pruneCustomServerPermissions: (serverId: string) => Promise<void>
  removeTagsForConnector: (id: string) => Promise<void>
  beginCustomServerSecurityChange: (serverId: string) => CustomServerSecurityChangeGuard | undefined
  clearCustomServerFailure: (serverId: string) => void
  resetCustomServerClient: (serverId: string) => Promise<void>
}

type WorkflowResult<Method extends keyof ConnectorSettingsWorkflowStore> = Promise<
  Awaited<ReturnType<ConnectorSettingsWorkflowStore[Method]>>
>

// Owns Connector mutation follow-up ordering, including the security barrier and derived projection.
// Every safety-critical effect is required; unsupported hosts must inject an explicit no-op adapter.
class ConnectorSettingsWorkflows {
  private readonly pendingCredentialRefresh = new Map<string, CustomServerSecurityChangeGuard>()

  constructor(
    private readonly settings: ConnectorSettingsWorkflowStore,
    private readonly effects: ConnectorSettingsWorkflowEffects
  ) {}

  async testCustomServer(
    request: { id: string },
    callerSignal?: AbortSignal
  ): Promise<{
    success: boolean
    toolCount?: number
    message: string
    stage: 'configuration' | 'startup' | 'handshake' | 'discovery'
    code:
      | 'unsupported'
      | 'invalid_configuration'
      | 'credentials_unavailable'
      | 'ok'
      | 'cancelled'
      | 'timeout'
      | 'authentication'
      | 'startup_failed'
      | 'handshake_failed'
      | 'discovery_failed'
  }> {
    const servers = (await this.settings.getConnectors())?.customMcpServers ?? []
    const server = servers.find((item) => item.id === request.id)
    if (!server)
      return {
        success: false,
        stage: 'configuration',
        code: 'unsupported',
        message:
          'Diagnostics require an existing custom MCP Connector. Bundled Connector live tests are not supported.'
      }
    if (!isCustomMcpServerRouteSafe(server, servers))
      return {
        success: false,
        stage: 'configuration',
        code: 'invalid_configuration',
        message: 'Connector configuration is invalid.'
      }
    if (!hasUsableCustomMcpCredentials(server))
      return {
        success: false,
        stage: 'configuration',
        code: 'credentials_unavailable',
        message:
          'Connector credentials are unavailable. Re-enter them using secure credential storage.'
      }
    // A probe must not reset or populate the shared runtime client cache.
    const manager = new McpClientManager({
      saveOAuthState: (id, state, fingerprint, secretRef) =>
        this.settings.saveCustomServerOAuthState(id, state, fingerprint, secretRef)
    })
    const timeout = AbortSignal.timeout(10_000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    const progress: { stage: 'startup' | 'handshake' | 'discovery' } = { stage: 'handshake' }
    try {
      const tools = await manager.listTools(toCustomMcpConfig(server), signal, () => {
        progress.stage = 'discovery'
      })
      return {
        success: true,
        stage: 'discovery',
        code: 'ok',
        toolCount: tools.length,
        message: 'MCP connection and tool discovery succeeded. Business tools were not executed.'
      }
    } catch (error) {
      // Only OS spawn codes prove a startup failure. Early exits and malformed initialize replies
      // remain handshake failures; never guess a phase from server-supplied text.
      if (
        server.transport === 'stdio' &&
        progress.stage === 'handshake' &&
        ['ENOENT', 'EACCES', 'ENOEXEC'].includes((error as NodeJS.ErrnoException)?.code ?? '')
      ) {
        progress.stage = 'startup'
      }
      const code = callerSignal?.aborted
        ? 'cancelled'
        : signal.aborted
          ? 'timeout'
          : classifyCustomMcpFailure(error) === 'unauthenticated'
            ? 'authentication'
            : progress.stage === 'startup'
              ? 'startup_failed'
              : progress.stage === 'discovery'
                ? 'discovery_failed'
                : 'handshake_failed'
      const messages = {
        cancelled: 'MCP diagnostic cancelled.',
        timeout: 'MCP connection timed out.',
        authentication:
          'MCP authentication failed. Authenticate the existing credential before retrying.',
        startup_failed:
          'MCP process could not start. Check the command, executable permissions, and PATH.',
        handshake_failed:
          'MCP initialization failed. Check the endpoint, transport, network, and server protocol support.',
        discovery_failed:
          'MCP connected, but the tool catalog could not be read. Check server tools/list support and retry.'
      }
      return { success: false, stage: progress.stage, code, message: messages[code] }
    } finally {
      await manager.closeAll()
    }
  }

  async setConnectorEnabled(
    request: SetConnectorEnabledRequest
  ): WorkflowResult<'setConnectorEnabled'> {
    return this.afterConnectorsChanged(() => this.settings.setConnectorEnabled(request))
  }

  async listDeviceCredentials(): WorkflowResult<'listDeviceCredentials'> {
    return this.settings.listDeviceCredentials()
  }

  async createDeviceCredential(
    request: CreateDeviceCredentialRequest
  ): WorkflowResult<'createDeviceCredential'> {
    return this.settings.createDeviceCredential(request)
  }

  async updateDeviceCredential(
    request: UpdateDeviceCredentialRequest
  ): WorkflowResult<'updateDeviceCredential'> {
    const snapshot =
      request.secret === undefined
        ? await this.settings.updateDeviceCredential(request)
        : await this.settings.updateDeviceCredential(request, (consumers, mutation) =>
            this.withDeviceCredentialConsumersBlocked(consumers, async () => {
              await this.settings.cancelDeviceCredentialAuthentication({ id: request.id })
              return mutation()
            })
          )
    return snapshot
  }

  async removeDeviceCredential(
    request: RemoveDeviceCredentialRequest
  ): WorkflowResult<'removeDeviceCredential'> {
    const consumers = await this.settings.deviceCredentialConsumerIds(request.id)
    if (consumers.length === 0) {
      await this.effects.resetCustomServerClient(`credential:${request.id}`)
    }
    return this.settings.removeDeviceCredential(request)
  }

  async authenticateDeviceCredential(
    request: DeviceCredentialAuthenticationRequest
  ): WorkflowResult<'authenticateDeviceCredential'> {
    const snapshot = await this.settings.authenticateDeviceCredential(request)
    this.connectorsChanged()
    return snapshot
  }

  async cancelDeviceCredentialAuthentication(
    request: DeviceCredentialAuthenticationRequest
  ): WorkflowResult<'cancelDeviceCredentialAuthentication'> {
    return this.settings.cancelDeviceCredentialAuthentication(request)
  }

  async disconnectDeviceCredential(
    request: DeviceCredentialAuthenticationRequest
  ): WorkflowResult<'disconnectDeviceCredential'> {
    const snapshot = await this.settings.disconnectDeviceCredential(
      request,
      (consumers, mutation) => this.withDeviceCredentialConsumersBlocked(consumers, mutation)
    )
    return snapshot
  }

  async setConnectorAutoAllow(
    request: SetConnectorAutoAllowRequest
  ): WorkflowResult<'setConnectorAutoAllow'> {
    return this.afterConnectorsChanged(() => this.settings.setConnectorAutoAllow(request))
  }

  async setToolPermission(request: SetToolPermissionRequest): WorkflowResult<'setToolPermission'> {
    return this.afterConnectorsChanged(() => this.settings.setToolPermission(request))
  }

  async setNcbiCredentials(
    request: SetNcbiCredentialsRequest
  ): WorkflowResult<'setNcbiCredentials'> {
    return this.afterConnectorsChanged(() => this.settings.setNcbiCredentials(request))
  }

  async setOpenAlexCredential(
    request: SetOpenAlexCredentialRequest
  ): WorkflowResult<'setOpenAlexCredential'> {
    return this.afterConnectorsChanged(() => this.settings.setOpenAlexCredential(request))
  }

  async validateOpenAlexCredential(
    request: ValidateOpenAlexCredentialRequest
  ): WorkflowResult<'validateOpenAlexCredential'> {
    return this.settings.validateOpenAlexCredential(request)
  }

  async addCustomServer(request: AddCustomServerRequest): WorkflowResult<'addCustomServer'> {
    return this.afterConnectorsChanged(() => this.settings.addCustomServer(request))
  }

  async setCustomServerEnabled(
    request: Parameters<ConnectorSettingsWorkflowStore['setCustomServerEnabled']>[0]
  ): WorkflowResult<'setCustomServerEnabled'> {
    const snapshot = await this.settings.setCustomServerEnabled(request)
    this.connectorsChanged(request.id)
    return snapshot
  }

  async removeCustomServer(
    request: RemoveCustomServerRequest
  ): WorkflowResult<'removeCustomServer'> {
    return this.settings
      .removeCustomServer(request, async (serverId) => {
        await this.effects.resetCustomServerClient(serverId)
        this.effects.clearCustomServerFailure(serverId)
        await this.effects.pruneCustomServerPermissions(serverId)
        await this.effects.removeTagsForConnector(serverId)
      })
      .finally(() => this.connectorsChanged())
  }

  async updateCustomServer(
    request: UpdateCustomServerRequest
  ): WorkflowResult<'updateCustomServer'> {
    const snapshot = await this.settings.updateCustomServer(request, (serverId) =>
      this.prepareCustomServerSecurityChange(serverId)
    )
    this.connectorsChanged()
    return snapshot
  }

  async authenticateCustomServer(
    request: DisconnectCustomServerRequest
  ): WorkflowResult<'authenticateCustomServer'> {
    const snapshot = await this.settings.authenticateCustomServer(request.id)
    this.effects.clearCustomServerFailure(request.id)
    this.connectorsChanged()
    return snapshot
  }

  async cancelCustomServerAuthentication(
    request: AuthenticateCustomServerRequest
  ): WorkflowResult<'cancelCustomServerAuthentication'> {
    return this.settings.cancelCustomServerAuthentication(request.id)
  }

  async disconnectCustomServer(
    request: AuthenticateCustomServerRequest
  ): WorkflowResult<'disconnectCustomServer'> {
    const snapshot = await this.settings.disconnectCustomServer(request.id, (consumers, mutation) =>
      this.withDeviceCredentialConsumersBlocked(consumers, mutation)
    )
    this.effects.clearCustomServerFailure(request.id)
    this.connectorsChanged()
    return snapshot
  }

  async retryCustomServer(
    request: AuthenticateCustomServerRequest
  ): WorkflowResult<'listConnectors'> {
    const pending = [...this.pendingCredentialRefresh].filter(([id]) => id === request.id)
    await this.effects.resetCustomServerClient(request.id)
    this.effects.clearCustomServerFailure(request.id)
    this.effects.invalidatePermissionProjection()
    await this.refreshConnectorProjection()
    await this.completeCredentialRefresh(pending)
    return this.settings.listConnectors()
  }

  async retryConnectorProjection(): WorkflowResult<'listConnectors'> {
    const pending = [...this.pendingCredentialRefresh]
    this.effects.invalidatePermissionProjection()
    await this.refreshConnectorProjection()
    await this.completeCredentialRefresh(pending)
    return this.settings.listConnectors()
  }

  private async completeCredentialRefresh(
    pending: Array<[string, CustomServerSecurityChangeGuard]>,
    consumers = pending.map(([id]) => id)
  ): Promise<void> {
    await Promise.all(consumers.map((id) => this.effects.resetCustomServerClient(id)))
    if (pending.length === 0) return
    const current = await this.settings.getConnectors()
    for (const [id, guard] of pending) {
      if (this.pendingCredentialRefresh.get(id) !== guard) continue
      const server = current?.customMcpServers?.find((candidate) => candidate.id === id)
      // commit only arms this generation; dispatch still checks the current fingerprint.
      if (server) guard.commit(server)
      else guard.rollback()
      this.pendingCredentialRefresh.delete(id)
    }
  }

  private async afterConnectorsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.connectorsChanged()
    return result
  }

  private connectorsChanged(customServerId?: string): void {
    this.effects.invalidatePermissionProjection()
    // Persisted Connector mutations intentionally do not wait for this derived projection. The
    // projection records and publishes degraded state; consume the rejection here so a failed
    // background refresh does not become an unhandled promise rejection.
    void this.refreshConnectorProjection(customServerId).catch(() => undefined)
  }

  private refreshConnectorProjection(customServerId?: string): Promise<unknown> {
    return wireConnectorReload(
      () => this.effects.refreshConnectorSkillDocs(customServerId),
      this.effects.requestSkillsReload
    )
  }

  private async prepareCustomServerSecurityChange(
    serverId: string
  ): Promise<CustomServerSecurityChangeGuard | void> {
    const guard = this.effects.beginCustomServerSecurityChange(serverId)
    try {
      await this.settings.cancelCustomServerAuthentication(serverId)
      await this.effects.pruneCustomServerPermissions(serverId)
      return guard
    } catch (error) {
      guard?.rollback()
      throw error
    }
  }

  private async withDeviceCredentialConsumersBlocked<Result>(
    consumers: string[],
    mutation: () => Promise<Result>
  ): Promise<Result> {
    const guards = consumers.map((id) => this.effects.beginCustomServerSecurityChange(id))
    const resetConsumers = (): Promise<void[]> =>
      Promise.all(consumers.map((id) => this.effects.resetCustomServerClient(id)))
    let mutationCompleted = false
    try {
      await resetConsumers()
      const result = await mutation()
      mutationCompleted = true
      const pending: Array<[string, CustomServerSecurityChangeGuard]> = []
      consumers.forEach((id, index) => {
        const guard = guards[index]
        if (guard) {
          this.pendingCredentialRefresh.set(id, guard)
          pending.push([id, guard])
        }
      })
      this.effects.invalidatePermissionProjection()
      await this.refreshConnectorProjection()
      await this.completeCredentialRefresh(pending, consumers)
      return result
    } catch (error) {
      if (!mutationCompleted) {
        for (const guard of guards) guard?.rollback()
        throw error
      }
      throw new Error(
        'Credential changes were saved, but Connectors could not refresh. Retry from Settings > Connectors.'
      )
    }
  }
}

export { ConnectorSettingsWorkflows }
export type { ConnectorSettingsWorkflowEffects, ConnectorSettingsWorkflowStore }
