import type {
  AuthenticateCustomServerRequest,
  DisconnectCustomServerRequest,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetOpenAlexCredentialRequest,
  SetToolPermissionRequest,
  UpdateCustomServerRequest,
  ValidateOpenAlexCredentialRequest
} from '../../../shared/settings'
import { wireConnectorReload } from '../../connector-reload'
import type { CustomServerSecurityChangeGuard } from '../connector-settings'
import type { SettingsService } from '../service'

type ConnectorSettingsWorkflowStore = Pick<
  SettingsService,
  | 'listConnectors'
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
    const snapshot = await this.settings.disconnectCustomServer(request.id)
    this.effects.clearCustomServerFailure(request.id)
    this.connectorsChanged()
    return snapshot
  }

  async retryCustomServer(
    request: AuthenticateCustomServerRequest
  ): WorkflowResult<'listConnectors'> {
    await this.effects.resetCustomServerClient(request.id)
    this.effects.clearCustomServerFailure(request.id)
    this.effects.invalidatePermissionProjection()
    await this.refreshConnectorProjection()
    return this.settings.listConnectors()
  }

  private async afterConnectorsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.connectorsChanged()
    return result
  }

  private connectorsChanged(customServerId?: string): void {
    this.effects.invalidatePermissionProjection()
    void this.refreshConnectorProjection(customServerId)
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
}

export { ConnectorSettingsWorkflows }
export type { ConnectorSettingsWorkflowEffects, ConnectorSettingsWorkflowStore }
