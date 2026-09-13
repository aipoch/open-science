import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  SkillMarketplaceBatch,
  SkillMarketplaceBatchRequest,
  SkillMarketplaceBatchStartResult,
  SkillMarketplaceInstallRequest,
  SkillMarketplaceInstallResult
} from '../../shared/skill-marketplace'

const batchRequest = z
  .strictObject({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    items: z
      .array(
        z.strictObject({
          id: z
            .string()
            .max(128)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          version: z.string().min(1).max(128),
          expectedVersion: z.string().min(1).max(128).nullable()
        })
      )
      .min(1)
      .max(1000)
  })
  .refine(({ items }) => new Set(items.map(({ id }) => id)).size === items.length)

// One main-process owner. No timers, renderer leases, persistence or downloaded-package backlog.
export class SkillMarketplaceInstallQueue {
  private batch: SkillMarketplaceBatch | null = null

  constructor(
    private readonly dependencies: {
      retainSnapshot: (request: SkillMarketplaceBatchRequest) => (() => void) | undefined
      install: (request: SkillMarketplaceInstallRequest) => Promise<SkillMarketplaceInstallResult>
      refresh: () => Promise<void>
    }
  ) {}

  get(): SkillMarketplaceBatch | null {
    return structuredClone(this.batch)
  }

  start(
    request: SkillMarketplaceBatchRequest,
    notifyChanged: () => void
  ): SkillMarketplaceBatchStartResult {
    const parsed = batchRequest.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid-request' }
    if (this.batch?.status === 'running' || this.batch?.status === 'stopping')
      return { ok: false, error: 'busy' }
    const release = this.dependencies.retainSnapshot(parsed.data)
    if (!release) return { ok: false, error: 'snapshot-unavailable' }
    const batch: SkillMarketplaceBatch = {
      id: randomUUID(),
      snapshotId: parsed.data.snapshotId,
      status: 'running',
      items: parsed.data.items.map((item) => ({ ...item, status: 'queued' }))
    }
    this.batch = batch
    void this.run(batch, release, notifyChanged)
    return { ok: true, value: structuredClone(batch) }
  }

  stop(id: string): boolean {
    if (typeof id !== 'string' || this.batch?.id !== id) return false
    if (this.batch.status === 'running') this.batch.status = 'stopping'
    return true
  }

  private async run(
    batch: SkillMarketplaceBatch,
    release: () => void,
    notifyChanged: () => void
  ): Promise<void> {
    let changed = false
    try {
      for (const item of batch.items) {
        if (batch.status === 'stopping') {
          item.status = 'stopped'
          continue
        }
        item.status = 'installing'
        try {
          item.result = await this.dependencies.install({
            snapshotId: batch.snapshotId,
            id: item.id,
            expectedVersion: item.expectedVersion
          })
        } catch {
          item.result = { ok: false, error: 'installation-failed' }
        }
        item.status = !item.result.ok
          ? 'failed'
          : item.result.value.status === 'unchanged'
            ? 'skipped'
            : 'succeeded'
        changed ||= item.status === 'succeeded'
      }
      if (changed) {
        try {
          await this.dependencies.refresh()
        } catch {
          // Installed files remain successful even if runtime/catalog refresh needs retrying.
          batch.refreshFailed = true
        }
        try {
          notifyChanged()
        } catch {
          batch.refreshFailed = true
        }
      }
    } finally {
      release()
      batch.status = batch.status === 'stopping' ? 'stopped' : 'completed'
    }
  }
}
