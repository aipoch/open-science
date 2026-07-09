import { FileWarning } from 'lucide-react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
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
      <PreviewFallbackCard
        icon={FileWarning}
        path={path}
        name={name}
        source={source}
        message="File couldn't be read for preview"
      />
    )
  }

  return (
    <SourcePreviewContent content={state.preview.content} truncated={state.preview.truncated} />
  )
}

export const TextPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewTextContent path={item.path} name={item.name} source={item.source} />
)
