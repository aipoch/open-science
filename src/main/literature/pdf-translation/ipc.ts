import { app } from 'electron'
import { join } from 'node:path'
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
import { callerLeaseForEvent } from '../../caller-lifecycle'
import { ipcMainHandle } from '../../ipc-handler-registry'
import type { PdfTranslationOwner } from './index'

export const registerPdfTranslationIpc = (owner: PdfTranslationOwner): void => {
  const resources = (): string =>
    toUnpackedAsarPath(join(app.getAppPath(), 'resources', 'pdf-translation'))
  const writer = new PdfTranslationPdfCache({
    root: resolveDataRoot,
    revision: () => pdfTranslationCacheRevision(resources(), app.getVersion()),
    owner,
    writer: new PdfTranslationWriter(() => join(resources(), 'worker.mjs'))
  })
  ipcMainHandle('pdf-translation:generate-pdf', (event, request: PdfTranslationPdfRequest) =>
    writer.generate(request, callerLeaseForEvent(event))
  )
  ipcMainHandle('pdf-translation:cancel-pdf', (event, id: string) =>
    writer.cancel(id, callerLeaseForEvent(event))
  )
  ipcMainHandle(
    'pdf-translation:save-snapshot',
    (event, request: PdfTranslationSaveSnapshotRequest) =>
      owner.saveSnapshot(request, callerLeaseForEvent(event))
  )
  ipcMainHandle(
    'pdf-translation:record-layout',
    async (event, request: PdfTranslationRecordLayoutRequest) => {
      const caller = callerLeaseForEvent(event)
      await owner.recordLayout(request, caller)
      await writer.confirm(request, caller)
    }
  )
  ipcMainHandle(
    'pdf-translation:read-checkpoint',
    (event, source: PdfTranslationCheckpointRequest) =>
      owner.readCheckpoint(source, callerLeaseForEvent(event))
  )
  ipcMainHandle('pdf-translation:begin', (event, request: PdfTranslationBeginRequest) =>
    owner.begin(request, callerLeaseForEvent(event))
  )
  ipcMainHandle('pdf-translation:list-editions', (event, source: PdfTranslationCheckpointRequest) =>
    owner.listEditions(source, callerLeaseForEvent(event))
  )
  ipcMainHandle(
    'pdf-translation:select-edition',
    (event, request: PdfTranslationSelectEditionRequest) =>
      owner.selectEdition(request, callerLeaseForEvent(event))
  )
  ipcMainHandle(
    'pdf-translation:delete-edition',
    (event, request: PdfTranslationSelectEditionRequest) =>
      owner.deleteEdition(request, callerLeaseForEvent(event))
  )
  ipcMainHandle(
    'pdf-translation:translate',
    async (event, request: PdfTranslationRunRequest): Promise<PdfTranslationRunResult> => {
      try {
        return await owner.translate(request, callerLeaseForEvent(event))
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
    }
  )
  ipcMainHandle('pdf-translation:skip', (event, request: PdfTranslationRunRequest) =>
    owner.skip(request, callerLeaseForEvent(event))
  )
  ipcMainHandle('pdf-translation:close', (event, request: PdfTranslationOperationRequest) =>
    owner.close(request?.operationId, callerLeaseForEvent(event))
  )
}
