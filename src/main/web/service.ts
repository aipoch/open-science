import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  fetchInputSchema,
  webResultSchema,
  WEB_FETCH_DEFAULT_MAX_CHARS,
  WEB_RESULT_MAX_BYTES,
  WEB_RESULT_MAX_CODE_UNITS,
  type WebResult
} from '../../shared/web-tools'
import { WebToolError } from './errors'
import { createWebTransport, parseWebUrl, type WebTransport } from './transport'
import { extractWebResource, WEB_EXTRACTOR_VERSION } from './extraction'
import { WebSnapshotStore, type WebSnapshot } from './snapshot-store'
import { WebSessionSlots } from './limits'

import type { WebSearchContext } from './search-service'

export type WebFetchContext = WebSearchContext
export type WebServiceOptions = {
  store: WebSnapshotStore
  transport?: WebTransport
  deadlineMs?: number
  isEnabled?: (operation: 'search' | 'fetch') => Promise<boolean>
  sessionSlots?: WebSessionSlots
}
const lineCount = (text: string): number => {
  if (!text) return 0
  let lines = 1
  for (const point of text) if (point === '\n') lines++
  return lines
}
const pagePoints = (
  text: string,
  offset: number,
  max: number
): { points: string[]; total: number; startLine: number } => {
  const points: string[] = []
  let total = 0,
    startLine = 1
  for (const point of text) {
    if (total < offset && point === '\n') startLine++
    if (total >= offset && points.length < max) points.push(point)
    total++
  }
  if (offset > total) throw new WebToolError('INVALID_CURSOR')
  return { points, total, startLine }
}
const fits = (result: WebResult): boolean => {
  const json = JSON.stringify(result)
  return json.length <= WEB_RESULT_MAX_CODE_UNITS && Buffer.byteLength(json) <= WEB_RESULT_MAX_BYTES
}
export class WebService {
  private readonly transport: WebTransport
  private readonly sessionSlots: WebSessionSlots
  constructor(private readonly options: WebServiceOptions) {
    this.transport = options.transport ?? createWebTransport()
    this.sessionSlots = options.sessionSlots ?? new WebSessionSlots()
  }

  async commitSnapshot(
    sessionId: string,
    snapshotId: string,
    authorize?: () => Promise<boolean>
  ): Promise<void> {
    await this.options.store.commit(sessionId, snapshotId, authorize)
  }

