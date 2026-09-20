import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { PdfAnnotation } from '../../../../shared/pdf-annotations'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { FilePreviewDialog } from '../workspace/FilePreviewDialog'
import { PdfAnnotationsProvider } from '../workspace/pdf-annotations/PdfAnnotationsProvider'
import { requestPdfAnnotationReveal } from '../workspace/annotations/annotation-reveal'

export const TaggedPdfPreviewDialog = ({
  annotation,
  item,
  onClose,
  onError
}: {
  annotation: PdfAnnotation
  item: PreviewFileItem
  onClose: () => void
  onError: (message: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    void requestPdfAnnotationReveal(annotation, {
      activatePreview: false,
      signal: controller.signal
    }).then(
      (outcome) => {
        if (active && outcome !== 'revealed') {
          onError(t('The exact annotation location could not be found.'))
        }
      },
      () => {
        if (active) onError(t('PDF annotations are unavailable for this source.'))
      }
    )
    return () => {
      active = false
      controller.abort()
    }
  }, [annotation, onError, t])
  return (
    <PdfAnnotationsProvider
      projectId={annotation.projectId}
      sessionId={annotation.sessionId}
      literatureVersionId={annotation.literatureVersionId}
    >
      <FilePreviewDialog item={item} onClose={onClose} allowReadingContext={false} />
    </PdfAnnotationsProvider>
  )
}
