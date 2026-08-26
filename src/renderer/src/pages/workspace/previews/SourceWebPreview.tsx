import { ExternalLink, Globe2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SOURCE_PREVIEW_FRAME_NAME,
  parseHttpsSourceUrl,
  type SourcePreviewLoadState
} from '../../../../../shared/source-preview'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreviewSourceItem } from '@/stores/preview-workbench-store'

const INITIAL_PROGRESS = 0.08
const MAX_LOADING_PROGRESS = 0.9
const PROGRESS_TICK_MS = 350
const COMPLETION_DELAY_MS = 250

type SourcePreviewDisplayState = SourcePreviewLoadState | { phase: 'loading' }

const getFailureCode = (
  state: Extract<SourcePreviewLoadState, { phase: 'failed' }>
): string | undefined => {
  if (state.failure === 'http' && state.httpStatusCode !== undefined) {
    return `HTTP ${state.httpStatusCode}${state.httpStatusText ? ` ${state.httpStatusText}` : ''}`
  }
  if (state.errorDescription) {
    return `${state.errorDescription}${state.errorCode === undefined ? '' : ` (${state.errorCode})`}`
  }
  return state.errorCode === undefined ? undefined : String(state.errorCode)
}

const SourcePreviewSkeleton = (): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-source-preview-skeleton=""
      role="status"
      aria-label={t('Loading preview…')}
      className="absolute inset-0 z-10 overflow-hidden bg-bg-000 px-5 py-6"
    >
      <div className="mx-auto flex w-full max-w-xl animate-pulse flex-col gap-4 motion-reduce:animate-none">
        <div className="h-5 w-3/5 rounded-sm bg-bg-300" />
        <div className="flex flex-col gap-2.5">
          <div className="h-3 w-full rounded-sm bg-bg-300" />
          <div className="h-3 w-11/12 rounded-sm bg-bg-300" />
          <div className="h-3 w-4/5 rounded-sm bg-bg-300" />
        </div>
        <div className="mt-2 h-32 w-full rounded-sm bg-bg-300" />
        <div className="flex flex-col gap-2.5">
          <div className="h-3 w-full rounded-sm bg-bg-300" />
          <div className="h-3 w-5/6 rounded-sm bg-bg-300" />
        </div>
      </div>
    </div>
  )
}

