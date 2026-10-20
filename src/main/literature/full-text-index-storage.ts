import { createHash } from 'node:crypto'
import type {
  LiteratureIndexStore,
  ReplaceLiteratureIndexInput,
  LiteratureIndexCandidate
} from '@aipoch/literature-reading'
import {
  LITERATURE_INDEX_SCHEMA_VERSION,
  literatureIndexSchemaObjects,
  literatureIndexSchemaStatements
} from './full-text-index-schema'
export interface IndexDatabase {
  execute(sql: string, ...values: unknown[]): Promise<number>
  query<T>(sql: string, ...values: unknown[]): Promise<T>
  transaction<T>(operation: (db: IndexDatabase) => Promise<T>): Promise<T>
  close(): Promise<void>
}
const querySql = <T>(db: IndexDatabase, sql: string, ...values: unknown[]): Promise<T> =>
  db.query<T>(sql, ...values)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const INDEX_IDLE_RETENTION = '-1 day'
const MIN_INCREMENTAL_VACUUM_FREE_RATIO = 0.1
const MIN_INCREMENTAL_VACUUM_FREE_BYTES = 16 * 1024 * 1024
const MAX_INCREMENTAL_VACUUM_PAGES = 2_048
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

/** The host owns connection admission, migration, SQL dialect and physical retention. */
export async function openSqliteLiteratureIndex(
  client: IndexDatabase,
  log: (message: string, fields: Record<string, unknown>) => void
): Promise<LiteratureIndexStore> {
  try {
    await migrateLiteratureIndex(client)
  } catch (error) {
    await client.close()
    throw error
  }
  return {
    close: () => client.close(),
    async deleteExtraction(extractionId) {
      await client.execute(
        'DELETE FROM "LiteratureIndexDocument" WHERE "extractionId" = ?',
        extractionId
      )
    },
    async hasExtraction(extractionId) {
      const [row] = await client.query<{ present: number | bigint }[]>(
        'SELECT EXISTS(SELECT 1 FROM "LiteratureIndexDocument" WHERE "extractionId" = ?) AS "present"',
        extractionId
      )
      return Number(row?.present ?? 0) === 1
    },
    async replace(input: ReplaceLiteratureIndexInput) {
      await client.transaction(async (transaction) => {
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
    },
    async search(input) {
      const query = input.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
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
        client,
        `SELECT chunk."extractionId", chunk."pageStart", chunk."pageEnd", chunk."textStart", chunk."textEnd", chunk."sectionTitle", chunk."content", bm25("LiteratureIndexChunkFts", 2.0, 1.0) AS "rank"
       FROM "LiteratureIndexChunkFts"
       JOIN "LiteratureIndexChunk" AS chunk ON chunk."id" = "LiteratureIndexChunkFts"."rowid"
       WHERE "LiteratureIndexChunkFts" MATCH ? AND chunk."extractionId" IN (${input.extractionIds.map(() => '?').join(', ')})
       ORDER BY "rank" ASC, chunk."id" ASC
       LIMIT ?`,
        query,
        ...input.extractionIds,
        input.limit
      )
      return rows.map(({ sectionTitle, ...row }): LiteratureIndexCandidate => ({
        ...row,
        ...(sectionTitle ? { sectionTitle } : {})
      }))
    },
    async purgeExpired() {
      const startedAt = Date.now()
      await client.execute(
        `DELETE FROM "LiteratureIndexDocument" WHERE "lastAccessedAt" < datetime('now', '${INDEX_IDLE_RETENTION}')`
      )
      const rows = await querySql<Array<{ count: bigint | number }>>(
        client,
        `SELECT changes() AS "count"`
      )
      const count = Number(rows[0]?.count ?? 0)
      if (count === 0) return
      const [storage] = await querySql<
        Array<{ pageSize: bigint | number; pageCount: bigint | number; freePages: bigint | number }>
      >(
        client,
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
        await client.execute(`PRAGMA incremental_vacuum(${MAX_INCREMENTAL_VACUUM_PAGES})`)
        const [after] = await querySql<Array<{ freePages: bigint | number }>>(
          client,
          `SELECT "freelist_count" AS "freePages" FROM pragma_freelist_count`
        )
        reclaimedPages = Math.max(0, freePagesBefore - Number(after?.freePages ?? freePagesBefore))
      }
      log('Expired Literature indexes purged', {
        count,
        databaseBytes: pageSize * pageCount,
        freeBytes,
        freeRatio,
        reclaimedPages,
        durationMs: Date.now() - startedAt
      })
    },
    async touch(extractionIds) {
      await client.execute(
        `UPDATE "LiteratureIndexDocument" SET "lastAccessedAt" = CURRENT_TIMESTAMP WHERE "extractionId" IN (${extractionIds.map(() => '?').join(', ')})`,
        ...extractionIds
      )
    }
  }
}
