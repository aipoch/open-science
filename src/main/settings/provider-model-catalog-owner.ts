import type {
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult
} from '../../shared/settings'
import { isXaiSubscriptionProvider } from '../../shared/settings'
import { resolveVendorModelsUrl } from '../../shared/provider-registry'
import { netFetchStandard } from '../skills/net-fetch'
import { listProviderModels } from './list-models'
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
    const modelsUrl =
      stored.type === 'official' && stored.vendorId
        ? resolveVendorModelsUrl(stored.vendorId, stored.region)
        : isXaiSubscriptionProvider(stored.type)
          ? 'https://api.x.ai/v1/models'
          : undefined
    if (!modelsUrl) {
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
    const result = await listProviderModels(
      {
        url: modelsUrl,
        key,
        ...(stored.type === 'official' && stored.vendorId ? { vendorId: stored.vendorId } : {})
      },
      { fetchImpl: netFetchStandard }
    )
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
