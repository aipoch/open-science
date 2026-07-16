import { FileWarning } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { MANAGED_PREVIEW_LOAD_ERROR } from '../../../../../../shared/preview-resources'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

type HtmlPreviewMode = 'render' | 'source'

const HTML_PREVIEW_MODES: { id: HtmlPreviewMode; label: string; ariaLabel: string }[] = [
  { id: 'render', label: 'Render', ariaLabel: 'Show rendered HTML' },
  { id: 'source', label: 'Source', ariaLabel: 'Show HTML source' }
]

const HtmlSourceContent = ({
  item,
  topContent
}: PreviewFileRendererProps & { topContent: React.ReactNode }): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />
  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        path={item.path}
        name={item.name}
        source={item.source}
        message="HTML couldn't be read for preview"
      />
    )
  }

  return (
    <SourcePreviewContent
      content={state.preview.content}
      pagination={state.pagination}
      topContent={topContent}
    />
  )
}

export const HtmlPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const [mode, setMode] = useState<HtmlPreviewMode>('render')
  const requestKey = JSON.stringify([
    item.source ?? 'artifact',
    item.path,
    item.mimeType ?? null,
    item.size ?? null,
    item.mtimeMs ?? null
  ])
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const resourceState = useManagedPreviewResource(item, mode === 'render' && !hasFailed)

  useEffect(() => {
    if (resourceState.status !== 'ready') return

    const handleMessage = (event: MessageEvent): void => {
      if (
        event.data === MANAGED_PREVIEW_LOAD_ERROR &&
        event.source === iframeRef.current?.contentWindow
      ) {
        // Disabling the hook releases the failed capability while Source mode stays available.
        setFailedRequestKey(requestKey)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [requestKey, resourceState])

  const modeToggle = (
    <div className="flex shrink-0 items-center justify-between border-b border-border-300 bg-bg-000 px-3 py-2">
      <div className="flex items-center gap-1 rounded-md bg-bg-200 p-0.5">
        {HTML_PREVIEW_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={mode === option.id}
            className={cn(
              'h-6 rounded px-2 text-[12px] text-text-300 transition-colors hover:bg-bg-000 hover:text-text-000',
              mode === option.id && 'bg-bg-000 text-text-000 shadow-sm'
            )}
            onClick={() => setMode(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )

  if (mode === 'source') {
    return <HtmlSourceContent item={item} topContent={modeToggle} />
  }

  if (resourceState.status === 'loading') return <PreviewLoadingContent />
  if (resourceState.status === 'error' || resourceState.status === 'idle' || hasFailed) {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-bg-10">
        {modeToggle}
        <div className="min-h-0 flex-1">
          <PreviewFallbackCard
            icon={FileWarning}
            path={item.path}
            name={item.name}
            source={item.source}
            message="HTML couldn't be read for preview"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {modeToggle}
      <iframe
        ref={iframeRef}
        title={`Preview of ${item.name}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={resourceState.resource.url}
        className="min-h-0 flex-1 border-0 bg-bg-000"
      />
    </div>
  )
}
