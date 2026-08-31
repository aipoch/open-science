import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import { migrationSqlExecutor } from '../database/migration-sql-executor'
import { createLogger } from '../logger'
import {
  LITERATURE_INDEX_SCHEMA_VERSION,
  literatureIndexSchemaObjects,
  literatureIndexSchemaStatements
} from './migrations/index-0001'

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
const MIN_RELATIVE_BM25_SCORE = 0.25
const MAX_RESULT_OVERLAP_RATIO = 0.5
const INDEX_IDLE_RETENTION = '-1 day'
const INDEX_ACCESS_FLUSH_INTERVAL_MS = 60 * 60 * 1000
const INDEX_RETENTION_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000
const MIN_INCREMENTAL_VACUUM_FREE_RATIO = 0.1
const MIN_INCREMENTAL_VACUUM_FREE_BYTES = 16 * 1024 * 1024
const MAX_INCREMENTAL_VACUUM_PAGES = 2_048
const HASH_PATTERN = /^[a-f0-9]{64}$/
const log = createLogger('literature-reading-context')
const pendingAccessesByPath = new Map<string, Set<string>>()
type IndexRetentionState = {
  activeSearches: number
  maintenance?: Promise<void>
  idleWaiters: Set<() => void>
}
const retentionStateByPath = new Map<string, IndexRetentionState>()

const retentionState = (indexPath: string): IndexRetentionState => {
  const current = retentionStateByPath.get(indexPath)
  if (current) return current
  const created: IndexRetentionState = { activeSearches: 0, idleWaiters: new Set() }
  retentionStateByPath.set(indexPath, created)
  return created
}

const withSearchRetentionGuard = async <T>(
  indexPath: string,
  operation: () => Promise<T>
): Promise<T> => {
  const state = retentionState(indexPath)
  while (state.maintenance) await state.maintenance
  state.activeSearches += 1
  try {
    return await operation()
  } finally {
    state.activeSearches -= 1
    if (state.activeSearches === 0) {
      for (const resolve of state.idleWaiters) resolve()
      state.idleWaiters.clear()
    }
  }
}

