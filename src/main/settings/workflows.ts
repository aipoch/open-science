import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type AddCustomServerRequest,
  type AppIconVariant,
  type CreateSkillRequest,
  type DeleteSkillRequest,
  type ImportAgentHomeSkillsRequest,
  type ImportSkillRequest,
  type ImportSkillZipBatchRequest,
  type ImportSkillZipRequest,
  type RemoveCustomServerRequest,
  type SetActiveProviderRequest,
  type SetAgentFrameworkRequest,
  type SetConnectorAutoAllowRequest,
  type SetConnectorEnabledRequest,
  type SetConversationSkillImportEnabledRequest,
  type SetNcbiCredentialsRequest,
  type SetReasoningEffortRequest,
  type SetSkillEnabledRequest,
  type SetToolPermissionRequest,
  type UpdateCustomServerRequest,
  type UpdateSkillRequest,
  type UpsertProviderRequest
} from '../../shared/settings'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { AgentFrameworkId } from '../agent-framework'
import { wireConnectorReload } from '../connector-reload'
import type { SettingsService } from './service'
import type { CustomServerSecurityChangeGuard } from './connector-settings'

type SettingsWorkflowStore = Pick<
  SettingsService,
  | 'getSettingsView'
  | 'getConnectors'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallCodex'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'setReasoningEffort'
  | 'resolveActiveReasoningEffort'
  | 'setConversationSkillImportEnabled'
  | 'setAppIconVariant'
  | 'loginClaudeShared'
  | 'logoutClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'logoutIsolatedClaude'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'setSkillEnabled'
  | 'createSkill'
  | 'updateSkill'
  | 'deleteSkill'
  | 'importSkill'
  | 'importSkillZip'
  | 'importSkillZipBatch'
  | 'importAgentHomeSkills'
  | 'setConnectorEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'addCustomServer'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'updateCustomServer'
>

type WorkflowResult<Method extends keyof SettingsWorkflowStore> = Promise<
  Awaited<ReturnType<SettingsWorkflowStore[Method]>>
>

export type SettingsWorkflowEffects = {
  requestProviderReconnect?: () => void
  requestAgentFrameworkSwitch?: () => void
  applyReasoningEffort?: (effort: ResolvedReasoningEffort) => Promise<boolean>
  requestSkillsReload?: () => void
  invalidatePermissionProjection?: () => void
  refreshConnectorSkillDocs?: () => Promise<unknown>
  pruneCustomServerPermissions?: (serverId: string) => Promise<void>
  beginCustomServerSecurityChange?: (
    serverId: string
  ) => CustomServerSecurityChangeGuard | undefined
  applyAppIconVariant?: (variant: AppIconVariant) => void
}

type RuntimeUninstallMethod = 'uninstallClaude' | 'uninstallOpencode' | 'uninstallCodex'

// Owns ordered effects that span otherwise-independent Settings capabilities. The owner is
// transport-free and holds no durable or mutable state: Electron and Web invoke the same methods,
// while the Settings repository remains the only write serializer.
class SettingsWorkflows {
  constructor(
    private readonly settings: SettingsWorkflowStore,
    private readonly effects: SettingsWorkflowEffects = {}
  ) {}

