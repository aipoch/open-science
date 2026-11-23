import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { DiscoveryReference } from './contracts.js'
import { resolveEuropePmc, readEuropePmcPage } from './related-europe-pmc.js'
import {
  resolveOpenCitations,
  readOpenCitationsPage,
  readOpenCitationsReferences,
  type OpenCitationsReferenceSnapshot
} from './related-opencitations.js'
import {
  resolveOpenCitationsIndex,
  readOpenCitationsIndexPage,
  type OpenCitationsIndexSnapshot
} from './related-opencitations-index.js'
import {
  literatureRelatedRequestSchema,
  literatureRelatedResultSchema,
  type LiteratureRelatedRequest,
  type LiteratureRelatedResult,
  type LiteratureRelatedRecord,
  type LiteratureRelatedProvider
} from './related-contracts.js'

import { SourceError } from './related-source-error.js'

const transientCodes = [
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_NETWORK_CHANGED'
] as const
type TransientCode = (typeof transientCodes)[number]
export type LiteratureRelatedDiagnostic = {
  provider: LiteratureRelatedProvider
  endpoint: 'identity' | 'references' | 'citations' | 'metadata'
  phase: 'fetch' | 'body' | 'http' | 'parse' | 'validation'
  attempt: 1 | 2
  outcome: 'failed' | 'recovered'
  status?: number
  code?: TransientCode
  issue?: LiteratureRelatedResult['issue']
  elapsedMs: number
  bytes?: number
}
type ReadTrace = Pick<LiteratureRelatedDiagnostic, 'endpoint' | 'phase' | 'status' | 'bytes'> & {
  attempt: 1 | 2
  started: number
}
type ReadContext = {
  retried: boolean
  beforeRetry(): Promise<void>
  callerSignal?: AbortSignal
  lastReportedError?: unknown
  trace?: ReadTrace
}

function transientCode(error: unknown): TransientCode | undefined {
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const entry = current as { code?: unknown; message?: unknown; cause?: unknown }
    const code =
      typeof entry.code === 'string'
        ? entry.code
        : typeof entry.message === 'string'
          ? /^net::(ERR_[A-Z_]+)$/.exec(entry.message)?.[1]
          : undefined
    if (transientCodes.includes(code as TransientCode)) return code as TransientCode
    current = entry.cause
  }
  return undefined
}

function failureIssue(error: unknown, signal: AbortSignal): LiteratureRelatedResult['issue'] {
  return error instanceof SourceError
    ? error.issue
    : signal.aborted
      ? 'timeout'
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 'response-invalid'
        : 'unavailable'
}

function sourceEndpoint(path: string, query: Record<string, string>): ReadTrace['endpoint'] {
  if (path.startsWith('meta/')) return 'metadata'
  if (path.startsWith('index/v2/references/')) return 'references'
  if (path.startsWith('index/v2/citations/')) return 'citations'
  if (path.endsWith('/references')) return 'references'
  if (path.endsWith('/citations') || query.filter?.startsWith('cf.cites')) return 'citations'
  return 'identity'
}
type RelatedPage = Pick<
  LiteratureRelatedResult,
  'records' | 'nextOffset' | 'omitted' | 'retrievedAt'
>
type Resolution = {
  root: boolean
  bytes: number
  started: Partial<Record<'references' | 'citations', number>>
  pages: Map<string, RelatedPage>
  itemId: string
  revision: number
  seed: LiteratureRelatedRecord
  provider: LiteratureRelatedProvider
  discovered: Map<string, LiteratureRelatedRecord>
  opencitationsReferences?: OpenCitationsReferenceSnapshot
  opencitationsMode?: 'skg-if' | 'index'
  opencitationsIndexSnapshots?: Partial<
    Record<'references' | 'citations', OpenCitationsIndexSnapshot>
  >
  expires: number
}
const resolutionLifetimeMs = 24 * 60 * 60_000
const maxDiscoveredRecords = 2000
export class LiteratureRelatedFinder {
  private readonly resolutions = new Map<string, Resolution>()
  private readonly pending = new Map<
    string,
    {
      controller: AbortController
      users: number
      promise: Promise<LiteratureRelatedResult>
    }
  >()
  private readonly nextRequests = new Map<LiteratureRelatedProvider, number>()
  private readonly cooldowns = new Map<string, number>()
  private readonly readContexts = new WeakMap<AbortSignal, ReadContext>()
  constructor(
    private readonly options: {
      catalog: {
        get(id: string): Promise<DiscoveryReference | undefined>
        sources(id: string): Promise<readonly { provider: string; externalId?: string }[]>
      }
      fetch: typeof fetch
      onDiagnostic?: (diagnostic: LiteratureRelatedDiagnostic) => void
    }
  ) {}

