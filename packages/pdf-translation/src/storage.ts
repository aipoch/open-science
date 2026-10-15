import type { PdfTranslationCheckpoint, PdfTranslationEdition } from './contracts.js'
export type TranslationCheckpointIdentity = Pick<PdfTranslationCheckpoint, 'sourceId' | 'checksum'>
/** Opaque consumer identities and a domain snapshot; no database rows or serialized fields. */
export type TranslationStoredCheckpoint = {
  id: string
  contentId: string
  checksum: string
  sizeBytes: bigint
  checkpoint: PdfTranslationCheckpoint
}
export type TranslationCheckpointCommit = {
  checkpoint: PdfTranslationCheckpoint
  /** Optional single-block change. Consumers may store the complete checkpoint instead,
   * preserving independently pinned layoutSnapshot and layoutReports unless reports are supplied below. */
  changedBlock?: { sourceIndex: number; translation: string | null }
  layoutReports?: NonNullable<PdfTranslationCheckpoint['layoutReports']>
}
/** Atomic admission: errors, cancellation and a failed CAS must leave no partial mutations. */
export interface TranslationTransaction {
  requireSource(identity: TranslationCheckpointIdentity): Promise<{ sizeBytes: bigint }>
  requireDocument(
    identity: TranslationCheckpointIdentity,
    source: { sizeBytes: bigint }
  ): Promise<string>
  findLatest(contentId: string, checkpointKey?: string): Promise<TranslationStoredCheckpoint | null>
  read(id: string, contentId?: string): Promise<TranslationStoredCheckpoint | null>
  list(contentId: string): Promise<PdfTranslationEdition[]>
  delete(id: string, contentId: string): Promise<boolean>
  insert(record: TranslationStoredCheckpoint): Promise<void>
  readHeader(
    id: string
  ): Promise<Pick<TranslationStoredCheckpoint, 'contentId' | 'checksum' | 'sizeBytes'> | null>
  /** Current metadata, including independently published layout results. */
  readMetadata(
    id: string
  ): Promise<Pick<
    PdfTranslationCheckpoint,
    'key' | 'fingerprint' | 'sources' | 'layoutSnapshot' | 'layoutReports'
  > | null>
  readLayoutReports(id: string): Promise<PdfTranslationCheckpoint['layoutReports']>
  pinLayout(
    id: string,
    snapshot: NonNullable<PdfTranslationCheckpoint['layoutSnapshot']>
  ): Promise<void>
  updateLayoutReports(
    id: string,
    reports: NonNullable<PdfTranslationCheckpoint['layoutReports']>
  ): Promise<void>
  /** Compare with the current revision atomically. false means no changes were applied. */
  commit(
    id: string,
    expectedRevision: number,
    change: TranslationCheckpointCommit
  ): Promise<boolean>
}
/** Optional checkpoint capability. Consumers choose storage, serialization and resource ownership. */
export interface TranslationDatabase {
  canPersist(identity: TranslationCheckpointIdentity): Promise<boolean>
  transaction<T>(operation: (tx: TranslationTransaction) => Promise<T>): Promise<T>
}