  async uninstallRuntime(
    method: RuntimeUninstallMethod,
    framework: AgentFrameworkId
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore[RuntimeUninstallMethod]>>['snapshot']> {
    const result = await this.settings[method]()

    if (result.activeBackendAffected) {
      if (result.snapshot.agentFrameworkId !== framework) {
        this.effects.requestAgentFrameworkSwitch?.()
      } else {
        this.effects.requestProviderReconnect?.()
      }
    }

    return result.snapshot
  }

  async upsertProvider(
    request: UpsertProviderRequest
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['upsertProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.upsertProvider(request)

    if (
      request.id &&
      (request.id === before.activeProviderId || request.id === snapshot.activeProviderId)
    ) {
      this.effects.requestProviderReconnect?.()
    }

    return snapshot
  }

  async deleteProvider(
    id: string
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['deleteProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.deleteProvider(id)
    if (before.activeProviderId !== snapshot.activeProviderId) {
      this.effects.requestProviderReconnect?.()
    }
    return snapshot
  }

  async setActiveProvider(
    request: SetActiveProviderRequest
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['setActiveProvider']>>> {
    const snapshot = await this.settings.setActiveProvider(request.id, request.model)
    this.effects.requestProviderReconnect?.()
    return snapshot
  }

  async setAgentFramework(
    request: SetAgentFrameworkRequest
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['setAgentFramework']>>> {
    const snapshot = await this.settings.setAgentFramework(request.id)
    this.effects.requestAgentFrameworkSwitch?.()
    return snapshot
  }

  async setReasoningEffort(
    request: SetReasoningEffortRequest
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['setReasoningEffort']>>> {
    const snapshot = await this.settings.setReasoningEffort(request.effort)
    const resolvedEffort = await this.settings.resolveActiveReasoningEffort(request.effort)
    const appliedLive = (await this.effects.applyReasoningEffort?.(resolvedEffort)) ?? false
    if (!appliedLive) this.effects.requestProviderReconnect?.()
    return snapshot
  }

  async setConversationSkillImportEnabled(
    request: SetConversationSkillImportEnabledRequest
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['setConversationSkillImportEnabled']>>> {
    const snapshot = await this.settings.setConversationSkillImportEnabled(request.enabled)
    this.effects.requestSkillsReload?.()
    return snapshot
  }

  async setAppIconVariant(
    variant: AppIconVariant
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['setAppIconVariant']>>> {
    const snapshot = await this.settings.setAppIconVariant(variant)
    this.effects.applyAppIconVariant?.(variant)
    return snapshot
  }

  async loginClaudeShared(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['loginClaudeShared']>>
  > {
    const result = await this.settings.loginClaudeShared()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID &&
        active?.type === 'claude-shared'
      ) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  async logoutClaudeShared(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['logoutClaudeShared']>>
  > {
    const result = await this.settings.logoutClaudeShared()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  async loginIsolatedClaude(
    token: string
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['loginIsolatedClaude']>>> {
    return this.finishIsolatedClaudeLogin(await this.settings.loginIsolatedClaude(token))
  }

  async loginIsolatedClaudeBrowser(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['loginIsolatedClaudeBrowser']>>
  > {
    return this.finishIsolatedClaudeLogin(await this.settings.loginIsolatedClaudeBrowser())
  }

  async logoutIsolatedClaude(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['logoutIsolatedClaude']>>
  > {
    const result = await this.settings.logoutIsolatedClaude()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  async loginIsolatedCodex(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['loginIsolatedCodex']>>
  > {
    const result = await this.settings.loginIsolatedCodex()
    if (result.ok && result.applied !== false) {
      const snapshot = await this.settings.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
        active?.type === 'codex-isolated' &&
        active.codexAuthMode === 'isolated'
      ) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  async logoutIsolatedCodex(): Promise<
    Awaited<ReturnType<SettingsWorkflowStore['logoutIsolatedCodex']>>
  > {
    const result = await this.settings.logoutIsolatedCodex()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  async setSkillEnabled(request: SetSkillEnabledRequest): WorkflowResult<'setSkillEnabled'> {
    return this.afterSkillsChanged(() => this.settings.setSkillEnabled(request))
  }

  async createSkill(request: CreateSkillRequest): WorkflowResult<'createSkill'> {
    return this.afterSkillsChanged(() => this.settings.createSkill(request))
  }

  async updateSkill(request: UpdateSkillRequest): WorkflowResult<'updateSkill'> {
    return this.afterSkillsChanged(() => this.settings.updateSkill(request))
  }

  async deleteSkill(request: DeleteSkillRequest): WorkflowResult<'deleteSkill'> {
    return this.afterSkillsChanged(() => this.settings.deleteSkill(request))
  }

  async importSkill(request: ImportSkillRequest): WorkflowResult<'importSkill'> {
    return this.afterSkillsChanged(() => this.settings.importSkill(request))
  }

  async importSkillZip(request: ImportSkillZipRequest): WorkflowResult<'importSkillZip'> {
    return this.afterSkillsChanged(() => this.settings.importSkillZip(request))
  }

  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): WorkflowResult<'importSkillZipBatch'> {
    return this.afterSkillsChanged(() => this.settings.importSkillZipBatch(request))
  }

  async importAgentHomeSkills(
    request: ImportAgentHomeSkillsRequest
  ): WorkflowResult<'importAgentHomeSkills'> {
    const result = await this.settings.importAgentHomeSkills(request)
    if (result.results.some((item) => item.status === 'imported' || item.status === 'updated')) {
      this.effects.requestSkillsReload?.()
    }
    return result
  }

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
    request: Parameters<SettingsWorkflowStore['setCustomServerEnabled']>[0]
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
    if (serverId) await this.effects.pruneCustomServerPermissions?.(serverId)
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

  private async finishIsolatedClaudeLogin(
    result: Awaited<ReturnType<SettingsWorkflowStore['loginIsolatedClaude']>>
  ): Promise<Awaited<ReturnType<SettingsWorkflowStore['loginIsolatedClaude']>>> {
    if (result.ok && result.applied !== false) {
      const snapshot = await this.settings.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID &&
        active?.type === 'claude-isolated'
      ) {
        this.effects.requestProviderReconnect?.()
      }
    }
    return result
  }

  private async afterSkillsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.effects.requestSkillsReload?.()
    return result
  }

  private async afterConnectorsChanged<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = await mutation()
    this.connectorsChanged()
    return result
  }

  private connectorsChanged(): void {
    this.effects.invalidatePermissionProjection?.()
    void wireConnectorReload(
      this.effects.refreshConnectorSkillDocs ?? (() => Promise.resolve()),
      () => this.effects.requestSkillsReload?.()
    )
  }

  private async prepareCustomServerSecurityChange(
    serverId: string
  ): Promise<CustomServerSecurityChangeGuard | void> {
    const guard = this.effects.beginCustomServerSecurityChange?.(serverId)
    try {
      await this.effects.pruneCustomServerPermissions?.(serverId)
      return guard
    } catch (error) {
      guard?.rollback()
      throw error
    }
  }
}

const createSettingsWorkflows = (
  settings: SettingsWorkflowStore,
  effects: SettingsWorkflowEffects = {}
): SettingsWorkflows => new SettingsWorkflows(settings, effects)

export { createSettingsWorkflows, SettingsWorkflows }
export type { SettingsWorkflowStore }
