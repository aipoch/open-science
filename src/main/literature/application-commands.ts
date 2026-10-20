import { type JournalRequest, type JournalResult } from '@aipoch/journal-catalog/contracts'
import {
  type LiteratureFullTextRequest,
  type LiteratureMetadataCompletionRequest
} from '@aipoch/literature-discovery/contracts'
import {
  type LiteratureJobRequest,
  type LiteratureJobsResult
} from '@aipoch/literature-discovery/jobs'
import {
  type LiteratureCatalogCommand,
  type LiteratureCatalogReceipt,
  type LiteratureCatalogSearchRequest,
  type LiteratureCitationStylesRequest,
  type LiteratureCitationStylesResult,
  type LiteratureFormatDocumentRequest,
  type LiteratureFormatDocumentResult,
  type LiteratureFormatReferencesRequest,
  type LiteratureFormatReferencesResult,
  type LiteratureFullTextResult,
  type LiteratureItemView,
  type LiteratureMetadataCompletionResult,
  type LiteraturePdfCancelImportRequest,
  type LiteraturePdfImportReceipt,
  type LiteratureRecordImportRequest,
  type LiteratureRecordImportResult,
  type LiteratureSourceRecordView
} from '@aipoch/literature-library/contracts'
import { type LiteratureItemInput } from '@aipoch/literature-library/item'
import { journalAttributesContract } from '../../shared/journal-attributes'
import {
  literatureApplicationCommandContracts,
  type LiteratureCandidateStatesRequest,
  type LiteratureCandidateStatesResult,
  pdfAddToLiteratureContract,
  type LiteratureCatalogSearchPage,
  type LiteraturePdfImportRequest
} from '../../shared/literature'
import {
  literatureExportRecordContract,
  type LiteratureExportRecordRequest,
  type LiteratureExportRecordResult
} from '../../shared/literature-export'
import { literatureJobsContract } from '../../shared/literature-jobs'
import type { PdfAddToLiteratureRequest } from '../../shared/pdf-annotations'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { withDataRootWrite } from '../storage/migration-state'

type LiteratureCommandOwner = Readonly<{
  getCandidateStates(
    request: LiteratureCandidateStatesRequest
  ): Promise<LiteratureCandidateStatesResult>
  addPdf(
    request: PdfAddToLiteratureRequest,
    signal?: AbortSignal
  ): Promise<LiteraturePdfImportReceipt>
  journals(request: JournalRequest): Promise<JournalResult>
  exportRecord(request: LiteratureExportRecordRequest): Promise<LiteratureExportRecordResult>
  jobs(request: LiteratureJobRequest): Promise<LiteratureJobsResult>
  fullText(request: LiteratureFullTextRequest): Promise<LiteratureFullTextResult>
  lookupMetadata(doi: string): Promise<LiteratureItemInput>
  completeMetadata(
    request: LiteratureMetadataCompletionRequest
  ): Promise<LiteratureMetadataCompletionResult>
  search(request: LiteratureCatalogSearchRequest): Promise<LiteratureCatalogSearchPage>
  sources(itemId: string): Promise<LiteratureSourceRecordView[]>
  get(itemId: string): Promise<LiteratureItemView | undefined>
  formatReferences(
    request: LiteratureFormatReferencesRequest
  ): Promise<LiteratureFormatReferencesResult>
  formatDocument(request: LiteratureFormatDocumentRequest): Promise<LiteratureFormatDocumentResult>
  citationStyles(request: LiteratureCitationStylesRequest): Promise<LiteratureCitationStylesResult>
  importRecords(request: LiteratureRecordImportRequest): Promise<LiteratureRecordImportResult>
  importPdf(
    request: LiteraturePdfImportRequest,
    signal?: AbortSignal
  ): Promise<LiteraturePdfImportReceipt>
  cancelPdfImport(request: LiteraturePdfCancelImportRequest): { cancelled: boolean }
  transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt>
}>

