import { ChevronDown, LoaderCircle, MessageSquare, MessagesSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type DiscussionStep = {
  id: string
  title: string
  branchIndex?: number
  stepNumber?: number
}

export const composerContextRowClassName =
  'flex min-h-9 items-center gap-1 border-b border-border-200 bg-bg-10 px-2'

// The action and its selected Session stay separate, in both drafts and ongoing conversations.
export const SessionDiscussionBar = ({
  title,
  scope,
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
  onRemove: () => void
  disabled?: boolean
  pending?: boolean
  removeLabel: string
  removeHint?: string
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const latest = steps.at(-1)
  if (!latest) return null
  const selectionLabel =
    scope === 'session'
      ? undefined
      : steps.length > 1
        ? t('{{count}} steps', { count: steps.length })
        : latest.stepNumber
          ? t('Step {{step}}', { step: latest.stepNumber })
          : undefined
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      data-testid="session-discussion-bar"
      aria-busy={pending}
    >
      <Popover>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-1.5 text-xs font-medium disabled:opacity-100"
                disabled={disabled}
              >
                <MessageSquare className="size-4 text-primary" aria-hidden="true" />
                {t('Discuss')}
                <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {scope === 'session' ? t('Entire research') : t('Selected steps')}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          className="max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto border border-border bg-popover p-2 text-popover-foreground [scrollbar-gutter:stable]"
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {scope === 'session' ? t('Entire research') : t('Selected steps')}
          </p>
          {steps.map((step) => (
            <PopoverClose key={step.id} asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                title={step.title}
                disabled={disabled}
                onClick={() => onReveal(step.id)}
              >
                <span className="truncate">
                  {step.branchIndex === undefined
                    ? ''
                    : `${t('Branch {{index}}', { index: step.branchIndex + 1 })} · `}
                  {step.stepNumber ? `${t('Step {{step}}', { step: step.stepNumber })} · ` : ''}
                  {step.title || title}
                </span>
              </Button>
            </PopoverClose>
          ))}
        </PopoverContent>
      </Popover>
      <span
        className="inline-flex min-w-0 max-w-56 items-center rounded-lg bg-bg-200"
        data-session-discussion-source="true"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 min-w-0 shrink gap-1.5 px-2 text-xs font-medium text-text-300 disabled:opacity-100"
              disabled={disabled}
              onClick={() => onReveal(latest.id)}
            >
              {pending ? (
                <LoaderCircle
                  className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <MessagesSquare
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{title}</span>
              {selectionLabel ? (
                <span className="shrink-0 text-muted-foreground">{selectionLabel}</span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent data-session-discussion-tooltip="true" className="max-w-72 truncate">
            {`${t('View replay')} · ${title} · ${scope === 'session' ? t('Entire research') : (selectionLabel ?? t('Selected steps'))}`}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 disabled:opacity-100"
              disabled={disabled}
              aria-label={removeLabel}
              onClick={onRemove}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{removeHint ?? removeLabel}</TooltipContent>
        </Tooltip>
      </span>
    </div>
  )
}
