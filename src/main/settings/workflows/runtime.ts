import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type SetActiveProviderRequest,
  type SetAgentFrameworkRequest,
  type SetReasoningEffortRequest,
  type UpsertProviderRequest
} from '../../../shared/settings'
import type { AgentFrameworkId } from '../../agent-framework'
import type { SettingsService } from '../service'

type RuntimeSettingsWorkflowStore = Pick<
  SettingsService,
  | 'getSettingsView'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallCodex'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'setReasoningEffort'
  | 'loginClaudeShared'
  | 'logoutClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'logoutIsolatedClaude'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
>

type RuntimeSettingsWorkflowEffects = {
  requestProviderReconnect: () => void
  requestAgentFrameworkSwitch: () => void
}

type RuntimeUninstallMethod = 'uninstallClaude' | 'uninstallOpencode' | 'uninstallCodex'

// Owns post-persistence runtime and authentication effects. Its required effect port makes an
// incomplete production composition fail at construction instead of silently skipping a reconnect.
class RuntimeSettingsWorkflows {
  constructor(
    private readonly settings: RuntimeSettingsWorkflowStore,
    private readonly effects: RuntimeSettingsWorkflowEffects
  ) {}

  async uninstallRuntime(
    method: RuntimeUninstallMethod,
    framework: AgentFrameworkId
  ): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore[RuntimeUninstallMethod]>>['snapshot']
  > {
    const result = await this.settings[method]()

    if (result.activeBackendAffected) {
      if (result.snapshot.agentFrameworkId !== framework) {
        this.effects.requestAgentFrameworkSwitch()
      } else {
        this.effects.requestProviderReconnect()
      }
    }

    return result.snapshot
  }

  async upsertProvider(
    request: UpsertProviderRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['upsertProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.upsertProvider(request)

    if (
      request.id &&
      (request.id === before.activeProviderId || request.id === snapshot.activeProviderId)
    ) {
      this.effects.requestProviderReconnect()
    }

    return snapshot
  }

  async deleteProvider(
    id: string
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['deleteProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.deleteProvider(id)
    if (before.activeProviderId !== snapshot.activeProviderId) {
      this.effects.requestProviderReconnect()
    }
    return snapshot
  }

  async setActiveProvider(
    request: SetActiveProviderRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['setActiveProvider']>>> {
    return this.settings.setActiveProvider(request.id, request.model)
  }

  async setAgentFramework(
    request: SetAgentFrameworkRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['setAgentFramework']>>> {
    const snapshot = await this.settings.setAgentFramework(request.id)
    this.effects.requestAgentFrameworkSwitch()
    return snapshot
  }

  async setReasoningEffort(
    request: SetReasoningEffortRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['setReasoningEffort']>>> {
    return this.settings.setReasoningEffort(request.effort)
  }

  async loginClaudeShared(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginClaudeShared']>>
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
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }

  async logoutClaudeShared(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutClaudeShared']>>
  > {
    const result = await this.settings.logoutClaudeShared()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID) {
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }

  async loginIsolatedClaude(
    token: string
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaude']>>> {
    return this.finishIsolatedClaudeLogin(await this.settings.loginIsolatedClaude(token))
  }

  async loginIsolatedClaudeBrowser(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaudeBrowser']>>
  > {
    return this.finishIsolatedClaudeLogin(await this.settings.loginIsolatedClaudeBrowser())
  }

  async logoutIsolatedClaude(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutIsolatedClaude']>>
  > {
    const result = await this.settings.logoutIsolatedClaude()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID) {
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }

  async loginIsolatedCodex(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedCodex']>>
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
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }

  async logoutIsolatedCodex(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutIsolatedCodex']>>
  > {
    const result = await this.settings.logoutIsolatedCodex()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      if (snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }

  beginXaiOAuthLogin(): ReturnType<RuntimeSettingsWorkflowStore['beginXaiOAuthLogin']> {
    return this.settings.beginXaiOAuthLogin()
  }

  async waitXaiOAuthLogin(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['waitXaiOAuthLogin']>>
  > {
    const result = await this.settings.waitXaiOAuthLogin()
    const snapshot = await this.settings.getSettingsView()
    if (snapshot.activeProviderId === XAI_SUBSCRIPTION_PROVIDER_ID) {
      this.effects.requestProviderReconnect()
    }
    return result
  }

  cancelXaiOAuthLogin(): void {
    this.settings.cancelXaiOAuthLogin()
  }

  async logoutXaiOAuth(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutXaiOAuth']>>
  > {
    const snapshot = await this.settings.logoutXaiOAuth()
    if (snapshot.activeProviderId === XAI_SUBSCRIPTION_PROVIDER_ID) {
      this.effects.requestProviderReconnect()
    }
    return snapshot
  }

  private async finishIsolatedClaudeLogin(
    result: Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaude']>>
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaude']>>> {
    if (result.ok && result.applied !== false) {
      const snapshot = await this.settings.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID &&
        active?.type === 'claude-isolated'
      ) {
        this.effects.requestProviderReconnect()
      }
    }
    return result
  }
}

export { RuntimeSettingsWorkflows }
export type { RuntimeSettingsWorkflowEffects, RuntimeSettingsWorkflowStore }
