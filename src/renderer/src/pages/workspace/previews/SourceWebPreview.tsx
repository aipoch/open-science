import { SourceWebview } from './SourceWebview'
import type { WebviewTag } from 'electron'
import { ActionMenuTarget } from '@/components/action-menu'
import { PreviewActionMenuAdapterProvider } from '../preview-actions/preview-action-adapter'
import {
  PREVIEW_CAPABILITY_CATALOG,
  SOURCE_PREVIEW_MENU_RECIPE,
  shouldHandlePreviewContextMenu
} from '../preview-actions/preview-action-model'
import { ExternalLink, Globe2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SOURCE_PREVIEW_FRAME_NAME,
  SOURCE_PREVIEW_SANDBOX,
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
  sourceUrl,
  onClose
}: {
  item: PreviewSourceItem
  sourceUrl: URL
  onClose?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const closeLabel = t('Close preview of {{title}}', { title: item.title })
  const [nativeView] = useState(() => Boolean(window.api?.getRuntimeVersions?.().electron))
  const webviewRef = useRef<WebviewTag | null>(null)
  const [frameAttempt, setFrameAttempt] = useState(0)
  const [progressRun, setProgressRun] = useState(0)
  const [loadState, setLoadState] = useState<SourcePreviewLoadState>({
    navigationId: 0,
    sourceUrl: sourceUrl.href,
    currentUrl: sourceUrl.href,
    phase: 'loading'
  })
  const [progress, setProgress] = useState(INITIAL_PROGRESS)
  const [isProgressVisible, setIsProgressVisible] = useState(true)
  const progressTimerRef = useRef<number | undefined>(undefined)
  const completionTimerRef = useRef<number | undefined>(undefined)
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

  const handleState = useCallback(
    (state: SourcePreviewLoadState): void => {
      setLoadState(state)
      if (state.phase === 'loading') {
        setProgress(INITIAL_PROGRESS)
        setIsProgressVisible(true)
        setProgressRun((current) => current + 1)
      } else if (state.phase === 'loaded') finishProgress()
      else stopProgress()
    },
    [finishProgress, stopProgress]
  )

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
    // Browser-only development has no guest navigation events.
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
    setLoadState((current) => ({ ...current, phase: 'loading' }))
    setProgress(INITIAL_PROGRESS)
    setIsProgressVisible(true)
    setProgressRun((current) => current + 1)
    if (nativeView) webviewRef.current?.reload()
    else setFrameAttempt((current) => current + 1)
  }

  const displayedUrl =
    'currentUrl' in loadState
      ? (parseHttpsSourceUrl(loadState.currentUrl)?.href ?? sourceUrl.href)
      : sourceUrl.href
  const restoreSourceFocus = useCallback(
    (restoreDefault: () => void): void => {
      if (!nativeView) {
        restoreDefault()
        return
      }
      const guest = webviewRef.current
      if (
        guest?.isConnected &&
        guest.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
        guest.getClientRects().length > 0
      )
        restoreDefault()
    },
    [nativeView]
  )
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
    <ActionMenuTarget
      asChild
      targetId={`source-content:${item.id}`}
      identityKey={item.id}
      catalog={PREVIEW_CAPABILITY_CATALOG}
      recipe={SOURCE_PREVIEW_MENU_RECIPE}
      invocation={undefined}
      onRestoreFocus={restoreSourceFocus}
      resolveInvocation={(event) =>
        shouldHandlePreviewContextMenu(event.target) ? undefined : null
      }
      bindings={{
        'open-source': {
          execute: () => {
            window.open(displayedUrl, '_blank', 'noreferrer')
          }
        },
        'copy-source-url': { execute: () => navigator.clipboard.writeText(displayedUrl) },
        close: { execute: () => onClose?.(), hidden: !onClose }
      }}
    >
      <div className="flex size-full min-h-0 flex-col bg-bg-000">
        <header
          data-source-preview-header=""
          className="relative flex h-10 shrink-0 items-start gap-1 border-b border-border-300/50 px-2 py-1"
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
                  size="icon-xs"
                  className="text-text-100 hover:text-text-000"
                  data-source-preview-header-external=""
                  aria-label={t('Open source in browser')}
                  onClick={() => window.open(displayedUrl, '_blank', 'noreferrer')}
                >
                  <ExternalLink data-source-preview-header-external-icon="" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('Open source in browser')}</TooltipContent>
            </Tooltip>
            {onClose ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-text-100 hover:text-text-000"
                    data-source-preview-header-close=""
                    aria-label={closeLabel}
                    onClick={onClose}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{closeLabel}</TooltipContent>
              </Tooltip>
            ) : null}
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
          {nativeView ? (
            <PreviewActionMenuAdapterProvider targetId={`source-content:${item.id}`}>
              <SourceWebview
                sourceUrl={sourceUrl.href}
                title={t('Source preview: {{title}}', { title: item.title })}
                webviewRef={webviewRef}
                onState={handleState}
              />
            </PreviewActionMenuAdapterProvider>
          ) : (
            <iframe
              key={frameAttempt}
              data-source-preview-frame=""
              name={SOURCE_PREVIEW_FRAME_NAME}
              title={t('Source preview: {{title}}', { title: item.title })}
              src={sourceUrl.href}
              sandbox={SOURCE_PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              aria-hidden={loadState.phase === 'failed' || undefined}
              className={cn(
                'absolute inset-0 size-full border-0 bg-white',
                loadState.phase === 'failed' && 'pointer-events-none'
              )}
              onLoad={handleFrameLoad}
            />
          )}
          {loadState.phase === 'loading' ? <SourcePreviewSkeleton /> : null}
          {loadState.phase === 'failed' ? (
            <div
              data-source-preview-error=""
              className="absolute inset-0 z-10 overflow-y-auto bg-bg-000"
            >
              {/* Matching 40% offsets make the top gap 80% of the previous centered gap. */}
              <div
                data-source-preview-error-content=""
                className="absolute left-1/2 top-[40%] flex w-full -translate-x-1/2 -translate-y-[40%] justify-center px-5"
              >
                <ErrorNotice
                  icon={Globe2}
                  tone="amber"
                  role="alert"
                  diagnosticsLabel={t('Diagnostics')}
                  title={t('Could not load this source')}
                  description={failureDescription}
                  errorCode={getFailureCode(loadState)}
                  secondaryButton={{
                    label: t('Open source in browser'),
                    onClick: () => window.open(displayedUrl, '_blank', 'noreferrer')
                  }}
                  primaryButton={{ label: t('Try again'), onClick: retry }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ActionMenuTarget>
  )
}

const SourceWebPreview = ({
  item,
  onClose
}: {
  item: PreviewSourceItem
  onClose?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const sourceUrl = parseHttpsSourceUrl(item.url)

  if (!sourceUrl) {
    return (
      <div className="flex size-full items-center justify-center px-6 text-center text-sm text-text-300">
        {t('Only HTTPS sources can be previewed')}
      </div>
    )
  }

  return (
    <SourceWebPreviewContent
      key={sourceUrl.href}
      item={item}
      sourceUrl={sourceUrl}
      onClose={onClose}
    />
  )
}

export { SourceWebPreview }
