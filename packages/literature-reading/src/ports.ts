import type { LiteratureSearchResult, ReplaceLiteratureIndexInput } from './full-text-index.js'
export type LiteratureIndexCandidate = Omit<LiteratureSearchResult, 'relativeScore'>
/** Optional search backend. The consumer owns storage, schema, connections and ranking implementation. */
export interface LiteratureIndexStore {
  hasExtraction(extractionId: string): Promise<boolean>
  deleteExtraction(extractionId: string): Promise<void>
  /** Atomically replace all chunks of one extraction; failures retain the previous value. */
  replace(input: ReplaceLiteratureIndexInput): Promise<void>
  /** Return at most limit candidates, ordered by rank ascending (negative relevance magnitude). */
  search(input: {
    extractionIds: readonly string[]
    terms: readonly string[]
    limit: number
  }): Promise<LiteratureIndexCandidate[]>
  touch(extractionIds: readonly string[]): Promise<void>
  purgeExpired(): Promise<void>
  close(): Promise<void>
}
export type IndexOptions = {
  /** Return a ready handle; clean up partial resources if opening or migration fails. */
  open(): Promise<LiteratureIndexStore>
  exists(): Promise<boolean>
  maintenance?(operation: () => Promise<void>): Promise<void>
  log?(message: string, fields: Record<string, unknown>): void
}
export type DocumentReference = Readonly<{
  bindingId: string
  name: string
  checksum: string
  sizeBytes: number
}>
export type TextExtraction = Readonly<{ text: string; pageCount: number; truncated: boolean }>
