import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { type UploadTransferProgress } from '../../../../shared/uploads'
import { stageComposerFile } from '../workspace/composer-upload-transfer'

/** One transfer owner for import and attachment, including native annotation cancellation. */
export function useLiteraturePdfStaging(): {
  stagePdf: (file: File, transferId: string) => ReturnType<typeof stageComposerFile>
  finishPdfStaging: () => void
  trackNativeImport: (operationId: string | undefined) => void
  wasCancelled: () => boolean
  clear: () => void
  notice: React.JSX.Element | null
} {
  const { t } = useTranslation()
  const [pdfUpload, setPdfUpload] = useState<{
    progress: UploadTransferProgress
    phase: 'uploading' | 'cancelling' | 'saving'
  }>()
  const [pdfNativeProgress, setPdfNativeProgress] =
    useState<import('../../../../shared/pdf-annotations').PdfNativeAnnotationImportProgress>()
  const pdfUploadRef = useRef<{ controller: AbortController; transferId: string } | undefined>(
    undefined
  )
  const pdfNativeImportRef = useRef<string | undefined>(undefined)
  const uploadPageMountedRef = useRef(true)
  const stagePdf = async (
    file: File,
    transferId: string
  ): Promise<Awaited<ReturnType<typeof stageComposerFile>>> => {
    const controller = new AbortController()
    pdfUploadRef.current = { controller, transferId }
    if (!uploadPageMountedRef.current) controller.abort()
    return stageComposerFile(file, window.api.uploads, {
      transferId,
      name: file.name,
      signal: controller.signal,
      onProgress: (progress) =>
        setPdfUpload({
          progress,
          phase: controller.signal.aborted ? 'cancelling' : 'uploading'
        })
    })
  }
  const finishPdfStaging = (): void => {
    if (pdfUploadRef.current?.controller.signal.aborted)
      throw new DOMException('Upload cancelled.', 'AbortError')
    pdfUploadRef.current = undefined
    setPdfUpload((current) => (current ? { ...current, phase: 'saving' } : current))
  }
  const cancelPdfUpload = (): void => {
    const operationId = pdfNativeImportRef.current
    if (operationId) {
      void window.api.literature.cancelPdfImport({ operationId }).catch(() => undefined)
      setPdfUpload((current) => (current ? { ...current, phase: 'cancelling' } : current))
    }
    const controller = pdfUploadRef.current?.controller
    if (!controller || controller.signal.aborted || !pdfUpload || pdfUpload.phase !== 'uploading')
      return
    controller.abort()
    setPdfUpload({ ...pdfUpload, phase: 'cancelling' })
    void window.api.uploads
      .abortTransfer({ transferId: pdfUpload.progress.transferId })
      .catch(() => undefined)
  }
  useEffect(() => {
    const subscribe = window.api.pdfAnnotations?.onImportProgress
    if (!subscribe) return
    return subscribe((progress) => {
      if (progress.operationId === pdfNativeImportRef.current) setPdfNativeProgress(progress)
    })
  }, [])
  useEffect(() => {
    uploadPageMountedRef.current = true
    return () => {
      uploadPageMountedRef.current = false
      const operationId = pdfNativeImportRef.current
      if (operationId)
        void window.api.literature.cancelPdfImport({ operationId }).catch(() => undefined)
      const upload = pdfUploadRef.current
      if (!upload) return
      upload.controller.abort()
      void window.api.uploads
        .abortTransfer({ transferId: upload.transferId })
        .catch(() => undefined)
    }
  }, [])
  const pdfUploadNotice =
    pdfUpload || pdfNativeProgress ? (
      <div className="shrink-0 space-y-2 border-b border-border px-5 py-3">
        {pdfUpload ? (
          <>
            <p className="truncate text-sm font-medium">{pdfUpload.progress.name}</p>
            <progress
              className="h-2 w-full accent-primary"
              aria-label={t('Upload progress')}
              max={Math.max(1, pdfUpload.progress.totalBytes)}
              value={pdfUpload.progress.receivedBytes}
            />
            <div className="flex items-center justify-between gap-3">
              <p role="status" className="text-xs text-muted-foreground">
                {pdfUpload.phase === 'cancelling'
                  ? t('Cancelling…')
                  : pdfUpload.phase === 'saving'
                    ? t('Saving…')
                    : t('{{received}} / {{total}} bytes uploaded', {
                        received: pdfUpload.progress.receivedBytes.toLocaleString(),
                        total: pdfUpload.progress.totalBytes.toLocaleString()
                      })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pdfUpload.phase !== 'uploading' && pdfNativeProgress?.phase !== 'parsing'}
                onClick={cancelPdfUpload}
              >
                {t('Cancel upload')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Keep this window open until the upload finishes or is cancelled.')}
            </p>
          </>
        ) : null}
        {pdfNativeProgress ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {pdfNativeProgress.phase === 'parsing' || pdfNativeProgress.phase === 'saving' ? (
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {pdfNativeProgress.phase === 'completed'
              ? t('Imported {{count}} native annotations.', {
                  count: pdfNativeProgress.importedCount
                })
              : pdfNativeProgress.phase === 'cancelled'
                ? t('Native annotation import cancelled.')
                : pdfNativeProgress.phase === 'failed'
                  ? t('Native annotation import failed.')
                  : t('Importing native annotations…')}{' '}
            {pdfNativeProgress.pageCount > 0
              ? t('{{processed}} / {{total}} pages', {
                  processed: pdfNativeProgress.pagesProcessed,
                  total: pdfNativeProgress.pageCount
                })
              : null}
            {pdfNativeProgress.truncated
              ? ` · ${t('Native annotation import limit reached. Some annotations were not imported.')}`
              : null}
            {pdfNativeProgress.unsupportedCount > 0
              ? ` · ${t('Unsupported native annotations: {{count}}', {
                  count: pdfNativeProgress.unsupportedCount
                })}`
              : null}
          </p>
        ) : null}
      </div>
    ) : null
  const trackNativeImport = (operationId: string | undefined): void => {
    pdfNativeImportRef.current = operationId
  }
  const wasCancelled = (): boolean => pdfUploadRef.current?.controller.signal.aborted === true
  const clear = (): void => {
    pdfUploadRef.current = undefined
    pdfNativeImportRef.current = undefined
    setPdfNativeProgress(undefined)
    setPdfUpload(undefined)
  }
  return {
    stagePdf,
    finishPdfStaging,
    trackNativeImport,
    wasCancelled,
    clear,
    notice: pdfUploadNotice
  }
}
