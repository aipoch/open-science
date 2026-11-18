import {
  codeBuddyAccounts,
  readCodeBuddyAccountRequest,
  type CodeBuddyAccountRequest
} from '../../../shared/codebuddy-subscription'
import type {
  ProviderDeletionScenarioModelHandling,
  SettingsSnapshot,
  RefreshProviderModelsRequest,
  SetActiveProviderRequest,
  SetAgentFrameworkRequest,
  SetAgentRoutingRequest,
  SetReasoningEffortRequest,
  UpsertProviderRequest
} from '../../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID
} from '../../../shared/settings-runtime'
import type { AgentFrameworkId } from '../../agent-framework'
import type { SettingsService } from '../service'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

const log = createLogger('settings')

type RuntimeSettingsWorkflowStore = Pick<
  SettingsService,
  | 'getSettingsView'
  | 'refreshProviderModels'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallPi'
  | 'uninstallCodeBuddy'
  | 'uninstallCodex'
  | 'upsertProvider'
  | 'saveValidatedProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'setAgentRouting'
  | 'setReasoningEffort'
  | 'loginClaudeShared'
  | 'logoutClaudeShared'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'logoutIsolatedClaude'
  | 'codeBuddyAccount'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
>

type RuntimeSettingsWorkflowEffects = {
  requestProviderReconnect: (providerIds?: readonly string[], includeDefault?: boolean) => void
  requestAgentFrameworkSwitch: (frameworkId?: AgentFrameworkId) => void
}

type RuntimeUninstallMethod =
  'uninstallClaude' | 'uninstallOpencode' | 'uninstallCodeBuddy' | 'uninstallCodex' | 'uninstallPi'

const affectedProviderIds = (providerId: string): readonly string[] =>
  providerId === CLAUDE_SHARED_PROVIDER_ID || providerId === CLAUDE_ISOLATED_PROVIDER_ID
    ? [CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID]
    : [providerId]

