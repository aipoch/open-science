import { useId, type ReactNode } from 'react'
import {
  ChevronRight,
  CircleAlert,
  CircleQuestionMark,
  LoaderCircle,
  X,
  type LucideIcon
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { FlaskLogo } from '@/components/flask-logo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Inline notices share one compact presentation. Only startup-blocking surfaces opt into
// the full-page branded layout. All copy arrives as final display strings — callers translate.

type ErrorNoticeTone = 'teal' | 'amber' | 'red'

type ErrorNoticeButton = {
  label: string
  testId?: string
  description?: string
  onClick: () => void
  disabled?: boolean
  // Shows a spinner beside the label and disables the button while an action is in flight.
  loading?: boolean
}

type ErrorNoticeProps = {
  className?: string
  fullPage?: boolean
  // Announce the summary without reading technical diagnostics or recovery controls.
  role?: 'alert' | 'status'
  children?: ReactNode
  icon?: LucideIcon
  tone?: ErrorNoticeTone
  title?: string
  description?: string
  errorCode?: string
  diagnosticsLabel?: string
  help?: { whyLabel: string; why: string; howLabel: string; how: string }
  issueLink?: { label: string; tooltip: string; onClick: () => void }
  secondaryButton?: ErrorNoticeButton
  primaryButton?: ErrorNoticeButton
  dismissButton?: { label: string; onClick: () => void; testId?: string }
}

// Semantic tones: teal = update the app, amber = transient / retryable, red = data or
// installation integrity. Classes resolve to the status token families registered in main.css.
const TONE_CLASSES: Record<ErrorNoticeTone, string> = {
  teal: 'bg-status-info-surface text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground',
  amber:
    'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
  red: 'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
}

const ICON_TONE_CLASSES: Record<ErrorNoticeTone, string> = {
  teal: 'text-status-info-foreground dark:text-status-info-dark-foreground',
  amber: 'text-status-warning-foreground dark:text-status-warning-dark-foreground',
  red: 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
}

const NoticeButton = ({
  button,
  secondary = false,
  compact
}: {
  button: ErrorNoticeButton
  secondary?: boolean
  compact: boolean
}): React.JSX.Element => {
  const descriptionId = useId()
  return (
    <div className="min-w-0">
      <Button
        type="button"
        data-testid={button.testId}
        className={cn(
          'focus-visible:transition-none',
          compact && 'h-auto min-h-8 max-w-full whitespace-normal text-left'
        )}
        variant={compact ? (secondary ? 'ghost' : 'outline') : secondary ? 'secondary' : 'default'}
        size={compact ? 'sm' : 'default'}
        onClick={button.onClick}
        disabled={button.disabled || button.loading}
        aria-busy={button.loading || undefined}
        aria-describedby={button.description ? descriptionId : undefined}
      >
        {button.loading ? (
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        {button.label}
      </Button>
      {button.description ? (
        <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-muted-foreground">
          {button.description}
        </p>
      ) : null}
    </div>
  )
}

const ErrorNotice = ({
  className,
  fullPage = false,
  role,
  children,
  icon: Icon = fullPage ? undefined : CircleAlert,
  tone,
  title,
  description,
  errorCode,
  diagnosticsLabel,
  help,
  issueLink,
  secondaryButton,
  primaryButton,
  dismissButton
}: ErrorNoticeProps): React.JSX.Element => {
  const compact = !fullPage
  const Heading = compact ? 'h2' : 'h1'
  const trailingAction =
    compact &&
    (title !== undefined || description !== undefined) &&
    primaryButton &&
    !secondaryButton &&
    !primaryButton.description &&
    !children &&
    !help
  const describedActions = compact && (primaryButton?.description || secondaryButton?.description)
  const diagnosticContent = (
    <pre className="w-full whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
      {errorCode}
    </pre>
  )
  return (
    <section
      className={cn(
        'flex w-full min-w-0 flex-col text-left',
        compact ? 'gap-3 rounded-lg border border-border bg-card p-4' : 'max-w-md gap-4',
        className
      )}
    >
      {fullPage ? <FlaskLogo className="mb-4 size-18 self-center text-text-300" /> : null}

      {title !== undefined || description !== undefined ? (
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          {Icon ? (
            <div
              className={cn(
                'flex shrink-0 items-center justify-center',
                compact
                  ? ['mt-0.5 h-5 w-4', ICON_TONE_CLASSES[tone ?? 'amber']]
                  : ['size-9 rounded-full', TONE_CLASSES[tone ?? 'amber']]
              )}
            >
              <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </div>
          ) : null}
          <div
            role={role}
            aria-atomic={role ? true : undefined}
            className="flex min-w-0 flex-1 basis-40 flex-col gap-1"
          >
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
              <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                {description}
              </p>
            ) : null}
          </div>
          {trailingAction ? (
            <div className="ml-7 shrink-0 sm:ml-0">
              <NoticeButton button={primaryButton} compact />
            </div>
          ) : null}
          {dismissButton ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={dismissButton.label}
              data-testid={dismissButton.testId}
              onClick={dismissButton.onClick}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {children ? <div className={cn('min-w-0', compact && Icon && 'pl-7')}>{children}</div> : null}

      {fullPage && errorCode !== undefined ? diagnosticContent : null}

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

      {!trailingAction && (secondaryButton || primaryButton) ? (
        <div
          className={cn(
            describedActions
              ? 'grid gap-3 border-t border-border pt-3 sm:grid-cols-2'
              : 'flex flex-wrap items-center gap-2',
            compact ? Icon && 'ml-7' : 'justify-end'
          )}
        >
          {compact && primaryButton ? <NoticeButton button={primaryButton} compact /> : null}
          {secondaryButton ? (
            <NoticeButton button={secondaryButton} secondary compact={compact} />
          ) : null}
          {!compact && primaryButton ? (
            <NoticeButton button={primaryButton} compact={false} />
          ) : null}
        </div>
      ) : null}

      {compact && errorCode !== undefined ? (
        diagnosticsLabel ? (
          <details className={cn('group border-t border-border pt-2.5', Icon && 'ml-7')}>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 group-open:rotate-90" aria-hidden="true" />
              {diagnosticsLabel}
            </summary>
            <div className="mt-2">{diagnosticContent}</div>
          </details>
        ) : (
          diagnosticContent
        )
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
