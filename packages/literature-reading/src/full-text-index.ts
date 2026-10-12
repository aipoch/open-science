import { createHash } from 'node:crypto'
import type { IndexDatabase, IndexOptions } from './ports.js'
import {
  LITERATURE_INDEX_SCHEMA_VERSION,
  literatureIndexSchemaObjects,
  literatureIndexSchemaStatements
} from './schema.js'
const querySql = <T>(db: IndexDatabase, sql: string, ...values: unknown[]): Promise<T> =>
  db.query<T>(sql, ...values)
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
const INDEX_IDLE_RETENTION = '-1 day'
const INDEX_ACCESS_FLUSH_INTERVAL_MS = 60 * 60 * 1000
const INDEX_RETENTION_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000
const MIN_INCREMENTAL_VACUUM_FREE_RATIO = 0.1
const MIN_INCREMENTAL_VACUUM_FREE_BYTES = 16 * 1024 * 1024
const MAX_INCREMENTAL_VACUUM_PAGES = 2_048
const HASH_PATTERN = /^[a-f0-9]{64}$/

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const migrateLiteratureIndex = async (client: IndexDatabase): Promise<void> => {
  await client.execute('PRAGMA foreign_keys = ON')
  const [version] = await querySql<Array<{ user_version: bigint | number }>>(
    client,
    'PRAGMA user_version'
  )
  const currentVersion = Number(version?.user_version ?? 0)
  if (currentVersion > LITERATURE_INDEX_SCHEMA_VERSION) {
    throw new Error(`Literature index schema version ${currentVersion} is not supported.`)
  }
  if (currentVersion === 0) {
    await client.execute('PRAGMA auto_vacuum = INCREMENTAL')
    await client.transaction(async (transaction) => {
      for (const statement of literatureIndexSchemaStatements) {
        await transaction.execute(statement)
      }
      await transaction.execute(`PRAGMA user_version = ${LITERATURE_INDEX_SCHEMA_VERSION}`)
    })
  }
  const rows = await querySql<Array<{ name: string }>>(
    client,
    `SELECT "name" FROM "sqlite_schema" WHERE "name" IN (${literatureIndexSchemaObjects.map(() => '?').join(', ')})`,
    ...literatureIndexSchemaObjects
  )
  const names = new Set(rows.map(({ name }) => name))
  if (literatureIndexSchemaObjects.some((name) => !names.has(name))) {
    throw new Error('Literature index schema is incomplete.')
  }
}

