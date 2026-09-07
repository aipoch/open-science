import { createHash } from 'node:crypto'

import { providerValidationFailed, type VisionModelConfiguration } from '../../shared/settings'
import { DEFAULT_AGENT_FRAMEWORK_ID, getAgentFramework } from '../agent-framework'
import type { AgentBackendResolver, ExplicitAgentBackendTarget } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import { providerRuntimeValidationTarget } from './provider-validation-state'
import type { SettingsRepository } from './repository'

type VisionModelOwnerOptions = Readonly<{
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: Pick<AgentBackendResolver, 'captureConfiguredSelection'>
}>

const providerConfigurationFingerprint = (provider: object): string =>
  createHash('sha256').update(JSON.stringify(provider)).digest('hex')

class VisionModelOwner {
  constructor(private readonly options: VisionModelOwnerOptions) {}

  async set(configuration: VisionModelConfiguration | undefined): Promise<void> {
    const frameworkId = configuration
      ? (await this.options.backendResolver.captureConfiguredSelection()).frameworkId
      : undefined
    await this.options.repository.setVisionModel(configuration, (settings, candidate) => {
      const provider = settings.providers.find((entry) => entry.id === candidate.providerId)
      if (!provider || providerValidationFailed(provider)) {
        throw new Error(
          'The selected Vision model is no longer available. Refresh the model catalog.'
        )
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
          'The selected Vision model is no longer available. Refresh the model catalog.'
        )
      }
      if (
        !target.frameworkCompatible ||
        (framework.id === 'codex' && !target.modelBridgeSupported)
      ) {
        throw new Error(
          'The selected Vision model is not available for the active Agent Framework. Refresh the model catalog.'
        )
      }
      if (target.provider.supportsImageInput !== true) {
        throw new Error('The selected Vision model does not support image input.')
      }
      return target.reasoningEffortProfile.supported
        ? candidate
        : { ...candidate, reasoningEffort: 'default' }
    })
  }

  async admit(): Promise<ExplicitAgentBackendTarget | undefined> {
    const settings = await this.options.repository.getSettings()
    const configuration = settings.visionModel
    if (!configuration) return undefined
    const provider = settings.providers.find((entry) => entry.id === configuration.providerId)
    if (!provider || providerValidationFailed(provider)) {
      throw new Error('The configured Vision model provider is unavailable.')
    }
    const { frameworkId } = await this.options.backendResolver.captureConfiguredSelection()
    const framework = getAgentFramework(frameworkId)
    const target = this.options.providers.resolveRuntimeTarget(
      provider,
      { kind: 'required', model: configuration.model },
      framework
    )
    if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
      throw new Error('The configured Vision model provider is unavailable.')
    }
    if (
      !target.frameworkCompatible ||
      (framework.id === 'codex' && !target.modelBridgeSupported) ||
      target.provider.supportsImageInput !== true
    ) {
      throw new Error('The configured Vision model is unavailable for image input.')
    }
    return Object.freeze({
      frameworkId,
      providerId: configuration.providerId,
      model: Object.freeze({ kind: 'required' as const, id: configuration.model }),
      reasoningEffort: configuration.reasoningEffort,
      configurationFingerprint: providerConfigurationFingerprint(provider)
    })
  }
}

const createVisionModels = (
  repository: SettingsRepository,
  providers: ProviderAccountsModule,
  backendResolver: AgentBackendResolver
): VisionModelOwner => new VisionModelOwner({ repository, providers, backendResolver })

export { createVisionModels, VisionModelOwner }
export type { VisionModelOwnerOptions }
