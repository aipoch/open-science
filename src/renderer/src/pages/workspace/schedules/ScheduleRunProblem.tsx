import { scheduleReasonText } from './schedule-reason'
import { ChevronRight, CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ScheduleSummary } from '../../../../../shared/session-schedules'

type Props = NonNullable<ScheduleSummary['latestProblem']> & {
  onOpenRun?: (runId?: string, trigger?: HTMLElement) => void
}

export function ScheduleRunProblem({
  status,
  reason,
  scriptRunId,
  onOpenRun
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const label =
    status === 'failed'
      ? t('Last run failed')
      : status === 'interrupted'
        ? t('Interrupted')
        : t('Skipped')
  const detail = reason && reason !== status ? scheduleReasonText(reason, t) : undefined
  const content = (
    <>
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </>
  )
  return (
    <span
      className={
        'block text-xs ' +
        (status === 'failed' ? 'text-status-failure-foreground' : 'text-status-warning-foreground')
      }
    >
      {onOpenRun ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto justify-start gap-1 px-0 py-0.5 text-inherit hover:bg-transparent hover:text-inherit hover:underline"
          onClick={(event) => onOpenRun(scriptRunId ?? undefined, event.currentTarget)}
        >
          {content}
          <ChevronRight aria-hidden="true" className="size-3" />
        </Button>
      ) : (
        <span className="inline-flex items-center gap-1">{content}</span>
      )}
      {detail && <span className="block break-words text-muted-foreground">{detail}</span>}
    </span>
  )
}
