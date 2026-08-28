import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'
import type { PreviewFileRendererProps } from './preview-types'

export const PreviewFileContent = ({
  item,
  downloadVersionContext,
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onAnnotationError
}: PreviewFileRendererProps & {
  downloadVersionContext?: PreviewDownloadVersionContext
}): React.JSX.Element => {
  const content = renderPreviewFile({
    item,
    activeAnnotations,
    onAddAnnotation,
    onUpdateAnnotationNote,
    onRemoveAnnotation,
    onAnnotationError
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
