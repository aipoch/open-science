import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import { PreviewRuntimeBoundary } from './preview-runtime'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

export const PreviewFileContent = ({ item }: { item: PreviewFileItem }): React.JSX.Element => {
  const content = renderPreviewFile({ item })

  return (
    <PreviewRuntimeBoundary item={item}>
      {content ?? (
        <PreviewUnsupportedContent path={item.path} name={item.name} source={item.source} />
      )}
    </PreviewRuntimeBoundary>
  )
}
