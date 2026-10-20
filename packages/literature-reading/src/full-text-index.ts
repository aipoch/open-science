import type { LiteratureIndexStore, IndexOptions } from './ports.js'
type LiteratureIndexChunk = Readonly<{
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  content: string
}>

type ReplaceLiteratureIndexInput = Readonly<{
  extractionId: string
  documentChecksum: string
  extractorFingerprint: string
  chunks: readonly LiteratureIndexChunk[]
}>

type LiteratureSearchResult = Readonly<{
  extractionId: string
  pageStart: number
  pageEnd: number
  textStart: number
  textEnd: number
  sectionTitle?: string
  content: string
  rank: number
  relativeScore: number
}>

type SearchLiteratureIndexInput = Readonly<{
  extractionIds: readonly string[]
  query: string
  limit?: number
}>

const MAX_INDEX_CHUNKS = 20_000
const MAX_CHUNK_CHARS = 12_000
const MAX_SECTION_TITLE_CHARS = 1_024
const MAX_QUERY_TERMS = 16
const MAX_SEARCH_RESULTS = 20
const SEARCH_CANDIDATE_MULTIPLIER = 3
const MAX_RESULT_OVERLAP_RATIO = 0.5
const INDEX_ACCESS_FLUSH_INTERVAL_MS = 60 * 60 * 1000
const INDEX_RETENTION_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000
const HASH_PATTERN = /^[a-f0-9]{64}$/

const normalizeSearchQuery = (query: string): string[] =>
  query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_QUERY_TERMS) ?? []

const resultOverlapRatio = (
  left: Pick<LiteratureSearchResult, 'extractionId' | 'textStart' | 'textEnd'>,
  right: Pick<LiteratureSearchResult, 'extractionId' | 'textStart' | 'textEnd'>
): number => {
  if (left.extractionId !== right.extractionId) return 0
  const intersection = Math.max(
    0,
    Math.min(left.textEnd, right.textEnd) - Math.max(left.textStart, right.textStart)
  )
  const shorterLength = Math.min(left.textEnd - left.textStart, right.textEnd - right.textStart)
  return shorterLength > 0 ? intersection / shorterLength : 0
}

const withRelativeScore = <T extends { rank: number }>(
  candidate: T,
  bestRank: number
): T & { relativeScore: number } => {
  const bestMagnitude = Math.abs(bestRank)
  const candidateMagnitude = Math.abs(candidate.rank)
  const relativeScore =
    Number.isFinite(bestMagnitude) && bestMagnitude > 0
      ? Math.min(candidateMagnitude / bestMagnitude, 1)
      : 1
  return { ...candidate, relativeScore }
}

export class LiteratureFullTextIndex {
  constructor(
    private readonly client: LiteratureIndexStore,
    private readonly owner: LiteratureIndex
  ) {}

  async close(): Promise<void> {
    await this.client.close()
  }