const literatureApplicationCommands = Object.freeze({
  getCandidateStates: defineApplicationCommand<
    'literature:get-candidate-states',
    readonly [LiteratureCandidateStatesRequest],
    LiteratureCandidateStatesResult
  >('literature:get-candidate-states', literatureApplicationCommandContracts.getCandidateStates),
  addPdf: defineApplicationCommand<
    'literature:add-pdf',
    readonly [PdfAddToLiteratureRequest],
    LiteraturePdfImportReceipt
  >('literature:add-pdf', pdfAddToLiteratureContract),
  journals: defineApplicationCommand<
    'literature:journals',
    readonly [JournalRequest],
    JournalResult
  >('literature:journals', journalAttributesContract),
  exportRecord: defineApplicationCommand<
    'literature:export-record',
    readonly [LiteratureExportRecordRequest],
    LiteratureExportRecordResult
  >('literature:export-record', literatureExportRecordContract),
  jobs: defineApplicationCommand<
    'literature:jobs',
    readonly [LiteratureJobRequest],
    LiteratureJobsResult
  >('literature:jobs', literatureJobsContract),
  fullText: defineApplicationCommand<
    'literature:full-text',
    readonly [LiteratureFullTextRequest],
    LiteratureFullTextResult
  >('literature:full-text', literatureApplicationCommandContracts.fullText),
  lookupMetadata: defineApplicationCommand<
    'literature:lookup-metadata',
    readonly [string],
    LiteratureItemInput
  >('literature:lookup-metadata', literatureApplicationCommandContracts.lookupMetadata),
  completeMetadata: defineApplicationCommand<
    'literature:complete-metadata',
    readonly [LiteratureMetadataCompletionRequest],
    LiteratureMetadataCompletionResult
  >('literature:complete-metadata', literatureApplicationCommandContracts.completeMetadata),
  search: defineApplicationCommand<
    'literature:search',
    readonly [LiteratureCatalogSearchRequest],
    LiteratureCatalogSearchPage
  >('literature:search', literatureApplicationCommandContracts.search),
  sources: defineApplicationCommand<
    'literature:sources',
    readonly [string],
    LiteratureSourceRecordView[]
  >('literature:sources', literatureApplicationCommandContracts.sources),
  get: defineApplicationCommand<
    'literature:get',
    readonly [string],
    LiteratureItemView | undefined
  >('literature:get', literatureApplicationCommandContracts.get),
  formatReferences: defineApplicationCommand<
    'literature:format-references',
    readonly [LiteratureFormatReferencesRequest],
    LiteratureFormatReferencesResult
  >('literature:format-references', literatureApplicationCommandContracts.formatReferences),
  formatDocument: defineApplicationCommand<
    'literature:format-document',
    readonly [LiteratureFormatDocumentRequest],
    LiteratureFormatDocumentResult
  >('literature:format-document', literatureApplicationCommandContracts.formatDocument),
  citationStyles: defineApplicationCommand<
    'literature:citation-styles',
    readonly [LiteratureCitationStylesRequest],
    LiteratureCitationStylesResult
  >('literature:citation-styles', literatureApplicationCommandContracts.citationStyles),
  importPdf: defineApplicationCommand<
    'literature:import-pdf',
    readonly [LiteraturePdfImportRequest],
    LiteraturePdfImportReceipt
  >('literature:import-pdf', literatureApplicationCommandContracts.importPdf),
  cancelPdfImport: defineApplicationCommand<
    'literature:cancel-pdf-import',
    readonly [LiteraturePdfCancelImportRequest],
    { cancelled: boolean }
  >('literature:cancel-pdf-import', literatureApplicationCommandContracts.cancelPdfImport),
  importRecords: defineApplicationCommand<
    'literature:import-records',
    readonly [LiteratureRecordImportRequest],
    LiteratureRecordImportResult
  >('literature:import-records', literatureApplicationCommandContracts.importRecords),
  transact: defineApplicationCommand<
    'literature:transact',
    readonly [LiteratureCatalogCommand],
    LiteratureCatalogReceipt
  >('literature:transact', literatureApplicationCommandContracts.transact)
})

