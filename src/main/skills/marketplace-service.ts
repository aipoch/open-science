import { z } from 'zod'
import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceCatalogRequest,
  SkillMarketplaceDetail,
  SkillMarketplaceDetailRequest,
  SkillMarketplaceBatchRequest,
  SkillMarketplaceResult
} from '../../shared/skill-marketplace'
import { netFetchWithManualRedirect } from './net-fetch'
import { createLogger } from '../logger'
import {
  marketplaceReceiptSchema,
  verifyMarketplacePackage,
  type MarketplacePackage
} from './marketplace-package'
import {
  toMarketplaceEntry,
  verifyMarketplaceDetail,
  verifyMarketplaceIndex,
  verifyMarketplaceRoot,
  type MarketplaceRoot
} from './marketplace-protocol'
import { sha256 } from './marketplace-protocol'

const REPOSITORY = 'aipoch/openscience-skill-marketplace'
const CATALOG_TTL_MS = 5 * 60 * 1000
const DETAIL_CACHE_LIMIT = 128
const catalogRequest = z
  .strictObject({
    forceRefresh: z.boolean().optional(),
    snapshotId: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional()
  })
  .refine((value) => !value.snapshotId || value.forceRefresh === undefined)
const detailRequest = z.strictObject({
  snapshotId: z.string().regex(/^[a-f0-9]{40}$/),
  id: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})
class NetworkError extends Error {}

// Owns remote verification; package writes remain in the existing UserSkillRepository transaction.
export class SkillMarketplaceService {
  private readonly snapshots = new Map<string, MarketplaceRoot>()
  private readonly retainedSnapshots = new Map<string, number>()
  private pending?: Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>>
  private current?: { catalog: SkillMarketplaceCatalog; checkedAt: number }
  private readonly details = new Map<string, SkillMarketplaceDetail>()
  private readonly pendingDetails = new Map<
    string,
    Promise<SkillMarketplaceResult<SkillMarketplaceDetail>>
  >()

  constructor(private readonly fetch: typeof globalThis.fetch = netFetchWithManualRedirect) {}

