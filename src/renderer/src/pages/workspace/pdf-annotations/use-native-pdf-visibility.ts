import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'

/** Let app overlays own imported marks; retain original rendering for everything not imported. */
export const useNativePdfVisibility = (
  document: PDFDocumentProxy | null,
  source: PdfAnnotationSource | undefined,
  sessionId: string | undefined,
  completedImportId?: string
): number => {
  const [revision, setRevision] = useState(0)
  const { kind, projectId, sourceFileId, versionId } = source ?? {}
  useEffect(() => {
    if (!document || !kind || !sourceFileId || !versionId) return
    let active = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.pdfAnnotations.list({
          ...(kind === 'literature-attachment-version'
            ? { literatureVersionId: versionId }
            : { projectId, sessionId }),
          sourceFileId,
          versionId,
          limit: 1
        })
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
  }, [document, kind, projectId, sessionId, sourceFileId, versionId, completedImportId])
  return revision
}
