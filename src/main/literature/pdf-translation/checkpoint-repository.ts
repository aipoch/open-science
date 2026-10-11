import type { Prisma } from '@prisma/client'
import { Prisma as SQL } from '@prisma/client'
import type {
  TranslationTransaction,
  TranslationStoredCheckpoint
} from '@aipoch/pdf-translation/storage'
import {
  fromPackageCheckpoint,
  toPackageCheckpoint,
  pdfTranslationCheckpointSchema
} from '../../../shared/pdf-translation'
import { pdfTranslationCheckpointSchema as packageCheckpointSchema } from '@aipoch/pdf-translation/contracts'

// Persist the established host representation. Package IDs never become database/IPC fields.
const encode = (payload: string): string =>
  JSON.stringify(fromPackageCheckpoint(packageCheckpointSchema.parse(JSON.parse(payload))))
const decode = (payload: string): string =>
  JSON.stringify(toPackageCheckpoint(pdfTranslationCheckpointSchema.parse(JSON.parse(payload))))
type SourceAuthority = Pick<TranslationTransaction, 'requireSource' | 'requireDocument'>
export function translationTransaction(
  tx: Prisma.TransactionClient,
  authority: SourceAuthority
): TranslationTransaction {
  const read: TranslationTransaction['read'] = async (id, contentId) => {
    const [row] = await tx.$queryRaw<Omit<TranslationStoredCheckpoint, 'blocks'>[]>(SQL.sql`
      SELECT "id","pdfDocumentId" AS "contentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson"
      FROM "PdfTranslation" WHERE "id"=${id} ${contentId === undefined ? SQL.empty : SQL.sql`AND "pdfDocumentId"=${contentId}`}`)
    if (!row) return null
    const blocks = await tx.$queryRaw<TranslationStoredCheckpoint['blocks']>(SQL.sql`
      SELECT "sourceIndex","translation","revision" FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
    return { ...row, payloadJson: decode(row.payloadJson), blocks }
  }
  return {
    ...authority,
    read,
    async findLatest(contentId, key) {
      const [row] = await tx.$queryRaw<{ id: string }[]>(SQL.sql`
        SELECT "id" FROM "PdfTranslation" WHERE "pdfDocumentId"=${contentId}
        ${key === undefined ? SQL.empty : SQL.sql`AND json_extract("payloadJson", '$.key')=${key}`}
        ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`)
      return row ? read(row.id) : null
    },
    list: (contentId) =>
      tx.$queryRaw(SQL.sql`
      SELECT "id",json_extract("payloadJson", '$.key') AS "key",
        json_extract("payloadJson", '$.language') AS "language",
        json_extract("payloadJson", '$.glossary') AS "glossary",
        coalesce(json_extract("payloadJson", '$.concurrency'),1) AS "concurrency",
        json_extract("payloadJson", '$.model') AS "model","updatedAt"
      FROM "PdfTranslation" WHERE "pdfDocumentId"=${contentId} ORDER BY "createdAt" DESC,"id" DESC`),
    async delete(id, contentId) {
      return (
        (await tx.$executeRaw(
          SQL.sql`DELETE FROM "PdfTranslation" WHERE "id"=${id} AND "pdfDocumentId"=${contentId}`
        )) === 1
      )
    },
    async insert(row) {
      await tx.$executeRaw(SQL.sql`INSERT INTO "PdfTranslation" ("id","pdfDocumentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson","createdAt","updatedAt")
        VALUES (${row.id},${row.contentId},${row.checksum},${row.sizeBytes},${row.revision},${encode(row.payloadJson)},${row.layoutSnapshotJson},${new Date()},${new Date()})`)
    },
    async readHeader(id) {
      const [row] = await tx.$queryRaw<
        Pick<TranslationStoredCheckpoint, 'contentId' | 'checksum' | 'sizeBytes'>[]
      >(SQL.sql`
        SELECT "pdfDocumentId" AS "contentId","checksum","sizeBytes" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row ?? null
    },
    async readBase(id) {
      const [row] = await tx.$queryRaw<
        { payloadJson: string; layoutSnapshotJson: string | null }[]
      >(SQL.sql`
        SELECT "payloadJson","layoutSnapshotJson" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row ? { ...row, payloadJson: decode(row.payloadJson) } : null
    },
    async readLayoutReports(id) {
      const [row] = await tx.$queryRaw<{ reports: string | null }[]>(SQL.sql`
        SELECT json_extract("payloadJson", '$.layoutReports') AS reports FROM "PdfTranslation" WHERE "id"=${id}`)
      return row?.reports ?? null
    },
    async pinLayout(id, snapshotJson) {
      await tx.$executeRaw(
        SQL.sql`UPDATE "PdfTranslation" SET "layoutSnapshotJson"=${snapshotJson} WHERE "id"=${id} AND "layoutSnapshotJson" IS NULL`
      )
    },
    async updatePayload(id, payloadJson) {
      await tx.$executeRaw(
        SQL.sql`UPDATE "PdfTranslation" SET "payloadJson"=${encode(payloadJson)},"updatedAt"=${new Date()} WHERE "id"=${id}`
      )
    },
    async commit(id, expectedRevision, change) {
      const state = await tx.$queryRaw<{ revision: number }[]>(SQL.sql`
        SELECT revision FROM "PdfTranslationBlock" WHERE "translationId"=${id} AND "sourceIndex"=-1`)
      const base = change.base
      // Incremental writes require an existing live revision row.
      if (!state.length && !base) return false
      const updated = state.length
        ? await tx.$executeRaw(SQL.sql`UPDATE "PdfTranslationBlock" SET revision=${change.revision}
            WHERE "translationId"=${id} AND "sourceIndex"=-1 AND revision=${expectedRevision}`)
        : await tx.$executeRaw(SQL.sql`UPDATE "PdfTranslation" SET revision=${change.revision},"payloadJson"=${encode(base!.payloadJson)},"updatedAt"=${new Date()}
            WHERE "id"=${id} AND revision=${expectedRevision}`)
      if (updated !== 1) return false
      if (base) {
        await tx.$executeRaw(
          SQL.sql`UPDATE "PdfTranslation" SET revision=${change.revision},"payloadJson"=${encode(base.payloadJson)},"layoutSnapshotJson"=${base.layoutSnapshotJson},"updatedAt"=${new Date()} WHERE "id"=${id}`
        )
        await tx.$executeRaw(SQL.sql`DELETE FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
        await tx.$executeRaw(
          SQL.sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision") VALUES (${id},-1,${change.revision})`
        )
      } else if (change.block) {
        const block = change.block
        await tx.$executeRaw(SQL.sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision","translation") VALUES (${id},${block.sourceIndex},${change.revision},${block.translation})
          ON CONFLICT ("translationId","sourceIndex") DO UPDATE SET revision=excluded.revision,translation=excluded.translation`)
        if (change.layoutReportsJson !== undefined)
          await tx.$executeRaw(SQL.sql`
          UPDATE "PdfTranslation" SET "payloadJson"=json_set("payloadJson", '$.layoutReports',json(${change.layoutReportsJson})) WHERE "id"=${id}`)
        await tx.$executeRaw(
          SQL.sql`UPDATE "PdfTranslation" SET "updatedAt"=${new Date()} WHERE "id"=${id}`
        )
      }
      return true
    }
  }
}
