import { providerValidationFailed, type ReviewerModelConfiguration } from '../../shared/settings'
import { DEFAULT_AGENT_FRAMEWORK_ID, getAgentFramework } from '../agent-framework'
import type { AgentBackendResolver, ExplicitAgentBackendTarget } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import { providerRuntimeValidationTarget } from './provider-validation-state'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'

type ReviewerModelOwnerOptions = {
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: Pick<AgentBackendResolver, 'captureConfiguredSelection'>
}

type ReviewerModelAdmission = Readonly<{
  model: string
  fixedTarget?: ExplicitAgentBackendTarget
}>

class ReviewerModelOwner {
  constructor(private readonly options: ReviewerModelOwnerOptions) {}

  async set(configuration: ReviewerModelConfiguration): Promise<void> {
    const frameworkId =
      configuration.mode === 'fixed'
        ? (await this.options.backendResolver.captureConfiguredSelection()).frameworkId
        : undefined
    await this.options.repository.setReviewerModel(configuration, (settings, candidate) =>
      this.validate(settings, candidate, frameworkId)
    )
  }

  validate(
    settings: StoredSettings,
    candidate: ReviewerModelConfiguration,
    frameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
  ): ReviewerModelConfiguration {
    if (candidate.mode === 'inherit') return candidate
    const provider = settings.providers.find((entry) => entry.id === candidate.providerId)
    const validationFailed = provider ? providerValidationFailed(provider) : false
    if (!provider || validationFailed) {
      throw new Error(
        'The selected Reviewer model is no longer available. Refresh the model catalog.'
      )
    }
    const framework = getAgentFramework(frameworkId)
    const target = this.options.providers.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: candidate.model },
      framework
    )
    if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
      throw new Error(
        'The selected Reviewer model is no longer available. Refresh the model catalog.'
      )
    }
    if (!target.frameworkCompatible || (framework.id === 'codex' && !target.modelBridgeSupported)) {
      throw new Error(
        'The selected Reviewer model is not available for the active Agent Framework. Refresh the model catalog.'
      )
    }
    return target.reasoningEffortProfile.supported
      ? candidate
      : { ...candidate, reasoningEffort: 'default' }
  }

  async admit(): Promise<ReviewerModelAdmission> {
    const settings = await this.options.repository.getSettings()
    const configuration = settings.reviewerModel ?? { mode: 'inherit' as const }
    if (configuration.mode === 'inherit') {
      const activeProvider = settings.activeProviderId
        ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
        : undefined
      return Object.freeze({
        model: settings.activeModel ?? activeProvider?.model ?? ''
      })
    }
    const provider = settings.providers.find((entry) => entry.id === configuration.providerId)
    if (provider && providerValidationFailed(provider)) {
      throw new Error('The configured Reviewer model provider validation failed.')
    }
    const { frameworkId } = await this.options.backendResolver.captureConfiguredSelection()
    const framework = getAgentFramework(frameworkId)
    if (provider) {
      const target = this.options.providers.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: configuration.model },
        framework
      )
      if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
        throw new Error('The configured Reviewer model provider validation failed.')
      }
    }
    return Object.freeze({
      model: configuration.model,
      fixedTarget: Object.freeze({
        frameworkId,
        providerId: configuration.providerId,
        model: Object.freeze({ kind: 'required' as const, id: configuration.model }),
        reasoningEffort: configuration.reasoningEffort
      })
    })
  }
}

const createReviewerModels = (
  repository: SettingsRepository,
  providers: ProviderAccountsModule,
  backendResolver: AgentBackendResolver
): ReviewerModelOwner => new ReviewerModelOwner({ repository, providers, backendResolver })

export { createReviewerModels, ReviewerModelOwner }
export type { ReviewerModelAdmission, ReviewerModelOwnerOptions }
