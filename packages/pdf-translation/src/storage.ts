import type { Sql } from '@prisma/client/runtime/library'
import type { PdfTranslationCheckpoint } from './contracts.js'
export type TranslationCheckpointIdentity = Pick<
  PdfTranslationCheckpoint,
  'attachmentVersionId' | 'documentSource' | 'checksum'
>
export interface TranslationSql {
  $queryRaw<T>(query: TemplateStringsArray | Sql, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray | Sql, ...values: unknown[]): Promise<number>
}
/** Source authorization and document registration run inside the checkpoint transaction. */
export interface TranslationTransaction extends TranslationSql {
  requireSource(identity: TranslationCheckpointIdentity): Promise<{ sizeBytes: bigint }>
  requireDocument(
    identity: TranslationCheckpointIdentity,
    source: { sizeBytes: bigint }
  ): Promise<string>
}
export interface TranslationDatabase {
  hasAttachment(versionId: string): Promise<boolean>
  $transaction<T>(operation: (tx: TranslationTransaction) => Promise<T>): Promise<T>
}
export type TranslationStoredCheckpoint = {
  id: string
  pdfDocumentId: string
  checksum: string
  sizeBytes: bigint
  revision: number
  payloadJson: string
  layoutSnapshotJson: string | null
  blocks: { sourceIndex: number; translation: string | null; revision: number }[]
}