const SourceWebPreviewContent = ({
  item,
  sourceUrl
}: {
  item: PreviewSourceItem
  sourceUrl: URL
}): React.JSX.Element => {
  const { t } = useTranslation()
  const hasLifecycleMonitor = Boolean(window.api?.sourcePreview?.onLoadState)
  const [frameAttempt, setFrameAttempt] = useState(0)
  const [progressRun, setProgressRun] = useState(0)
  const [isFrameReady, setIsFrameReady] = useState(!hasLifecycleMonitor)
  const [loadState, setLoadState] = useState<SourcePreviewDisplayState>({ phase: 'loading' })
  const [progress, setProgress] = useState(INITIAL_PROGRESS)
  const [isProgressVisible, setIsProgressVisible] = useState(true)
  const minimumNavigationIdRef = useRef(0)
  const progressTimerRef = useRef<number | undefined>(undefined)
  const completionTimerRef = useRef<number | undefined>(undefined)
  const isMountedRef = useRef(false)

  const finishProgress = useCallback((): void => {
    window.clearTimeout(progressTimerRef.current)
    window.clearTimeout(completionTimerRef.current)
    setProgress(1)
    completionTimerRef.current = window.setTimeout(() => {
      setIsProgressVisible(false)
    }, COMPLETION_DELAY_MS)
  }, [])

  const stopProgress = useCallback((): void => {
    window.clearTimeout(progressTimerRef.current)
    window.clearTimeout(completionTimerRef.current)
    setIsProgressVisible(false)
  }, [])

  useEffect(() => {
    const subscribe = window.api?.sourcePreview?.onLoadState
    if (!subscribe) return

    // Subscribe before inserting the iframe so even an immediate browser-process failure is observed.
    const removeListener = subscribe((state) => {
      if (parseHttpsSourceUrl(state.sourceUrl)?.href !== sourceUrl.href) return
      if (state.navigationId < minimumNavigationIdRef.current) return

      minimumNavigationIdRef.current = state.navigationId
      setLoadState(state)
      if (state.phase === 'loading') {
        setProgress(INITIAL_PROGRESS)
        setIsProgressVisible(true)
        setProgressRun((current) => current + 1)
      } else if (state.phase === 'loaded') {
        finishProgress()
      } else {
        stopProgress()
      }
    })
    let active = true
    void Promise.resolve().then(() => {
      if (active) setIsFrameReady(true)
    })
    return () => {
      active = false
      removeListener()
    }
  }, [finishProgress, sourceUrl.href, stopProgress])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // StrictMode immediately replays mount effects without removing the iframe. Defer release so
      // that replay can retain the active main-process tracking record; a real unmount stays false.
      void Promise.resolve().then(() => {
        if (!isMountedRef.current) window.api?.sourcePreview?.release?.(sourceUrl.href)
      })
    }
  }, [sourceUrl.href])

  useEffect(() => {
    let currentProgress = INITIAL_PROGRESS
    const advanceProgress = (): void => {
      currentProgress = Math.min(
        MAX_LOADING_PROGRESS,
        currentProgress + Math.max(0.015, (MAX_LOADING_PROGRESS - currentProgress) * 0.12)
      )
      setProgress(currentProgress)
      if (currentProgress < MAX_LOADING_PROGRESS) {
        progressTimerRef.current = window.setTimeout(advanceProgress, PROGRESS_TICK_MS)
      }
    }
    progressTimerRef.current = window.setTimeout(advanceProgress, PROGRESS_TICK_MS)

    return () => {
      window.clearTimeout(progressTimerRef.current)
      window.clearTimeout(completionTimerRef.current)
    }
  }, [progressRun])

  const handleFrameLoad = (): void => {
    // Browser-only development has no Electron lifecycle bridge, so retain iframe.onload as a
    // graceful fallback. Electron ignores it because blocked/error documents also dispatch load.
    if (hasLifecycleMonitor) return
    setLoadState({
      navigationId: 0,
      sourceUrl: sourceUrl.href,
      currentUrl: sourceUrl.href,
      phase: 'loaded',
      httpStatusCode: 200,
      httpStatusText: 'OK'
    })
    finishProgress()
  }

  const retry = (): void => {
    minimumNavigationIdRef.current += 1
    setLoadState({ phase: 'loading' })
    setProgress(INITIAL_PROGRESS)
    setIsProgressVisible(true)
    setProgressRun((current) => current + 1)
    setFrameAttempt((current) => current + 1)
  }

  const displayedUrl =
    'currentUrl' in loadState
      ? (parseHttpsSourceUrl(loadState.currentUrl)?.href ?? sourceUrl.href)
      : sourceUrl.href
  const failureDescription =
    loadState.phase !== 'failed'
      ? undefined
      : loadState.failure === 'blocked'
        ? t('This source does not allow embedded previews.')
        : loadState.failure === 'certificate'
          ? t('A secure connection to this source could not be established.')
          : loadState.failure === 'http'
            ? t('The source returned an HTTP error.')
            : t('The source could not be reached.')

  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-000">
      <header
        data-source-preview-header=""
        className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border-300/50 px-3"
      >
        <div className="min-w-0 flex-1">
          <div
            data-source-preview-header-title=""
            className="truncate text-[12px] font-medium text-text-000"
          >
            {item.title}
          </div>
          <div
            data-source-preview-header-url=""
            className="truncate text-[10px] text-text-000/70"
            title={displayedUrl}
          >
            {displayedUrl}
          </div>
        </div>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-source-preview-header-external=""
                aria-label={t('Open source in browser')}
                onClick={() => window.open(sourceUrl.href, '_blank', 'noreferrer')}
              >
                <ExternalLink
                  data-source-preview-header-external-icon=""
                  className="size-4"
                  aria-hidden="true"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Open source in browser')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {isProgressVisible ? (
          <div
            data-source-preview-progress=""
            role="progressbar"
            aria-label={t('Loading preview…')}
            className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15"
          >
            <div
              data-source-preview-progress-fill=""
              className="h-full w-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        ) : null}
      </header>
      <div className="relative min-h-0 flex-1 bg-white">
        {isFrameReady ? (
          <iframe
            key={frameAttempt}
            data-source-preview-frame=""
            name={SOURCE_PREVIEW_FRAME_NAME}
            title={t('Source preview: {{title}}', { title: item.title })}
            src={sourceUrl.href}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            aria-hidden={loadState.phase === 'failed' || undefined}
            className={cn(
              'absolute inset-0 size-full border-0 bg-white',
              loadState.phase === 'failed' && 'pointer-events-none'
            )}
            onLoad={handleFrameLoad}
          />
        ) : null}
        {loadState.phase === 'loading' ? <SourcePreviewSkeleton /> : null}
        {loadState.phase === 'failed' ? (
          <div
            data-source-preview-error=""
            className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-bg-000 px-5 py-8"
          >
            <ErrorNotice
              icon={Globe2}
              tone="amber"
              title={t('Could not load this source')}
              description={failureDescription}
              errorCode={getFailureCode(loadState)}
              secondaryButton={{
                label: t('Open source in browser'),
                onClick: () => window.open(sourceUrl.href, '_blank', 'noreferrer')
              }}
              primaryButton={{ label: t('Try again'), onClick: retry }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

const SourceWebPreview = ({ item }: { item: PreviewSourceItem }): React.JSX.Element => {
  const { t } = useTranslation()
  const sourceUrl = parseHttpsSourceUrl(item.url)

  if (!sourceUrl) {
    return (
      <div className="flex size-full items-center justify-center px-6 text-center text-sm text-text-300">
        {t('Only HTTPS sources can be previewed')}
      </div>
    )
  }

  return <SourceWebPreviewContent key={sourceUrl.href} item={item} sourceUrl={sourceUrl} />
}

export { SourceWebPreview }
