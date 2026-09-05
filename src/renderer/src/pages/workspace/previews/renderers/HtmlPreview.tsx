import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { MANAGED_PREVIEW_LOAD_ERROR } from '../../../../../../shared/preview-resources'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { createPreviewResourceKey } from '../preview-resource-key'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'
import { useRegisterPreviewContextMenuFrame } from '../../preview-actions/preview-action-hooks'

type HtmlPreviewMode = 'render' | 'source'

// Catalog keys rather than text so the toggle relabels on a language switch.
const HTML_PREVIEW_MODES = [
  { id: 'render', labelKey: 'Render', ariaLabelKey: 'Show rendered HTML' },
  { id: 'source', labelKey: 'Source', ariaLabelKey: 'Show HTML source' }
] as const satisfies readonly { id: HtmlPreviewMode; labelKey: string; ariaLabelKey: string }[]

const HtmlSourceContent = ({
  item,
  topContent,
  ...annotationProps
}: PreviewFileRendererProps & { topContent: React.ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)
  const renderStatus = (content: React.ReactNode): React.JSX.Element => (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {topContent}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  )

  if (state.status === 'loading') return renderStatus(<PreviewLoadingContent />)
  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return renderStatus(
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("HTML couldn't be read for preview")}
      />
    )
  }

  return (
    <PreviewTextAnnotationSurface item={item} {...annotationProps}>
      <SourcePreviewContent
        content={state.preview.content}
        pagination={state.pagination}
        topContent={topContent}
      />
    </PreviewTextAnnotationSurface>
  )
}

export const HtmlPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const [mode, setMode] = useState<HtmlPreviewMode>('render')
  const requestKey = createPreviewResourceKey(item)
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const resourceState = useManagedPreviewResource(item, mode === 'render' && !hasFailed)
  const renderedFrameUrl =
    mode === 'render' && resourceState.status === 'ready' ? resourceState.resource.url : ''
  useRegisterPreviewContextMenuFrame({
    id: `html-preview:${requestKey}`,
    frameUrl: renderedFrameUrl,
    frameRef: iframeRef,
    enabled: renderedFrameUrl !== ''
  })

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
            aria-label={t(option.ariaLabelKey)}
            aria-pressed={mode === option.id}
            className={cn(
              'h-6 rounded px-2 text-[12px] text-text-300 transition-colors hover:bg-bg-000 hover:text-text-000',
              mode === option.id && 'bg-bg-000 text-text-000 shadow-sm'
            )}
            onClick={() => setMode(option.id)}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
    </div>
  )

  if (mode === 'source') {
    return <HtmlSourceContent {...props} topContent={modeToggle} />
  }

  if (resourceState.status === 'loading') return <PreviewLoadingContent />
  if (resourceState.status === 'error' || resourceState.status === 'idle' || hasFailed) {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-bg-10">
        {modeToggle}
        <div className="min-h-0 flex-1">
          <PreviewErrorCard
            name={item.name}
            error={resourceState.status === 'error' ? resourceState.error : undefined}
            fallbackMessage={t("HTML couldn't be read for preview")}
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
        title={t('Preview of {{name}}', { name: item.name })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={resourceState.resource.url}
        className="min-h-0 flex-1 border-0 bg-bg-000"
      />
    </div>
  )
}