const literatureApplicationCommandGroup = defineApplicationCommandGroup('literature', [
  literatureApplicationCommands.getCandidateStates,
  literatureApplicationCommands.journals,
  literatureApplicationCommands.exportRecord,
  literatureApplicationCommands.jobs,
  literatureApplicationCommands.fullText,
  literatureApplicationCommands.lookupMetadata,
  literatureApplicationCommands.completeMetadata,
  literatureApplicationCommands.citationStyles,
  literatureApplicationCommands.formatReferences,
  literatureApplicationCommands.formatDocument,
  literatureApplicationCommands.get,
  literatureApplicationCommands.sources,
  literatureApplicationCommands.importPdf,
  literatureApplicationCommands.addPdf,
  literatureApplicationCommands.cancelPdfImport,
  literatureApplicationCommands.importRecords,
  literatureApplicationCommands.search,
  literatureApplicationCommands.transact
] as const)

export type LiteratureCommandInstallation = ApplicationCommandInstallation & {
  whenIdle(): Promise<void>
}

const registerLiteratureApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: LiteratureCommandOwner
): LiteratureCommandInstallation => {
  const scope = registrar.createScope()
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const run = <Result>(
    operation: () => Promise<Result> | Result,
    write = true
  ): Promise<Result> => {
    const task = Promise.resolve().then(() => {
      lifetime.signal.throwIfAborted()
      return write ? withDataRootWrite(async () => operation()) : operation()
    })
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    )
    return task
  }
  try {
    scope.registerGroup(literatureApplicationCommandGroup, {
      'literature:get-candidate-states': ({ args }) => run(() => owner.getCandidateStates(args[0])),
      'literature:journals': ({ args }) => run(() => owner.journals(args[0])),
      'literature:export-record': ({ args }) => run(() => owner.exportRecord(args[0])),
      'literature:jobs': ({ args }) => run(() => owner.jobs(args[0])),
      'literature:full-text': ({ args }) => run(() => owner.fullText(args[0])),
      'literature:lookup-metadata': ({ args }) => run(() => owner.lookupMetadata(args[0])),
      'literature:complete-metadata': ({ args }) => run(() => owner.completeMetadata(args[0])),
      'literature:citation-styles': ({ args }) => run(() => owner.citationStyles(args[0])),
      'literature:format-references': ({ args }) => run(() => owner.formatReferences(args[0])),
      'literature:format-document': ({ args }) => run(() => owner.formatDocument(args[0])),
      'literature:sources': ({ args }) => run(() => owner.sources(args[0])),
      'literature:get': ({ args }) => run(() => owner.get(args[0])),
      'literature:import-pdf': ({ args, callerLease }) =>
        run(() => owner.importPdf(args[0], AbortSignal.any([callerLease.signal, lifetime.signal]))),
      'literature:add-pdf': ({ args, callerLease }) =>
        run(() => owner.addPdf(args[0], AbortSignal.any([callerLease.signal, lifetime.signal]))),
      'literature:cancel-pdf-import': ({ args }) =>
        run(() => owner.cancelPdfImport(args[0]), false),
      'literature:import-records': ({ args }) => run(() => owner.importRecords(args[0])),
      'literature:search': ({ args }) => run(() => owner.search(args[0])),
      'literature:transact': ({ args }) => run(() => owner.transact(args[0]))
    })
    const installation = scope.complete(() =>
      lifetime.abort(new Error('Literature commands are uninstalled.'))
    )
    return {
      ...installation,
      async whenIdle() {
        while (pending.size) await Promise.allSettled([...pending])
      }
    }
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  literatureApplicationCommandGroup,
  literatureApplicationCommands,
  registerLiteratureApplicationCommands
}
export type { LiteratureCommandOwner }
