import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

const formatJsonPreview = (content: string): { formatted: string; error?: string } => {
  try {
    return { formatted: JSON.stringify(JSON.parse(content), null, 2) }
  } catch (error) {
    return {
      formatted: content,
      error: error instanceof Error ? error.message : 'Invalid JSON'
    }
  }
}

export const JsonPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        path={item.path}
        name={item.name}
        source={item.source}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="JSON couldn't be read for preview"
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  const { formatted, error } = formatJsonPreview(state.preview.content)

  const errorContent = error ? (
    <div className="shrink-0 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-danger-000">
      Invalid JSON: {error}
    </div>
  ) : undefined

  return <SourcePreviewContent content={formatted} topContent={errorContent} />
}
