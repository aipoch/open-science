import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewFileRendererProps } from './preview-types'

export const PreviewFileContent = ({
  item,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onUndoAnnotation,
  onRedoAnnotation,
  onAnnotationError,
  onPdfReadingPositionChange
}: PreviewFileRendererProps): React.JSX.Element => {
  const content = renderPreviewFile({
    item,
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
    <PreviewRuntimeBoundary item={item}>
      {content ?? (
        <PreviewUnsupportedContent path={item.path} name={item.name} source={item.source} />
      )}
    </PreviewRuntimeBoundary>
  )
}
