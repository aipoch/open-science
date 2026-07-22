import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

export const PreviewTextContent = ({
  path,
  name,
  source = 'artifact'
}: {
  path: string
  name: string
  source?: PreviewFileSource
}): React.JSX.Element => {
  const state = usePreviewFileContent({ path, source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="File couldn't be read for preview"
      />
    )
  }

  return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
}

export const TextPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewTextContent path={item.path} name={item.name} source={item.source} />
)
