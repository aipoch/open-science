import { withDataRootWrite } from '../storage/migration-state'
import {
  literatureExportRecordContract,
  type LiteratureExportRecordRequest,
  type LiteratureExportRecordResult
} from '../../shared/literature-export'
import {
  literatureJobsContract,
  type LiteratureJobRequest,
  type LiteratureJobsResult
} from '../../shared/literature-jobs'
import {
  literatureApplicationCommandContracts,
  type LiteratureFullTextRequest,
  type LiteratureFullTextResult,
  type LiteratureCatalogCommand,
  type LiteratureCatalogReceipt,
  type LiteratureCatalogSearchPage,
  type LiteratureCatalogSearchRequest,
  type LiteratureCitationStylesRequest,
  type LiteratureCitationStylesResult,
  type LiteratureFormatReferencesRequest,
  type LiteratureFormatReferencesResult,
  type LiteratureFormatDocumentRequest,
  type LiteratureFormatDocumentResult,
  type LiteratureItemInput,
  type LiteratureItemView,
  type LiteratureMetadataCompletionRequest,
  type LiteratureMetadataCompletionResult,
  type LiteraturePdfImportReceipt,
  type LiteraturePdfImportRequest,
  type LiteratureRecordImportRequest,
  type LiteratureRecordImportResult
} from '../../shared/literature'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

type LiteratureCommandOwner = Readonly<{
  exportRecord(request: LiteratureExportRecordRequest): Promise<LiteratureExportRecordResult>
  jobs(request: LiteratureJobRequest): Promise<LiteratureJobsResult>
  fullText(request: LiteratureFullTextRequest): Promise<LiteratureFullTextResult>
  lookupMetadata(doi: string): Promise<LiteratureItemInput>
  completeMetadata(
    request: LiteratureMetadataCompletionRequest
  ): Promise<LiteratureMetadataCompletionResult>
  search(request: LiteratureCatalogSearchRequest): Promise<LiteratureCatalogSearchPage>
  get(itemId: string): Promise<LiteratureItemView | undefined>
  formatReferences(
    request: LiteratureFormatReferencesRequest
  ): Promise<LiteratureFormatReferencesResult>
  formatDocument(request: LiteratureFormatDocumentRequest): Promise<LiteratureFormatDocumentResult>
  citationStyles(request: LiteratureCitationStylesRequest): Promise<LiteratureCitationStylesResult>
  importRecords(request: LiteratureRecordImportRequest): Promise<LiteratureRecordImportResult>
  importPdf(request: LiteraturePdfImportRequest): Promise<LiteraturePdfImportReceipt>
  transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt>
}>

const literatureApplicationCommands = Object.freeze({
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
  literatureApplicationCommands.exportRecord,
  literatureApplicationCommands.jobs,
  literatureApplicationCommands.fullText,
  literatureApplicationCommands.lookupMetadata,
  literatureApplicationCommands.completeMetadata,
  literatureApplicationCommands.citationStyles,
  literatureApplicationCommands.formatReferences,
  literatureApplicationCommands.formatDocument,
  literatureApplicationCommands.get,
  literatureApplicationCommands.importPdf,
  literatureApplicationCommands.importRecords,
  literatureApplicationCommands.search,
  literatureApplicationCommands.transact
] as const)

const registerLiteratureApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: LiteratureCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(literatureApplicationCommandGroup, {
      'literature:export-record': ({ args }) => withDataRootWrite(() => owner.exportRecord(args[0])),
      'literature:jobs': ({ args }) => withDataRootWrite(() => owner.jobs(args[0])),
      'literature:full-text': ({ args }) => withDataRootWrite(() => owner.fullText(args[0])),
      'literature:lookup-metadata': ({ args }) =>
        withDataRootWrite(() => owner.lookupMetadata(args[0])),
      'literature:complete-metadata': ({ args }) =>
        withDataRootWrite(() => owner.completeMetadata(args[0])),
      'literature:citation-styles': ({ args }) =>
        withDataRootWrite(() => owner.citationStyles(args[0])),
      'literature:format-references': ({ args }) =>
        withDataRootWrite(() => owner.formatReferences(args[0])),
      'literature:format-document': ({ args }) =>
        withDataRootWrite(() => owner.formatDocument(args[0])),
      'literature:get': ({ args }) => withDataRootWrite(() => owner.get(args[0])),
      'literature:import-pdf': ({ args }) => withDataRootWrite(() => owner.importPdf(args[0])),
      'literature:import-records': ({ args }) =>
        withDataRootWrite(() => owner.importRecords(args[0])),
      'literature:search': ({ args }) => withDataRootWrite(() => owner.search(args[0])),
      'literature:transact': ({ args }) => withDataRootWrite(() => owner.transact(args[0]))
    })
    return scope.complete()
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
