import type { TranslationTransaction, TranslationStoredCheckpoint } from './storage.js'

/** Version 1 owns the PdfTranslation / PdfTranslationBlock SQL representation, including JSON projections. */
export const PDF_TRANSLATION_SQLITE_SCHEMA_VERSION = 1
export type TranslationSqliteStatement = {
  strings: TemplateStringsArray
  values: readonly (string | number | bigint | Date | null)[]
}
export interface TranslationSqliteExecutor {
  query<T>(statement: TranslationSqliteStatement): Promise<T>
  execute(statement: TranslationSqliteStatement): Promise<number>
}
/** Optional identity compatibility codec; all other checkpoint fields must round-trip unchanged. */
export interface TranslationPayloadCodec {
  encode(payload: string): string
  decode(payload: string): string
}
const identityCodec: TranslationPayloadCodec = {
  encode: (value) => value,
  decode: (value) => value
}
const sql = (
  strings: TemplateStringsArray,
  ...values: TranslationSqliteStatement['values']
): TranslationSqliteStatement => ({ strings, values })

/** The executor MUST be bound to one atomic transaction; the caller owns connection and source authority. */
export function createSqliteTranslationTransaction(
  tx: TranslationSqliteExecutor,
  authority: Pick<TranslationTransaction, 'requireSource' | 'requireDocument'>,
  codec: TranslationPayloadCodec = identityCodec
): TranslationTransaction {
  const read: TranslationTransaction['read'] = async (id, contentId) => {
    const [row] = await tx.query<Omit<TranslationStoredCheckpoint, 'blocks'>[]>(sql`
      SELECT "id","pdfDocumentId" AS "contentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson"
      FROM "PdfTranslation" WHERE "id"=${id} AND (${contentId ?? null} IS NULL OR "pdfDocumentId"=${contentId ?? null})`)
    if (!row) return null
    const blocks = await tx.query<TranslationStoredCheckpoint['blocks']>(sql`
      SELECT "sourceIndex","translation","revision" FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
    return { ...row, payloadJson: codec.decode(row.payloadJson), blocks }
  }
  return {
    ...authority,
    read,
    async findLatest(contentId, key) {
      const [row] = await tx.query<{ id: string }[]>(sql`
        SELECT "id" FROM "PdfTranslation" WHERE "pdfDocumentId"=${contentId}
        AND (${key ?? null} IS NULL OR json_extract("payloadJson", '$.key')=${key ?? null})
        ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`)
      return row ? read(row.id) : null
    },
    list: (contentId) =>
      tx.query(sql`
      SELECT "id",json_extract("payloadJson", '$.key') AS "key",
        json_extract("payloadJson", '$.language') AS "language",
        json_extract("payloadJson", '$.glossary') AS "glossary",
        coalesce(json_extract("payloadJson", '$.concurrency'),1) AS "concurrency",
        json_extract("payloadJson", '$.model') AS "model","updatedAt"
      FROM "PdfTranslation" WHERE "pdfDocumentId"=${contentId} ORDER BY "createdAt" DESC,"id" DESC`),
    async delete(id, contentId) {
      return (
        (await tx.execute(
          sql`DELETE FROM "PdfTranslation" WHERE "id"=${id} AND "pdfDocumentId"=${contentId}`
        )) === 1
      )
    },
    async insert(row) {
      await tx.execute(sql`INSERT INTO "PdfTranslation" ("id","pdfDocumentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson","createdAt","updatedAt")
        VALUES (${row.id},${row.contentId},${row.checksum},${row.sizeBytes},${row.revision},${codec.encode(row.payloadJson)},${row.layoutSnapshotJson},${new Date()},${new Date()})`)
    },
    async readHeader(id) {
      const [row] = await tx.query<
        Pick<TranslationStoredCheckpoint, 'contentId' | 'checksum' | 'sizeBytes'>[]
      >(sql`
        SELECT "pdfDocumentId" AS "contentId","checksum","sizeBytes" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row ?? null
    },
    async readBase(id) {
      const [row] = await tx.query<
        { payloadJson: string; layoutSnapshotJson: string | null }[]
      >(sql`
        SELECT "payloadJson","layoutSnapshotJson" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row ? { ...row, payloadJson: codec.decode(row.payloadJson) } : null
    },
    async readLayoutReports(id) {
      const [row] = await tx.query<{ reports: string | null }[]>(sql`
        SELECT json_extract("payloadJson", '$.layoutReports') AS reports FROM "PdfTranslation" WHERE "id"=${id}`)
      return row?.reports ?? null
    },
    async pinLayout(id, snapshotJson) {
      await tx.execute(
        sql`UPDATE "PdfTranslation" SET "layoutSnapshotJson"=${snapshotJson} WHERE "id"=${id} AND "layoutSnapshotJson" IS NULL`
      )
    },
    async updatePayload(id, payloadJson) {
      await tx.execute(
        sql`UPDATE "PdfTranslation" SET "payloadJson"=${codec.encode(payloadJson)},"updatedAt"=${new Date()} WHERE "id"=${id}`
      )
    },
    async commit(id, expectedRevision, change) {
      const state = await tx.query<{ revision: number }[]>(sql`
        SELECT revision FROM "PdfTranslationBlock" WHERE "translationId"=${id} AND "sourceIndex"=-1`)
      const base = change.base
      // Incremental writes require an existing live revision row.
      if (!state.length && !base) return false
      const updated = state.length
        ? await tx.execute(sql`UPDATE "PdfTranslationBlock" SET revision=${change.revision}
            WHERE "translationId"=${id} AND "sourceIndex"=-1 AND revision=${expectedRevision}`)
        : await tx.execute(sql`UPDATE "PdfTranslation" SET revision=${change.revision},"payloadJson"=${codec.encode(base!.payloadJson)},"updatedAt"=${new Date()}
            WHERE "id"=${id} AND revision=${expectedRevision}`)
      if (updated !== 1) return false
      if (base) {
        await tx.execute(
          sql`UPDATE "PdfTranslation" SET revision=${change.revision},"payloadJson"=${codec.encode(base.payloadJson)},"layoutSnapshotJson"=${base.layoutSnapshotJson},"updatedAt"=${new Date()} WHERE "id"=${id}`
        )
        await tx.execute(sql`DELETE FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
        await tx.execute(
          sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision") VALUES (${id},-1,${change.revision})`
        )
      } else if (change.block) {
        const block = change.block
        await tx.execute(sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision","translation") VALUES (${id},${block.sourceIndex},${change.revision},${block.translation})
          ON CONFLICT ("translationId","sourceIndex") DO UPDATE SET revision=excluded.revision,translation=excluded.translation`)
        if (change.layoutReportsJson !== undefined)
          await tx.execute(sql`
          UPDATE "PdfTranslation" SET "payloadJson"=json_set("payloadJson", '$.layoutReports',json(${change.layoutReportsJson})) WHERE "id"=${id}`)
        await tx.execute(
          sql`UPDATE "PdfTranslation" SET "updatedAt"=${new Date()} WHERE "id"=${id}`
        )
      }
      return true
    }
  }
}
