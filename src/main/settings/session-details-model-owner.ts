import {
  DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  isCodexSubscriptionProvider,
  providerValidationFailed,
  type SessionDetailsModelConfiguration
} from '../../shared/settings'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { DEFAULT_AGENT_FRAMEWORK_ID, getAgentFramework } from '../agent-framework'
import type { AgentBackendResolver, ExplicitAgentBackendTarget } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import { providerRuntimeValidationTarget } from './provider-validation-state'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'

type SessionDetailsModelOwnerOptions = Readonly<{
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: Pick<AgentBackendResolver, 'captureConfiguredSelection'>
}>

type SessionDetailsModelAdmission =
  Readonly<{ mode: 'disabled' }> | Readonly<{ mode: 'target'; target: ExplicitAgentBackendTarget }>

const inheritedProviderId = (session: PersistedChatSession): string | undefined => {
  if (session.agentConfiguration?.providerId) return session.agentConfiguration.providerId
  if (!session.agentFrameworkId || !session.agentBackendId) return undefined
  const prefix = `${session.agentFrameworkId}:`
  return session.agentBackendId.startsWith(prefix)
    ? session.agentBackendId.slice(prefix.length)
    : undefined
}

class SessionDetailsModelOwner {
  constructor(private readonly options: SessionDetailsModelOwnerOptions) {}

  async set(configuration: SessionDetailsModelConfiguration): Promise<void> {
    const frameworkId =
      configuration.mode === 'fixed'
        ? (await this.options.backendResolver.captureConfiguredSelection()).frameworkId
        : undefined
    await this.options.repository.setSessionDetailsModel(configuration, (settings, candidate) => {
      if (candidate.mode !== 'fixed') return
      const provider = settings.providers.find((entry) => entry.id === candidate.providerId)
      if (!provider || providerValidationFailed(provider)) {
        throw new Error(
          'The selected Session details model is no longer available. Refresh the model catalog.'
        )
      }
      if (isCodexSubscriptionProvider(provider.type)) {
        throw new Error('Codex subscription models cannot run as the Session details model.')
      }
      const framework = getAgentFramework(
        frameworkId ?? settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
      )
      const target = this.options.providers.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: candidate.model },
        framework
      )
      if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
        throw new Error(
          'The selected Session details model is no longer available. Refresh the model catalog.'
        )
      }
      if (
        !target.frameworkCompatible ||
        (framework.id === 'codex' && !target.modelBridgeSupported)
      ) {
        throw new Error(
          'The selected Session details model is not available for the active Agent Framework. Refresh the model catalog.'
        )
      }
      // A target without effort support remains eligible. Keep the user's independent intent so
      // the runtime resolver can omit only the provider override, not rewrite the preference.
      return candidate
    })
  }

  async getConfiguration(): Promise<SessionDetailsModelConfiguration> {
    const settings = await this.options.repository.getSettings()
    return settings.sessionDetailsModel ?? DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION
  }

  private assertAvailable(
    settings: StoredSettings,
    frameworkId: PersistedChatSession['agentFrameworkId'],
    providerId: string,
    model: string
  ): void {
    if (!frameworkId) throw new Error('The Session details model has no Agent Framework.')
    const provider = settings.providers.find((entry) => entry.id === providerId)
    if (!provider || providerValidationFailed(provider)) {
      throw new Error('The Session details model provider is unavailable.')
    }
    if (isCodexSubscriptionProvider(provider.type)) {
      throw new Error('Codex subscription models cannot run as the Session details model.')
    }
    const framework = getAgentFramework(frameworkId)
    const target = this.options.providers.resolveRuntimeTarget(
      provider,
      { kind: 'required', model },
      framework
    )
    if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
      throw new Error('The Session details model provider is unavailable.')
    }
    if (!target.frameworkCompatible || (framework.id === 'codex' && !target.modelBridgeSupported)) {
      throw new Error('The Session details model is unavailable for its Agent Framework.')
    }
  }

  async admit(session: PersistedChatSession): Promise<SessionDetailsModelAdmission> {
    const settings = await this.options.repository.getSettings()
    const configuration =
      settings.sessionDetailsModel ?? DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION
    if (configuration.mode === 'disabled') return Object.freeze({ mode: 'disabled' })

    if (configuration.mode === 'inherit') {
      const frameworkId = session.agentFrameworkId
      const providerId = inheritedProviderId(session)
      const model = session.agentModel ?? session.agentConfiguration?.model
      if (!frameworkId || !providerId || !model) {
        throw new Error('The saved Session has no complete Main model target for Session details.')
      }
      this.assertAvailable(settings, frameworkId, providerId, model)
      return Object.freeze({
        mode: 'target',
        target: Object.freeze({
          frameworkId,
          providerId,
          model: Object.freeze({ kind: 'required' as const, id: model }),
          reasoningEffort: configuration.reasoningEffort
        })
      })
    }

    const { frameworkId } = await this.options.backendResolver.captureConfiguredSelection()
    this.assertAvailable(settings, frameworkId, configuration.providerId, configuration.model)
    return Object.freeze({
      mode: 'target',
      target: Object.freeze({
        frameworkId,
        providerId: configuration.providerId,
        model: Object.freeze({ kind: 'required' as const, id: configuration.model }),
        reasoningEffort: configuration.reasoningEffort
      })
    })
  }
}

const createSessionDetailsModels = (
  repository: SettingsRepository,
  providers: ProviderAccountsModule,
  backendResolver: AgentBackendResolver
): SessionDetailsModelOwner =>
  new SessionDetailsModelOwner({ repository, providers, backendResolver })

export { createSessionDetailsModels, SessionDetailsModelOwner }
export type { SessionDetailsModelAdmission, SessionDetailsModelOwnerOptions }
