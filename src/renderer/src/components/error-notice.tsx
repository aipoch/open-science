import { CircleQuestionMark, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { FlaskLogo } from '@/components/flask-logo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Generic error notice column: the brand mark is fixed, everything else is data-driven. Each
// section renders only when its prop is present, so callers compose anything from a bare title to
// a full troubleshooting card. Copy arrives as final display strings — callers translate; the
// built-in help labels below are the only component-owned copy.

type ErrorNoticeTone = 'teal' | 'amber' | 'red'

type ErrorNoticeButton = {
  label: string
  onClick: () => void
  disabled?: boolean
}

type ErrorNoticeProps = {
  icon?: LucideIcon
  tone?: ErrorNoticeTone
  title?: string
  description?: string
  errorCode?: string
  help?: { why: string; how: string }
  issueLink?: { label: string; tooltip: string; onClick: () => void }
  secondaryButton?: ErrorNoticeButton
  primaryButton?: ErrorNoticeButton
}

// Semantic tones: teal = update the app, amber = transient / retryable, red = data or
// installation integrity.
const TONE_CLASSES: Record<ErrorNoticeTone, string> = {
  teal: 'bg-[oklch(0.93_0.03_195)] text-[oklch(0.47_0.105_184)] dark:bg-[oklch(0.32_0.05_200)] dark:text-[oklch(0.72_0.1_184)]',
  amber:
    'bg-[oklch(0.94_0.045_85)] text-[oklch(0.52_0.11_65)] dark:bg-[oklch(0.32_0.05_75)] dark:text-[oklch(0.78_0.11_75)]',
  red: 'bg-[oklch(0.94_0.03_25)] text-[oklch(0.55_0.19_25)] dark:bg-[oklch(0.32_0.06_25)] dark:text-[oklch(0.72_0.16_25)]'
}

const ErrorNotice = ({
  icon: Icon,
  tone,
  title,
  description,
  errorCode,
  help,
  issueLink,
  secondaryButton,
  primaryButton
}: ErrorNoticeProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <section className="flex w-full max-w-md flex-col items-center gap-5">
      <FlaskLogo className="mb-1 h-auto w-1/3 text-text-300" />

      {title !== undefined || description !== undefined ? (
        <div className="flex w-full items-start gap-4">
          {Icon ? (
            <div
              className={`flex size-11 shrink-0 items-center justify-center rounded-full ${TONE_CLASSES[tone ?? 'amber']}`}
            >
              <Icon className="size-5" strokeWidth={1.8} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 pt-0.5">
            {title !== undefined ? (
              <h1 className="text-lg font-semibold text-foreground">{title}</h1>
            ) : null}
            {description !== undefined ? (
              <p className="text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorCode !== undefined ? (
        <p className="w-full rounded-lg bg-muted px-3.5 py-2.5 text-center font-mono text-xs text-muted-foreground">
          {errorCode}
        </p>
      ) : null}

      {help ? (
        <div className="flex w-full flex-col gap-3.5 rounded-2xl bg-[#f1f0eb] p-5 dark:bg-[#24231e]">
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t('Why this happened')}
            </p>
            <p className="text-[13px] leading-6 text-foreground/90">{help.why}</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t('How to fix')}
            </p>
            <p className="text-[13px] leading-6 text-foreground/90">{help.how}</p>
          </div>
        </div>
      ) : null}

      {secondaryButton !== undefined || primaryButton !== undefined ? (
        <div className="flex items-center gap-3">
          {secondaryButton ? (
            <Button
              variant="secondary"
              onClick={secondaryButton.onClick}
              disabled={secondaryButton.disabled}
            >
              {secondaryButton.label}
            </Button>
          ) : null}
          {primaryButton ? (
            <Button onClick={primaryButton.onClick} disabled={primaryButton.disabled}>
              {primaryButton.label}
            </Button>
          ) : null}
        </div>
      ) : null}

      {issueLink ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
                onClick={issueLink.onClick}
              >
                <CircleQuestionMark className="size-3.5" />
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
export type { ErrorNoticeProps, ErrorNoticeTone }
