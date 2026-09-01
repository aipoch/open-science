import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'
import type { PreviewFileRendererProps } from './preview-types'

export const PreviewFileContent = ({
  item,
  downloadVersionContext,
  annotationVersionId,
  annotationBlockedByHistoricalVersion,
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
}): React.JSX.Element => {
  const content = renderPreviewFile({
    item,
    annotationVersionId,
    annotationBlockedByHistoricalVersion,
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
    <PreviewRuntimeBoundary item={item} downloadVersionContext={downloadVersionContext}>
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
    </PreviewRuntimeBoundary>
  )
}
