import { join } from 'node:path'
import { runtimeMetadata } from '../../runtime-metadata'
import { toUnpackedAsarPath } from '../../skills/resource-path'
import { PdfTranslationWriter } from './writer'
import { PdfTranslationPdfCache } from './pdf-cache'
import { pdfTranslationCacheRevision } from './cache-revision'
import { resolveDataRoot } from '../../storage-root'
import {
  PdfTranslationError,
  type PdfTranslationRunResult,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationSelectEditionRequest,
  type PdfTranslationPdfRequest,
  type PdfTranslationSaveSnapshotRequest,
  type PdfTranslationRecordLayoutRequest,
  type PdfTranslationBeginRequest,
  type PdfTranslationRunRequest,
  type PdfTranslationOperationRequest
} from '../../../shared/pdf-translation'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandHandlers,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../../application-command-router'
import type { PdfTranslationOwner } from './index'

export const pdfTranslationApplicationCommandGroup = defineApplicationCommandGroup(
  'pdf-translation',
  [
    defineApplicationCommand<
      'pdf-translation:generate-pdf',
      readonly [PdfTranslationPdfRequest],
      unknown
    >('pdf-translation:generate-pdf'),
    defineApplicationCommand<'pdf-translation:cancel-pdf', readonly [string], unknown>(
      'pdf-translation:cancel-pdf'
    ),
    defineApplicationCommand<
      'pdf-translation:save-snapshot',
      readonly [PdfTranslationSaveSnapshotRequest],
      unknown
    >('pdf-translation:save-snapshot'),
    defineApplicationCommand<
      'pdf-translation:record-layout',
      readonly [PdfTranslationRecordLayoutRequest],
      unknown
    >('pdf-translation:record-layout'),
    defineApplicationCommand<
      'pdf-translation:read-checkpoint',
      readonly [PdfTranslationCheckpointRequest],
      unknown
    >('pdf-translation:read-checkpoint'),
    defineApplicationCommand<
      'pdf-translation:begin',
      readonly [PdfTranslationBeginRequest],
      unknown
    >('pdf-translation:begin'),
    defineApplicationCommand<
      'pdf-translation:list-editions',
      readonly [PdfTranslationCheckpointRequest],
      unknown
    >('pdf-translation:list-editions'),
    defineApplicationCommand<
      'pdf-translation:select-edition',
      readonly [PdfTranslationSelectEditionRequest],
      unknown
    >('pdf-translation:select-edition'),
    defineApplicationCommand<
      'pdf-translation:delete-edition',
      readonly [PdfTranslationSelectEditionRequest],
      unknown
    >('pdf-translation:delete-edition'),
    defineApplicationCommand<
      'pdf-translation:translate',
      readonly [PdfTranslationRunRequest],
      PdfTranslationRunResult
    >('pdf-translation:translate'),
    defineApplicationCommand<'pdf-translation:skip', readonly [PdfTranslationRunRequest], unknown>(
      'pdf-translation:skip'
    ),
    defineApplicationCommand<
      'pdf-translation:close',
      readonly [PdfTranslationOperationRequest],
      unknown
    >('pdf-translation:close')
  ] as const
)

export function createPdfTranslationHandlers(
  owner: PdfTranslationOwner
): ApplicationCommandHandlers<typeof pdfTranslationApplicationCommandGroup.commands> {
  const resources = (): string =>
    toUnpackedAsarPath(join(runtimeMetadata().applicationPath, 'resources', 'pdf-translation'))
  const writer = new PdfTranslationPdfCache({
    root: resolveDataRoot,
    revision: () => pdfTranslationCacheRevision(resources(), runtimeMetadata().version),
    owner,
    writer: new PdfTranslationWriter(() => join(resources(), 'worker.mjs'))
  })
  return {
    'pdf-translation:generate-pdf': ({ args, callerLease }) =>
      writer.generate(args[0], callerLease),
    'pdf-translation:cancel-pdf': ({ args, callerLease }) => writer.cancel(args[0], callerLease),
    'pdf-translation:save-snapshot': ({ args, callerLease }) =>
      owner.saveSnapshot(args[0], callerLease),
    'pdf-translation:record-layout': async ({ args, callerLease }) => {
      await owner.recordLayout(args[0], callerLease)
      await writer.confirm(args[0], callerLease)
    },
    'pdf-translation:read-checkpoint': ({ args, callerLease }) =>
      owner.readCheckpoint(args[0], callerLease),
    'pdf-translation:begin': ({ args, callerLease }) => owner.begin(args[0], callerLease),
    'pdf-translation:list-editions': ({ args, callerLease }) =>
      owner.listEditions(args[0], callerLease),
    'pdf-translation:select-edition': ({ args, callerLease }) =>
      owner.selectEdition(args[0], callerLease),
    'pdf-translation:delete-edition': ({ args, callerLease }) =>
      owner.deleteEdition(args[0], callerLease),
    'pdf-translation:translate': async ({ args, callerLease }) => {
      try {
        return await owner.translate(args[0], callerLease)
      } catch (error) {
        if (
          error instanceof PdfTranslationError &&
          (error.code === 'incomplete-output' || error.code === 'cancelled')
        )
          return {
            failure: error.code,
            message: error.message,
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {})
          }
        throw error
      }
    },
    'pdf-translation:skip': ({ args, callerLease }) => owner.skip(args[0], callerLease),
    'pdf-translation:close': ({ args, callerLease }) =>
      owner.close(args[0]?.operationId, callerLease)
  }
}

export function registerPdfTranslationApplicationCommands(
  registrar: ApplicationCommandRegistrar,
  owner: PdfTranslationOwner
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(pdfTranslationApplicationCommandGroup, createPdfTranslationHandlers(owner))
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
