import { useLiteratureHost } from '../renderer-host'
import type { LiteratureDetailController } from '@aipoch/literature-library/client'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { stageUploadFile as stageComposerFile } from '@/lib/upload-transfer'
import { pdfImportErrorMessage } from '../imports/useLiteratureImport'
import { useLiteraturePdfStaging } from '../imports/useLiteraturePdfStaging'

/** Own existing-reference file admission and transfer errors; share the page staging lifecycle. */
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
  addPdfs: (files: File[]) => Promise<void>
  pdfProgress: string | undefined
} {
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const [isAddingPdf, setIsAddingPdf] = useState(false)
  const addingPdfRef = useRef(false)
  const [pdfError, setPdfError] = useState<string>()
  const [pdfProgress, setPdfProgress] = useState<string>()
  const addPdfs = async (files: File[]): Promise<void> => {
    const { item: current, generation, open } = detailController.getSnapshot()
    if (!open || !current || addingPdfRef.current || files.length === 0) return
    addingPdfRef.current = true
    setIsAddingPdf(true)
    setPdfError(undefined)
    const failures: string[] = []
    try {
      for (const [index, file] of files.entries()) {
        // Keep the whole batch bound to the original reference, even during external navigation.
        const snapshot = detailController.getSnapshot()
        if (
          !snapshot.open ||
          snapshot.generation !== generation ||
          snapshot.item?.id !== current.id
        )
          break
        setPdfProgress(
          t('Adding {{fileName}} ({{current}}/{{total}})…', {
            fileName: file.name,
            current: index + 1,
            total: files.length
          })
        )
        const transferId = crypto.randomUUID()
        let staged: Awaited<ReturnType<typeof stageComposerFile>> | undefined
        let cancelled = false
        try {
          staged = await pdfStaging.stagePdf(file, transferId)
          await hostApi.uploads.claimLocalFile?.({ transferId })
          pdfStaging.finishPdfStaging()
          const operationId = crypto.randomUUID()
          pdfStaging.trackNativeImport(operationId)
          const receipt = await hostApi.literature.importPdf({
            itemId: current.id,
            attachment: staged,
            operationId
          })
          pdfStaging.trackNativeImport(undefined)
          const updated = await detailController.read(current.id).catch(() => undefined)
          detailController.replace(updated ?? receipt.item)
        } catch (error) {
          cancelled = pdfStaging.wasCancelled()
          failures.push(
            `${file.name}: ${cancelled ? t('Upload cancelled. The reference was kept.') : file.name.toLowerCase().endsWith('.pdf') ? pdfImportErrorMessage(error, t) : t('The attachment operation failed. Try again.')}`
          )
        } finally {
          cancelled ||= pdfStaging.wasCancelled()
          if (staged)
            await hostApi.uploads.deleteUpload({ path: staged.path }).catch(() => undefined)
          pdfStaging.clear()
        }
        if (cancelled) {
          const remaining = files.slice(index + 1)
          if (remaining.length)
            failures.push(
              t('Not added: {{names}}', { names: remaining.map((entry) => entry.name).join(', ') })
            )
          break
        }
      }
    } finally {
      if (detailController.getSnapshot().generation === generation)
        setPdfError(failures.join(' ') || undefined)
      addingPdfRef.current = false
      setIsAddingPdf(false)
      setPdfProgress(undefined)
      // A refresh failure must not turn committed attachments into failed uploads.
      void loadEntries(true).catch(() => undefined)
    }
  }
  return { isAddingPdf, addingPdfRef, pdfError, setPdfError, addPdfs, pdfProgress }
}
