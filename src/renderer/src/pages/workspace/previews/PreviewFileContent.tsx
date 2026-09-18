import { renderPreviewFile } from './preview-registry'
import { Suspense } from 'react'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'
import type { PreviewFileRendererProps } from './preview-types'

export const PreviewFileContent = ({
  item,
  presentation,
  downloadVersionContext,
  onRetry,
  annotationVersionId,
  annotationBlockedByHistoricalVersion,
  annotationVersionPending,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onUndoAnnotation,
  onRedoAnnotation,
  onAnnotationError,
  onPdfReadingPositionChange
}: PreviewFileRendererProps & {
  downloadVersionContext?: PreviewDownloadVersionContext
  onRetry?: () => Promise<void>
}): React.JSX.Element => {
  const content = renderPreviewFile({
    item,
    presentation,
    annotationVersionId,
    annotationBlockedByHistoricalVersion,
    annotationVersionPending,
    activeAnnotations,
    onAddAnnotation,
    onUpdateAnnotationNote,
    onRemoveAnnotation,
    onUndoAnnotation,
    onRedoAnnotation,
    onAnnotationError,
    onPdfReadingPositionChange
  })

  return (
    <PreviewRuntimeBoundary
      item={item}
      downloadVersionContext={downloadVersionContext}
      onRetry={onRetry}
    >
      <Suspense fallback={null}>
        {content ?? (
          <PreviewUnsupportedContent
            path={item.path}
            name={item.name}
            source={item.source}
            projectId={item.projectId}
            fileId={item.managedFileId}
            versionId={item.selectedVersionId}
          />
        )}
      </Suspense>
    </PreviewRuntimeBoundary>
  )
}
