import type { JournalDataset, JournalIdentity, JournalImportRow } from './contracts.js'

export type JournalRecord = JournalIdentity & { id: string }
export type JournalEntry = {
  datasetId: string
  journalId: string
  values: JournalImportRow['values']
  sourceRow: number
}
export type JournalDatasetRow = JournalImportRow & { id: string }
export type JournalDatasetImport = Omit<JournalDataset, 'revision' | 'count'>
export type JournalDatasetPatch = Partial<
  Pick<JournalDataset, 'name' | 'source' | 'year' | 'fields'>
>
export type JournalEntryQuery = {
  datasetIds: readonly string[]
  journalIds?: readonly string[]
  after?: string
  limit?: number
}
export type JournalRowQuery = { after?: string; limit?: number; journalIds?: readonly string[] }

/** All operations, including references, belong to the same storage session. */
export interface JournalStore {
  listJournals(): Promise<JournalRecord[]>
  listDatasets(): Promise<JournalDataset[]>
  readEntries(query: JournalEntryQuery): Promise<JournalEntry[]>
  /** Ordered by journal ID, with an exclusive cursor. An empty ID list returns no rows. */
  readDatasetRows(datasetId: string, query: JournalRowQuery): Promise<JournalDatasetRow[]>
  /** Journals that would become unreferenced when this dataset is removed, ordered by ID. */
  listExclusiveJournalIds(datasetId: string, after: string, limit: number): Promise<string[]>
  hasJournal(id: string): Promise<boolean>
  /** Insert at revision 1; on update preserve name/source/year and increment revision. */
  saveDatasetImport(dataset: JournalDatasetImport): Promise<void>
  /** Insert new identities; existing names stay fixed while aliases and identifiers are replaced. */
  saveJournals(journals: readonly JournalRecord[]): Promise<void>
  saveEntries(entries: readonly JournalEntry[]): Promise<void>
  /** Apply presentation changes and increment revision, including an empty patch for entry edits. */
  updateDataset(id: string, patch: JournalDatasetPatch): Promise<void>
  /** Remove entries, then orphan journals and their bindings; preserve references themselves. */
  removeDataset(id: string): Promise<void>
  readonly references: JournalReferences
}

/** A stable object per opened database; adapters own connections, schema and migrations. */
export interface JournalDatabase extends JournalStore {
  /** Resolve after commit; reject only after rollback of catalog AND reference changes.
   * The scoped store must not escape this callback. Options are durations in milliseconds.
   */
  transaction<T>(
    operation: (transaction: JournalStore) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>
}
export type JournalReferenceIdentity = {
  id: string
  title: string
  metadataRevision: number
  identity: JournalIdentity
  fingerprint: string
  bindingJournalId: string | null
  bindingFingerprint: string | null
  bindingRevision: string | null
}
export type JournalReferenceFilter = Readonly<{ after?: string; ids?: readonly string[] }>
export interface JournalReferences {
  /** Ordered by reference ID; exclusive cursor, explicit IDs (including empty), and lifecycle. */
  read: (
    predicate: JournalReferenceFilter,
    limit: number,
    lifecycle: 'active' | 'deleted' | 'all'
  ) => Promise<JournalReferenceIdentity[]>
  /** At most 500 bindings, ordered by itemId, strictly after the cursor. */
  bindings: (journalIds: string[], after: string) => Promise<{ itemId: string; revision: string }[]>
  /** A fresh revision per binding write; omitted journalId removes the binding. */
  bind: (item: JournalReferenceIdentity, journalId?: string) => Promise<void>
}
export interface JournalIntegration {
  warn: (message: string, error: unknown) => void
}
