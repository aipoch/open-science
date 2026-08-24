import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

export const PreviewFileContent = ({
  item,
  downloadVersionContext
}: {
  item: PreviewFileItem
  downloadVersionContext?: PreviewDownloadVersionContext
}): React.JSX.Element => {
  const content = renderPreviewFile({ item })

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
