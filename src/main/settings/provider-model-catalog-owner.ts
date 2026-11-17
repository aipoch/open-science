import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '@aipoch/diagnostics/node'
import { resolveVendorModelCatalog, type CatalogSnapshot, type CatalogStatus } from '@aipoch/providers'
import { createProvider } from '@aipoch/providers/client'
import type { ProviderDraft, RefreshProviderModelsRequest, RefreshProviderModelsResult } from '../../shared/settings'
import { isXaiSubscriptionProvider } from '../../shared/settings-runtime'
import { netFetchStandard } from '../network-fetch'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import { decodeCatalogParameters } from './model-catalog-codec'
import type { ResolvedProvider } from './provider-env'
import type { SettingsRepository } from './repository'
import type { XaiAccessCredential } from './xai-oauth'
import type { StoredProvider } from './types'

const log = createLogger('settings.model-catalog')
type DraftCatalog = { fingerprint: string; expiresAt: number; catalog: CatalogSnapshot; catalogStatus: CatalogStatus }
export class ProviderModelCatalogOwner {
  private readonly drafts = new Map<string, DraftCatalog>()
  private sequence = 0
  private readonly generations = new Map<string, number>()
  constructor(
    private readonly repository: SettingsRepository,
    private readonly resolveProvider: (provider: StoredProvider) => ResolvedProvider,
    private readonly getXaiAccessCredential: () => Promise<XaiAccessCredential>
  ) {}

  private fingerprint(provider: Pick<StoredProvider, 'vendorId' | 'region' | 'catalogParameters'>, key: string | undefined, id?: string, revision?: number): string {
    return createHash('sha256').update(JSON.stringify([id, revision ?? 0, provider.vendorId, provider.region, Object.entries(provider.catalogParameters ?? {}).sort(), key ?? ''])).digest('hex')
  }

  /** A renderer token grants access only to a main-owned snapshot of the exact refreshed draft. */
  applyDraft(token: string | undefined, provider: StoredProvider, existing: StoredProvider | undefined): void {
    if (!token) return
    const result = this.drafts.get(token)
    if (!result || result.expiresAt < Date.now() || result.fingerprint !== this.fingerprint(provider, this.resolveProvider(provider).key, existing?.id, existing?.configRevision)) {
      throw new Error('The provider changed while loading models. Try again.')
    }
    provider.modelCatalog = result.catalog
    provider.modelCatalogStatus = result.catalogStatus
    provider.fetchedModels = result.catalog.models.map((model) => model.id)
  }

  async refresh(request: RefreshProviderModelsRequest): Promise<RefreshProviderModelsResult> {
    const start = Date.now()
    const stored = request.providerId ? (await this.repository.getSettings()).providers.find((p) => p.id === request.providerId) : undefined
    if (request.providerId && !stored) return { ok: false, category: 'unknown', code: 'stale', message: 'Provider not found.' }
    if (request.expectedConfigRevision !== undefined && request.expectedConfigRevision !== (stored?.configRevision ?? 0)) return { ok: false, category: 'unknown', code: 'stale' }
    const draft: ProviderDraft | undefined = request.draft
    if (draft && draft.type !== 'official') return { ok: false, category: 'unknown', code: 'unsupported' }
    const target = draft ? { ...stored, id: stored?.id ?? '', name: draft.name ?? '', type: draft.type, vendorId: draft.vendorId, region: draft.region, catalogParameters: decodeCatalogParameters(draft.catalogParameters) } as StoredProvider : stored
    if (!target) return { ok: false, category: 'unknown', code: 'unsupported' }
    if (draft?.catalogParameters && !target.catalogParameters) return { ok: false, category: 'unknown', code: 'missing-parameter' }
    const subscription = isXaiSubscriptionProvider(target.type)
    const providerId = target.type === 'official' ? target.vendorId : subscription ? 'xai' : undefined
    if (!providerId || (!subscription && !resolveVendorModelCatalog(providerId, target.region))) return { ok: false, category: 'unknown', code: 'unsupported' }
    const sameSavedTarget = stored?.type === target.type && stored.vendorId === target.vendorId && stored.region === target.region
    let key = draft?.key || (stored && sameSavedTarget ? this.resolveProvider(stored).key : undefined)
    let expectedProvider = target
    if (subscription) {
      try {
        const credential = await this.getXaiAccessCredential()
        key = credential.token
        expectedProvider = { ...target, keyRef: credential.keyRef }
      } catch { return { ok: false, category: 'auth', code: 'authentication' } }
    }
    const identity = request.providerId ?? this.fingerprint(target, key)
    const generation = ++this.sequence
    this.generations.set(identity, generation)
    log.info('Refreshing model catalog', { providerId: request.providerId, vendor: providerId, region: target.region, draft: Boolean(draft) })
    const result = await createProvider({ id: providerId, region: target.region, fetch: netFetchStandard, key,
      discovery: { ...(subscription ? { url: 'https://api.x.ai/v1/models' } : {}), parameters: target.catalogParameters }
    }).listModels({ limits: PROVIDER_RESOURCE_LIMITS })
    if (this.generations.get(identity) !== generation) return { ok: false, category: 'unknown', code: 'stale' }
    this.generations.delete(identity)
    const catalogStatus: CatalogStatus = { attemptedAt: Date.now(), ok: result.ok, code: result.code, status: result.status }
    log.info('Model catalog refresh completed', { vendor: providerId, phase: 'catalog', elapsedMs: Date.now() - start, ok: result.ok, code: result.code, status: result.status, count: result.models?.length ?? 0 })
    if (!result.ok || !result.models) {
      if (!draft) await this.repository.updateProviderModelCatalogIfTargetMatches(expectedProvider, undefined, { modelCatalogStatus: catalogStatus })
      const previousDraft = draft?.catalogDraftToken ? this.drafts.get(draft.catalogDraftToken) : undefined
      if (previousDraft && previousDraft.fingerprint === this.fingerprint(target, key, stored?.id, stored?.configRevision)) previousDraft.catalogStatus = catalogStatus
      return { ok: false, category: result.code === 'authentication' || result.code === 'permission' || result.code === 'missing-key' ? 'auth' : result.code === 'network' || result.code === 'timeout' ? 'network' : 'unknown', code: result.code, message: result.message, catalogStatus }
    }
    const models = subscription ? result.models.filter((m) => m.startsWith('grok-')) : result.models
    if (!models.length) return { ok: false, category: 'unknown', code: 'invalid-response' }
    const catalog: CatalogSnapshot = { fetchedAt: Date.now(), models: (result.catalog ?? models.map((id) => ({ id }))).filter((m) => models.includes(m.id)) }
    if (draft) {
      for (const [token, value] of this.drafts) if (value.expiresAt < Date.now()) this.drafts.delete(token)
      if (this.drafts.size >= 32) this.drafts.delete(this.drafts.keys().next().value!)
      const draftToken = randomUUID()
      this.drafts.set(draftToken, { fingerprint: this.fingerprint(target, key, stored?.id, stored?.configRevision), expiresAt: Date.now() + 15 * 60_000, catalog, catalogStatus })
      return { ok: true, category: 'ok', models, catalog, catalogStatus, draftToken }
    }
    const applied = await this.repository.updateProviderModelCatalogIfTargetMatches(expectedProvider, models, { modelCatalog: catalog, modelCatalogStatus: catalogStatus })
    return applied ? { ok: true, category: 'ok', models, catalog, catalogStatus } : { ok: false, category: 'unknown', code: 'stale' }
  }
}
