import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { createPreviewResourceKey } from '../preview-resource-key'
import { DEFAULT_TIFF_PREVIEW_LIMITS, type DecodedTiffPage } from '../tiff-preview-types'
import { createTiffDecodeSession, type TiffDecodeSession } from '../tiff-preview-worker-client'
import type { PreviewFileRendererProps } from '../preview-types'
import { useManagedPreviewResource } from '../useManagedPreviewResource'
import { TiffCanvas } from './TiffCanvas'
import { ZoomablePreview } from './ZoomablePreview'

type TiffDecodeResult =
  | { requestKey: string; status: 'ready'; page: DecodedTiffPage }
  | { scope: 'resource'; resourceKey: string; status: 'error'; error: Error }
  | { scope: 'page'; requestKey: string; status: 'error'; error: Error; pageCount: number }

type CachedTiffSession = {
  resourceKey: string
  session: TiffDecodeSession
}

const getTiffPreviewErrorMessage = (error: Error, t: (key: string) => string): string => {
  if (
    error.message === 'TIFF file is too large to preview safely' ||
    error.message === 'TIFF page dimensions are too large to preview safely' ||
    error.message === 'TIFF page is too large to preview safely' ||
    error.message === 'TIFF page needs too much memory to preview safely'
  ) {
    return error.message
  }

  if (
    error.message.startsWith('TIFF preview read failed') ||
    error.message === 'TIFF file changed during the preview read'
  ) {
    return t("TIFF couldn't be loaded for preview")
  }

  if (error.message.startsWith('Unsupported ')) {
    return t("This TIFF encoding isn't supported for preview")
  }

  return t("TIFF couldn't be decoded for preview")
}

