import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from '../../shared/settings'
import { NO_ACTIVE_PROVIDER_MESSAGE } from '../../shared/run-error-classification'
import {
  resolveReasoningEffortValue,
  type ResolvedReasoningEffort
} from '../../shared/reasoning-effort'
import { DEFAULT_AGENT_FRAMEWORK_ID, type AgentFrameworkId } from '../agent-framework'
import type { StoredSettings } from './types'
import type { ProviderAccountsModule, RuntimeProviderModelSelection } from './provider-accounts'

type AgentBackendSelection = Readonly<{
  frameworkId: AgentFrameworkId
}>

type ExplicitAgentBackendTarget = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  model: Readonly<{ kind: 'required'; id: string }> | Readonly<{ kind: 'provider-default' }>
  reasoningEffort: ReasoningEffort
  resolvedReasoningEffort?: ResolvedReasoningEffort
}>

type BackendSelectionResolution = Readonly<{
  settings: StoredSettings
  frameworkId: AgentFrameworkId
  providerId: string
  modelSelection: RuntimeProviderModelSelection
  reasoningEffort: ReasoningEffort
  resolvedReasoningEffort?: ResolvedReasoningEffort
}>

type BackendSelectionOwnerOptions = {
  readSettings: () => Promise<StoredSettings>
  readFrameworkOverride: () => string | undefined
  resolveRuntimeReasoningEffortProfile: ProviderAccountsModule['resolveRuntimeReasoningEffortProfile']
}

class BackendSelectionOwner {
  constructor(private readonly options: BackendSelectionOwnerOptions) {}

  async captureConfiguredSelection(): Promise<AgentBackendSelection> {
    const settings = await this.options.readSettings()
    return { frameworkId: this.resolveConfiguredFrameworkId(settings) }
  }

  async captureExplicitTarget(): Promise<ExplicitAgentBackendTarget> {
    const settings = await this.options.readSettings()
    if (!settings.activeProviderId) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    return Object.freeze({
      frameworkId: this.resolveConfiguredFrameworkId(settings),
      providerId: settings.activeProviderId,
      model: settings.activeModel
        ? Object.freeze({ kind: 'required' as const, id: settings.activeModel })
        : Object.freeze({ kind: 'provider-default' as const }),
      reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    })
  }

  async resolveSelection(selection: AgentBackendSelection): Promise<BackendSelectionResolution> {
    const settings = await this.options.readSettings()
    return Object.freeze({
      settings,
      frameworkId: selection.frameworkId,
      providerId: this.requireProviderId(settings, settings.activeProviderId),
      modelSelection: {
        kind: 'configured' as const,
        requestedModel: settings.activeModel
      },
      reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    })
  }

  async resolveActiveSelection(): Promise<BackendSelectionResolution> {
    const settings = await this.options.readSettings()
    return Object.freeze({
      settings,
      frameworkId: this.resolveConfiguredFrameworkId(settings),
      providerId: this.requireProviderId(settings, settings.activeProviderId),
      modelSelection: {
        kind: 'configured' as const,
        requestedModel: settings.activeModel
      },
      reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    })
  }

  async resolveExplicitTarget(
    target: ExplicitAgentBackendTarget
  ): Promise<BackendSelectionResolution> {
    const settings = await this.options.readSettings()
    const modelSelection: RuntimeProviderModelSelection =
      target.model.kind === 'required'
        ? { kind: 'required', model: target.model.id }
        : { kind: 'provider-default' }
    return Object.freeze({
      settings,
      frameworkId: target.frameworkId,
      providerId: this.requireProviderId(settings, target.providerId),
      modelSelection,
      reasoningEffort: target.reasoningEffort,
      resolvedReasoningEffort: target.resolvedReasoningEffort
    })
  }

  async resolveActiveModelChangeSelection(): Promise<BackendSelectionResolution | undefined> {
    const settings = await this.options.readSettings()
    const frameworkId = this.resolveConfiguredFrameworkId(settings)
    const providerId = settings.activeProviderId
    if (!providerId || !settings.providers.some((provider) => provider.id === providerId)) {
      return undefined
    }
    return Object.freeze({
      settings,
      frameworkId,
      providerId,
      modelSelection: {
        kind: 'configured' as const,
        requestedModel: settings.activeModel
      },
      reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    })
  }

  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    const settings = await this.options.readSettings()
    if (intent === DEFAULT_REASONING_EFFORT) return DEFAULT_REASONING_EFFORT
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    if (!activeProvider) return DEFAULT_REASONING_EFFORT

    const profile = this.options.resolveRuntimeReasoningEffortProfile(
      activeProvider,
      settings.activeModel
    )
    return resolveReasoningEffortValue(intent, profile)
  }

  private resolveConfiguredFrameworkId(settings: StoredSettings): AgentFrameworkId {
    const forced = this.options.readFrameworkOverride()
    return forced === 'opencode' ||
      forced === 'claude-code' ||
      forced === 'codex' ||
      forced === 'codebuddy'
      ? forced
      : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
  }

  private requireProviderId(settings: StoredSettings, providerId: string | undefined): string {
    if (!providerId || !settings.providers.some((provider) => provider.id === providerId)) {
      throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    }
    return providerId
  }
}

export { BackendSelectionOwner }
export type {
  AgentBackendSelection,
  BackendSelectionResolution,
  BackendSelectionOwnerOptions,
  ExplicitAgentBackendTarget
}
