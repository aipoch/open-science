import { z } from 'zod'
import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceDetail,
  SkillMarketplaceDetailRequest,
  SkillMarketplaceResult
} from '../../shared/skill-marketplace'
import { netFetchStandard } from './net-fetch'
import {
  toMarketplaceEntry,
  verifyMarketplaceDetail,
  verifyMarketplaceIndex,
  verifyMarketplaceRoot,
  type MarketplaceRoot
} from './marketplace-protocol'

const REPOSITORY = 'aipoch/openscience-skill-marketplace'
const detailRequest = z.strictObject({
  snapshotId: z.string().regex(/^[a-f0-9]{40}$/),
  id: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})
class NetworkError extends Error {}

// Read-only owner: never downloads shards, writes files or modifies the installed Skill catalog.
export class SkillMarketplaceService {
  private readonly snapshots = new Map<string, MarketplaceRoot>()
  private pending?: Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>>

  constructor(private readonly fetch: typeof globalThis.fetch = netFetchStandard) {}

  private async read(
    url: string,
    limit: number,
    signal = AbortSignal.timeout(15000)
  ): Promise<Uint8Array> {
    try {
      const response = await this.fetch(url, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/json' }
      })
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
      throw new NetworkError('Metadata request failed')
    }
  }

  private rawUrl(commit: string, path: string): string {
    return `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  list(): Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>> {
    // Coalesce concurrent callers; explicit subsequent calls always refresh discovery.
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
      const [bytes, signature] = await Promise.all([
        this.read(this.rawUrl(commit, 'marketplace.json'), 4 * 1024 * 1024, signal),
        this.read(this.rawUrl(commit, 'marketplace.json.sig'), 4096, signal)
      ])
      const root = verifyMarketplaceRoot(bytes, signature)
      verifyMarketplaceIndex(
        await this.read(this.rawUrl(commit, root.release_index.path), 8 * 1024 * 1024, signal),
        root
      )
      this.snapshots.delete(commit)
      this.snapshots.set(commit, root)
      // Bounded, memory-only history lets an open detail survive a catalog refresh.
      if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!)
      return {
        ok: true,
        value: {
          snapshotId: commit,
          revision: root.revision,
          entries: root.skills.map(toMarketplaceEntry)
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof NetworkError ? 'network' : 'integrity' }
    }
  }

  async detail(
    request: SkillMarketplaceDetailRequest
  ): Promise<SkillMarketplaceResult<SkillMarketplaceDetail>> {
    const parsed = detailRequest.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'snapshot-unavailable' }
    const { snapshotId, id } = parsed.data
    const listing = this.snapshots.get(snapshotId)?.skills.find((entry) => entry.id === id)
    if (!listing) return { ok: false, error: 'snapshot-unavailable' }
    try {
      const bytes = await this.read(this.rawUrl(snapshotId, listing.release.path), 1024 * 1024)
      return { ok: true, value: verifyMarketplaceDetail(bytes, listing) }
    } catch (error) {
      return { ok: false, error: error instanceof NetworkError ? 'network' : 'integrity' }
    }
  }
}
