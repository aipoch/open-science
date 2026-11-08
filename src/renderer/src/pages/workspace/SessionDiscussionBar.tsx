import { LoaderCircle, MessagesSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type DiscussionStep = {
  id: string
  title: string
  branchIndex?: number
  showTitle?: boolean
  stepNumber?: number
}

export const composerContextRowClassName =
  'flex min-h-9 items-center gap-1 border-b border-border-200 bg-bg-10 px-2'

export const SessionDiscussionBar = ({
  title,
  scope,
  onCancelDraft,
  steps,
  onReveal,
  onRemove,
  disabled = false,
  pending = false,
  removeLabel,
  removeHint
}: {
  title: string
  scope?: 'step' | 'session'
  steps: readonly DiscussionStep[]
  onReveal: (id: string) => void
  onCancelDraft?: () => void
  onRemove?: () => void
  disabled?: boolean
  pending?: boolean
  removeLabel?: string
  removeHint?: string
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const wholeResearch = scope === 'session'
  if (!steps.length) return null
  const viewReplay = t('View replay')
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2"
      data-testid="session-discussion-bar"
      aria-busy={pending}
    >
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        data-session-discussion-source="true"
      >
        {steps.map((step) => {
          const stepLabel = wholeResearch
            ? undefined
            : step.stepNumber
              ? [t('Step {{step}}', { step: step.stepNumber }), step.showTitle && step.title]
                  .filter(Boolean)
                  .join(' · ')
              : steps.length > 1
                ? step.title
                : undefined
          const label =
            steps.length > 1 && step.branchIndex !== undefined
              ? [t('Branch {{index}}', { index: step.branchIndex + 1 }), stepLabel]
                  .filter(Boolean)
                  .join(' · ')
              : stepLabel
          const hint = `${viewReplay}: ${title}, ${wholeResearch ? t('Entire research') : label || step.title || t('Selected steps')}`
          return (
            <Tooltip key={step.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 min-w-0 max-w-full flex-auto justify-start gap-1.5 px-1.5 text-xs font-medium"
                  disabled={disabled}
                  aria-label={hint}
                  onClick={() => onReveal(step.id)}
                >
                  {pending ? (
                    <LoaderCircle
                      className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <MessagesSquare className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  )}
                  <span className="min-w-0 max-w-[24ch] truncate">{title}</span>
                  {label && (
                    <span className="max-w-[60%] shrink-0 truncate border-s border-border-200 ps-1.5 text-muted-foreground">
                      {label}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent data-session-discussion-tooltip="true">{hint}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      {onCancelDraft && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto h-7 shrink-0 px-1.5 text-xs font-normal text-muted-foreground"
              aria-label={t('Cancel discussion and keep draft')}
              disabled={disabled}
              onClick={onCancelDraft}
            >
              {t('Cancel')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('Cancel discussion and keep draft')}</TooltipContent>
        </Tooltip>
      )}
      {onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ms-auto shrink-0"
              disabled={disabled}
              aria-label={removeLabel}
              onClick={onRemove}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{removeHint ?? removeLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
