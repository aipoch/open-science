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
  fullText(request: LiteratureFullTextRequest): Promise<LiteratureFullTextResult>
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
  fullText: defineApplicationCommand<
    'literature:full-text',
    readonly [LiteratureFullTextRequest],
    LiteratureFullTextResult
  >('literature:full-text', literatureApplicationCommandContracts.fullText),
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
  literatureApplicationCommands.fullText,
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
      'literature:full-text': ({ args }) => owner.fullText(args[0]),
      'literature:complete-metadata': ({ args }) => owner.completeMetadata(args[0]),
      'literature:citation-styles': ({ args }) => owner.citationStyles(args[0]),
      'literature:format-references': ({ args }) => owner.formatReferences(args[0]),
      'literature:format-document': ({ args }) => owner.formatDocument(args[0]),
      'literature:get': ({ args }) => owner.get(args[0]),
      'literature:import-pdf': ({ args }) => owner.importPdf(args[0]),
      'literature:import-records': ({ args }) => owner.importRecords(args[0]),
      'literature:search': ({ args }) => owner.search(args[0]),
      'literature:transact': ({ args }) => owner.transact(args[0])
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
