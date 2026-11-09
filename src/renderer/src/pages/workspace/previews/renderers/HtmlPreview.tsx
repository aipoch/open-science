import type { ResearchVideoProgress } from '@aipoch/research-film/contracts'
import {
  localModelDownloadProgress,
  type LocalModelSnapshot
} from '../../../../../../shared/local-models'
import { DownloadProgressLine } from '../../../../components/DownloadProgressLine'
import { ResearchVideoProgressLine } from '../../../../components/research-video-progress'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../../../shared/web-event-connection'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { MANAGED_PREVIEW_LOAD_ERROR } from '../../../../../../shared/preview-resources'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewResourceKey } from '../usePreviewResourceGeneration'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'
import { useRegisterPreviewContextMenuFrame } from '../../preview-actions/preview-action-hooks'
import { Loader2, Video } from 'lucide-react'

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
  const requestKey = usePreviewResourceKey(props.item)
  return <HtmlPreviewContent key={requestKey} {...props} />
}

const HtmlPreviewContent = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const [videoKey, setVideoKey] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ResearchVideoProgress>()
  const [installBytes, setInstallBytes] = useState<number>()
  const [installSnapshot, setInstallSnapshot] = useState<LocalModelSnapshot>()
  const installingTools = useRef(false)
  const [exportError, setExportError] = useState<string>()
  const exportResource = useRef<string | undefined>(undefined)
  const exportCancelled = useRef(false)
  const [mode, setMode] = useState<HtmlPreviewMode>('render')
  const requestKey = usePreviewResourceKey(item)
  const [failedRequestKey, setFailedRequestKey] = useState<string | undefined>(undefined)
  const hasFailed = failedRequestKey === requestKey
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // Source mode may unmount the frame, but an export still owns its readable capability.
  const resourceState = useManagedPreviewResource(
    item,
    (mode === 'render' && !hasFailed) || exporting
  )
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
        event.source === iframeRef.current?.contentWindow &&
        event.data?.type === 'open-science-research-video-ready'
      )
        setVideoKey(requestKey)
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

  useEffect(() => {
    return () => {
      const resourceId = exportResource.current
      if (resourceId)
        void window.api.previewResources.cancelResearchVideoExport({ resourceId }).catch(() => {})
      exportResource.current = undefined
      setInstallBytes(undefined)
      setInstallSnapshot(undefined)
      setExportProgress(undefined)
      setExporting(false)
      if (installingTools.current)
        void window.api.localModels.cancel('video-export').catch(() => {})
    }
  }, [requestKey])

  const exportVideo = async (install = false): Promise<void> => {
    if (resourceState.status !== 'ready' || exportResource.current) return
    const resourceId = resourceState.resource.id
    exportResource.current = resourceId
    exportCancelled.current = false
    setExporting(true)
    setExportError(undefined)
    setExportProgress(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = (): boolean => exportResource.current === resourceId && !exportCancelled.current
    const poll = async (): Promise<void> => {
      try {
        const progress = await window.api.previewResources.researchVideoExportProgress({
          resourceId
        })
        if (current()) setExportProgress(progress ?? undefined)
      } catch {
        /* Keep the export result authoritative during a transient status failure. */
      }
      if (current()) timer = setTimeout(() => void poll(), 500)
    }
    try {
      if (install) {
        installingTools.current = true
        let snapshot = await window.api.localModels.install('video-export')
        while (current() && snapshot.availability === 'installing') {
          setInstallSnapshot(snapshot)
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (!current()) return
          snapshot = await window.api.localModels.getSnapshot('video-export')
        }
        if (!current()) return
        if (snapshot.availability !== 'ready')
          throw new Error(t('Video export component installation failed. Retry to continue.'))
        setInstallBytes(undefined)
        setInstallSnapshot(undefined)
        installingTools.current = false
      }
      if (!current()) return
      void poll()
      const result = await window.api.previewResources.exportResearchVideo({ resourceId })
      if (current()) setInstallBytes(result.needsInstallation?.downloadBytes)
    } catch (error) {
      if (current()) setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (exportResource.current === resourceId) {
        exportResource.current = undefined
        installingTools.current = false
        setInstallSnapshot(undefined)
        setExportProgress(undefined)
        setExporting(false)
      }
    }
  }
  const cancelExport = async (): Promise<void> => {
    const resourceId = exportResource.current
    if (resourceId) {
      exportCancelled.current = true
      if (installingTools.current) await window.api.localModels.cancel('video-export')
      else await window.api.previewResources.cancelResearchVideoExport({ resourceId })
    }
  }
  const modeToggle = (
    <div
      data-research-video-export-toolbar
      className="flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2"
    >
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
      {!exporting &&
        mode === 'render' &&
        videoKey === requestKey &&
        document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' && (
          <Button
            size="xs"
            variant="ghost"
            className="text-text-000"
            onClick={() => void exportVideo(installBytes !== undefined)}
          >
            <Video aria-hidden="true" />
            {t('Export MP4')}
          </Button>
        )}
    </div>
  )
  const exportStatus = exporting && (
    <div
      data-research-video-export-status
      className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border-300 bg-bg-000 px-3 py-2"
    >
      {installSnapshot ? (
        <DownloadProgressLine compact progress={localModelDownloadProgress(installSnapshot)} />
      ) : exportProgress ? (
        <ResearchVideoProgressLine compact progress={exportProgress} />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span role="status" className="truncate">
            {t('Exporting MP4…')}
          </span>
        </div>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={() => void cancelExport().catch((error) => setExportError(String(error)))}
      >
        {t('Cancel')}
      </Button>
    </div>
  )
  const installPrompt = !exporting &&
    installBytes !== undefined &&
    mode === 'render' &&
    videoKey === requestKey &&
    document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' && (
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border-300 bg-bg-000 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t('Video export components required: {{size}} MiB', {
            size: (installBytes / 1024 / 1024).toFixed(1)
          })}
        </span>
        <Button
          size="xs"
          variant="secondary"
          className="shrink-0"
          onClick={() => void exportVideo(true)}
        >
          <Video aria-hidden="true" />
          {t('Install and export')}
        </Button>
      </div>
    )
  const topContent = (
    <>
      {modeToggle}
      {exportStatus}
      {installPrompt}
      {exportError && <ErrorNotice inline tone="amber" description={exportError} />}
    </>
  )

  if (mode === 'source') {
    return <HtmlSourceContent {...props} topContent={topContent} />
  }

  if (resourceState.status === 'loading') return <PreviewLoadingContent />
  if (resourceState.status === 'error' || resourceState.status === 'idle' || hasFailed) {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-bg-10">
        {topContent}
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
      {topContent}
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