// Official accounts derive their model list and capabilities from discovery. Those may
// change while the configured runtime connection stays the same.
function needsProviderReconnect(
  request: UpsertProviderRequest,
  before: SettingsSnapshot,
  after?: SettingsSnapshot
): boolean {
  if (request.type !== 'official' || request.key) return true
  const previous = before.providers.find(({ id }) => id === request.id)
  const current = after?.providers.find(({ id }) => id === request.id)
  if (previous?.type !== 'official') return true
  return (
    (current?.vendorId ?? request.vendorId ?? previous.vendorId) !== previous.vendorId ||
    (current?.region ?? request.region ?? previous.region) !== previous.region
  )
}

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
        this.effects.requestAgentFrameworkSwitch(framework)
      }
    }

    return result.snapshot
  }

  async upsertProvider(
    request: UpsertProviderRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['upsertProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.upsertProvider(request)

    if (request.id && needsProviderReconnect(request, before, snapshot)) {
      this.effects.requestProviderReconnect(
        affectedProviderIds(request.id),
        request.id === before.activeProviderId || request.id === snapshot.activeProviderId
      )
    }

    return snapshot
  }

  async saveValidatedProvider(
    request: UpsertProviderRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['saveValidatedProvider']>>> {
    const before = await this.settings.getSettingsView()
    const result = await this.settings.saveValidatedProvider(request)
    if (
      result.providerId &&
      request.id &&
      needsProviderReconnect(request, before, result.snapshot)
    ) {
      try {
        this.effects.requestProviderReconnect(
          affectedProviderIds(result.providerId),
          result.providerId === before.activeProviderId ||
            result.providerId === result.snapshot?.activeProviderId
        )
      } catch (error) {
        log.warn(
          'Provider saved, but runtime reconnect could not be requested.',
          diagnosticErrorFields(error)
        )
        return { ...result, runtimeReconnectFailed: true }
      }
    }
    return result
  }

  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['refreshProviderModels']>>> {
    // Running sessions own their negotiated routes. New connections read the refreshed inventory.
    return this.settings.refreshProviderModels(request)
  }

  async deleteProvider(
    id: string,
    scenarioModelHandling?: ProviderDeletionScenarioModelHandling
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['deleteProvider']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.deleteProvider(id, scenarioModelHandling)
    this.effects.requestProviderReconnect(
      affectedProviderIds(id),
      before.activeProviderId !== snapshot.activeProviderId
    )
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

  async setAgentRouting(
    request: SetAgentRoutingRequest
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['setAgentRouting']>>> {
    const before = await this.settings.getSettingsView()
    const snapshot = await this.settings.setAgentRouting(request)
    if (snapshot.agentFrameworkId !== before.agentFrameworkId) {
      this.effects.requestAgentFrameworkSwitch()
    }
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
      this.effects.requestProviderReconnect(
        [CLAUDE_SHARED_PROVIDER_ID],
        snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID
      )
    }
    return result
  }

  async logoutClaudeShared(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutClaudeShared']>>
  > {
    const result = await this.settings.logoutClaudeShared()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      this.effects.requestProviderReconnect(
        [CLAUDE_SHARED_PROVIDER_ID],
        snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID
      )
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
      this.effects.requestProviderReconnect(
        [CLAUDE_ISOLATED_PROVIDER_ID],
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID
      )
    }
    return result
  }

  async codeBuddyAccount(
    input: CodeBuddyAccountRequest
  ): ReturnType<RuntimeSettingsWorkflowStore['codeBuddyAccount']> {
    const request = readCodeBuddyAccountRequest(input)
    const result = await this.settings.codeBuddyAccount(request)
    if (
      (result.ok && (request.action === 'login' || request.action === 'logout')) ||
      (request.action === 'refresh' && result.category === 'auth')
    ) {
      const id = codeBuddyAccounts[request.site].id
      const snapshot = await this.settings.getSettingsView()
      this.effects.requestProviderReconnect([id], snapshot.activeProviderId === id)
    }
    return result
  }

  async loginIsolatedCodex(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedCodex']>>
  > {
    const result = await this.settings.loginIsolatedCodex()
    if (result.ok && result.applied !== false) {
      const snapshot = await this.settings.getSettingsView()
      this.effects.requestProviderReconnect(
        [CODEX_SUBSCRIPTION_PROVIDER_ID],
        snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID
      )
    }
    return result
  }

  async logoutIsolatedCodex(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutIsolatedCodex']>>
  > {
    const result = await this.settings.logoutIsolatedCodex()
    if (result.ok) {
      const snapshot = await this.settings.getSettingsView()
      this.effects.requestProviderReconnect(
        [CODEX_SUBSCRIPTION_PROVIDER_ID],
        snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID
      )
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
    this.effects.requestProviderReconnect(
      [XAI_SUBSCRIPTION_PROVIDER_ID],
      snapshot.activeProviderId === XAI_SUBSCRIPTION_PROVIDER_ID
    )
    return result
  }

  cancelXaiOAuthLogin(): void {
    this.settings.cancelXaiOAuthLogin()
  }

  async logoutXaiOAuth(): Promise<
    Awaited<ReturnType<RuntimeSettingsWorkflowStore['logoutXaiOAuth']>>
  > {
    const snapshot = await this.settings.logoutXaiOAuth()
    this.effects.requestProviderReconnect(
      [XAI_SUBSCRIPTION_PROVIDER_ID],
      snapshot.activeProviderId === XAI_SUBSCRIPTION_PROVIDER_ID
    )
    return snapshot
  }

  private async finishIsolatedClaudeLogin(
    result: Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaude']>>
  ): Promise<Awaited<ReturnType<RuntimeSettingsWorkflowStore['loginIsolatedClaude']>>> {
    if (result.ok && result.applied !== false) {
      const snapshot = await this.settings.getSettingsView()
      this.effects.requestProviderReconnect(
        [CLAUDE_ISOLATED_PROVIDER_ID],
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID
      )
    }
    return result
  }
}

export { RuntimeSettingsWorkflows }
export type { RuntimeSettingsWorkflowEffects, RuntimeSettingsWorkflowStore }