const withRetentionMaintenance = async <T>(
  indexPath: string,
  operation: () => Promise<T>
): Promise<T> => {
  const state = retentionState(indexPath)
  while (state.maintenance) await state.maintenance
  let releaseMaintenance!: () => void
  const maintenance = new Promise<void>((resolve) => {
    releaseMaintenance = resolve
  })
  state.maintenance = maintenance
  if (state.activeSearches > 0) {
    await new Promise<void>((resolve) => state.idleWaiters.add(resolve))
  }
  try {
    return await operation()
  } finally {
    if (state.maintenance === maintenance) {
      state.maintenance = undefined
      releaseMaintenance()
    }
  }
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const literatureIndexPath = (storageRoot: string): string =>
  join(storageRoot, 'literature', 'literature-fulltext.sqlite').replace(/\\/g, '/')

const createLiteratureIndexClient = (storageRoot: string): PrismaClient =>
  new PrismaClient({
    datasources: { db: { url: `file:${literatureIndexPath(storageRoot)}?connection_limit=1` } }
  })

const migrateLiteratureIndex = async (client: PrismaClient): Promise<void> => {
  await migrationSqlExecutor.execute(client, 'PRAGMA foreign_keys = ON')
  const [version] = await migrationSqlExecutor.query<Array<{ user_version: bigint | number }>>(
    client,
    'PRAGMA user_version'
  )
  const currentVersion = Number(version?.user_version ?? 0)
  if (currentVersion > LITERATURE_INDEX_SCHEMA_VERSION) {
    throw new Error(`Literature index schema version ${currentVersion} is not supported.`)
  }
  if (currentVersion === 0) {
    await migrationSqlExecutor.execute(client, 'PRAGMA auto_vacuum = INCREMENTAL')
    await client.$transaction(async (transaction) => {
      for (const statement of literatureIndexSchemaStatements) {
        await migrationSqlExecutor.execute(transaction, statement)
      }
      await migrationSqlExecutor.execute(
        transaction,
        `PRAGMA user_version = ${LITERATURE_INDEX_SCHEMA_VERSION}`
      )
    })
  }
  const rows = await migrationSqlExecutor.query<Array<{ name: string }>>(
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

class LiteratureFullTextIndex {
  private constructor(
    private readonly client: PrismaClient,
    private readonly indexPath: string
  ) {}

  static async open(storageRoot: string): Promise<LiteratureFullTextIndex> {
    await mkdir(join(storageRoot, 'literature'), { recursive: true })
    const client = createLiteratureIndexClient(storageRoot)
    try {
      await migrateLiteratureIndex(client)
      return new LiteratureFullTextIndex(client, literatureIndexPath(storageRoot))
    } catch (error) {
      await client.$disconnect()
      throw error
    }
  }

  static async sweepExpired(storageRoot: string): Promise<void> {
    const indexPath = literatureIndexPath(storageRoot)
    try {
      await access(indexPath)
    } catch (error) {
      if (isMissingFile(error)) {
        pendingAccessesByPath.delete(indexPath)
        return
      }
      throw error
    }
    await withRetentionMaintenance(indexPath, async () => {
      await LiteratureFullTextIndex.flushPendingAccesses(storageRoot)
      const index = await LiteratureFullTextIndex.open(storageRoot)
      try {
        await index.purgeExpired()
      } finally {
        await index.close()
      }
    })
  }

  static startRetentionSweep(
    storageRoot: string,
    onError: (error: unknown) => void,
    sweepIntervalMs: number = INDEX_RETENTION_SWEEP_INTERVAL_MS,
    flushIntervalMs: number = INDEX_ACCESS_FLUSH_INTERVAL_MS
  ): () => Promise<void> {
    let maintenance = Promise.resolve()
    const schedule = (operation: () => Promise<void>): void => {
      maintenance = maintenance.then(operation).catch((error) => {
        onError(error)
      })
    }
    schedule(() => LiteratureFullTextIndex.sweepExpired(storageRoot))
    const flushTimer = setInterval(
      () => schedule(() => LiteratureFullTextIndex.flushPendingAccesses(storageRoot)),
      flushIntervalMs
    )
    const sweepTimer = setInterval(
      () => schedule(() => LiteratureFullTextIndex.sweepExpired(storageRoot)),
      sweepIntervalMs
    )
    flushTimer.unref()
    sweepTimer.unref()
    return async () => {
      clearInterval(flushTimer)
      clearInterval(sweepTimer)
      await maintenance
      try {
        await LiteratureFullTextIndex.flushPendingAccesses(storageRoot)
      } catch (error) {
        onError(error)
      }
    }
  }

  static async flushPendingAccesses(storageRoot: string): Promise<void> {
    const indexPath = literatureIndexPath(storageRoot)
    const pending = pendingAccessesByPath.get(indexPath)
    if (!pending?.size) return
    const index = await LiteratureFullTextIndex.open(storageRoot)
    try {
      await index.flushPendingAccesses()
    } finally {
      await index.close()
    }
  }

  async close(): Promise<void> {
    await this.client.$disconnect()
  }

  async deleteExtraction(extractionId: string): Promise<void> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    await migrationSqlExecutor.execute(
      this.client,
      `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
      extractionId
    )
  }

  async hasExtraction(extractionId: string): Promise<boolean> {
    if (!extractionId.trim()) throw new Error('Literature extraction identity is invalid.')
    const rows = await migrationSqlExecutor.query<Array<{ present: bigint | number }>>(
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
    await this.client.$transaction(async (transaction) => {
      await migrationSqlExecutor.execute(
        transaction,
        `DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?`,
        input.extractionId
      )
      await migrationSqlExecutor.execute(
        transaction,
        `INSERT INTO "LiteratureIndexDocument" ("extractionId", "documentChecksum", "extractorFingerprint", "indexSchemaVersion", "chunkCount") VALUES (?, ?, ?, ?, ?)`,
        input.extractionId,
        input.documentChecksum,
        input.extractorFingerprint,
        LITERATURE_INDEX_SCHEMA_VERSION,
        input.chunks.length
      )
      for (const chunk of input.chunks) {
        await migrationSqlExecutor.execute(
          transaction,
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
      log.info('Literature BM25 search skipped', {
        reason: 'invalid-extraction-count',
        extractionCount: input.extractionIds.length,
        bm25Used: false,
        bm25ResultCount: 0
      })
      return []
    }
    const query = normalizeSearchQuery(input.query)
    if (!query) {
      log.info('Literature BM25 search skipped', {
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
    return withSearchRetentionGuard(this.indexPath, async () => {
      const rows = await migrationSqlExecutor.query<
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
      const qualified = candidates.filter(
        ({ relativeScore }, index) => index === 0 || relativeScore >= MIN_RELATIVE_BM25_SCORE
      )
      const results: LiteratureSearchResult[] = []
      let overlapFilteredCount = 0
      for (const candidate of qualified) {
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
      log.info('Literature BM25 search completed', {
        extractionCount: input.extractionIds.length,
        queryLength: input.query.length,
        limit,
        candidateLimit,
        candidateCount: candidates.length,
        relativeScoreThreshold: MIN_RELATIVE_BM25_SCORE,
        qualityFilteredCount: candidates.length - qualified.length,
        overlapFilteredCount,
        bestRank: candidates[0]?.rank ?? null,
        lowestReturnedRelativeScore: results.at(-1)?.relativeScore ?? null,
        bm25Used: true,
        bm25ResultCount: results.length
      })
      return results
    })
  }

  private async purgeExpired(): Promise<void> {
    const startedAt = Date.now()
    await migrationSqlExecutor.execute(
      this.client,
      `DELETE FROM "LiteratureIndexDocument" WHERE "lastAccessedAt" < datetime('now', '${INDEX_IDLE_RETENTION}')`
    )
    const rows = await migrationSqlExecutor.query<Array<{ count: bigint | number }>>(
      this.client,
      `SELECT changes() AS "count"`
    )
    const count = Number(rows[0]?.count ?? 0)
    if (count === 0) return
    const [storage] = await migrationSqlExecutor.query<
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
      await migrationSqlExecutor.execute(
        this.client,
        `PRAGMA incremental_vacuum(${MAX_INCREMENTAL_VACUUM_PAGES})`
      )
      const [after] = await migrationSqlExecutor.query<Array<{ freePages: bigint | number }>>(
        this.client,
        `SELECT "freelist_count" AS "freePages" FROM pragma_freelist_count`
      )
      reclaimedPages = Math.max(0, freePagesBefore - Number(after?.freePages ?? freePagesBefore))
    }
    log.info('Expired Literature indexes purged', {
      count,
      databaseBytes: pageSize * pageCount,
      freeBytes,
      freeRatio,
      reclaimedPages,
      durationMs: Date.now() - startedAt
    })
  }

  private markAccess(extractionIds: readonly string[]): void {
    const pending = pendingAccessesByPath.get(this.indexPath) ?? new Set<string>()
    for (const extractionId of extractionIds) pending.add(extractionId)
    pendingAccessesByPath.set(this.indexPath, pending)
  }

  private async flushPendingAccesses(): Promise<void> {
    const pending = pendingAccessesByPath.get(this.indexPath)
    if (!pending?.size) return
    const extractionIds = [...pending]
    pendingAccessesByPath.delete(this.indexPath)
    try {
      await migrationSqlExecutor.execute(
        this.client,
        `UPDATE "LiteratureIndexDocument" SET "lastAccessedAt" = CURRENT_TIMESTAMP WHERE "extractionId" IN (${extractionIds.map(() => '?').join(', ')})`,
        ...extractionIds
      )
    } catch (error) {
      const retry = pendingAccessesByPath.get(this.indexPath) ?? new Set<string>()
      for (const extractionId of extractionIds) retry.add(extractionId)
      pendingAccessesByPath.set(this.indexPath, retry)
      throw error
    }
  }
}

export { LiteratureFullTextIndex, literatureIndexPath }
export type {
  LiteratureIndexChunk,
  LiteratureSearchResult,
  ReplaceLiteratureIndexInput,
  SearchLiteratureIndexInput
}
