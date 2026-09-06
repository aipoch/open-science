import { CircleAlert, CircleQuestionMark, LoaderCircle, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { FlaskLogo } from '@/components/flask-logo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Inline notices share one compact presentation. Only startup-blocking surfaces opt into
// the full-page branded layout. All copy arrives as final display strings — callers translate.

type ErrorNoticeTone = 'teal' | 'amber' | 'red'

type ErrorNoticeButton = {
  label: string
  onClick: () => void
  disabled?: boolean
  // Shows a spinner beside the label and disables the button while an action is in flight.
  loading?: boolean
}

type ErrorNoticeProps = {
  fullPage?: boolean
  icon?: LucideIcon
  tone?: ErrorNoticeTone
  title?: string
  description?: string
  errorCode?: string
  help?: { whyLabel: string; why: string; howLabel: string; how: string }
  issueLink?: { label: string; tooltip: string; onClick: () => void }
  secondaryButton?: ErrorNoticeButton
  primaryButton?: ErrorNoticeButton
}

// Semantic tones: teal = update the app, amber = transient / retryable, red = data or
// installation integrity. Classes resolve to the status token families registered in main.css.
const TONE_CLASSES: Record<ErrorNoticeTone, string> = {
  teal: 'bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground',
  amber:
    'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
  red: 'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
}

const NoticeButton = ({
  button,
  variant,
  compact
}: {
  button: ErrorNoticeButton
  variant?: 'secondary'
  compact?: boolean
}): React.JSX.Element => (
  <Button
    type="button"
    className="focus-visible:transition-none"
    variant={compact && variant === 'secondary' ? 'outline' : variant}
    size={compact ? 'sm' : 'default'}
    onClick={button.onClick}
    disabled={button.disabled || button.loading}
    aria-busy={button.loading || undefined}
  >
    {button.loading ? (
      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    ) : null}
    {button.label}
  </Button>
)

const ErrorNotice = ({
  fullPage = false,
  icon: Icon = fullPage ? undefined : CircleAlert,
  tone,
  title,
  description,
  errorCode,
  help,
  issueLink,
  secondaryButton,
  primaryButton
}: ErrorNoticeProps): React.JSX.Element => {
  const compact = !fullPage
  const Heading = compact ? 'h2' : 'h1'
  return (
    <section
      className={cn(
        'flex w-full min-w-0 flex-col text-left',
        compact
          ? ['gap-3 rounded-lg border border-current/15 p-4', TONE_CLASSES[tone ?? 'amber']]
          : 'max-w-md gap-4'
      )}
    >
      {fullPage ? <FlaskLogo className="mb-4 size-18 self-center text-text-300" /> : null}

      {title !== undefined || description !== undefined ? (
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <div
              className={cn(
                'flex shrink-0 items-center justify-center',
                compact ? 'h-5 w-4' : ['size-9 rounded-full', TONE_CLASSES[tone ?? 'amber']]
              )}
            >
              <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title !== undefined ? (
              <Heading
                className={cn(
                  'font-semibold text-foreground [overflow-wrap:anywhere]',
                  compact ? 'text-sm leading-5' : 'text-base leading-6'
                )}
              >
                {title}
              </Heading>
            ) : null}
            {description !== undefined ? (
              <p
                className={cn(
                  'text-sm text-muted-foreground [overflow-wrap:anywhere]',
                  compact ? 'leading-5' : 'leading-6'
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorCode !== undefined ? (
        <p className="w-full rounded-lg bg-muted px-3 py-2.5 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {errorCode}
        </p>
      ) : null}

      {help ? (
        <div className="flex w-full min-w-0 flex-col gap-4 rounded-lg bg-muted p-4 [overflow-wrap:anywhere]">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{help.whyLabel}</p>
            <p className="text-[13px] leading-6 text-foreground/90">{help.why}</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{help.howLabel}</p>
            <p className="text-[13px] leading-6 text-foreground/90">{help.how}</p>
          </div>
        </div>
      ) : null}

      {secondaryButton !== undefined || primaryButton !== undefined ? (
        <div
          className={cn(
            'flex w-full flex-wrap items-center gap-2',
            compact ? Icon && 'pl-7' : 'justify-end'
          )}
        >
          {secondaryButton ? (
            <NoticeButton button={secondaryButton} variant="secondary" compact={compact} />
          ) : null}
          {primaryButton ? <NoticeButton button={primaryButton} compact={compact} /> : null}
        </div>
      ) : null}

      {issueLink ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1.5 self-end rounded-sm text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={issueLink.onClick}
              >
                <CircleQuestionMark className="size-3.5 shrink-0" aria-hidden="true" />
                {issueLink.label}
              </button>
            </TooltipTrigger>
            <TooltipContent>{issueLink.tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </section>
  )
}

export { ErrorNotice }
export type { ErrorNoticeButton, ErrorNoticeProps, ErrorNoticeTone }
