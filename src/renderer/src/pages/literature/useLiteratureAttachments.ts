import { useFileDropZone } from '@/hooks/useFileDropZone'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { stageComposerFile } from '../workspace/composer-upload-transfer'
import type { LiteratureDetailController } from './LiteratureDetailController'
import { pdfImportErrorMessage } from './useLiteratureImport'
import { useLiteraturePdfStaging } from './useLiteraturePdfStaging'

/** Own existing-reference PDF admission and transfer errors; share the page staging lifecycle. */
export function useLiteratureAttachments({
  detailController,
  pdfStaging,
  loadEntries
}: {
  detailController: LiteratureDetailController
  pdfStaging: ReturnType<typeof useLiteraturePdfStaging>
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
}): {
  isAddingPdf: boolean
  addingPdfRef: React.RefObject<boolean>
  pdfError: string | undefined
  setPdfError: React.Dispatch<React.SetStateAction<string | undefined>>
  addPdf: (file: File) => Promise<void>
  isDraggingPdf: boolean
  pdfDropZoneProps: ReturnType<typeof useFileDropZone>['dropZoneProps']
} {
  const { t } = useTranslation()
  const [isAddingPdf, setIsAddingPdf] = useState(false)
  const addingPdfRef = useRef(false)
  const [pdfError, setPdfError] = useState<string>()
  const addPdf = async (file: File): Promise<void> => {
    const { item: current, generation } = detailController.getSnapshot()
    if (!current || addingPdfRef.current) return
    addingPdfRef.current = true
    setIsAddingPdf(true)
    setPdfError(undefined)
    const transferId = crypto.randomUUID()
    let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
    try {
      staged = await pdfStaging.stagePdf(file, transferId)
      await window.api.uploads.claimLocalFile?.({ transferId })
      pdfStaging.finishPdfStaging()
      const operationId = crypto.randomUUID()
      pdfStaging.trackNativeImport(operationId)
      const receipt = await window.api.literature.importPdf({
        itemId: current.id,
        attachment: staged,
        operationId
      })
      pdfStaging.trackNativeImport(undefined)
      // An attachment receipt may predate metadata edits in a reopened detail. Re-read rather
      // than using metadataRevision as an attachment version or rolling metadata backwards.
      const updated = await detailController.read(current.id).catch(() => undefined)
      detailController.replace(updated ?? receipt.item)
      await loadEntries(true)
    } catch (error) {
      if (detailController.getSnapshot().generation === generation)
        setPdfError(
          pdfStaging.wasCancelled()
            ? t('PDF upload cancelled. The reference was kept.')
            : pdfImportErrorMessage(error, t)
        )
    } finally {
      if (staged)
        await window.api.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
      pdfStaging.clear()
      addingPdfRef.current = false
      setIsAddingPdf(false)
    }
  }
  const { isDragging: isDraggingPdf, dropZoneProps: pdfDropZoneProps } = useFileDropZone({
    enabled: !isAddingPdf,
    onFiles: (files) => {
      const unsupported = files.filter(
        (file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')
      )
      if (files.length !== 1 || unsupported.length) {
        setPdfError(
          [
            t('Choose one PDF at a time. No files were added.'),
            ...(unsupported.length
              ? [
                  t('Unsupported files: {{names}}', {
                    names: unsupported.map((file) => file.name).join(', ')
                  })
                ]
              : [])
          ].join(' ')
        )
        return
      }
      void addPdf(files[0])
    }
  })
  return {
    isAddingPdf,
    addingPdfRef,
    pdfError,
    setPdfError,
    addPdf,
    isDraggingPdf,
    pdfDropZoneProps
  }
}
