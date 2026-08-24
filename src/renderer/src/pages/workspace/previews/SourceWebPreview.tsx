import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SOURCE_PREVIEW_FRAME_NAME,
  parseHttpsSourceUrl
} from '../../../../../shared/source-preview'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewSourceItem } from '@/stores/preview-workbench-store'

const INITIAL_PROGRESS = 0.08
const MAX_LOADING_PROGRESS = 0.9
const PROGRESS_TICK_MS = 350
const COMPLETION_DELAY_MS = 250

const SourceWebPreviewContent = ({
  item,
  sourceUrl
}: {
  item: PreviewSourceItem
  sourceUrl: URL
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [progress, setProgress] = useState(INITIAL_PROGRESS)
  const [isProgressVisible, setIsProgressVisible] = useState(true)
  const progressTimerRef = useRef<number | undefined>(undefined)
  const completionTimerRef = useRef<number | undefined>(undefined)

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
  }, [])

  const handleFrameLoad = (): void => {
    window.clearTimeout(progressTimerRef.current)
    window.clearTimeout(completionTimerRef.current)
    setProgress(1)
    completionTimerRef.current = window.setTimeout(() => {
      setIsProgressVisible(false)
    }, COMPLETION_DELAY_MS)
  }

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
            title={sourceUrl.href}
          >
            {sourceUrl.href}
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
      <iframe
        data-source-preview-frame=""
        name={SOURCE_PREVIEW_FRAME_NAME}
        title={t('Source preview: {{title}}', { title: item.title })}
        src={sourceUrl.href}
        sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
        onLoad={handleFrameLoad}
      />
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
