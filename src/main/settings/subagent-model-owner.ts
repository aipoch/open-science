import { providerValidationFailed, type SubagentModelConfiguration } from '../../shared/settings'
import type { ResolvedSubagentModelSnapshot } from '../../shared/session-persistence'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import { createDelegateExecutionBackendLease } from '../delegation/execution-backend-lease'
import type { DelegatedExecutionModelAdmission } from '../delegation/execution-port'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  releaseResolvedAgentBackendLeases,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import type { AgentBackendResolutionContext, AgentBackendResolver } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import { providerRuntimeValidationTarget } from './provider-validation-state'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'

type InheritedSubagentModel = Readonly<{
  providerId?: string
  backendId?: string
  modelRoute?: ResolvedSubagentModelSnapshot['modelRoute']
  model?: string
  reasoningEffort?: Exclude<ResolvedReasoningEffort, 'default'>
}>

type SubagentModelOwnerOptions = {
  repository: SettingsRepository
  providers: ProviderAccountsModule
  backendResolver: AgentBackendResolver
}

// Owns validation, immutable admission snapshots, and backend leases for delegated execution. The
// settings facade only forwards this cohesive workflow and never retains a live delegated backend.
class SubagentModelOwner {
  constructor(private readonly options: SubagentModelOwnerOptions) {}

  async set(configuration: SubagentModelConfiguration): Promise<void> {
    await this.options.repository.setSubagentModel(configuration, (settings, candidate) =>
      this.validate(settings, candidate)
    )
  }

  validate(
    settings: StoredSettings,
    candidate: SubagentModelConfiguration,
    frameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
  ): SubagentModelConfiguration {
    if (candidate.mode === 'inherit') return candidate
    const provider = settings.providers.find((entry) => entry.id === candidate.providerId)
    const validationFailed = provider ? providerValidationFailed(provider) : false
    if (!provider || validationFailed) {
      throw new Error(
        'The selected Subagent model is no longer available. Refresh the model catalog.'
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
        'The selected Subagent model is no longer available. Refresh the model catalog.'
      )
    }
    if (!target.frameworkCompatible || (framework.id === 'codex' && !target.modelBridgeSupported)) {
      throw new Error(
        'The selected Subagent model is not available for the active Agent Framework. Refresh the model catalog.'
      )
    }
    return target.reasoningEffortProfile.supported
      ? candidate
      : { ...candidate, reasoningEffort: 'default' }
  }

  async admit(
    frameworkId: AgentFrameworkId,
    inherited: InheritedSubagentModel
  ): Promise<DelegatedExecutionModelAdmission> {
    const settings = await this.options.repository.getSettings()
    const configuration = settings.subagentModel ?? { mode: 'inherit' as const }
    if (configuration.mode === 'inherit') {
      const prefix = `${frameworkId}:`
      const providerId =
        inherited.providerId ??
        (inherited.backendId?.startsWith(prefix)
          ? inherited.backendId.slice(prefix.length)
          : undefined)
      if (!providerId || !inherited.backendId || !inherited.modelRoute || !inherited.model) {
        throw new Error('The originating Session has no complete Main Agent runtime model.')
      }
      const snapshot = Object.freeze({
        frameworkId,
        providerId,
        backendId: inherited.backendId,
        modelRoute: inherited.modelRoute,
        model: inherited.model,
        reasoningEffort: inherited.reasoningEffort ?? 'default'
      })
      const backend = await this.resolveAdmittedBackend(snapshot)
      return Object.freeze({
        snapshot,
        backendLease: createDelegateExecutionBackendLease(backend)
      })
    }

    const provider = settings.providers.find(
      (candidate) => candidate.id === configuration.providerId
    )
    const validationFailed = provider ? providerValidationFailed(provider) : false
    if (validationFailed) {
      throw new Error('The configured Subagent model provider validation failed.')
    }
    if (provider) {
      const framework = getAgentFramework(frameworkId)
      const target = this.options.providers.resolveRuntimeTarget(
        provider,
        { kind: 'required', model: configuration.model },
        framework
      )
      if (providerValidationFailed(provider, providerRuntimeValidationTarget(target, framework))) {
        throw new Error('The configured Subagent model provider validation failed.')
      }
    }

    const backend = await this.options.backendResolver.resolveExplicitTarget({
      frameworkId,
      providerId: configuration.providerId,
      model: { kind: 'required', id: configuration.model },
      reasoningEffort: configuration.reasoningEffort
    })
    try {
      if (!backend.backendId || !backend.modelRoute) {
        throw new Error('The configured Subagent model has no stable runtime route.')
      }
      const snapshot = Object.freeze({
        frameworkId,
        providerId: configuration.providerId,
        backendId: backend.backendId,
        modelRoute: backend.modelRoute,
        model: configuration.model,
        reasoningEffort: backend.sessionEffort ?? 'default'
      })
      return Object.freeze({
        snapshot,
        backendLease: createDelegateExecutionBackendLease(backend)
      })
    } catch (error) {
      await releaseResolvedAgentBackendLeases(backend)
      throw error
    }
  }

  async resolve(
    frameworkId: AgentFrameworkId,
    inherited: InheritedSubagentModel
  ): Promise<ResolvedSubagentModelSnapshot> {
    const admission = await this.admit(frameworkId, inherited)
    await admission.backendLease?.release()
    return admission.snapshot
  }

  resolveAdmittedBackend(
    snapshot: ResolvedSubagentModelSnapshot,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.options.backendResolver.resolveAdmittedTarget(
      {
        frameworkId: snapshot.frameworkId,
        providerId: snapshot.providerId,
        model: { kind: 'required', id: snapshot.model },
        reasoningEffort: 'default',
        resolvedReasoningEffort: snapshot.reasoningEffort,
        expectedBackendId: snapshot.backendId,
        expectedModelRoute: snapshot.modelRoute
      },
      context
    )
  }
}

const createSubagentModels = (
  repository: SettingsRepository,
  providers: ProviderAccountsModule,
  backendResolver: AgentBackendResolver
): SubagentModelOwner => new SubagentModelOwner({ repository, providers, backendResolver })

export { createSubagentModels, SubagentModelOwner }
export type { InheritedSubagentModel, SubagentModelOwnerOptions }
