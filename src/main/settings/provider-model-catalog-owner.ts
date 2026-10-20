import type {
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult
} from '../../shared/settings'
import { isXaiSubscriptionProvider } from '../../shared/settings'
import { netFetchStandard } from '../network-fetch'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import { createProvider } from '@aipoch/providers/client'
import type { ResolvedProvider } from './provider-env'
import type { SettingsRepository } from './repository'
import type { XaiAccessCredential } from './xai-oauth'
import type { StoredProvider } from './types'
import { classifyStatus } from './validate'

export class ProviderModelCatalogOwner {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly resolveProvider: (provider: StoredProvider) => ResolvedProvider,
    private readonly getXaiAccessCredential: () => Promise<XaiAccessCredential>
  ) {}

  async refresh(request: RefreshProviderModelsRequest): Promise<RefreshProviderModelsResult> {
    const stored = (await this.repository.getSettings()).providers.find(
      (provider) => provider.id === request.providerId
    )
    if (!stored) return { ok: false, category: 'unknown', message: 'Provider not found.' }
    // Account eligibility and OAuth remain host policy; endpoint/auth dialect belong to the SDK.
    const providerId =
      stored.type === 'official'
        ? stored.vendorId
        : isXaiSubscriptionProvider(stored.type)
          ? 'xai'
          : undefined
    const connection = {
      id: providerId ?? 'custom',
      region: stored.region,
      fetch: netFetchStandard
    }
    // The API-key xAI chat picker uses curated suggestions; OAuth refresh filters grok IDs below.
    if (
      !providerId ||
      (stored.type === 'official' && providerId === 'xai') ||
      !createProvider(connection).supportsModelDiscovery
    ) {
      return {
        ok: false,
        category: 'unknown',
        message: 'This provider has no model-list endpoint.'
      }
    }
    let expectedProvider = stored
    let key = this.resolveProvider(stored).key
    if (isXaiSubscriptionProvider(stored.type)) {
      try {
        const credential = await this.getXaiAccessCredential()
        key = credential.token
        // This reference comes from the token's own save, never an unrelated later read.
        expectedProvider = { ...stored, keyRef: credential.keyRef }
      } catch (error) {
        return {
          ok: false,
          category: 'auth',
          message: error instanceof Error ? error.message : 'xAI sign-in is unavailable.'
        }
      }
    }
    const result = await createProvider({ ...connection, key }).listModels({
      limits: PROVIDER_RESOURCE_LIMITS
    })
    if (!result.ok || !result.models) {
      return {
        ok: false,
        category: result.status ? classifyStatus(result.status) : 'network',
        message: result.message
      }
    }
    const models = isXaiSubscriptionProvider(stored.type)
      ? result.models.filter((model) => model.startsWith('grok-'))
      : result.models
    const applied = await this.repository.updateProviderModelCatalogIfTargetMatches(
      expectedProvider,
      models
    )
    if (!applied) {
      return {
        ok: false,
        category: 'unknown',
        message: 'The provider changed while loading models. Try again.'
      }
    }
    return { ok: true, category: 'ok', models }
  }
}
