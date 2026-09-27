import { diagnosticErrorFields, errorLogFields } from '../logger'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { PdfAnnotationService } from '../pdf-annotations/service'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { runDataRootStartupRecovery } from '../storage/migration-state'
import { createDefaultUploadRepository } from '../uploads/ipc'
import type { composeStorageStartup } from './storage-startup'

export async function composeUploadStorage({
  storageStartup
}: {
  storageStartup: Awaited<ReturnType<typeof composeStorageStartup>>
}): Promise<{
  pdfUploadImporter: { current?: PdfAnnotationService }
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
}> {
  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const pdfUploadImporter: { current?: PdfAnnotationService } = {}
  const uploadRepository = createDefaultUploadRepository((projectId, sessionId, attachments) => {
    for (const attachment of attachments) {
      if (!attachment.versionId || !attachment.originalName.toLowerCase().endsWith('.pdf')) continue
      // Enrichment starts after publication. Do not await it while the upload caller still owns
      // the Session mutation barrier; the annotation service acquires that barrier itself.
      void pdfUploadImporter.current
        ?.importNative({
          operationId: crypto.randomUUID(),
          projectId,
          sessionId,
          sourceKind: 'upload-version',
          sourceFileId: attachment.id,
          versionId: attachment.versionId
        })
        .catch((error) =>
          storageStartup.storageLog.warn(
            'Native PDF annotation import failed',
            errorLogFields(error)
          )
        )
    }
  })
  await runDataRootStartupRecovery(() => uploadRepository.recoverStagingUploads(), {
    reportFailure: (error) => {
      // Ready bytes remain fail-closed; keep startup available so Files can surface unaffected rows and
      // the next launch can retry any recoverable staging Version.
      storageStartup.storageLog.error(
        'staging upload recovery incomplete; will retry next launch',
        diagnosticErrorFields(error)
      )
    }
  })
  const managedFileVersionService = new ManagedFileVersionService({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })
  return { pdfUploadImporter, uploadRepository, managedFileVersionService }
}
