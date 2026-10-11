import type { JournalIdentity } from './contracts.js'
export type JournalStatement = Readonly<{ text: string; values: readonly unknown[] }>
export interface JournalReader {
  query<T>(statement: JournalStatement): Promise<T>
  execute(statement: JournalStatement): Promise<number>
}
export interface JournalDatabase extends JournalReader {
  transaction<T>(
    operation: (transaction: JournalReader) => Promise<T>,
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
export interface JournalIntegration {
  warn: (message: string, error: unknown) => void
  references: {
    read: (
      reader: JournalReader,
      predicate: JournalReferenceFilter,
      limit: number,
      lifecycle: 'active' | 'deleted' | 'all'
    ) => Promise<JournalReferenceIdentity[]>
    bindings: (
      reader: JournalReader,
      journalIds: string[],
      after: string
    ) => Promise<{ itemId: string; revision: string }[]>
    bind: (
      reader: JournalReader,
      item: JournalReferenceIdentity,
      journalId?: string
    ) => Promise<void>
  }
}