  private diagnose(diagnostic: LiteratureRelatedDiagnostic): void {
    try {
      void Promise.resolve(this.options.onDiagnostic?.(diagnostic)).catch(() => undefined)
    } catch {
      // Observability must not change source routing or request results.
    }
  }

  private remember(token: string, resolution: Resolution): void {
    // Count serialized data conservatively, including records shared by pages and aliases.
    resolution.bytes = Buffer.byteLength(
      JSON.stringify({
        ...resolution,
        discovered: [...resolution.discovered],
        pages: [...resolution.pages]
      })
    )
    this.resolutions.delete(token)
    this.resolutions.set(token, resolution)
    let bytes = [...this.resolutions.values()].reduce((sum, value) => sum + value.bytes, 0)
    while (this.resolutions.size > 200 || bytes > 32 * 1024 * 1024) {
      const oldest = this.resolutions.keys().next().value!
      bytes -= this.resolutions.get(oldest)!.bytes
      this.resolutions.delete(oldest)
    }
  }

  private async readSource(
    provider: LiteratureRelatedProvider,
    path: string,
    query: Record<string, string>,
    signal: AbortSignal,
    trace: ReadTrace
  ): Promise<unknown> {
    if (
      provider === 'opencitations' &&
      !/^skg-if\/v1\/products(?:\/https:\/\/w3id\.org\/oc\/meta\/br\/\d{1,30})?$/.test(path) &&
      !/^meta\/v1\/metadata\/omid:br\/\d{1,30}(?:__omid:br\/\d{1,30}){0,19}$/.test(path) &&
      !/^meta\/v1\/metadata\/doi:[A-Za-z0-9.!~*'()%_-]+$/.test(path) &&
      !/^index\/v2\/(references|citations)\/(omid:br\/\d{1,30}|doi:[A-Za-z0-9.!~*'()%_-]+)$/.test(
        path
      )
    )
      throw new SourceError('response-invalid')
    for (const [identity, until] of this.cooldowns)
      if (until <= Date.now()) this.cooldowns.delete(identity)
    const checkCooldown = (): void => {
      const retryAt = this.cooldowns.get(provider)
      if (retryAt && retryAt > Date.now()) throw new SourceError('rate-limited', retryAt)
    }
    checkCooldown()
    const slot = Math.max(Date.now(), this.nextRequests.get(provider) ?? 0)
    if (slot - Date.now() > 10_000) throw new SourceError('rate-limited', slot)
    this.nextRequests.set(provider, slot + 1000)
    await delay(Math.max(0, slot - Date.now()), undefined, { signal })
    checkCooldown()
    signal.throwIfAborted()
    const origin =
      provider === 'opencitations'
        ? 'https://api.opencitations.net/'
        : 'https://www.ebi.ac.uk/europepmc/webservices/rest/'
    const response = await this.options.fetch(`${origin}${path}?${new URLSearchParams(query)}`, {
      redirect: 'error',
      credentials: 'omit',
      signal,
      headers: { Accept: 'application/json' }
    })
    trace.status = response.status
    signal.throwIfAborted()
    // SKG-IF represents an empty search page as 404 with a JSON-LD envelope.
    // Its parser still validates the envelope and the exact requested page.
    const emptySearch =
      provider === 'opencitations' && path === 'skg-if/v1/products' && response.status === 404
    if (!response.ok && !emptySearch) {
      trace.phase = 'http'
      // Cleanup errors cannot override the authoritative HTTP classification.
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 429) {
        const value = response.headers.get('retry-after') ?? ''
        const wait = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
        const retryAt =
          Date.now() + Math.min(300_000, Math.max(1000, Number.isFinite(wait) ? wait : 60_000))
        this.cooldowns.set(provider, retryAt)
        throw new SourceError('rate-limited', retryAt)
      }
      throw new SourceError(
        response.status === 404
          ? provider === 'opencitations' && path.startsWith('meta/')
            ? 'unavailable'
            : 'no-match'
          : [401, 403].includes(response.status)
            ? 'authentication'
            : 'unavailable',
        undefined,
        response.status,
        // A valid server retry hint is not permission for an immediate retry.
        /^\d+$/.test(response.headers.get('retry-after')?.trim() ?? '') ||
          Number.isFinite(Date.parse(response.headers.get('retry-after') ?? ''))
      )
    }
    if (!response.body) throw new SourceError('response-invalid')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let bytes = 0
    trace.phase = 'body'
    try {
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        trace.bytes = bytes
        if (bytes > 2 * 1024 * 1024) throw new SourceError('source-limit')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    trace.phase = 'parse'
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (emptySearch)
      z.object({
        meta: z.object({ part_of: z.object({ total_items: z.literal(0) }) }),
        '@graph': z.array(z.unknown()).length(0)
      }).parse(parsed)
    return parsed
  }

  private async read(
    provider: LiteratureRelatedProvider,
    path: string,
    query: Record<string, string>,
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted()
    // Bound injected transports too: not every host implementation rejects fetch
    // or reader.read promptly when its AbortSignal is aborted.
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const context = this.readContexts.get(signal)
      for (let attempt: 1 | 2 = 1; ; attempt = 2) {
        const trace: ReadTrace = {
          endpoint: sourceEndpoint(path, query),
          phase: 'fetch',
          attempt,
          started: Date.now()
        }
        if (context) context.trace = trace
        try {
          const value = await Promise.race([
            this.readSource(provider, path, query, signal, trace),
            aborted
          ])
          if (attempt === 2)
            this.diagnose({
              provider,
              endpoint: trace.endpoint,
              phase: trace.phase,
              attempt,
              status: trace.status,
              bytes: trace.bytes,
              outcome: 'recovered',
              elapsedMs: Math.max(0, Date.now() - trace.started)
            })
          return value
        } catch (error) {
          const code = transientCode(error)
          if (!context?.callerSignal?.aborted)
            this.diagnose({
              provider,
              endpoint: trace.endpoint,
              phase: trace.phase,
              attempt,
              status: trace.status,
              bytes: trace.bytes,
              code,
              outcome: 'failed',
              issue: failureIssue(error, signal),
              elapsedMs: Math.max(0, Date.now() - trace.started)
            })
          if (context) context.lastReportedError = error
          if (
            provider !== 'opencitations' ||
            !context ||
            context.retried ||
            signal.aborted ||
            !(
              (error instanceof SourceError &&
                !error.retrySuppressed &&
                [502, 503, 504].includes(error.status ?? 0)) ||
              (!(error instanceof SourceError) &&
                (trace.phase === 'fetch' || trace.phase === 'body') &&
                code)
            )
          )
            throw error
          context.retried = true
          // A retry spends the original request's sole budget and deadline, and
          // cannot continue after the saved root has changed or been removed.
          await Promise.race([context.beforeRetry(), aborted])
          signal.throwIfAborted()
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async page(
    resolution: Resolution,
    request: LiteratureRelatedRequest,
    signal: AbortSignal
  ): Promise<RelatedPage> {
    const cached = resolution.pages.get(`${request.direction}:${request.offset}`)
    if (cached) return cached
    const livePages =
      resolution.provider === 'europe-pmc' ||
      (resolution.opencitationsMode !== 'index' && request.direction === 'citations')
    // Live offset APIs cannot provide a stable snapshot across a day-long pause.
    if (
      livePages &&
      request.offset &&
      Date.now() - (resolution.started[request.direction] ?? Date.now()) >= 15 * 60_000
    ) {
      if (request.resolutionToken) this.resolutions.delete(request.resolutionToken)
      throw new SourceError('expired')
    }
    if (resolution.provider === 'europe-pmc')
      return readEuropePmcPage(resolution.seed, request.direction, request.offset, (path, query) =>
        this.read('europe-pmc', path, query, signal)
      )
    if (resolution.provider === 'opencitations' && resolution.opencitationsMode === 'index') {
      const { snapshot, ...page } = await readOpenCitationsIndexPage(
        resolution.seed,
        request.direction,
        request.offset,
        (path, query) => this.read('opencitations', path, query, signal),
        resolution.opencitationsIndexSnapshots?.[request.direction]
      )
      resolution.opencitationsIndexSnapshots = {
        ...resolution.opencitationsIndexSnapshots,
        [request.direction]: snapshot
      }
      return page
    }
    if (resolution.provider === 'opencitations' && request.direction === 'references') {
      const { snapshot, ...page } = await readOpenCitationsReferences(
        resolution.seed,
        request.offset,
        (path, query) => this.read('opencitations', path, query, signal),
        resolution.opencitationsReferences
      )
      resolution.opencitationsReferences = snapshot
      return page
    }
    return readOpenCitationsPage(
      resolution.seed,
      request.direction,
      request.offset,
      (path, query) => this.read('opencitations', path, query, signal)
    )
  }

  async run(
    input: LiteratureRelatedRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteratureRelatedResult> {
    callerSignal?.throwIfAborted()
    const request = literatureRelatedRequestSchema.parse(input)
    const identity = { ...request, requestId: undefined }
    const key = JSON.stringify(identity)
    let pending = this.pending.get(key)
    if (!pending || pending.controller.signal.aborted) {
      // Admission limits network concurrency; bound the coalescing index independently.
      if (this.pending.size >= 200) return this.lookup(request, callerSignal)
      const controller = new AbortController()
      pending = { controller, users: 0, promise: this.lookup(request, controller.signal) }
      this.pending.set(key, pending)
      const entry = pending
      const remove = (): void => {
        if (this.pending.get(key) === entry) this.pending.delete(key)
      }
      void pending.promise.then(remove, remove)
    }
    const entry = pending
    entry.users++
    return new Promise<LiteratureRelatedResult>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, response?: LiteratureRelatedResult): void => {
        if (settled) return
        settled = true
        callerSignal?.removeEventListener('abort', cancel)
        if (--entry.users === 0) entry.controller.abort()
        if (response) resolve(literatureRelatedResultSchema.parse(response))
        else reject(error)
      }
      const cancel = (): void => finish(callerSignal?.reason)
      callerSignal?.addEventListener('abort', cancel, { once: true })
      if (callerSignal?.aborted) cancel()
      void entry.promise.then(
        (response) => finish(undefined, response),
        (error) => finish(error)
      )
    })
  }

  private async lookup(
    input: LiteratureRelatedRequest,
    callerSignal?: AbortSignal
  ): Promise<LiteratureRelatedResult> {
    const request = literatureRelatedRequestSchema.parse(input)
    const result: LiteratureRelatedResult = {
      itemId: request.itemId,
      metadataRevision: request.expectedMetadataRevision,
      direction: request.direction,
      state: 'ready',
      records: [],
      provider: request.provider && request.provider !== 'auto' ? request.provider : 'europe-pmc'
    }
    if (result.provider === 'opencitations')
      result.opencitationsMode = request.opencitationsMode ?? 'skg-if'
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(callerSignal ? [callerSignal] : [])
    ])
    const check = async (): Promise<DiscoveryReference> => {
      signal.throwIfAborted()
      const item = await this.options.catalog.get(request.itemId)
      signal.throwIfAborted()
      if (
        !item ||
        item.id !== request.itemId ||
        item.deletedAt !== undefined ||
        item.metadataRevision !== request.expectedMetadataRevision
      )
        throw new SourceError('reference-changed')
      return item
    }
    const readContext: ReadContext = {
      retried: false,
      callerSignal,
      beforeRetry: async () => {
        await check()
      }
    }
    this.readContexts.set(signal, readContext)
    try {
      const item = await check()
      for (const [token, value] of this.resolutions)
        if (value.expires <= Date.now()) this.resolutions.delete(token)
      let resolution = request.resolutionToken
        ? this.resolutions.get(request.resolutionToken)
        : undefined
      let token = request.resolutionToken
      let publish = false
      // Reopening a view may omit its token; reuse only the same saved root and source.
      if (!request.refresh && !token && !request.seedPaperId && !request.offset) {
        const cached = [...this.resolutions].find(
          ([, entry]) =>
            entry.root &&
            entry.itemId === item.id &&
            entry.revision === item.metadataRevision &&
            entry.provider === result.provider &&
            entry.opencitationsMode === result.opencitationsMode
        )
        if (cached) [token, resolution] = cached
      }
      if (
        request.resolutionToken &&
        (!resolution ||
          resolution.itemId !== item.id ||
          resolution.revision !== item.metadataRevision)
      )
        throw new SourceError('expired')
      if (resolution) {
        // Keep reference snapshots and discovered capabilities private until the
        // complete page passes the final root, cancellation and expiry checks.
        if (resolution.provider === 'opencitations') resolution = { ...resolution }
        result.provider = resolution.provider
        result.opencitationsMode =
          resolution.provider === 'opencitations'
            ? (resolution.opencitationsMode ?? 'skg-if')
            : undefined
        if (
          request.provider &&
          (request.provider === 'auto' ? 'europe-pmc' : request.provider) !== resolution.provider
        )
          throw new SourceError('expired')
        if (request.opencitationsMode && request.opencitationsMode !== result.opencitationsMode)
          throw new SourceError('expired')
      }
      if (request.seedPaperId) {
        if (!resolution) throw new SourceError('expired')
        if (request.seedPaperId !== resolution.seed.paperId) {
          if (request.offset) throw new SourceError('expired')
          const seed = resolution.discovered.get(request.seedPaperId)
          if (!seed) throw new SourceError('expired')
          resolution = {
            ...resolution,
            root: false,
            bytes: 0,
            started: {},
            pages: new Map(),
            seed,
            opencitationsReferences: undefined,
            opencitationsIndexSnapshots: undefined,
            discovered: new Map(),
            expires: Date.now() + resolutionLifetimeMs
          }
          token = randomUUID()
          publish = true
        }
      }
      if (!resolution) {
        if (request.offset) throw new SourceError('expired')
        const attempt = async (
          provider: LiteratureRelatedProvider,
          attemptSignal: AbortSignal
        ): Promise<Resolution> => {
          result.provider = provider
          const savedSourceIds = async (): Promise<string[]> =>
            (await this.options.catalog.sources(item.id)).flatMap((entry) =>
              entry.provider === provider && entry.externalId ? [entry.externalId] : []
            )
          const read = (path: string, query: Record<string, string>): Promise<unknown> =>
            this.read(provider, path, query, attemptSignal)
          const found =
            provider === 'opencitations'
              ? request.opencitationsMode === 'index'
                ? {
                    seed: await resolveOpenCitationsIndex(item, read, await savedSourceIds())
                  }
                : await resolveOpenCitations(item, read, savedSourceIds)
              : {
                  seed: await resolveEuropePmc(item, read, savedSourceIds)
                }
          if (!found?.seed) throw new SourceError('no-match')
          const candidate: Resolution = {
            root: true,
            bytes: 0,
            started: {},
            pages: new Map(),
            itemId: item.id,
            revision: item.metadataRevision,
            seed: found.seed,
            opencitationsReferences: 'references' in found ? found.references : undefined,
            opencitationsMode:
              provider === 'opencitations' ? (request.opencitationsMode ?? 'skg-if') : undefined,
            provider,
            discovered: new Map(),
            expires: Date.now() + resolutionLifetimeMs
          }
          Object.assign(result, await this.page(candidate, request, attemptSignal))
          await check()
          attemptSignal.throwIfAborted()
          return candidate
        }
        resolution = await attempt(
          request.provider && request.provider !== 'auto' ? request.provider : 'europe-pmc',
          signal
        )
        token = randomUUID()
        publish = true
      } else {
        Object.assign(result, await this.page(resolution, request, signal))
        await check()
      }
      signal.throwIfAborted()
      if (resolution.expires <= Date.now()) throw new SourceError('expired')
      if (!publish && !this.resolutions.has(token!)) throw new SourceError('expired')
      if (!publish && resolution.provider === 'opencitations') {
        const current = this.resolutions.get(token!)
        const previous = current?.opencitationsReferences
        const snapshot = resolution.opencitationsReferences
        if (
          previous &&
          snapshot &&
          (previous.length !== snapshot.length ||
            previous.some((identity, index) => identity !== snapshot[index]))
        )
          throw new SourceError('response-invalid')
        if (current && snapshot) current.opencitationsReferences ??= snapshot
        for (const direction of ['references', 'citations'] as const) {
          const previous = current?.opencitationsIndexSnapshots?.[direction]
          const snapshot = resolution.opencitationsIndexSnapshots?.[direction]
          if (
            previous &&
            snapshot &&
            (previous.length !== snapshot.length ||
              previous.some(
                (entry, index) => JSON.stringify(entry) !== JSON.stringify(snapshot[index])
              ))
          )
            throw new SourceError('response-invalid')
        }
        if (current) {
          current.opencitationsIndexSnapshots = {
            ...current.opencitationsIndexSnapshots,
            ...resolution.opencitationsIndexSnapshots
          }
          resolution.opencitationsIndexSnapshots = current.opencitationsIndexSnapshots
          resolution.opencitationsReferences = current.opencitationsReferences
          resolution.root = current.root
        }
      }
      result.retrievedAt ??= Date.now()
      result.records = result.records.map((record) => ({
        ...record,
        retrievedAt: record.retrievedAt ?? result.retrievedAt
      }))
      resolution.seed = {
        ...resolution.seed,
        retrievedAt: resolution.seed.retrievedAt ?? result.retrievedAt
      }
      resolution.started[request.direction] ??= result.retrievedAt
      result.seed = resolution.seed
      result.provider = resolution.provider
      result.opencitationsMode =
        resolution.provider === 'opencitations'
          ? (resolution.opencitationsMode ?? 'skg-if')
          : undefined
      result.resolutionToken = token
      for (const entry of result.records) {
        resolution.discovered.delete(entry.paperId)
        resolution.discovered.set(entry.paperId, entry)
        if (resolution.discovered.size > maxDiscoveredRecords)
          resolution.discovered.delete(resolution.discovered.keys().next().value!)
      }
      // Retain only validated pages, under the same expiry as their exploration token.
      const pageKey = `${request.direction}:${request.offset}`
      resolution.pages.delete(pageKey)
      resolution.pages.set(pageKey, {
        records: result.records,
        nextOffset: result.nextOffset,
        omitted: result.omitted,
        retrievedAt: result.retrievedAt
      })
      if (resolution.pages.size > 10) resolution.pages.delete(resolution.pages.keys().next().value!)
      // A token only authorizes records from completed, root-revalidated pages.
      // A successful refresh replaces only cached root lookup selection; existing tokens
      // remain valid for other views until their own expiry or capacity eviction.
      if (request.refresh)
        for (const value of this.resolutions.values())
          if (
            value.root &&
            value.itemId === resolution.itemId &&
            value.revision === resolution.revision &&
            value.provider === resolution.provider &&
            value.opencitationsMode === resolution.opencitationsMode
          )
            value.root = false
      this.remember(token!, resolution)
    } catch (error) {
      callerSignal?.throwIfAborted()
      if (readContext.lastReportedError !== error)
        this.diagnose({
          provider: result.provider!,
          endpoint: readContext.trace?.endpoint ?? request.direction,
          phase: 'validation',
          attempt: readContext.trace?.attempt ?? 1,
          outcome: 'failed',
          status: readContext.trace?.status,
          bytes: readContext.trace?.bytes,
          issue: failureIssue(error, signal),
          elapsedMs: Math.max(0, Date.now() - (readContext.trace?.started ?? Date.now()))
        })
      return literatureRelatedResultSchema.parse({
        ...result,
        state: 'unavailable',
        records: [],
        nextOffset: undefined,
        issue: failureIssue(error, signal),
        retryAt: error instanceof SourceError ? error.retryAt : undefined
      })
    } finally {
      this.readContexts.delete(signal)
    }
    return literatureRelatedResultSchema.parse(result)
  }
}
