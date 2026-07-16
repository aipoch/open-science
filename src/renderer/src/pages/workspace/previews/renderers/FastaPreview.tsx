import { FileWarning } from 'lucide-react'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

export const FastaPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        path={item.path}
        name={item.name}
        source={item.source}
        message="FASTA couldn't be read for preview"
      />
    )
  }

  return (
    <SourcePreviewContent
      content={state.preview.content}
      pagination={state.pagination}
      lineClassName="break-all"
    />
  )
}
