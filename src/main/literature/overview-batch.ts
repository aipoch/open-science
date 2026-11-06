import { randomUUID } from 'node:crypto'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import {
  OVERVIEW_BATCH_CONCURRENCY,
  overviewBatchSchema,
  overviewBatchRequestSchema,
  type OverviewBatch,
  type OverviewBatchRequest
} from '../../shared/literature-overview-batch'
import type { LiteratureOverviewService } from './overview'
import { withDataRootWrite } from '../storage/migration-state'

// Request strings need at most 5 * (256 + 4096 + 64) * 6 JSON-escaped bytes.
// Leave room for structure and the owner's finite status/issue values on completion.
const MAX_CHECKPOINT_BYTES = 200_000

/** Caller-driven worker: no detached inference or unowned background lifetime. */
export class LiteratureOverviewBatch {
  private busy = false
  constructor(
    private readonly path: () => string,
    private readonly overviews: Pick<LiteratureOverviewService, 'run'>
  ) {}

  private async read(): Promise<OverviewBatch | null> {
    const saved = await readDurableJsonFile(
      this.path(),
      (text) => overviewBatchSchema.parse(JSON.parse(text)),
      {},
      { maxBytes: MAX_CHECKPOINT_BYTES }
    )
    return saved.status === 'found' ? saved.value : null
  }

  async run(input: OverviewBatchRequest, signal?: AbortSignal): Promise<OverviewBatch | null> {
    const request = overviewBatchRequestSchema.parse(input)
    if (this.busy) {
      // Poll durable progress without mistaking the active wave for an interrupted caller.
      if (request.action === 'read') return withDataRootWrite(() => this.read())
      throw new Error('Overview batch is busy.')
    }
    this.busy = true
    try {
      return await withDataRootWrite(async () => {
        let job = await this.read()
        let checkpoint = Promise.resolve()
        const save = async (): Promise<OverviewBatch | null> => {
          if (job) {
            // Capture in completion order, then serialize writes so an older checkpoint cannot win.
            const content = JSON.stringify(job)
            checkpoint = checkpoint
              .catch(() => undefined)
              .then(() => writeDurableJsonFile(this.path(), content))
            await checkpoint
          }
          return job
        }
        // A running checkpoint without an active worker means the previous caller stopped.
        if (job?.rows.some((row) => row.status === 'running')) {
          job.paused = true
          for (const row of job.rows) if (row.status === 'running') row.status = 'pending'
          await save()
        }
        if (request.action === 'read') return job
        signal?.throwIfAborted()
        if (request.action === 'start') {
          if (job?.rows.some((row) => row.status === 'pending'))
            throw new Error('Finish the existing overview batch first.')
          const keys = request.entries.map((entry) => entry.itemId)
          if (new Set(keys).size !== keys.length)
            throw new Error('Duplicate overview batch entries.')
          job = {
            id: randomUUID(),
            paused: false,
            rows: request.entries.map((entry) => ({ request: entry, status: 'pending' }))
          }
          return save()
        }
        if (!job || job.id !== request.jobId) throw new Error('Overview batch changed.')
        if (request.action === 'pause') {
          job.paused = true
          return save()
        }
        if (request.action === 'resume' || request.action === 'retry') {
          if (request.action === 'retry')
            for (const row of job.rows)
              if (row.status === 'failed') {
                row.status = 'pending'
                delete row.issue
              }
          job.paused = false
          return save()
        }
        if (job.paused) return job
        const wave = job.rows
          .filter((row) => row.status === 'pending')
          .slice(0, OVERVIEW_BATCH_CONCURRENCY)
        if (!wave.length) return job
        for (const row of wave) row.status = 'running'
        await save()
        const activeJob = job
        const settled = await Promise.allSettled(
          wave.map(async (row) => {
            try {
              // Reconcile a saved single-paper result after an interrupted batch checkpoint.
              let result = await this.overviews.run({ ...row.request, mode: 'read' }, signal)
              if ('issue' in result && result.issue === 'not-generated')
                result = await this.overviews.run({ ...row.request, mode: 'generate' }, signal)
              signal?.throwIfAborted()
              row.status = 'issue' in result ? 'failed' : 'succeeded'
              row.issue = 'issue' in result ? result.issue : undefined
              if (row.status === 'failed') activeJob.paused = true
            } catch {
              row.status = signal?.aborted ? 'pending' : 'failed'
              row.issue = signal?.aborted ? undefined : 'generation-failed'
              activeJob.paused = true
            }
            // Each paper becomes durable independently; a failed sibling never cancels its save.
            await save()
          })
        )
        const failedSave = settled.find((result) => result.status === 'rejected')
        if (failedSave?.status === 'rejected') throw failedSave.reason
        return job
      })
    } finally {
      this.busy = false
    }
  }
}
