import { useState } from 'react'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ReplayScene, ReplayStep } from '../../../../../shared/replay'
import { useReplayTranslation } from './replay-presentation'
import { replayExcerpt } from './replay-content'
import type { RecordedExecutionState } from '@/lib/replay/recorded-execution'
import { ReplayExecutionState } from './ReplayExecutionState'

/** Compact historical context survives narrow layouts and material changes. */
export function ReplayCurrentContext({
  compact = false,
  scene,
  steps,
  onHistory,
  onNotebook,
  executionState,
  executionWaiting
}: {
  compact?: boolean
  scene: ReplayScene
  steps: readonly ReplayStep[]
  onHistory: () => void
  onNotebook?: () => void
  executionState?: RecordedExecutionState
  executionWaiting?: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const [expanded, setExpanded] = useState(false)
  const latest = steps
    .slice(0, scene.stepIndex + 1)
    .filter((step) => step.message)
    .at(-1)
  const message = latest?.message
  const description =
    scene.step?.kind === 'notebook'
      ? t('Notebook')
      : scene.step?.kind === 'artifact'
        ? t('Results')
        : scene.step?.kind === 'activity'
          ? t('Recorded activity')
          : scene.step?.kind === 'review'
            ? t('Review')
            : t('Original research conversation')
  if (compact)
    return (
      <section
        className="shrink-0 border-b border-border-200 bg-bg-10 px-3 py-1"
        aria-label={t('Current research context')}
        data-testid="replay-current-context"
      >
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full min-w-0 justify-start gap-2 px-0 text-xs"
              aria-label={t('Expand context')}
            >
              <span className="shrink-0 text-text-300">
                {scene.step
                  ? t('Step {{step}}', { step: scene.stepIndex + 1 })
                  : t('Research replay')}
              </span>
              <span className="min-w-0 flex-1 truncate text-left">
                {scene.step?.title || (message ? replayExcerpt(message.content, 180) : description)}
              </span>
              <ChevronDown size={12} className="shrink-0 text-text-300" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-[min(28rem,calc(100vw-1.5rem))] overflow-auto p-3 text-sm"
          >
            <p className="mb-2 text-xs text-text-300">
              {description} · {t('Read-only research history')}
            </p>
            <p className="whitespace-pre-wrap break-words">
              {message
                ? replayExcerpt(message.content, 6000)
                : t('No original conversation is saved for this step.')}
            </p>
            {executionState ? (
              <div className="mt-3 border-t border-border-200 pt-3">
                <ReplayExecutionState state={executionState} detail waiting={executionWaiting} />
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1">
              <PopoverClose asChild>
                <Button variant="outline" size="sm" onClick={onHistory}>
                  {t('Browse original conversation')}
                </Button>
              </PopoverClose>
              {onNotebook ? (
                <PopoverClose asChild>
                  <Button variant="ghost" size="sm" onClick={onNotebook}>
                    {t('View related Notebook')}
                  </Button>
                </PopoverClose>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
        {executionState ? (
          <div className="pb-1">
            <ReplayExecutionState state={executionState} waiting={executionWaiting} />
          </div>
        ) : null}
      </section>
    )
  return (
    <section
      aria-label={t('Current research context')}
      className="shrink-0 border-b border-border-200 bg-bg-10 px-3 py-2 text-xs"
      data-testid="replay-current-context"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{description}</span>
        <span className="text-text-300">{t('Read-only research history')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? t('Collapse context') : t('Expand context')}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onHistory}>
          {t('Browse original conversation')}
        </Button>
      </div>
      {message ? (
        <p
          className={`${expanded ? 'max-h-32 overflow-auto whitespace-pre-wrap' : 'line-clamp-2'} mt-1 break-words text-text-200`}
        >
          <span className="font-medium">{message.role === 'user' ? t('User') : t('Agent')}</span>
          {': '}
          {replayExcerpt(message.content, expanded ? 6000 : 400)}
        </p>
      ) : (
        <p className="mt-1 text-text-300">
          {t('No original conversation is saved for this step.')}
        </p>
      )}
      {executionState ? (
        <ReplayExecutionState state={executionState} detail={expanded} waiting={executionWaiting} />
      ) : null}
      {expanded ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-text-300">
          <span>{t('Only saved research records are shown.')}</span>
          {onNotebook ? (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onNotebook}>
              {t('View related Notebook')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
