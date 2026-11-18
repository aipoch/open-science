import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  resolveVendorModelCatalog,
  type CatalogSnapshot,
  type CatalogStatus
} from '@aipoch/providers'
import { createProvider } from '@aipoch/providers/client'
import type {
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult
} from '../../shared/settings'
import { isXaiSubscriptionProvider } from '../../shared/settings-runtime'
import { netFetchStandard } from '../network-fetch'
import { assertProviderDraftLimits, PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import {
  decodeCatalogParameters,
  decodeModelCatalog,
  providerCatalogState,
  type ProviderCatalogState
} from '../../shared/provider-model-catalog-codec'
import type { ResolvedProvider } from './provider-env'
import type { SettingsRepository } from './repository'
import type { XaiAccessCredential } from './xai-oauth'
import type { StoredProvider } from './types'

const log = createLogger('settings.model-catalog')
type DraftCatalog = {
  baseline?: ProviderCatalogState
  fingerprint: string
  expiresAt: number
  catalog: CatalogSnapshot
  catalogStatus: CatalogStatus
}
export class ProviderModelCatalogOwner {
  private readonly drafts = new Map<string, DraftCatalog>()
  private sequence = 0
  private readonly generations = new Map<string, number>()
  constructor(
    private readonly repository: SettingsRepository,
    private readonly resolveProvider: (provider: StoredProvider) => ResolvedProvider,
    private readonly getXaiAccessCredential: () => Promise<XaiAccessCredential>
  ) {}

  private fingerprint(
    provider: Pick<StoredProvider, 'vendorId' | 'region' | 'catalogParameters'>,
    key: string | undefined,
    id?: string,
    revision?: number
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          id,
          revision ?? 0,
          provider.vendorId,
          provider.region,
          Object.entries(provider.catalogParameters ?? {}).sort(),
          key ?? ''
        ])
      )
      .digest('hex')
  }

  /** A renderer token grants access only to a main-owned snapshot of the exact refreshed draft. */
  applyDraft(
    token: string | undefined,
    provider: StoredProvider,
    existing: StoredProvider | undefined
  ): ProviderCatalogState | undefined {
    if (!token) return
    const result = this.drafts.get(token)
    if (
      !result ||
      result.expiresAt < Date.now() ||
      result.fingerprint !==
        this.fingerprint(
          provider,
          this.resolveProvider(provider).key,
          existing?.id,
          existing?.configRevision
        )
    ) {
      throw new Error('The provider changed while loading models. Try again.')
    }
    provider.modelCatalog = result.catalog
    provider.modelCatalogStatus = result.catalogStatus
    provider.fetchedModels = result.catalog.models.map((model) => model.id)
    return result.baseline
  }

  async refresh(request: RefreshProviderModelsRequest): Promise<RefreshProviderModelsResult> {
    const start = Date.now()
    const draft = request.draft
    if (draft) {
      try {
        assertProviderDraftLimits(draft)
      } catch {
        return { ok: false, category: 'unknown', code: 'resource-limit' }
      }
    }
    const stored = request.providerId
      ? (await this.repository.getSettings()).providers.find((p) => p.id === request.providerId)
      : undefined
    if (request.providerId && !stored)
      return { ok: false, category: 'unknown', code: 'stale', message: 'Provider not found.' }
    if (
      request.expectedConfigRevision !== undefined &&
      request.expectedConfigRevision !== (stored?.configRevision ?? 0)
    )
      return { ok: false, category: 'unknown', code: 'stale' }
    if (draft && draft.type !== 'official')
      return { ok: false, category: 'unknown', code: 'unsupported' }
    const target = draft
      ? ({
          ...stored,
          id: stored?.id ?? '',
          name: draft.name ?? '',
          type: draft.type,
          vendorId: draft.vendorId,
          region: draft.region,
          catalogParameters: decodeCatalogParameters(draft.catalogParameters)
        } as StoredProvider)
      : stored
    if (!target) return { ok: false, category: 'unknown', code: 'unsupported' }
    if (draft?.catalogParameters && !target.catalogParameters)
      return { ok: false, category: 'unknown', code: 'missing-parameter' }
    const subscription = isXaiSubscriptionProvider(target.type)
    const providerId =
      target.type === 'official' ? target.vendorId : subscription ? 'xai' : undefined
    if (!providerId || (!subscription && !resolveVendorModelCatalog(providerId, target.region)))
      return { ok: false, category: 'unknown', code: 'unsupported' }
    const sameSavedTarget =
      stored?.type === target.type &&
      stored.vendorId === target.vendorId &&
      stored.region === target.region
    const savedKey = stored && sameSavedTarget ? this.resolveProvider(stored).key : undefined
    let key = draft?.key || savedKey
    let expectedProvider = target
    if (subscription) {
      try {
        const credential = await this.getXaiAccessCredential()
        key = credential.token
        expectedProvider = { ...target, keyRef: credential.keyRef }
      } catch {
        return { ok: false, category: 'auth', code: 'authentication' }
      }
    }
    const draftFingerprint = draft
      ? this.fingerprint(target, key, stored?.id, stored?.configRevision)
      : undefined
    const identity = draftFingerprint ? `draft:${draftFingerprint}` : `saved:${target.id}`
    const generation = ++this.sequence
    this.generations.set(identity, generation)
    log.info('Refreshing model catalog', {
      providerId: request.providerId,
      vendor: providerId,
      region: target.region,
      draft: Boolean(draft)
    })
    const result = await createProvider({
      id: providerId,
      region: target.region,
      fetch: netFetchStandard,
      key,
      discovery: {
        ...(subscription ? { url: 'https://api.x.ai/v1/models' } : {}),
        parameters: target.catalogParameters
      }
    }).listModels({ limits: PROVIDER_RESOURCE_LIMITS })
    if (this.generations.get(identity) !== generation)
      return { ok: false, category: 'unknown', code: 'stale' }
    this.generations.delete(identity)
    const entries = result.catalog ?? result.models?.map((id) => ({ id }))
    const attemptedAt = Date.now()
    const catalog = result.ok
      ? decodeModelCatalog({
          fetchedAt: attemptedAt,
          models: subscription ? entries?.filter(({ id }) => id.startsWith('grok-')) : entries
        })
      : undefined
    const code = result.ok && !catalog ? 'invalid-response' : result.code
    const catalogStatus: CatalogStatus = {
      attemptedAt,
      ok: Boolean(catalog),
      code,
      status: result.status
    }
    log.info('Model catalog refresh completed', {
      vendor: providerId,
      phase: 'catalog',
      elapsedMs: Date.now() - start,
      ok: catalogStatus.ok,
      code,
      status: result.status,
      count: catalog?.models.length ?? 0
    })
    if (!catalog) {
      if (!draft) {
        const applied = await this.repository.updateProviderModelCatalogIfTargetMatches(
          expectedProvider,
          undefined,
          { modelCatalogStatus: catalogStatus }
        )
        if (!applied) return { ok: false, category: 'unknown', code: 'stale' }
      }
      const previousDraft = draft?.catalogDraftToken
        ? this.drafts.get(draft.catalogDraftToken)
        : undefined
      if (previousDraft && previousDraft.fingerprint === draftFingerprint)
        previousDraft.catalogStatus = catalogStatus
      return {
        ok: false,
        category:
          code === 'authentication' || code === 'permission' || code === 'missing-key'
            ? 'auth'
            : code === 'network' || code === 'timeout'
              ? 'network'
              : 'unknown',
        code,
        message: result.message,
        catalogStatus
      }
    }
    const models = catalog.models.map(({ id }) => id)
    if (draftFingerprint) {
      for (const [token, value] of this.drafts)
        if (value.expiresAt < Date.now()) this.drafts.delete(token)
      if (this.drafts.size >= 32) this.drafts.delete(this.drafts.keys().next().value!)
      const draftToken = randomUUID()
      this.drafts.set(draftToken, {
        baseline:
          stored &&
          sameSavedTarget &&
          draftFingerprint === this.fingerprint(stored, savedKey, stored.id, stored.configRevision)
            ? providerCatalogState(stored)
            : undefined,
        fingerprint: draftFingerprint,
        expiresAt: Date.now() + 15 * 60_000,
        catalog,
        catalogStatus
      })
      return { ok: true, category: 'ok', models, catalog, catalogStatus, draftToken }
    }
    const applied = await this.repository.updateProviderModelCatalogIfTargetMatches(
      expectedProvider,
      models,
      { modelCatalog: catalog, modelCatalogStatus: catalogStatus }
    )
    return applied
      ? { ok: true, category: 'ok', models, catalog, catalogStatus }
      : { ok: false, category: 'unknown', code: 'stale' }
  }
}