  retainSnapshot(request: SkillMarketplaceBatchRequest): (() => void) | undefined {
    const root = this.snapshots.get(request.snapshotId)
    if (!root) return
    const versions = new Map(root.skills.map(({ id, version }) => [id, version]))
    if (request.items.some(({ id, version }) => versions.get(id) !== version)) return
    const { snapshotId } = request
    this.retainedSnapshots.set(snapshotId, (this.retainedSnapshots.get(snapshotId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.retainedSnapshots.get(snapshotId) ?? 1) - 1
      if (count) this.retainedSnapshots.set(snapshotId, count)
      else this.retainedSnapshots.delete(snapshotId)
      this.pruneSnapshots()
    }
  }

  private pruneSnapshots(): void {
    for (const id of this.snapshots.keys()) {
      if (this.snapshots.size <= 4) break
      if (!this.retainedSnapshots.has(id)) {
        this.snapshots.delete(id)
        for (const key of this.details.keys())
          if (key.startsWith(`${id}/`)) this.details.delete(key)
      }
    }
  }

  private async read(
    url: string,
    limit: number,
    signal = AbortSignal.timeout(15000),
    artifact = false
  ): Promise<Uint8Array> {
    try {
      let response = await this.fetch(url, {
        signal,
        credentials: 'omit',
        redirect: artifact ? 'manual' : 'error',
        headers: { Accept: artifact ? 'application/octet-stream' : 'application/json' }
      })
      // GitHub Release downloads redirect to its asset host. Never forward credentials or follow
      // publisher-controlled hosts, local addresses, or a redirect chain beyond this single hop.
      if (artifact && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = new URL(response.headers.get('location') ?? '', url)
        await response.body?.cancel()
        if (
          location.protocol !== 'https:' ||
          location.hostname !== 'release-assets.githubusercontent.com' ||
          location.port ||
          location.username ||
          location.password
        )
          throw new NetworkError('Invalid asset redirect')
        response = await this.fetch(location.href, {
          signal,
          redirect: 'error',
          credentials: 'omit'
        })
      }
      if (!response.ok || !response.body) throw new NetworkError('Metadata unavailable')
      const reader = response.body.getReader()
      let done = false
      try {
        if (Number(response.headers.get('content-length')) > limit)
          throw new Error('Metadata exceeds limit')
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const next = await reader.read()
          if (next.done) {
            done = true
            break
          }
          size += next.value.byteLength
          if (size > limit) throw new Error('Metadata exceeds limit')
          chunks.push(next.value)
        }
        return Buffer.concat(chunks, size)
      } finally {
        if (!done) await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Metadata exceeds limit') throw error
      createLogger('skill-marketplace').warn('Marketplace request failed', {
        origin: new URL(url).origin,
        reason: error instanceof Error ? error.message : 'Unknown network failure'
      })
      throw new NetworkError('Metadata request failed')
    }
  }

  private rawUrl(commit: string, path: string): string {
    return `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  list(
    request?: SkillMarketplaceCatalogRequest
  ): Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>> {
    const parsed = catalogRequest.safeParse(request ?? {})
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'integrity' })
    if (parsed.data.snapshotId) {
      const root = this.snapshots.get(parsed.data.snapshotId)
      return Promise.resolve(
        root
          ? {
              ok: true,
              value: {
                snapshotId: parsed.data.snapshotId,
                revision: root.revision,
                entries: root.skills.map(toMarketplaceEntry)
              }
            }
          : { ok: false, error: 'snapshot-unavailable' }
      )
    }
    if (!parsed.data.forceRefresh && this.current) {
      return Promise.resolve({
        ok: true,
        value: {
          ...structuredClone(this.current.catalog),
          revalidate: Date.now() - this.current.checkedAt >= CATALOG_TTL_MS
        }
      })
    }
    // Only remote discovery is coalesced; local installation state is projected by Settings.
    if (!this.pending) {
      this.pending = this.load().finally(() => {
        this.pending = undefined
      })
    }
    return this.pending
  }

  private async load(): Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>> {
    try {
      // One deadline covers discovery and streamed bodies, below the Web RPC's 30s deadline.
      const signal = AbortSignal.timeout(25000)
      const refBytes = await this.read(
        `https://api.github.com/repos/${REPOSITORY}/git/ref/heads/published`,
        16384,
        signal
      )
      const ref = z
        .object({
          object: z.object({ type: z.literal('commit'), sha: z.string().regex(/^[a-f0-9]{40}$/) })
        })
        .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(refBytes)))
      const commit = ref.object.sha
      const previous = this.snapshots.get(commit)
      if (previous) return this.remember(commit, previous)
      const [bytes, signature] = await Promise.all([
        this.read(this.rawUrl(commit, 'marketplace.json'), 4 * 1024 * 1024, signal),
        this.read(this.rawUrl(commit, 'marketplace.json.sig'), 4096, signal)
      ])
      const root = verifyMarketplaceRoot(bytes, signature)
      verifyMarketplaceIndex(
        await this.read(this.rawUrl(commit, root.release_index.path), 8 * 1024 * 1024, signal),
        root
      )
      return this.remember(commit, root)
    } catch (error) {
      this.current = undefined
      return { ok: false, error: error instanceof NetworkError ? 'network' : 'integrity' }
    }
  }

  private remember(
    snapshotId: string,
    root: MarketplaceRoot
  ): SkillMarketplaceResult<SkillMarketplaceCatalog> {
    this.snapshots.delete(snapshotId)
    this.snapshots.set(snapshotId, root)
    // Bounded, memory-only history lets an open detail survive a catalog refresh.
    this.pruneSnapshots()
    const catalog = {
      snapshotId,
      revision: root.revision,
      entries: root.skills.map(toMarketplaceEntry)
    }
    this.current = { catalog, checkedAt: Date.now() }
    return { ok: true, value: structuredClone(catalog) }
  }

  async detail(
    request: SkillMarketplaceDetailRequest
  ): Promise<SkillMarketplaceResult<SkillMarketplaceDetail>> {
    const parsed = detailRequest.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'snapshot-unavailable' }
    const { snapshotId, id } = parsed.data
    const listing = this.snapshots.get(snapshotId)?.skills.find((entry) => entry.id === id)
    if (!listing) return { ok: false, error: 'snapshot-unavailable' }
    const key = `${snapshotId}/${id}`
    const cached = this.details.get(key)
    if (cached) {
      this.details.delete(key)
      this.details.set(key, cached)
      return { ok: true, value: structuredClone(cached) }
    }
    let pending = this.pendingDetails.get(key)
    if (!pending) {
      pending = this.loadDetail(snapshotId, listing).finally(() => this.pendingDetails.delete(key))
      this.pendingDetails.set(key, pending)
    }
    return structuredClone(await pending)
  }

  private async loadDetail(
    snapshotId: string,
    listing: MarketplaceRoot['skills'][number]
  ): Promise<SkillMarketplaceResult<SkillMarketplaceDetail>> {
    try {
      const bytes = await this.read(this.rawUrl(snapshotId, listing.release.path), 1024 * 1024)
      const value = verifyMarketplaceDetail(bytes, listing)
      if (this.snapshots.has(snapshotId)) {
        this.details.set(`${snapshotId}/${listing.id}`, value)
        while (this.details.size > DETAIL_CACHE_LIMIT)
          this.details.delete(this.details.keys().next().value!)
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: error instanceof NetworkError ? 'network' : 'integrity' }
    }
  }

  async download(
    request: SkillMarketplaceDetailRequest
  ): Promise<SkillMarketplaceResult<MarketplacePackage>> {
    const parsed = detailRequest.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'snapshot-unavailable' }
    const { snapshotId, id } = parsed.data
    const root = this.snapshots.get(snapshotId)
    const listing = root?.skills.find((entry) => entry.id === id)
    if (!root || !listing) return { ok: false, error: 'snapshot-unavailable' }
    try {
      const signal = AbortSignal.timeout(25000)
      const descriptor = verifyMarketplaceDetail(
        await this.read(this.rawUrl(snapshotId, listing.release.path), 1024 * 1024, signal),
        listing
      )
      const receipt = marketplaceReceiptSchema.omit({ installedContentSha256: true }).parse({
        marketplace: 'openscience-skills',
        id,
        version: listing.version,
        snapshotId,
        revision: root.revision,
        descriptorSha256: listing.release.sha256,
        artifactSha256: listing.artifact.sha256,
        contentSha256: listing.content_sha256
      })
      const assetName = `${sha256(Buffer.from(listing.artifact.path))}.zip`
      const bytes = await this.read(
        `https://github.com/${REPOSITORY}/releases/download/catalog-${root.revision}/${assetName}`,
        Math.min(listing.artifact.bytes, 64 * 1024 * 1024),
        signal,
        true
      )
      return {
        ok: true,
        value: {
          receipt,
          files: verifyMarketplacePackage(
            Buffer.from(bytes),
            id,
            listing.artifact,
            descriptor.package
          )
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof NetworkError ? 'network' : 'integrity' }
    }
  }
}
