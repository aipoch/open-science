import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogBodyClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { ScheduleRun, ScheduleSummary } from '../../../../../shared/session-schedules'
import { ScheduleRunStatus } from './ScheduleRunStatus'
import { scheduleErrorText, scheduleReasonText } from './schedule-reason'
import { useScheduleSelection } from './use-schedule-selection'

export function ScheduleRunResultDialog({
  task,
  onClose,
  returnFocus
}: {
  task: ScheduleSummary
  onClose: () => void
  returnFocus?: HTMLElement
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [run, setRun] = useState<ScheduleRun>()
  const [error, setError] = useState('')
  const { select, error: navigationError } = useScheduleSelection(onClose)
  useEffect(() => {
    let active = true
    void window.api.schedules
      .history({
        projectId: task.target.projectId,
        sessionId: task.target.sessionId,
        scheduleId: task.id
      })
      .then((runs) => {
        if (!active) return
        const found = runs.find((row) =>
          task.latestProblem?.scheduledAt === undefined
            ? row.status === task.latestProblem?.status
            : row.scheduledAt === task.latestProblem.scheduledAt
        )
        if (found) setRun(found)
        else setError(t('The source message is no longer available.'))
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [task, t])
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (returnFocus?.isConnected) {
              event.preventDefault()
              returnFocus.focus({ preventScroll: true })
            }
          }}
          aria-describedby={undefined}
          className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] p-0')}
        >
          <header className={dialogHeaderClassName}>
            <Dialog.Title className="font-semibold">{t('Results')}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('Close')}>
                <X />
              </Button>
            </Dialog.Close>
          </header>
          <div className={dialogBodyClassName + ' space-y-3'} aria-busy={!run && !error}>
            <h2 className="break-words font-medium">{task.draft.name}</h2>
            {run && (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <time className="text-muted-foreground">
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: task.draft.rule.timeZone
                    }).format(run.scheduledAt)}
                  </time>
                  <ScheduleRunStatus
                    projectId={task.target.projectId}
                    scheduleId={task.id}
                    run={run}
                  />
                </div>
                {run.reason && run.reason !== 'failed' && (
                  <ErrorNotice
                    inline
                    level="warning"
                    description={scheduleReasonText(run.reason, t)}
                  />
                )}
              </>
            )}
            {(error || navigationError) && (
              <ErrorNotice
                inline
                title={t('Schedule')}
                description={scheduleErrorText(error || navigationError, t)}
              />
            )}
          </div>
          {run?.promptMessageId && (
            <footer className={dialogFooterClassName}>
              <Button variant="secondary" onClick={() => select(task, undefined, run.scheduledAt)}>
                {t('Open session')}
              </Button>
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
