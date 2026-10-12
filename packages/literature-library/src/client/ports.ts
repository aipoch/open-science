import type { LiteratureJobRequest, LiteratureJobsResult } from '@aipoch/literature-discovery/jobs'
import type {
  LiteratureCatalogSearchRequest,
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult,
  LiteratureItemView
} from '../contracts.js'
export type LibraryPage = {
  entries: object[]
  nextOffset?: number
  totalCount?: number
  itemIds?: string[]
}
export type LibraryClientApi<Page extends LibraryPage = LibraryPage> = {
  search(request: LiteratureCatalogSearchRequest): Promise<Page>
  get(id: string): Promise<LiteratureItemView | undefined>
  exportRecord(request: {
    itemId: string
    offset?: number
    digest?: string
  }): Promise<{ chunk: string; digest: string; nextOffset?: number }>
  jobs(request: LiteratureJobRequest): Promise<LiteratureJobsResult>
  formatReferences(
    request: LiteratureFormatReferencesRequest
  ): Promise<LiteratureFormatReferencesResult>
}
