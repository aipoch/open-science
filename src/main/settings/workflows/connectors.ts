import type {
  AuthenticateCustomServerRequest,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetToolPermissionRequest,
  UpdateCustomServerRequest
} from '../../../shared/settings'
import { wireConnectorReload } from '../../connector-reload'
import type { CustomServerSecurityChangeGuard } from '../connector-settings'
import type { SettingsService } from '../service'

type ConnectorSettingsWorkflowStore = Pick<
  SettingsService,
  | 'getConnectors'
  | 'setConnectorEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'addCustomServer'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'updateCustomServer'
  | 'authenticateCustomServer'
  | 'cancelCustomServerAuthentication'
>

type ConnectorSettingsWorkflowEffects = {
  invalidatePermissionProjection: () => void
  refreshConnectorSkillDocs: () => Promise<unknown>
  requestSkillsReload: () => void
  pruneCustomServerPermissions: (serverId: string) => Promise<void>
  beginCustomServerSecurityChange: (serverId: string) => CustomServerSecurityChangeGuard | undefined
  clearCustomServerFailure: (serverId: string) => void
}

type WorkflowResult<Method extends keyof ConnectorSettingsWorkflowStore> = Promise<
  Awaited<ReturnType<ConnectorSettingsWorkflowStore[Method]>>
>

// Owns Connector mutation follow-up ordering, including the security barrier and derived projection.
// Every safety-critical effect is required; unsupported hosts must inject an explicit no-op adapter.
class ConnectorSettingsWorkflows {
  constructor(
    private readonly settings: ConnectorSettingsWorkflowStore,
    private readonly effects: ConnectorSettingsWorkflowEffects
  ) {}

  async setConnectorEnabled(
    request: SetConnectorEnabledRequest
  ): WorkflowResult<'setConnectorEnabled'> {
    return this.afterConnectorsChanged(() => this.settings.setConnectorEnabled(request))
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

  async addCustomServer(request: AddCustomServerRequest): WorkflowResult<'addCustomServer'> {
    return this.afterConnectorsChanged(() => this.settings.addCustomServer(request))
  }

  async setCustomServerEnabled(
    request: Parameters<ConnectorSettingsWorkflowStore['setCustomServerEnabled']>[0]
  ): WorkflowResult<'setCustomServerEnabled'> {
    return this.afterConnectorsChanged(() => this.settings.setCustomServerEnabled(request))
  }

  async removeCustomServer(
    request: RemoveCustomServerRequest
  ): WorkflowResult<'removeCustomServer'> {
    const serverId = (await this.settings.getConnectors())?.customMcpServers?.find(
      (server) => server.id === request.id
    )?.id
    const snapshot = await this.settings.removeCustomServer(request)
    if (serverId) await this.effects.pruneCustomServerPermissions(serverId)
    this.connectorsChanged()
    return snapshot
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
    request: AuthenticateCustomServerRequest
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

  private async afterConnectorsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.connectorsChanged()
    return result
  }

  private connectorsChanged(): void {
    this.effects.invalidatePermissionProjection()
    void wireConnectorReload(
      this.effects.refreshConnectorSkillDocs,
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
}

export { ConnectorSettingsWorkflows }
export type { ConnectorSettingsWorkflowEffects, ConnectorSettingsWorkflowStore }
