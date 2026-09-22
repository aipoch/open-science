import {
  pdfAnnotationApplicationCommandContracts,
  type CreatePdfAnnotationRequest,
  type DeletePdfAnnotationRequest,
  type DeletePdfAnnotationResult,
  type ListPdfAnnotationsRequest,
  type PdfAnnotation,
  type PdfAnnotationListResult,
  type PdfNativeAnnotationCancelRequest,
  type PdfNativeAnnotationImportRequest,
  type PdfNativeAnnotationImportResult,
  type UpdatePdfAnnotationRequest
} from '../../shared/pdf-annotations'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'

type PdfAnnotationCommandOwner = Readonly<{
  list(request: ListPdfAnnotationsRequest): Promise<PdfAnnotationListResult>
  create(request: CreatePdfAnnotationRequest): Promise<PdfAnnotation>
  update(request: UpdatePdfAnnotationRequest): Promise<PdfAnnotation>
  delete(request: DeletePdfAnnotationRequest): Promise<DeletePdfAnnotationResult>
  importNative(
    request: PdfNativeAnnotationImportRequest,
    signal?: AbortSignal
  ): Promise<PdfNativeAnnotationImportResult>
  cancelImport(request: PdfNativeAnnotationCancelRequest): { cancelled: boolean }
}>
const pdfAnnotationApplicationCommands = Object.freeze({
  list: defineApplicationCommand<
    'pdf-annotations:list',
    readonly [ListPdfAnnotationsRequest],
    PdfAnnotationListResult
  >('pdf-annotations:list', pdfAnnotationApplicationCommandContracts.list),
  create: defineApplicationCommand<
    'pdf-annotations:create',
    readonly [CreatePdfAnnotationRequest],
    PdfAnnotation
  >('pdf-annotations:create', pdfAnnotationApplicationCommandContracts.create),
  update: defineApplicationCommand<
    'pdf-annotations:update',
    readonly [UpdatePdfAnnotationRequest],
    PdfAnnotation
  >('pdf-annotations:update', pdfAnnotationApplicationCommandContracts.update),
  delete: defineApplicationCommand<
    'pdf-annotations:delete',
    readonly [DeletePdfAnnotationRequest],
    DeletePdfAnnotationResult
  >('pdf-annotations:delete', pdfAnnotationApplicationCommandContracts.delete),
  importNative: defineApplicationCommand<
    'pdf-annotations:import-native',
    readonly [PdfNativeAnnotationImportRequest],
    PdfNativeAnnotationImportResult
  >('pdf-annotations:import-native', pdfAnnotationApplicationCommandContracts.importNative),
  cancelImport: defineApplicationCommand<
    'pdf-annotations:cancel-import',
    readonly [PdfNativeAnnotationCancelRequest],
    { cancelled: boolean }
  >('pdf-annotations:cancel-import', pdfAnnotationApplicationCommandContracts.cancelImport)
})
const pdfAnnotationApplicationCommandGroup = defineApplicationCommandGroup('pdf-annotations', [
  pdfAnnotationApplicationCommands.list,
  pdfAnnotationApplicationCommands.create,
  pdfAnnotationApplicationCommands.update,
  pdfAnnotationApplicationCommands.delete,
  pdfAnnotationApplicationCommands.importNative,
  pdfAnnotationApplicationCommands.cancelImport
] as const)
const registerPdfAnnotationApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: PdfAnnotationCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(pdfAnnotationApplicationCommandGroup, {
      'pdf-annotations:list': ({ args }) => owner.list(args[0]),
      'pdf-annotations:create': ({ args }) => owner.create(args[0]),
      'pdf-annotations:update': ({ args }) => owner.update(args[0]),
      'pdf-annotations:delete': ({ args }) => owner.delete(args[0]),
      'pdf-annotations:import-native': ({ args, callerLease }) =>
        owner.importNative(args[0], callerLease.signal),
      'pdf-annotations:cancel-import': ({ args }) => owner.cancelImport(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
export {
  pdfAnnotationApplicationCommandGroup,
  pdfAnnotationApplicationCommands,
  registerPdfAnnotationApplicationCommands
}
export type { PdfAnnotationCommandOwner }
