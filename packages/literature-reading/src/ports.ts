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
export type PdfTextCoverage = Readonly<{
  textPages: readonly number[]
  ocrPages: readonly number[]
  unavailablePages: readonly number[]
  uncheckedPages: readonly number[]
  unverifiedPages?: readonly number[]
}>
/** Source text units and geometry; array order does not declare reading order or table cells. */
export type PageTextLayout = Readonly<{
  page: number
  width: number
  height: number
  coordinateSystem: 'top-left'
  blocks: readonly Readonly<{
    id: number
    text: string
    bounds: readonly [number, number, number, number]
  }>[]
}>
export type TextExtraction = Readonly<{
  text: string
  pageCount: number
  truncated: boolean
  coverage?: PdfTextCoverage
  /** Source-owned physical page starts in the exact text, including any generated headers. */
  pageStarts?: readonly Readonly<{ page: number; offset: number }>[]
  warnings?: readonly string[]
  pageLayouts?: readonly PageTextLayout[]
  layoutOmittedPages?: readonly number[]
}>