  async deleteExtraction(extractionId: string): Promise<void> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    await this.client.deleteExtraction(extractionId)
  }

  async hasExtraction(extractionId: string): Promise<boolean> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    return this.client.hasExtraction(extractionId)
  }

  async replace(input: ReplaceLiteratureIndexInput): Promise<void> {
    if (
      !input.extractionId.trim() ||
      !HASH_PATTERN.test(input.documentChecksum) ||
      !HASH_PATTERN.test(input.extractorFingerprint) ||
      input.chunks.length > MAX_INDEX_CHUNKS ||
      input.chunks.some(
        (chunk) =>
          !Number.isSafeInteger(chunk.pageStart) ||
          !Number.isSafeInteger(chunk.pageEnd) ||
          chunk.pageStart < 1 ||
          chunk.pageEnd < chunk.pageStart ||
          !Number.isSafeInteger(chunk.textStart) ||
          !Number.isSafeInteger(chunk.textEnd) ||
          chunk.textStart < 0 ||
          chunk.textEnd < chunk.textStart ||
          !chunk.content.trim() ||
          chunk.content.length > MAX_CHUNK_CHARS ||
          (chunk.sectionTitle?.length ?? 0) > MAX_SECTION_TITLE_CHARS
      )
    ) {
      throw new Error('Literature index input is invalid.')
    }
    await this.client.replace(input)
  }

  async search(input: SearchLiteratureIndexInput): Promise<LiteratureSearchResult[]> {
    if (input.extractionIds.length === 0 || input.extractionIds.length > 3) {
      this.owner.log('Literature BM25 search skipped', {
        reason: 'invalid-extraction-count',
        extractionCount: input.extractionIds.length,
        bm25Used: false,
        bm25ResultCount: 0
      })
      return []
    }
    const query = normalizeSearchQuery(input.query)
    if (!query.length) {
      this.owner.log('Literature BM25 search skipped', {
        reason: 'empty-query',
        extractionCount: input.extractionIds.length,
        queryLength: input.query.length,
        bm25Used: false,
        bm25ResultCount: 0
      })
      return []
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_SEARCH_RESULTS)
    const candidateLimit = Math.min(limit * SEARCH_CANDIDATE_MULTIPLIER, MAX_SEARCH_RESULTS)
    return this.owner.withSearch(async () => {
      const rows = await this.client.search({
        extractionIds: input.extractionIds,
        terms: query,
        limit: candidateLimit
      })
      this.markAccess(input.extractionIds)
      const candidates = rows.map(({ sectionTitle, ...row }) =>
        withRelativeScore(
          {
            ...row,
            ...(sectionTitle ? { sectionTitle } : {})
          },
          rows[0]?.rank ?? 0
        )
      )
      // BM25 statistics cover the shared index, so relative scores must not exclude
      // matching evidence merely because unselected documents were indexed or removed.
      const results: LiteratureSearchResult[] = []
      let overlapFilteredCount = 0
      for (const candidate of candidates) {
        const overlapsSelected = results.some(
          (selected) => resultOverlapRatio(candidate, selected) >= MAX_RESULT_OVERLAP_RATIO
        )
        if (overlapsSelected) {
          overlapFilteredCount += 1
          continue
        }
        results.push(candidate)
        if (results.length === limit) break
      }
      this.owner.log('Literature BM25 search completed', {
        extractionCount: input.extractionIds.length,
        queryLength: input.query.length,
        limit,
        candidateLimit,
        candidateCount: candidates.length,
        overlapFilteredCount,
        bestRank: candidates[0]?.rank ?? null,
        lowestReturnedRelativeScore: results.at(-1)?.relativeScore ?? null,
        bm25Used: true,
        bm25ResultCount: results.length
      })
      return results
    })
  }

  async purgeExpired(): Promise<void> {
    await this.client.purgeExpired()
  }

  private markAccess(extractionIds: readonly string[]): void {
    const pending = this.owner.pendingAccesses ?? new Set<string>()
    for (const extractionId of extractionIds) pending.add(extractionId)
    this.owner.pendingAccesses = pending
  }

  async flushPendingAccesses(): Promise<void> {
    const pending = this.owner.pendingAccesses
    if (!pending?.size) return
    const extractionIds = [...pending]
    this.owner.pendingAccesses = new Set()
    try {
      await this.client.touch(extractionIds)
    } catch (error) {
      const retry = this.owner.pendingAccesses ?? new Set<string>()
      for (const extractionId of extractionIds) retry.add(extractionId)
      this.owner.pendingAccesses = retry
      throw error
    }
  }
}

export type {
  LiteratureIndexChunk,
  LiteratureSearchResult,
  ReplaceLiteratureIndexInput,
  SearchLiteratureIndexInput
}

/** One owner per shared index. All handles, searches and retention share this lifecycle. */
export class LiteratureIndex {
  pendingAccesses = new Set<string>()
  private activeSearches = 0
  private maintenance?: Promise<void>
  private idleWaiters = new Set<() => void>()
  constructor(private readonly options: IndexOptions) {}
  log(message: string, fields: Record<string, unknown>): void {
    this.options.log?.(message, fields)
  }
  async open(): Promise<LiteratureFullTextIndex> {
    return new LiteratureFullTextIndex(await this.options.open(), this)
  }

  async withSearch<T>(operation: () => Promise<T>): Promise<T> {
    while (this.maintenance) await this.maintenance
    this.activeSearches++
    try {
      return await operation()
    } finally {
      if (--this.activeSearches === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }
  async sweepExpired(): Promise<void> {
    if (!(await this.options.exists())) {
      this.pendingAccesses.clear()
      return
    }
    while (this.maintenance) await this.maintenance
    let release!: () => void
    this.maintenance = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      if (this.activeSearches) await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
      await this.flushPendingAccesses()
      const index = await this.open()
      try {
        await index.purgeExpired()
      } finally {
        await index.close()
      }
    } finally {
      this.maintenance = undefined
      release()
    }
  }
  async flushPendingAccesses(): Promise<void> {
    if (!this.pendingAccesses.size) return
    const index = await this.open()
    try {
      await index.flushPendingAccesses()
    } finally {
      await index.close()
    }
  }
  startRetentionSweep(
    onError: (error: unknown) => void,
    sweepIntervalMs = INDEX_RETENTION_SWEEP_INTERVAL_MS,
    flushIntervalMs = INDEX_ACCESS_FLUSH_INTERVAL_MS
  ): () => Promise<void> {
    let maintenance = Promise.resolve()
    const schedule = (operation: () => Promise<void>): void => {
      maintenance = maintenance
        .then(() => (this.options.maintenance ? this.options.maintenance(operation) : operation()))
        .catch(onError)
    }
    schedule(() => this.sweepExpired())
    const flushTimer = setInterval(
      () => schedule(() => this.flushPendingAccesses()),
      flushIntervalMs
    )
    const sweepTimer = setInterval(() => schedule(() => this.sweepExpired()), sweepIntervalMs)
    flushTimer.unref()
    sweepTimer.unref()
    return async () => {
      clearInterval(flushTimer)
      clearInterval(sweepTimer)
      schedule(() => this.flushPendingAccesses())
      await maintenance
    }
  }
}
