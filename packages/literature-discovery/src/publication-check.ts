import { z } from 'zod'
import type { DiscoveryReference } from './contracts.js'
import {
  getPublicationCheckDoi,
  literaturePublicationCheckRequestSchema,
  literaturePublicationCheckSnapshotSchema,
  type LiteraturePublicationCheckRequest,
  type LiteraturePublicationCheckResult,
  type LiteraturePublicationCheckSnapshot,
  type LiteraturePublicationNotice
} from './publication-check-contracts.js'
import { normalizeSupplementDoi } from './supplement-contracts.js'

const PROVIDER = 'crossref-publication-check'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_NOTICES = 100

const crossrefSchema = z.object({
  status: z.literal('ok'),
  'message-type': z.literal('work'),
  message: z.object({
    DOI: z.string(),
    // Crossref's reverse edge identifies notices updating THIS work. The update-to
    // edge instead identifies works changed BY this record and is not used here.
    'updated-by': z
      .array(
        z.object({
          DOI: z.string(),
          type: z.string().trim().min(1).max(100),
          source: z.enum(['publisher', 'retraction-watch']).optional(),
          updated: z
            .object({ 'date-parts': z.array(z.array(z.number().int())).optional() })
            .optional()
        })
      )
      .max(MAX_NOTICES)
      .optional()
  })
})

type Issue = NonNullable<LiteraturePublicationCheckResult['issue']>
class CheckError extends Error {
  constructor(readonly issue: Issue) {
    super(issue)
  }
}

const noticeDate = (parts: number[] | undefined): string | undefined => {
  if (!parts || parts.length !== 3) return undefined
  const [year, month, day] = parts
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : undefined
}

export class LiteraturePublicationChecker {
  private readonly pending = new Map<string, Promise<LiteraturePublicationCheckResult>>()
  private retryAt = 0

  constructor(
    private readonly options: {
      catalog: {
        get(id: string): Promise<DiscoveryReference | undefined>
        sources(id: string): Promise<readonly { provider: string; rawMetadata: unknown }[]>
        savePublicationCheck(
          input: {
            itemId: string
            expectedMetadataRevision: number
            snapshot: LiteraturePublicationCheckSnapshot
          },
          signal?: AbortSignal
        ): Promise<void>
      }
      fetch: typeof fetch
    }
  ) {}

  private async read(doi: string, signal: AbortSignal): Promise<LiteraturePublicationNotice[]> {
    if (Date.now() < this.retryAt) throw new CheckError('rate-limited')
    const response = await this.options.fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } }
    )
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 429) {
        const value = response.headers.get('retry-after') ?? ''
        const wait = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
        this.retryAt =
          Date.now() + Math.min(300_000, Math.max(1000, Number.isFinite(wait) ? wait : 60_000))
        throw new CheckError('rate-limited')
      }
      throw new CheckError(response.status === 404 ? 'not-found' : 'unavailable')
    }
    if (!response.body) throw new CheckError('response-invalid')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > MAX_BYTES) throw new CheckError('response-invalid')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    let work: z.infer<typeof crossrefSchema>['message']
    try {
      work = crossrefSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).message
    } catch {
      throw new CheckError('response-invalid')
    }
    if (normalizeSupplementDoi(work.DOI) !== doi) throw new CheckError('response-invalid')
    // Display fields are not notice identities: partial dates and other provider
    // details may project to the same values. Preserve the provider's records.
    return (work['updated-by'] ?? []).map((update): LiteraturePublicationNotice => {
      const noticeDoi = normalizeSupplementDoi(update.DOI)
      if (!noticeDoi) throw new CheckError('response-invalid')
      return {
        doi: noticeDoi,
        type: update.type,
        source: update.source ?? 'crossref',
        date: noticeDate(update.updated?.['date-parts']?.[0])
      }
    })
  }

  private async currentReference(
    request: LiteraturePublicationCheckRequest,
    doi?: string
  ): Promise<DiscoveryReference> {
    const item = await this.options.catalog.get(request.itemId)
    if (!item || item.deletedAt || item.id !== request.itemId)
      throw new CheckError('reference-unavailable')
    if (
      item.metadataRevision !== request.expectedMetadataRevision ||
      (doi !== undefined && getPublicationCheckDoi(item.item.identifiers) !== doi)
    )
      throw new CheckError('reference-changed')
    return item
  }

  async run(
    input: LiteraturePublicationCheckRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteraturePublicationCheckResult> {
    const request = literaturePublicationCheckRequestSchema.parse(input)
    // Caller lifetime is part of ownership: never share an abortable task between
    // callers. Duplicate checks are rejected rather than borrowing another lease.
    const key = `${request.itemId}:${request.expectedMetadataRevision}`
    if (request.mode === 'check' && (this.pending.has(key) || this.pending.size >= 4))
      return {
        itemId: request.itemId,
        metadataRevision: request.expectedMetadataRevision,
        issue: 'unavailable'
      }
    const task = this.execute(request, callerSignal)
    if (request.mode !== 'check') return task
    this.pending.set(key, task)
    try {
      return await task
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key)
    }
  }

  private async execute(
    request: LiteraturePublicationCheckRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteraturePublicationCheckResult> {
    const response: LiteraturePublicationCheckResult = {
      itemId: request.itemId,
      metadataRevision: request.expectedMetadataRevision
    }
    const timeout = AbortSignal.timeout(15_000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    let doi: string | undefined
    try {
      signal.throwIfAborted()
      const item = await this.currentReference(request)
      doi = getPublicationCheckDoi(item.item.identifiers)
      if (!doi) throw new CheckError('doi-required')
      const sources = await this.options.catalog.sources(item.id)
      for (const source of sources) {
        if (source.provider !== PROVIDER) continue
        const saved = literaturePublicationCheckSnapshotSchema.safeParse(source.rawMetadata)
        if (!saved.success) {
          if (request.mode === 'get') throw new CheckError('response-invalid')
          // A fresh explicit check can repair an unreadable saved result.
          continue
        }
        if (saved.data.doi === doi) {
          response.snapshot = saved.data
          break
        }
      }
      if (request.mode === 'get') {
        signal.throwIfAborted()
        await this.currentReference(request, doi)
        return response
      }
      const notices = await this.read(doi, signal)
      signal.throwIfAborted()
      await this.currentReference(request, doi)
      const snapshot = literaturePublicationCheckSnapshotSchema.parse({
        doi,
        checkedAt: Date.now(),
        notices
      })
      // The host rechecks active identity, revision and DOI inside the same short
      // transaction as the source write. Network failures never reach this step.
      await this.options.catalog.savePublicationCheck(
        { itemId: item.id, expectedMetadataRevision: request.expectedMetadataRevision, snapshot },
        signal
      )
      return { ...response, snapshot }
    } catch (error) {
      // An invalidated identity must not carry a snapshot into the new context.
      let issue: Issue =
        error instanceof CheckError ? error.issue : timeout.aborted ? 'timeout' : 'unavailable'
      if (doi && issue !== 'reference-changed' && issue !== 'reference-unavailable') {
        try {
          // Identity must also hold on failure paths, including network errors and
          // time spent waiting for the save transaction. Never attach stale data.
          await this.currentReference(request, doi)
        } catch (identityError) {
          if (identityError instanceof CheckError) issue = identityError.issue
        }
      }
      return {
        ...response,
        ...(issue === 'reference-changed' || issue === 'reference-unavailable'
          ? { snapshot: undefined }
          : {}),
        issue
      }
    }
  }
}