  async fetch(
    sessionId: string,
    rawInput: unknown,
    context: WebFetchContext = {}
  ): Promise<WebResult> {
    const began = performance.now()
    const retrievedAt = new Date().toISOString()
    const invocationId = context.invocationId ?? randomUUID()
    const timeout = AbortSignal.timeout(this.options.deadlineMs ?? 30_000)
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
    const base = (): WebResult => ({
      schema: 'open-science.web.v1',
      invocation_id: invocationId,
      operation: 'fetch',
      status: 'ok',
      request: {},
      retrieved_at: retrievedAt,
      duration_ms: Math.max(0, Math.round(performance.now() - began)),
      sources: []
    })
    let request: WebResult['request'] = {}
    try {
      signal.throwIfAborted()
      const parsed = fetchInputSchema.safeParse(rawInput)
      if (!parsed.success) throw new WebToolError('INVALID_INPUT')
      const input = parsed.data
      await this.options.store.assertAvailable(sessionId)
      if (this.options.isEnabled && !(await this.options.isEnabled('fetch'))) {
        throw new WebToolError('CAPABILITY_DISABLED')
      }
      const url = input.url !== undefined ? parseWebUrl(input.url).href : undefined
      request = url ? { ...input, url } : input
      const release = await this.sessionSlots.acquire(context.sessionSlotKey ?? sessionId, signal)
      try {
        let snapshot: WebSnapshot | undefined
        let cacheHit = false
        let offset = 0
        if (url === undefined) {
          const cursor = await this.options.store.parseCursor(input.snapshot_id!, input.cursor!)
          snapshot = await this.options.store.readCommitted(sessionId, input.snapshot_id!)
          if (cursor.h !== snapshot.sha256 || cursor.x !== snapshot.extractorVersion)
            throw new WebToolError('INVALID_CURSOR')
          offset = cursor.o
          cacheHit = true
        } else if (!input.refresh) {
          snapshot = await this.options.store.findCached(sessionId, url, WEB_EXTRACTOR_VERSION)
          cacheHit = !!snapshot
        }
        if (!snapshot) {
          const resource = await this.transport(url!, signal)
          signal.throwIfAborted()
          const extraction = await extractWebResource(resource, signal)
          signal.throwIfAborted()
          try {
            snapshot = await this.options.store.write(
              sessionId,
              {
                invocationId,
                originalUrl: url!,
                finalUrl: resource.finalUrl,
                fetchedAt: new Date().toISOString(),
                contentType: resource.contentType.split(';')[0].trim(),
                extractorVersion: WEB_EXTRACTOR_VERSION,
                extractionMethod: extraction.method,
                extractionQuality: extraction.quality,
                ...(extraction.title ? { title: extraction.title } : {}),
                text: extraction.text
              },
              signal
            )
          } catch {
            signal.throwIfAborted()
            throw new WebToolError('EVIDENCE_UNAVAILABLE')
          }
        }
        signal.throwIfAborted()
        const { points, total, startLine } = pagePoints(
          snapshot.text,
          offset,
          input.max_chars ?? WEB_FETCH_DEFAULT_MAX_CHARS
        )
        const result: WebResult = {
          ...base(),
          request,
          sources: [
            {
              source_id: snapshot.snapshotId,
              url: snapshot.finalUrl,
              ...(snapshot.title ? { title: snapshot.title } : {}),
              evidence_kind: 'page_extract',
              snapshot_id: snapshot.snapshotId
            }
          ],
          document: {
            snapshot_id: snapshot.snapshotId,
            final_url: snapshot.finalUrl,
            fetched_at: snapshot.fetchedAt,
            content_type: snapshot.contentType,
            extraction_method: snapshot.extractionMethod,
            extraction_quality: snapshot.extractionQuality,
            extractor_version: snapshot.extractorVersion,
            sha256: snapshot.sha256,
            text: '',
            start_line: startLine,
            end_line: 0,
            total_lines: lineCount(snapshot.text),
            truncated: true
          },
          cache: {
            hit: cacheHit,
            ...(cacheHit
              ? { age_ms: Math.max(0, Date.now() - Date.parse(snapshot.fetchedAt)) }
              : {})
          }
        }
        const document = result.document!
        const applyPage = async (count: number): Promise<void> => {
          document.text = points.slice(0, count).join('')
          document.end_line = document.text
            ? startLine + lineCount(document.text) - 1
            : startLine - 1
          document.truncated = offset + count < total
          if (document.truncated)
            document.next_cursor = await this.options.store.createCursor(snapshot, offset + count)
          else delete document.next_cursor
        }
        await applyPage(points.length)
        let low = 0,
          high = points.length
        if (fits(result)) low = high
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          await applyPage(middle)
          if (fits(result)) low = middle
          else high = middle - 1
        }
        if (low === 0 && offset < total) throw new WebToolError('CONTENT_TOO_LARGE')
        await applyPage(low)
        if (!fits(result)) throw new WebToolError('CONTENT_TOO_LARGE')
        signal.throwIfAborted()
        return webResultSchema.parse(result)
      } finally {
        release()
      }
    } catch (error) {
      // Caller cancellation belongs to the host invocation state and must not become a late result.
      context.signal?.throwIfAborted()
      const failure = timeout.aborted
        ? new WebToolError('TIMEOUT', true)
        : error instanceof WebToolError
          ? error
          : new WebToolError('NETWORK_ERROR', true)
      return webResultSchema.parse({
        ...base(),
        request,
        status: 'error',
        error: { code: failure.code, retryable: failure.retryable }
      })
    }
  }
}
