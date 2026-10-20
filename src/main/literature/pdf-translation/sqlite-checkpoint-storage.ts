import type {
  TranslationTransaction,
  TranslationStoredCheckpoint
} from '@aipoch/pdf-translation/storage'
import {
  pdfTranslationCheckpointSchema,
  pdfTranslationLayoutReportSchema,
  pdfTranslationLayoutSnapshotSchema,
  pdfTranslationSnapshotMatchesSources,
  type PdfTranslationCheckpoint,
  type PdfTranslationEdition
} from '@aipoch/pdf-translation/contracts'
import { pdfTranslationSourceIndices } from '@aipoch/pdf-translation/text'

type CheckpointRow = Omit<TranslationStoredCheckpoint, 'checkpoint'> & {
  revision: number
  payloadJson: string
  layoutSnapshotJson: string | null
}
type CheckpointBlockRow = { sourceIndex: number; translation: string | null; revision: number }
const payload = (checkpoint: PdfTranslationCheckpoint): string =>
  JSON.stringify({ ...checkpoint, layoutSnapshot: undefined })
const readPayload = (
  serialized: string,
  codec: TranslationPayloadCodec
): PdfTranslationCheckpoint => {
  if (serialized.length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
  return pdfTranslationCheckpointSchema.parse(JSON.parse(codec.decode(serialized)))
}
const readSnapshot = (
  serialized: string
): NonNullable<PdfTranslationCheckpoint['layoutSnapshot']> => {
  if (serialized.length > 32 * 1024 * 1024) throw new Error('Invalid PDF layout snapshot.')
  return pdfTranslationLayoutSnapshotSchema.parse(JSON.parse(serialized))
}

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

function restoreCheckpoint(
  row: CheckpointRow,
  blocks: CheckpointBlockRow[],
  codec: TranslationPayloadCodec
): PdfTranslationCheckpoint {
  let value = readPayload(row.payloadJson, codec)
  if (value.checksum !== row.checksum || value.revision !== row.revision)
    throw new Error('Translation source changed.')
  const state = blocks.find((block) => block.sourceIndex === -1)
  const changes = blocks.filter((block) => block.sourceIndex !== -1)
  if (state) {
    if (
      state.translation !== null ||
      state.revision < value.revision ||
      (changes.length ? Math.max(...changes.map((block) => block.revision)) : value.revision) !==
        state.revision ||
      changes.some(
        (block) =>
          block.revision <= value.revision ||
          block.sourceIndex < 0 ||
          block.sourceIndex >= value.sources.length
      )
    )
      throw new Error('Invalid translation checkpoint.')
    const accepted = new Map(
      pdfTranslationSourceIndices(value).map((index, position) => [
        index,
        value.translations[position]
      ])
    )
    const failed = new Set(value.failedSourceIndices ?? [])
    for (const block of changes) {
      if (block.translation === null) {
        accepted.delete(block.sourceIndex)
        failed.add(block.sourceIndex)
      } else {
        accepted.set(block.sourceIndex, block.translation)
        failed.delete(block.sourceIndex)
      }
    }
    const entries = [...accepted].sort(([a], [b]) => a - b)
    value = pdfTranslationCheckpointSchema.parse({
      ...value,
      version: 1,
      revision: state.revision,
      translations: entries.map(([, text]) => text),
      translatedSourceIndices: entries.map(([index]) => index),
      failedSourceIndices: [...failed].sort((a, b) => a - b),
      ...(value.failures
        ? { failures: value.failures.filter(({ sourceIndex }) => failed.has(sourceIndex)) }
        : {})
    })
  } else if (changes.length) throw new Error('Invalid translation checkpoint.')
  if (row.layoutSnapshotJson) {
    const snapshot = readSnapshot(row.layoutSnapshotJson)
    if (!pdfTranslationSnapshotMatchesSources(snapshot, value.fingerprint, value.sources))
      throw new Error('PDF layout snapshot does not match translation.')
    value = { ...value, layoutSnapshot: snapshot }
  }
  return value
}

/** The executor MUST be bound to one atomic transaction; the caller owns connection and source authority. */
export function createSqliteTranslationTransaction(
  tx: TranslationSqliteExecutor,
  authority: Pick<TranslationTransaction, 'requireSource' | 'requireDocument'>,
  codec: TranslationPayloadCodec = identityCodec
): TranslationTransaction {
  const read: TranslationTransaction['read'] = async (id, contentId) => {
    const [row] = await tx.query<CheckpointRow[]>(sql`
      SELECT "id","pdfDocumentId" AS "contentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson"
      FROM "PdfTranslation" WHERE "id"=${id} AND (${contentId ?? null} IS NULL OR "pdfDocumentId"=${contentId ?? null})`)
    if (!row) return null
    const blocks = await tx.query<CheckpointBlockRow[]>(sql`
      SELECT "sourceIndex","translation","revision" FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
    return {
      id: row.id,
      contentId: row.contentId,
      checksum: row.checksum,
      sizeBytes: row.sizeBytes,
      checkpoint: restoreCheckpoint(row, blocks, codec)
    }
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
    async list(contentId) {
      const rows = await tx.query<
        (Omit<PdfTranslationEdition, 'glossary' | 'model' | 'updatedAt'> & {
          glossary: string
          model: string
          updatedAt: Date | number
        })[]
      >(sql`
      SELECT "id",json_extract("payloadJson", '$.key') AS "key",
        json_extract("payloadJson", '$.language') AS "language",
        json_extract("payloadJson", '$.glossary') AS "glossary",
        coalesce(json_extract("payloadJson", '$.concurrency'),1) AS "concurrency",
        json_extract("payloadJson", '$.model') AS "model","updatedAt"
      FROM "PdfTranslation" WHERE "pdfDocumentId"=${contentId} ORDER BY "createdAt" DESC,"id" DESC`)
      return rows.map((row) => ({
        ...row,
        glossary: JSON.parse(row.glossary),
        model: JSON.parse(row.model),
        updatedAt: new Date(row.updatedAt).getTime()
      }))
    },
    async delete(id, contentId) {
      return (
        (await tx.execute(
          sql`DELETE FROM "PdfTranslation" WHERE "id"=${id} AND "pdfDocumentId"=${contentId}`
        )) === 1
      )
    },
    async insert(row) {
      await tx.execute(sql`INSERT INTO "PdfTranslation" ("id","pdfDocumentId","checksum","sizeBytes","revision","payloadJson","layoutSnapshotJson","createdAt","updatedAt")
        VALUES (${row.id},${row.contentId},${row.checksum},${row.sizeBytes},${row.checkpoint.revision},${codec.encode(payload(row.checkpoint))},${row.checkpoint.layoutSnapshot ? JSON.stringify(row.checkpoint.layoutSnapshot) : null},${new Date()},${new Date()})`)
    },
    async readHeader(id) {
      const [row] = await tx.query<
        Pick<TranslationStoredCheckpoint, 'contentId' | 'checksum' | 'sizeBytes'>[]
      >(sql`
        SELECT "pdfDocumentId" AS "contentId","checksum","sizeBytes" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row ?? null
    },
    async readMetadata(id) {
      const [row] = await tx.query<
        { payloadJson: string; layoutSnapshotJson: string | null }[]
      >(sql`
        SELECT "payloadJson","layoutSnapshotJson" FROM "PdfTranslation" WHERE "id"=${id}`)
      return row
        ? {
            ...readPayload(row.payloadJson, codec),
            ...(row.layoutSnapshotJson
              ? { layoutSnapshot: readSnapshot(row.layoutSnapshotJson) }
              : {})
          }
        : null
    },
    async readLayoutReports(id) {
      const [row] = await tx.query<{ reports: string | null }[]>(sql`
        SELECT json_extract("payloadJson", '$.layoutReports') AS reports FROM "PdfTranslation" WHERE "id"=${id}`)
      return row?.reports
        ? pdfTranslationLayoutReportSchema.array().max(10000).parse(JSON.parse(row.reports))
        : undefined
    },
    async pinLayout(id, snapshot) {
      const snapshotJson = JSON.stringify(snapshot)
      await tx.execute(
        sql`UPDATE "PdfTranslation" SET "layoutSnapshotJson"=${snapshotJson} WHERE "id"=${id} AND "layoutSnapshotJson" IS NULL`
      )
    },
    async updateLayoutReports(id, reports) {
      await tx.execute(
        sql`UPDATE "PdfTranslation" SET "payloadJson"=json_set("payloadJson", '$.layoutReports',json(${JSON.stringify(reports)})),"updatedAt"=${new Date()} WHERE "id"=${id}`
      )
    },
    async commit(id, expectedRevision, change) {
      const state = await tx.query<{ revision: number }[]>(sql`
        SELECT revision FROM "PdfTranslationBlock" WHERE "translationId"=${id} AND "sourceIndex"=-1`)
      // Storage optimization stays here: a consumer may always replace a full checkpoint.
      const base =
        !change.changedBlock || !state.length
          ? {
              payloadJson: codec.encode(payload(change.checkpoint)),
              layoutSnapshotJson: change.checkpoint.layoutSnapshot
                ? JSON.stringify(change.checkpoint.layoutSnapshot)
                : null
            }
          : undefined
      const updated = state.length
        ? await tx.execute(sql`UPDATE "PdfTranslationBlock" SET revision=${change.checkpoint.revision}
            WHERE "translationId"=${id} AND "sourceIndex"=-1 AND revision=${expectedRevision}`)
        : await tx.execute(sql`UPDATE "PdfTranslation" SET revision=${change.checkpoint.revision},"payloadJson"=${base!.payloadJson},"updatedAt"=${new Date()}
            WHERE "id"=${id} AND revision=${expectedRevision}`)
      if (updated !== 1) return false
      if (base) {
        await tx.execute(
          sql`UPDATE "PdfTranslation" SET revision=${change.checkpoint.revision},"payloadJson"=${base.payloadJson},"layoutSnapshotJson"=${base.layoutSnapshotJson},"updatedAt"=${new Date()} WHERE "id"=${id}`
        )
        await tx.execute(sql`DELETE FROM "PdfTranslationBlock" WHERE "translationId"=${id}`)
        await tx.execute(
          sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision") VALUES (${id},-1,${change.checkpoint.revision})`
        )
      } else if (change.changedBlock) {
        const block = change.changedBlock
        await tx.execute(sql`INSERT INTO "PdfTranslationBlock" ("translationId","sourceIndex","revision","translation") VALUES (${id},${block.sourceIndex},${change.checkpoint.revision},${block.translation})
          ON CONFLICT ("translationId","sourceIndex") DO UPDATE SET revision=excluded.revision,translation=excluded.translation`)
        if (change.layoutReports !== undefined)
          await tx.execute(sql`
          UPDATE "PdfTranslation" SET "payloadJson"=json_set("payloadJson", '$.layoutReports',json(${JSON.stringify(change.layoutReports)})) WHERE "id"=${id}`)
        await tx.execute(
          sql`UPDATE "PdfTranslation" SET "updatedAt"=${new Date()} WHERE "id"=${id}`
        )
      }
      return true
    }
  }
}
