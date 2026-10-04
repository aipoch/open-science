import type { PdfAddToLiteratureRequest } from '../pdf-annotations'
import type { JournalRequest, JournalResult } from '../journal-attributes'

import type {
  LiteratureExportRecordRequest,
  LiteratureExportRecordResult
} from '../literature-export'

import type { LiteratureChangedEvent } from '../literature'

import type { LiteratureJobRequest, LiteratureJobsResult } from '../literature-jobs'

import type { LiteratureFullTextRequest, LiteratureFullTextResult } from '../literature'

import type {
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt,
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest,
  LiteratureCitationStylesRequest,
  LiteratureCitationStylesResult,
  LiteratureFormatDocumentRequest,
  LiteratureFormatDocumentResult,
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult,
  LiteratureItemView,
  LiteratureSourceRecordView,
  LiteratureItemInput,
  LiteratureMetadataCompletionRequest,
  LiteratureMetadataCompletionResult,
  LiteraturePdfCancelImportRequest,
  LiteraturePdfImportReceipt,
  LiteraturePdfImportRequest,
  LiteratureRecordImportRequest,
  LiteratureRecordImportResult
} from '../literature'

import {
  callable,
  WEB,
  RUNTIME_VALIDATED,
  type AcpListener,
  type RemoveListener,
  EVENT
} from './definition'

export const contracts = {
  'literature.journals': callable<(request: JournalRequest) => Promise<JournalResult>>()(
    'literature',
    ['literature:journals', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'literature.formatReferences': callable<
    (request: LiteratureFormatReferencesRequest) => Promise<LiteratureFormatReferencesResult>
  >()('literature', ['literature:format-references', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.formatDocument': callable<
    (request: LiteratureFormatDocumentRequest) => Promise<LiteratureFormatDocumentResult>
  >()('literature', ['literature:format-document', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.citationStyles': callable<
    (request: LiteratureCitationStylesRequest) => Promise<LiteratureCitationStylesResult>
  >()('literature', ['literature:citation-styles', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.lookupMetadata': callable<(doi: string) => Promise<LiteratureItemInput>>()(
    'literature',
    ['literature:lookup-metadata', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'literature.completeMetadata': callable<
    (request: LiteratureMetadataCompletionRequest) => Promise<LiteratureMetadataCompletionResult>
  >()('literature', ['literature:complete-metadata', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.exportRecord': callable<
    (request: LiteratureExportRecordRequest) => Promise<LiteratureExportRecordResult>
  >()('literature', ['literature:export-record', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.sources': callable<(itemId: string) => Promise<LiteratureSourceRecordView[]>>()(
    'literature',
    ['literature:sources', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'literature.get': callable<(itemId: string) => Promise<LiteratureItemView | undefined>>()(
    'literature',
    ['literature:get', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'literature.fullText': callable<
    (request: LiteratureFullTextRequest) => Promise<LiteratureFullTextResult>
  >()('literature', ['literature:full-text', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.jobs': callable<(request: LiteratureJobRequest) => Promise<LiteratureJobsResult>>()(
    'literature',
    ['literature:jobs', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'literature.addPdf': callable<
    (request: PdfAddToLiteratureRequest) => Promise<LiteraturePdfImportReceipt>
  >()('literature', ['literature:add-pdf', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.importPdf': callable<
    (request: LiteraturePdfImportRequest) => Promise<LiteraturePdfImportReceipt>
  >()('literature', ['literature:import-pdf', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.cancelPdfImport': callable<
    (request: LiteraturePdfCancelImportRequest) => Promise<{ cancelled: boolean }>
  >()('literature', ['literature:cancel-pdf-import', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.importRecords': callable<
    (request: LiteratureRecordImportRequest) => Promise<LiteratureRecordImportResult>
  >()('literature', ['literature:import-records', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.onChanged': callable<
    (listener: AcpListener<LiteratureChangedEvent>) => RemoveListener
  >()('literature', ['literature:changed', EVENT]),
  'literature.search': callable<
    (request: LiteratureCatalogSearchRequest) => Promise<LiteratureCatalogSearchPage>
  >()('literature', ['literature:search', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'literature.transact': callable<
    (command: LiteratureCatalogCommand) => Promise<LiteratureCatalogReceipt>
  >()('literature', ['literature:transact', WEB, undefined, undefined, RUNTIME_VALIDATED])
} as const
