import { useTranslation } from 'react-i18next'

import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'

export const MarkdownPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("Markdown couldn't be read for preview")}
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return (
      <PreviewTextAnnotationSurface {...props}>
        <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
      </PreviewTextAnnotationSurface>
    )
  }

  return (
    <PreviewTextAnnotationSurface {...props}>
      <div className="size-full overflow-auto bg-bg-10 p-4">
        <AgentMarkdown content={state.preview.content} />
      </div>
    </PreviewTextAnnotationSurface>
  )
}
