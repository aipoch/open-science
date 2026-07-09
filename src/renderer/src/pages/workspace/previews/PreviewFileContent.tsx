import { renderPreviewFile } from './preview-registry'
import { PreviewUnsupportedContent } from './PreviewFallback'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

export const PreviewFileContent = ({ item }: { item: PreviewFileItem }): React.JSX.Element => {
  const content = renderPreviewFile({ item })

  if (content) return content

  return <PreviewUnsupportedContent path={item.path} name={item.name} source={item.source} />
}