const normalizeSearchQuery = (query: string): string | undefined => {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_QUERY_TERMS) ?? []
  return terms.length > 0
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    : undefined
}

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
    private readonly client: IndexDatabase,
    private readonly owner: LiteratureIndex
  ) {}

  async close(): Promise<void> {
    await this.client.close()
  }

  async deleteExtraction(extractionId: string): Promise<void> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    await this.client.execute(
      `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
      extractionId
    )
  }

  async hasExtraction(extractionId: string): Promise<boolean> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    const rows = await querySql<Array<{ present: bigint | number }>>(
      this.client,
      `SELECT EXISTS(SELECT 1 FROM "LiteratureIndexDocument" WHERE "extractionId" = ?) AS "present"`,
      extractionId
    )
    return Number(rows[0]?.present ?? 0) === 1
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
    await this.client.transaction(async (transaction) => {
      await transaction.execute(
        `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
        input.extractionId
      )
      await transaction.execute(
        `INSERT INTO "LiteratureIndexDocument" ("extractionId", "documentChecksum", "extractorFingerprint", "indexSchemaVersion", "chunkCount") VALUES (?, ?, ?, ?, ?)`,
        input.extractionId,
        input.documentChecksum,
        input.extractorFingerprint,
        LITERATURE_INDEX_SCHEMA_VERSION,
        input.chunks.length
      )
      for (const chunk of input.chunks) {
        await transaction.execute(
          `INSERT INTO "LiteratureIndexChunk" ("extractionId", "pageStart", "pageEnd", "textStart", "textEnd", "sectionTitle", "content", "contentChecksum") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.extractionId,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.textStart,
          chunk.textEnd,
          chunk.sectionTitle ?? null,
          chunk.content,
          sha256(chunk.content)
        )
      }
    })
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
    if (!query) {
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
      const rows = await querySql<
        Array<{
          extractionId: string
          pageStart: number
          pageEnd: number
          textStart: number
          textEnd: number
          sectionTitle: string | null
          content: string
          rank: number
        }>
      >(
        this.client,
        `SELECT chunk."extractionId", chunk."pageStart", chunk."pageEnd", chunk."textStart", chunk."textEnd", chunk."sectionTitle", chunk."content", bm25("LiteratureIndexChunkFts", 2.0, 1.0) AS "rank"
       FROM "LiteratureIndexChunkFts"
       JOIN "LiteratureIndexChunk" AS chunk ON chunk."id" = "LiteratureIndexChunkFts"."rowid"
       WHERE "LiteratureIndexChunkFts" MATCH ? AND chunk."extractionId" IN (${input.extractionIds.map(() => '?').join(', ')})
       ORDER BY "rank" ASC, chunk."id" ASC
       LIMIT ?`,
        query,
        ...input.extractionIds,
        candidateLimit
      )
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
    const startedAt = Date.now()
    await this.client.execute(
      `DELETE FROM "LiteratureIndexDocument" WHERE "lastAccessedAt" < datetime('now', '${INDEX_IDLE_RETENTION}')`
    )
    const rows = await querySql<Array<{ count: bigint | number }>>(
      this.client,
      `SELECT changes() AS "count"`
    )
    const count = Number(rows[0]?.count ?? 0)
    if (count === 0) return
    const [storage] = await querySql<
      Array<{ pageSize: bigint | number; pageCount: bigint | number; freePages: bigint | number }>
    >(
      this.client,
      `SELECT (SELECT "page_size" FROM pragma_page_size) AS "pageSize", (SELECT "page_count" FROM pragma_page_count) AS "pageCount", (SELECT "freelist_count" FROM pragma_freelist_count) AS "freePages"`
    )
    const pageSize = Number(storage?.pageSize ?? 0)
    const pageCount = Number(storage?.pageCount ?? 0)
    const freePagesBefore = Number(storage?.freePages ?? 0)
    const freeBytes = pageSize * freePagesBefore
    const freeRatio = pageCount > 0 ? freePagesBefore / pageCount : 0
    let reclaimedPages = 0
    if (
      freeBytes >= MIN_INCREMENTAL_VACUUM_FREE_BYTES &&
      freeRatio >= MIN_INCREMENTAL_VACUUM_FREE_RATIO
    ) {
      await this.client.execute(`PRAGMA incremental_vacuum(${MAX_INCREMENTAL_VACUUM_PAGES})`)
      const [after] = await querySql<Array<{ freePages: bigint | number }>>(
        this.client,
        `SELECT "freelist_count" AS "freePages" FROM pragma_freelist_count`
      )
      reclaimedPages = Math.max(0, freePagesBefore - Number(after?.freePages ?? freePagesBefore))
    }
    this.owner.log('Expired Literature indexes purged', {
      count,
      databaseBytes: pageSize * pageCount,
      freeBytes,
      freeRatio,
      reclaimedPages,
      durationMs: Date.now() - startedAt
    })
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
      await this.client.execute(
        `UPDATE "LiteratureIndexDocument" SET "lastAccessedAt" = CURRENT_TIMESTAMP WHERE "extractionId" IN (${extractionIds.map(() => '?').join(', ')})`,
        ...extractionIds
      )
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

/** One owner per physical database. All handles, searches and retention share this lifecycle. */
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
    const db = await this.options.open()
    try {
      await migrateLiteratureIndex(db)
      return new LiteratureFullTextIndex(db, this)
    } catch (error) {
      await db.close()
      throw error
    }
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