const TiffPageControls = ({
  pageIndex,
  pageCount,
  onPageChange
}: {
  pageIndex: number
  pageCount: number
  onPageChange: (pageIndex: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const actions = [
    {
      label: 'Previous TIFF page',
      icon: ChevronLeft,
      disabled: pageIndex === 0,
      onClick: () => onPageChange(pageIndex - 1)
    },
    {
      label: 'Next TIFF page',
      icon: ChevronRight,
      disabled: pageIndex === pageCount - 1,
      onClick: () => onPageChange(pageIndex + 1)
    }
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
        {actions.map(({ label, icon: Icon, disabled, onClick }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
        <span className="px-1 text-[11px] tabular-nums text-text-100">
          {t('Page {{current}} of {{total}}', { current: pageIndex + 1, total: pageCount })}
        </span>
      </div>
    </TooltipProvider>
  )
}

const TiffPreviewContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  mimeType,
  size,
  mtimeMs,
  variant = 'interactive',
  align = 'center'
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  variant?: 'interactive' | 'thumbnail'
  align?: 'start' | 'center'
}): React.JSX.Element => {
  const { t } = useTranslation()

  const resourceKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    managedFileId,
    selectedVersionId,
    mimeType,
    size,
    mtimeMs
  })
  const [pageSelection, setPageSelection] = useState({ resourceKey, pageIndex: 0 })
  const pageIndex = pageSelection.resourceKey === resourceKey ? pageSelection.pageIndex : 0
  const setPageIndex = (nextPageIndex: number): void =>
    setPageSelection({ resourceKey, pageIndex: nextPageIndex })
  const [resourceAdmission, setResourceAdmission] = useState({ resourceKey, enabled: true })
  const resourceEnabled =
    resourceAdmission.resourceKey === resourceKey ? resourceAdmission.enabled : true
  const sessionCacheRef = useRef<CachedTiffSession | null>(null)
  const lastDecodedPageRef = useRef<{ resourceKey: string; pageCount: number } | null>(null)
  const resourceState = useManagedPreviewResource(
    {
      projectId,
      sessionId,
      managedFileId,
      selectedVersionId,
      path,
      source,
      mimeType,
      size,
      mtimeMs,
      maxBytes: DEFAULT_TIFF_PREVIEW_LIMITS.maxFileBytes
    },
    resourceEnabled
  )
  const requestKey =
    resourceState.status === 'ready'
      ? `${resourceKey}:${resourceState.resource.id}:${resourceState.resource.version}:${pageIndex}`
      : `${resourceKey}:${pageIndex}`
  const [result, setResult] = useState<TiffDecodeResult | null>(null)

  const handleDrawError = useCallback(
    (error: Error): void => {
      sessionCacheRef.current?.session.dispose()
      sessionCacheRef.current = null
      setResult({ scope: 'resource', resourceKey, status: 'error', error })
      setResourceAdmission({ resourceKey, enabled: false })
    },
    [resourceKey]
  )

  useEffect(() => {
    lastDecodedPageRef.current = null
    return () => {
      sessionCacheRef.current?.session.dispose()
      sessionCacheRef.current = null
    }
  }, [resourceKey])

  useEffect(() => {
    if (resourceState.status !== 'ready') return

    const resource = resourceState.resource
    const controller = new AbortController()
    const dataKey = `${resourceKey}:${resource.id}:${resource.version}`
    let decodeStarted = false

    void Promise.resolve()
      .then(async () => {
        if (resource.size > DEFAULT_TIFF_PREVIEW_LIMITS.maxFileBytes) {
          throw new Error('TIFF file is too large to preview safely')
        }

        let session =
          sessionCacheRef.current?.resourceKey === dataKey ? sessionCacheRef.current.session : null
        if (!session) {
          sessionCacheRef.current?.session.dispose()
          sessionCacheRef.current = null
          const response = await fetch(resource.url, {
            cache: 'no-store',
            signal: controller.signal
          })
          if (!response.ok) {
            throw new Error(`TIFF preview read failed with status ${response.status}`)
          }

          const data = await response.arrayBuffer()
          if (data.byteLength !== resource.size) {
            throw new Error('TIFF file changed during the preview read')
          }
          if (controller.signal.aborted) throw controller.signal.reason

          session = createTiffDecodeSession(data)
          sessionCacheRef.current = { resourceKey: dataKey, session }
        }
        decodeStarted = true
        return session.decodePage(pageIndex, controller.signal)
      })
      .then((page) => {
        if (!controller.signal.aborted) {
          lastDecodedPageRef.current = { resourceKey, pageCount: page.pageCount }
          setResult({ requestKey, status: 'ready', page })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        sessionCacheRef.current?.session.dispose()
        sessionCacheRef.current = null
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        const lastDecodedPage = lastDecodedPageRef.current
        if (decodeStarted && lastDecodedPage?.resourceKey === resourceKey) {
          setResult({
            scope: 'page',
            requestKey,
            status: 'error',
            error: normalizedError,
            pageCount: lastDecodedPage.pageCount
          })
          return
        }

        setResult({ scope: 'resource', resourceKey, status: 'error', error: normalizedError })
        // Revoking the capability releases both its path mapping and strict file snapshot.
        setResourceAdmission({ resourceKey, enabled: false })
      })

    return () => {
      controller.abort()
      if (sessionCacheRef.current?.session.isDisposed()) sessionCacheRef.current = null
    }
  }, [pageIndex, requestKey, resourceKey, resourceState])

  if (resourceState.status === 'error') {
    return (
      <PreviewErrorCard
        name={name}
        error={resourceState.error}
        fallbackMessage={t("TIFF couldn't be loaded for preview")}
      />
    )
  }

  if (
    result?.status === 'error' &&
    result.scope === 'resource' &&
    result.resourceKey === resourceKey
  ) {
    return (
      <PreviewErrorCard
        name={name}
        error={result.error}
        fallbackMessage={getTiffPreviewErrorMessage(result.error, t)}
      />
    )
  }

  if (result?.status === 'error' && result.scope === 'page' && result.requestKey === requestKey) {
    return (
      <div className="relative size-full overflow-hidden">
        <PreviewErrorCard
          name={name}
          error={result.error}
          fallbackMessage={getTiffPreviewErrorMessage(result.error, t)}
        />
        {result.pageCount > 1 ? (
          <TiffPageControls
            pageIndex={pageIndex}
            pageCount={result.pageCount}
            onPageChange={setPageIndex}
          />
        ) : null}
      </div>
    )
  }

  if (
    resourceState.status !== 'ready' ||
    result?.status !== 'ready' ||
    result.requestKey !== requestKey
  ) {
    return <PreviewLoadingContent title={t('Decoding TIFF image')} />
  }

  if (variant === 'thumbnail') {
    return (
      <div
        className={`relative flex size-full items-center overflow-hidden [&_canvas]:rounded-lg [&_canvas]:border [&_canvas]:border-border-200 ${align === 'start' ? 'justify-start' : 'justify-center'}`}
      >
        <TiffCanvas page={result.page} name={name} fit="intrinsic" onError={handleDrawError} />
        {result.page.pageCount > 1 ? (
          <TiffPageControls
            pageIndex={result.page.pageIndex}
            pageCount={result.page.pageCount}
            onPageChange={setPageIndex}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="relative size-full overflow-hidden p-4">
      <ZoomablePreview>
        <TiffCanvas page={result.page} name={name} onError={handleDrawError} />
      </ZoomablePreview>
      {result.page.pageCount > 1 ? (
        <TiffPageControls
          pageIndex={result.page.pageIndex}
          pageCount={result.page.pageCount}
          onPageChange={setPageIndex}
        />
      ) : null}
    </div>
  )
}

const TiffPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <TiffPreviewContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
    managedFileId={item.managedFileId}
    selectedVersionId={item.selectedVersionId}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)

export { TiffPreviewContent, TiffPreviewRenderer }
