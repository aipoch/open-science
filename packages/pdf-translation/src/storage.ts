import type { PdfTranslationCheckpoint } from './contracts.js'
export type TranslationCheckpointIdentity = Pick<PdfTranslationCheckpoint, 'sourceId' | 'checksum'>
export type TranslationStoredCheckpoint = {
  id: string
  contentId: string
  checksum: string
  sizeBytes: bigint
  revision: number
  payloadJson: string
  layoutSnapshotJson: string | null
  blocks: { sourceIndex: number; translation: string | null; revision: number }[]
}
export type TranslationEditionRow = {
  id: string
  key: string
  language: string
  glossary: string
  concurrency: number
  model: string
  updatedAt: Date | number
}
export type TranslationCheckpointCommit = {
  revision: number
  base?: { payloadJson: string; layoutSnapshotJson: string | null }
  block?: { sourceIndex: number; translation: string | null }
  layoutReportsJson?: string
}
/** All methods share one transaction. An error must roll back every mutation, including source registration. */
export interface TranslationTransaction {
  requireSource(identity: TranslationCheckpointIdentity): Promise<{ sizeBytes: bigint }>
  requireDocument(
    identity: TranslationCheckpointIdentity,
    source: { sizeBytes: bigint }
  ): Promise<string>
  findLatest(contentId: string, checkpointKey?: string): Promise<TranslationStoredCheckpoint | null>
  read(id: string, contentId?: string): Promise<TranslationStoredCheckpoint | null>
  list(contentId: string): Promise<TranslationEditionRow[]>
  delete(id: string, contentId: string): Promise<boolean>
  insert(row: Omit<TranslationStoredCheckpoint, 'blocks'>): Promise<void>
  readHeader(
    id: string
  ): Promise<Pick<TranslationStoredCheckpoint, 'contentId' | 'checksum' | 'sizeBytes'> | null>
  readBase(
    id: string
  ): Promise<Pick<TranslationStoredCheckpoint, 'payloadJson' | 'layoutSnapshotJson'> | null>
  readLayoutReports(id: string): Promise<string | null>
  pinLayout(id: string, snapshotJson: string): Promise<void>
  updatePayload(id: string, payloadJson: string): Promise<void>
  /** CAS against the live revision. false means no changes; base replacement or one block commits atomically. */
  commit(
    id: string,
    expectedRevision: number,
    change: TranslationCheckpointCommit
  ): Promise<boolean>
}
export interface TranslationDatabase {
  canPersist(identity: TranslationCheckpointIdentity): Promise<boolean>
  transaction<T>(operation: (tx: TranslationTransaction) => Promise<T>): Promise<T>
}
