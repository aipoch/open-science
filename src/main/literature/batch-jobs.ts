import { z } from 'zod'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import {
  literatureJobSchema,
  literatureJobRequestSchema,
  literatureJobProgress,
  type LiteratureJob,
  type LiteratureJobRequest,
  type LiteratureJobRow,
  type LiteratureJobsResult
} from '../../shared/literature-jobs'
import {
  readDurableJsonFile,
  writeDurableJsonFile,
  DurableJsonRecoveryBarrierError
} from '../storage/durable-json-file'
import type { LiteratureCatalog } from './catalog'
import type { LiteratureFullTextFinder } from './full-text-finder'
import type { LiteratureMetadataEnricher } from './metadata-enricher'

const journal = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), jobs: z.array(literatureJobSchema).max(50) }).strict(),
  z.object({ version: z.literal(2), jobIds: z.array(z.string().uuid()).max(50) }).strict()
])
type Options = {
  path: string
  catalog: Pick<LiteratureCatalog, 'get'>
  fullText: Pick<LiteratureFullTextFinder, 'run'>
  metadata: Pick<LiteratureMetadataEnricher, 'complete' | 'applyReviewed'>
  onError: (error: unknown) => void
  spacingMs?: number
}

// One worker for this Library keeps provider requests bounded across windows and jobs.
// The journal checkpoints references, not partial PDF bytes. Attachments remain content-addressed.
export class LiteratureBatchJobs {
  private jobs: LiteratureJob[] = []
  private loaded?: Promise<void>
  private worker?: Promise<void>
  private closed = false
  private writes = Promise.resolve()
  private commands = Promise.resolve()
  private active?: { jobId: string; itemId: string; candidateId: string }
  private readonly cooldowns = new Map<string, number>()
  constructor(private readonly options: Options) {}

  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      const stored = await readDurableJsonFile(
        this.options.path,
        (text) => {
          const value: unknown = JSON.parse(text)
          if (
            typeof value === 'object' &&
            value &&
            'version' in value &&
            value.version !== 1 &&
            value.version !== 2
          )
            throw new DurableJsonRecoveryBarrierError('Unsupported Literature job journal version.')
          return journal.parse(value)
        },
        {},
        { maxBytes: 128 * 1024 * 1024 }
      )
      if (stored.status === 'found' && stored.value.version === 2) {
        this.jobs = await Promise.all(
          stored.value.jobIds.map(async (id) => {
            const record = await readDurableJsonFile(
              this.jobPath(id),
              (text) => literatureJobSchema.parse(JSON.parse(text)),
              {},
              { maxBytes: 128 * 1024 * 1024 }
            )
            if (record.status !== 'found' || record.value.id !== id)
              throw new DurableJsonRecoveryBarrierError(
                'Literature task checkpoint is missing or invalid.'
              )
            return record.value
          })
        )
      } else
        this.jobs = stored.status === 'found' && stored.value.version === 1 ? stored.value.jobs : []
      for (const job of this.jobs) {
        if (['queued', 'running', 'pausing'].includes(job.state)) job.state = 'paused'
        for (const row of job.rows) {
          if (row.status === 'searching') row.status = 'pending'
          if (row.status === 'saving') row.status = 'ready'
        }
      }
      if (stored.status === 'found' && stored.value.version === 1) {
        for (const job of this.jobs) await this.save(job)
        await this.saveIndex()
      }
    })())
  }

  private jobPath(id: string): string {
    return join(`${this.options.path}.d`, `${z.string().uuid().parse(id)}.json`)
  }
  private save(job: LiteratureJob): Promise<void> {
    const contents = JSON.stringify(job)
    const write = async (): Promise<void> => {
      await mkdir(`${this.options.path}.d`, { recursive: true })
      await writeDurableJsonFile(this.jobPath(job.id), contents)
    }
    this.writes = this.writes.then(write, write)
    return this.writes
  }
  private saveIndex(): Promise<void> {
    const contents = JSON.stringify({ version: 2, jobIds: this.jobs.map((job) => job.id) })
    const write = (): Promise<void> => writeDurableJsonFile(this.options.path, contents)
    this.writes = this.writes.then(write, write)
    return this.writes
  }
  private snapshot(job: LiteratureJob): LiteratureJob {
    const snapshot = structuredClone(job)
    if (snapshot.state === 'running' && !this.activeJob(job)) snapshot.state = 'queued'
    return snapshot
  }

  async run(raw: LiteratureJobRequest): Promise<LiteratureJobsResult> {
    const request = literatureJobRequestSchema.parse(raw)
    if (request.action === 'get' || request.action === 'list') return this.execute(request)
    const result = this.commands.then(() => this.execute(request))
    this.commands = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private async execute(request: LiteratureJobRequest): Promise<LiteratureJobsResult> {
    await this.load()
    if (this.closed) throw new Error('Literature tasks are shutting down.')
    if (request.action === 'list')
      return {
        jobs: [],
        summaries: this.jobs.map(({ rows, ...job }) => ({
          ...job,
          state: job.state === 'running' && this.currentJobId !== job.id ? 'queued' : job.state,
          ...literatureJobProgress({ ...job, rows }),
          completedItemIds: rows.filter((row) => row.status === 'done').map((row) => row.id),
          total: rows.length,
          checked: rows.filter(({ status }) => !['pending', 'searching'].includes(status)).length,
          ready: rows.filter(({ status }) => status === 'ready').length,
          done: rows.filter(({ status }) => status === 'done').length,
          failed: rows.filter(({ status }) => status === 'error').length
        }))
      }
    if (request.action === 'create') {
      const existing = this.jobs.find(({ id }) => id === request.requestId)
      if (existing) {
        if (
          existing.mode !== request.mode ||
          JSON.stringify(existing.rows.map(({ id }) => id)) !==
            JSON.stringify([...new Set(request.itemIds)])
        )
          throw new Error('Task request identity was already used for different references.')
        return { jobs: [this.snapshot(existing)] }
      }
      const previousJobs = [...this.jobs]
      let prunedId: string | undefined
      if (this.jobs.length >= 50) {
        const settled = this.jobs.findLastIndex(
          (job) =>
            job.state === 'completed' &&
            job.rows.every(({ status }) => status !== 'ready' && status !== 'error')
        )
        if (settled < 0) throw new Error('Remove completed Literature tasks before adding more.')
        prunedId = this.jobs.splice(settled, 1)[0]?.id
      }
      const now = Date.now()
      const job: LiteratureJob = {
        id: request.requestId,
        mode: request.mode,
        phase: 'search',
        state: 'running',
        createdAt: now,
        updatedAt: now,
        rows: [...new Set(request.itemIds)].map((id) => ({ id, status: 'pending', checked: true }))
      }
      this.jobs.unshift(job)
      try {
        await this.save(job)
        await this.saveIndex()
      } catch (error) {
        this.jobs = previousJobs
        throw error
      }
      if (prunedId) await rm(this.jobPath(prunedId), { force: true }).catch(this.options.onError)
      this.kick()
      return { jobs: [this.snapshot(job)] }
    }
    const job = this.jobs.find(({ id }) => id === request.jobId)
    if (!job) throw new Error('Literature task not found.')
    if (request.action === 'get') {
      const snapshot = request.ifUpdatedAt === job.updatedAt ? undefined : this.snapshot(job)
      let download: LiteratureJob['progress']
      const active = this.active
      if (active?.jobId === job.id) {
        const progress = await this.options.fullText.run({
          mode: 'progress',
          itemId: active.itemId,
          candidateId: active.candidateId
        })
        if (this.active === active && progress.mode === 'progress' && progress.progress)
          download = { itemId: active.itemId, value: progress.progress }
      }
      if (snapshot && download) snapshot.progress = download
      return { jobs: snapshot ? [snapshot] : [], progress: download }
    }
    if (request.action === 'review') {
      for (const selection of request.selections) {
        const row = job.rows.find((row) => row.id === selection.itemId)
        if (
          !row ||
          row.status !== 'ready' ||
          (job.phase === 'apply' && ['running', 'pausing'].includes(job.state)) ||
          (selection.candidateId &&
            !row.candidates?.some((candidate) => candidate.id === selection.candidateId))
        )
          throw new Error('Review the current task results before changing selections.')
      }
      for (const selection of request.selections)
        Object.assign(
          job.rows.find((row) => row.id === selection.itemId)!,
          { checked: selection.checked, candidateId: selection.candidateId }
        )
    } else if (request.action === 'pause') {
      if (job.state === 'running') job.state = this.activeJob(job) ? 'pausing' : 'paused'
    } else {
      if (job.state === 'running' || job.state === 'pausing')
        throw new Error('Pause this Literature task first.')
      if (request.action === 'remove') this.jobs = this.jobs.filter(({ id }) => id !== job.id)
      else if (request.action === 'apply') {
        if (
          new Set(request.selections.map(({ itemId }) => itemId)).size !== request.selections.length
        )
          throw new Error('Duplicate task selections.')
        for (const selection of request.selections) {
          const row = job.rows.find(({ id }) => id === selection.itemId)
          if (
            !row ||
            row.status !== 'ready' ||
            (job.mode === 'full-text' &&
              !row.candidates?.some(({ id }) => id === selection.candidateId))
          )
            throw new Error('Review the current task results before applying.')
        }
        for (const row of job.rows) {
          const selected = request.selections.find(({ itemId }) => itemId === row.id)
          row.checked = Boolean(selected)
          if (selected?.candidateId) row.candidateId = selected.candidateId
        }
        job.phase = 'apply'
        job.phaseItemIds = request.selections.map((selection) => selection.itemId)
        job.state = 'running'
      } else if (request.action === 'retry') {
        for (const row of job.rows)
          if (row.status !== 'done') {
            row.status = 'pending'
            row.metadata = undefined
            row.candidates = undefined
            row.candidateId = undefined
            row.message = undefined
            row.notices = undefined
          }
        job.phase = 'search'
        job.phaseItemIds = undefined
        job.state = 'running'
      } else if (request.action === 'resume' && job.state === 'paused') {
        if (job.phase === 'apply') {
          const previousPhase = new Set(
            job.phaseItemIds ??
              job.rows
                .filter((row) => row.checked && ['done', 'error'].includes(row.status))
                .map((row) => row.id)
          )
          job.phaseItemIds = job.rows
            .filter((row) => (row.status === 'ready' ? row.checked : previousPhase.has(row.id)))
            .map((row) => row.id)
        }
        job.state = 'running'
      }
    }
    job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
    if (request.action === 'remove') {
      await this.saveIndex()
      await rm(this.jobPath(job.id), { force: true })
    } else await this.save(job)
    this.kick()
    return { jobs: request.action === 'remove' ? [] : [this.snapshot(job)] }
  }

  private currentJobId?: string
  private activeJob(job: LiteratureJob): boolean {
    return this.currentJobId === job.id
  }
  private kick(): void {
    if (this.worker || this.closed) return
    this.worker = this.drain()
      .catch((error: unknown) => {
        for (const job of this.jobs)
          if (job.state === 'running' || job.state === 'pausing') {
            job.state = 'paused'
            job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
            for (const row of job.rows) {
              if (row.status === 'searching') row.status = 'pending'
              if (row.status === 'saving') row.status = 'ready'
            }
          }
        this.currentJobId = undefined
        this.options.onError(error)
      })
      .finally(() => {
        this.worker = undefined
        if (this.jobs.some(({ state }) => state === 'running')) this.kick()
      })
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const job = [...this.jobs].reverse().find(({ state }) => state === 'running')
      if (!job) break
      this.currentJobId = job.id
      job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
      for (const row of job.rows) {
        if (this.closed || job.state !== 'running') break
        if (
          job.phase === 'search' ? row.status !== 'pending' : row.status !== 'ready' || !row.checked
        )
          continue
        row.status = job.phase === 'search' ? 'searching' : 'saving'
        row.message = undefined
        job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
        // Pending/ready is already durable. An interrupted row resumes from that checkpoint.
        try {
          if (job.phase === 'search') await this.search(job, row)
          else await this.apply(job, row)
        } catch {
          row.status = 'error'
          row.message =
            job.mode === 'metadata'
              ? 'Metadata could not be completed.'
              : job.phase === 'apply'
                ? 'PDF could not be added'
                : 'Full-text search failed. Try again.'
        } finally {
          this.active = undefined
        }
        job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
        await this.save(job)
        if (job.state === 'running' && !this.closed)
          await new Promise((resolve) => setTimeout(resolve, this.options.spacingMs ?? 350))
      }
      job.state =
        this.closed || job.state !== 'running'
          ? 'paused'
          : job.phase === 'search' &&
              job.rows.some(({ status }) => status === 'ready' || status === 'error')
            ? 'review'
            : 'completed'
      job.updatedAt = Math.max(Date.now(), job.updatedAt + 1)
      this.currentJobId = undefined
      await this.save(job)
    }
  }

  private async search(job: LiteratureJob, row: LiteratureJobRow): Promise<void> {
    const item = await this.options.catalog.get(row.id)
    if (!item || item.id !== row.id || item.deletedAt) throw new Error('Reference unavailable')
    row.item = item
    if (job.mode === 'metadata') {
      if (
        !item.item.identifiers.some(
          ({ scheme, value }) => ['doi', 'pmid'].includes(scheme) && value.trim()
        )
      ) {
        row.status = 'skipped'
        row.message = 'Needs identifiers'
        return
      }
      row.metadata = await this.options.metadata.complete({ mode: 'preview', itemId: row.id })
      row.status = row.metadata.filled.length ? 'ready' : 'skipped'
      if (!row.metadata.filled.length) row.message = 'No missing metadata was found.'
    } else {
      if (
        item.attachments.some((attachment) =>
          attachment.versions.some(({ contentType }) => contentType === 'application/pdf')
        )
      ) {
        row.status = 'skipped'
        row.message = 'PDF already attached'
        return
      }
      const result = await this.options.fullText.run({ mode: 'search', itemId: row.id })
      if (result.mode !== 'search') throw new Error('Unexpected full-text response')
      row.candidates = result.candidates
      row.notices = result.notices
      row.candidateId = result.candidates[0]?.id
      const partial = result.notices.some((notice) => notice.endsWith('-unavailable'))
      row.status = result.candidates.length ? 'ready' : partial ? 'error' : 'skipped'
      row.message = result.notices.includes('missing-identifiers')
        ? 'Needs identifiers'
        : partial
          ? 'Some sources were unavailable. Results may be incomplete.'
          : !result.candidates.length
            ? 'No freely accessible full-text PDF was found.'
            : undefined
    }
  }

  private async apply(job: LiteratureJob, row: LiteratureJobRow): Promise<void> {
    const current = await this.options.catalog.get(row.id)
    if (
      !current ||
      current.id !== row.id ||
      current.deletedAt ||
      current.metadataRevision !== row.item?.metadataRevision
    )
      throw new Error('Reference changed')
    if (job.mode === 'metadata') {
      if (!row.metadata) throw new Error('Metadata review unavailable')
      await this.options.metadata.applyReviewed(row.metadata)
    } else {
      const candidate = row.candidates?.find(({ id }) => id === row.candidateId)
      if (!candidate) throw new Error('No source selected')
      // A previous attempt may have committed before its completion checkpoint was saved.
      if (
        current.attachments.some((attachment) =>
          attachment.versions.some(({ contentType }) => contentType === 'application/pdf')
        )
      ) {
        row.status = 'skipped'
        row.message = 'PDF already attached'
        return
      }
      const origin = new URL(candidate.url).origin
      if ((this.cooldowns.get(origin) ?? 0) > Date.now()) {
        row.status = 'error'
        row.message = 'Source rate limit reached. Search again later.'
        return
      }
      const refreshed = await this.options.fullText.run({ mode: 'search', itemId: row.id })
      if (refreshed.mode !== 'search') throw new Error('Unexpected full-text response')
      const confirmed = refreshed.candidates.find(
        (entry) => entry.url === candidate.url && entry.provider === candidate.provider
      )
      if (!confirmed) {
        row.status = 'error'
        row.message = 'The selected source changed. Search again and review the results.'
        return
      }
      this.active = { jobId: job.id, itemId: row.id, candidateId: confirmed.id }
      const result = await this.options.fullText.run({
        mode: 'attach',
        itemId: row.id,
        candidateId: confirmed.id
      })
      if (result.mode === 'attach-error') {
        this.cooldowns.set(origin, result.retryAt)
        row.status = 'error'
        row.message = 'Source rate limit reached. Search again later.'
        return
      }
      if (result.mode !== 'attach') throw new Error('Unexpected attachment response')
    }
    row.status = 'done'
  }

  async close(): Promise<void> {
    this.closed = true
    await this.commands
    await this.worker
    await this.writes
  }
}
