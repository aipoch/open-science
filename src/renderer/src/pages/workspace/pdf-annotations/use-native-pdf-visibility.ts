import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'

/** Let app overlays own imported marks; retain original rendering for everything not imported. */
export const useNativePdfVisibility = (
  document: PDFDocumentProxy | null,
  source: PdfAnnotationSource | undefined,
  sessionId: string | undefined,
  completedImportId?: string,
  writable = false
): number => {
  const [revision, setRevision] = useState(0)
  const { kind, projectId, sourceFileId, versionId } = source ?? {}
  const importSessionId = sessionId ?? source?.sessionId
  useEffect(() => {
    if (!document || !kind || !sourceFileId || !versionId) return
    let active = true
    const load = async (): Promise<void> => {
      try {
        const request = {
          ...(kind === 'literature-attachment-version'
            ? { literatureVersionId: versionId }
            : { projectId, sessionId }),
          sourceFileId,
          versionId,
          limit: 1
        }
        let result = await window.api.pdfAnnotations.list(request)
        if (!active) return
        if (
          !result.nativeImport &&
          writable &&
          projectId &&
          importSessionId &&
          (kind === 'upload-version' || kind === 'artifact-version')
        ) {
          // Recover versions published before native import was available. The durable receipt
          // makes reopening safe even after every imported annotation has been deleted.
          await window.api.pdfAnnotations.importNative({
            operationId: crypto.randomUUID(),
            projectId,
            sessionId: importSessionId,
            sourceKind: kind,
            sourceFileId,
            versionId
          })
          if (!active) return
          result = await window.api.pdfAnnotations.list(request)
        }
        if (!active) return
        for (const { id } of result.nativeImport?.nativeRefs ?? []) {
          document.annotationStorage.setValue(id, { noView: true })
        }
        if (result.nativeImport?.nativeRefs.length) setRevision((value) => value + 1)
      } catch {
        // Keep original PDF annotations visible when their managed source cannot be verified.
        // Provider load/write errors remain the user-facing authority for that source.
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [
    document,
    kind,
    projectId,
    sessionId,
    sourceFileId,
    versionId,
    completedImportId,
    importSessionId,
    writable
  ])
  return revision
}
