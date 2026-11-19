import type { ResearchVideoProgress } from '@aipoch/research-film/contracts'
import {
  RESEARCH_VIDEO_EXPORT_OPTIONS,
  RESEARCH_VIDEO_PLAYER_SIZE_ERROR,
  researchVideoResolutionSchema,
  researchVideoExportEstimate,
  type ResearchVideoResolution
} from '@aipoch/research-film/contracts'
import {
  localModelDownloadProgress,
  type LocalModelSnapshot
} from '../../../../../../shared/local-models'
import { DownloadProgressLine } from '../../../../components/DownloadProgressLine'
import { ResearchVideoProgressLine } from '../../../../components/research-video-progress'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../../../shared/web-event-connection'
import { useEffect, useId, useRef, useState } from 'react'
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
import { useManagedFileDownload } from '../../use-managed-file-download'
import { Check, ChevronDown, Download, Loader2, Video } from 'lucide-react'
import { ResearchVideoExportComplete } from './ResearchVideoExportComplete'

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
  const sharingDescriptionId = useId()
  const htmlDownload = useManagedFileDownload({
    source: item.source ?? 'artifact',
    path: item.path,
    projectId: item.projectId,
    fileId: item.managedFileId,
    versionId: item.selectedVersionId,
    suggestedName: item.name
  })
  const [videoKey, setVideoKey] = useState<string>()
  const [videoDuration, setVideoDuration] = useState<number>()
  const [exportResolution, setExportResolution] = useState<ResearchVideoResolution>('720p')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ResearchVideoProgress>()
  const [installBytes, setInstallBytes] = useState<number>()
  const [installSnapshot, setInstallSnapshot] = useState<LocalModelSnapshot>()
  const [exportError, setExportError] = useState<string>()
  const [exportedPath, setExportedPath] = useState<string>()
  const exportButtonRef = useRef<HTMLButtonElement>(null)
  const activeExport = useRef<
    { resourceId: string; cancelled: boolean; installing: boolean } | undefined
  >(undefined)
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
      ) {
        setVideoKey(requestKey)
        const duration: unknown = event.data.duration
        setVideoDuration(
          typeof duration === 'number' &&
            Number.isFinite(duration) &&
            duration > 0 &&
            duration <= 3600
            ? duration
            : undefined
        )
      }
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
      const attempt = activeExport.current
      activeExport.current = undefined
      if (attempt && !attempt.installing)
        void window.api.previewResources
          .cancelResearchVideoExport({ resourceId: attempt.resourceId })
          .catch(() => {})
      setInstallBytes(undefined)
      setInstallSnapshot(undefined)
      setExportProgress(undefined)
      setExporting(false)
    }
  }, [requestKey])

  const exportVideo = async (
    resolution: ResearchVideoResolution,
    install = false
  ): Promise<void> => {
    if (resourceState.status !== 'ready' || activeExport.current) return
    const resourceId = resourceState.resource.id
    const attempt = { resourceId, cancelled: false, installing: install }
    activeExport.current = attempt
    setExportResolution(resolution)
    setExporting(true)
    setExportError(undefined)
    setExportedPath(undefined)
    setExportProgress(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = (): boolean => activeExport.current === attempt && !attempt.cancelled
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
        attempt.installing = false
      }
      if (!current()) return
      void poll()
      const result = await window.api.previewResources.exportResearchVideo({
        resourceId,
        resolution
      })
      if (current()) {
        setInstallBytes(result.needsInstallation?.downloadBytes)
        if (!result.canceled && !result.needsInstallation && result.filePath)
          setExportedPath(result.filePath)
      }
    } catch (error) {
      if (current()) setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      if (activeExport.current === attempt) {
        activeExport.current = undefined
        setInstallSnapshot(undefined)
        setExportProgress(undefined)
        setExporting(false)
      }
    }
  }
  const cancelExport = async (): Promise<void> => {
    const attempt = activeExport.current
    if (attempt) {
      attempt.cancelled = true
      // The component download is shared by every preview. Cancel only this export.
      if (!attempt.installing)
        await window.api.previewResources.cancelResearchVideoExport({
          resourceId: attempt.resourceId
        })
    }
  }
  const resolutionLabel = (resolution: ResearchVideoResolution): string => {
    const estimate = researchVideoExportEstimate(resolution, videoDuration)
    const values = { ...estimate, resolution: RESEARCH_VIDEO_EXPORT_OPTIONS[resolution].label }
    return estimate.perMinute
      ? t('{{resolution}} (allow {{min}}–{{max}} min per minute of film)', values)
      : t('{{resolution}} (allow {{min}}–{{max}} min)', values)
  }
  const modeToggle = (
    <div
      data-research-video-export-toolbar
      className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2"
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
        !hasFailed &&
        resourceState.status === 'ready' &&
        document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' && (
          <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={exportButtonRef}
                  size="xs"
                  variant="secondary"
                  disabled={htmlDownload.status === 'saving'}
                >
                  <Video aria-hidden="true" />
                  {t('Render video (MP4)')}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {researchVideoResolutionSchema.options.map((resolution) => (
                  <DropdownMenuItem
                    key={resolution}
                    onSelect={() => {
                      if (installBytes !== undefined) setExportResolution(resolution)
                      else void exportVideo(resolution)
                    }}
                  >
                    {resolutionLabel(resolution)}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t(
                    'MP4 uses landscape (16:9). If export is interrupted, it restarts from the beginning.'
                  )}
                </p>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="xs"
              variant="outline"
              disabled={htmlDownload.status === 'saving'}
              aria-busy={htmlDownload.status === 'saving'}
              aria-label={t('Save shareable HTML')}
              aria-describedby={sharingDescriptionId}
              onClick={() => void htmlDownload.execute()}
            >
              {htmlDownload.status === 'saving' ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : htmlDownload.status === 'saved' ? (
                <Check aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {htmlDownload.status === 'saving'
                ? t('Saving...')
                : htmlDownload.status === 'saved'
                  ? t('Saved')
                  : t('Save shareable HTML')}
            </Button>
            <p
              id={sharingDescriptionId}
              className="basis-full text-right text-xs text-muted-foreground"
            >
              {t(
                'Shared HTML can include the conversation on this branch, embedded media, and runnable app code.'
              )}
            </p>
          </div>
        )}
    </div>
  )
  const exportStatus = exporting && (
    <div className="shrink-0 border-b border-border-300 bg-bg-000 px-3 py-2">
      <p className="mb-2 text-xs text-muted-foreground">{resolutionLabel(exportResolution)}</p>
      <div data-research-video-export-status className="flex min-w-0 items-center gap-3">
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
    </div>
  )
  const installPrompt = !exporting &&
    installBytes !== undefined &&
    mode === 'render' &&
    videoKey === requestKey &&
    document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' && (
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border-300 bg-bg-000 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {RESEARCH_VIDEO_EXPORT_OPTIONS[exportResolution].label} ·{' '}
          {t('Video export components required: {{size}} MiB', {
            size: (installBytes / 1024 / 1024).toFixed(1)
          })}
        </span>
        <Button
          size="xs"
          variant="secondary"
          className="shrink-0"
          onClick={() => void exportVideo(exportResolution, true)}
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
      {exportError && (
        <ErrorNotice
          inline
          tone="amber"
          description={
            exportError === RESEARCH_VIDEO_PLAYER_SIZE_ERROR
              ? t('The film exceeds 200 MiB. Shorten it or use smaller media.')
              : exportError
          }
        />
      )}
      {htmlDownload.status === 'error' && (
        <ErrorNotice inline tone="amber" description={t('Download failed. Try again')} />
      )}
      {exportedPath && (
        <ResearchVideoExportComplete
          filePath={exportedPath}
          resolution={RESEARCH_VIDEO_EXPORT_OPTIONS[exportResolution].label}
          onClose={() => setExportedPath(undefined)}
          onRestoreFocus={() => exportButtonRef.current?.focus()}
        />
      )}
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
