import { normalizeMessagesRootUrl, resolveChatCompletionsBaseUrl } from '@aipoch/providers/protocol'
import { resolveResponsesBaseUrl } from '../agent-framework/codex'
import type { ProviderAccountsModule, ProviderRuntimeTarget } from './provider-accounts'
import type { SettingsRepository } from './repository'
import type { ProviderFailureObservation } from './provider-failure-observation'

const endpointBase = (
  provider: ProviderRuntimeTarget['provider'],
  endpoint: ProviderFailureObservation['endpoint']
): string | undefined => {
  if (endpoint === 'messages') return normalizeMessagesRootUrl(provider.baseUrl ?? '')
  return endpoint === 'responses'
    ? resolveResponsesBaseUrl(provider)
    : resolveChatCompletionsBaseUrl(provider)
}

export class ProviderRuntimeHealthOwner {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly providers: Pick<ProviderAccountsModule, 'resolveProvider'>,
    private readonly onChanged?: () => Promise<void>
  ) {}
  async observe(target: ProviderRuntimeTarget, failure: ProviderFailureObservation): Promise<void> {
    const applied = await this.repository.updateProviderValidationIfTargetMatches(
      target.providerId,
      (current, _settings, firstCompatibleRevision) => {
        if (
          current.type !== target.providerType ||
          target.configRevision === undefined ||
          target.configRevision < firstCompatibleRevision ||
          target.configRevision > (current.configRevision ?? 0) ||
          // A model-specific failure cannot restore an account already known to be unusable.
          (failure.category === 'model-not-found' &&
            current.lastValidationFailure?.category === 'auth' &&
            !current.lastValidationFailure.target)
        )
          return false

        const provider = this.providers.resolveProvider(
          current,
          failure.model ?? target.effectiveModel
        )
        const { endpoint } = failure
        const url = endpointBase(target.provider, endpoint)
        return (
          provider.key === target.provider.key &&
          (!current.modelCatalog || provider.apiEndpoints?.includes(endpoint) === true) &&
          Boolean(url) &&
          url === endpointBase(provider, endpoint)
        )
      },
      { ok: false, category: failure.category, status: failure.status },
      failure.category === 'auth'
        ? undefined
        : { model: failure.model, endpoint: failure.endpoint },
      failure.startedAt
    )
    if (applied) await this.onChanged?.()
  }
}
