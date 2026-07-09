import { FileWarning } from 'lucide-react'

import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

export const MarkdownPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        path={item.path}
        name={item.name}
        source={item.source}
        message="Markdown couldn't be read for preview"
      />
    )
  }

  return (
    <div className="size-full overflow-auto bg-bg-10 p-4">
      {state.preview.truncated ? (
        <div className="mb-3 rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          Preview truncated because the file is large
        </div>
      ) : null}
      <AgentMarkdown content={state.preview.content} />
    </div>
  )
}
