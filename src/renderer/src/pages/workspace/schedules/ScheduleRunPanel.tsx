import { scheduleErrorText, scheduleReasonText } from './schedule-reason'
import { ResizablePanel } from '@/components/ui/resizable'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Menu, Pencil, SlidersHorizontal } from 'lucide-react'
import type { ScheduleSummary, ScheduleRun } from '../../../../../shared/session-schedules'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useScheduleSelection } from './use-schedule-selection'
import {
  subscribeScheduleHistory,
  useSchedules,
  useScheduleDetail,
  useScheduleRunSession
} from './use-schedules'
import { ScheduleTiming } from './SchedulePage'
import { ScheduleRunStatus } from './ScheduleRunStatus'
import { ScheduleDialog } from './ScheduleDialog'

function LatestRunReply({
  projectId,
  scheduleId,
  run
}: {
  projectId: string
  scheduleId: string
  run: ScheduleRun
}): React.JSX.Element | null {
  const session = useScheduleRunSession(projectId, run)
  const messages = session?.conversationGraph?.messages
  const prompt = messages?.find(
    (m) =>
      m.attribution?.feature === 'schedule' &&
      m.attribution.scheduleId === scheduleId &&
      m.attribution.scheduledAt === run.scheduledAt
  )
  const reply =
    prompt &&
    messages?.findLast(
      (m) => m.role === 'agent' && m.responseToMessageId === prompt.id && m.content.trim()
    )?.content
  return reply ? (
    <div className="max-h-40 overflow-y-auto overscroll-contain break-words text-sm">
      <AgentMarkdown content={reply} allowMedia={false} />
    </div>
  ) : null
}

export function ScheduleRunPanel({
  task: initial,
  openMobileSidebar,
  onOpenSession
}: {
  task: ScheduleSummary
  openMobileSidebar?: () => void
  onOpenSession: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { projectId } = initial.target
  const { tasks, error: listError } = useSchedules(projectId)
  const task = tasks.find((item) => item.id === initial.id) ?? initial
  const { detail, error: detailError } = useScheduleDetail(task)
  const [runs, setRuns] = useState<ScheduleRun[]>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const { select, error: navigationError } = useScheduleSelection(onOpenSession)
  useEffect(() => {
    const unsubscribe = subscribeScheduleHistory(
      { projectId, sessionId: null, scheduleId: initial.id },
      (rows) => {
        setRuns(rows)
        setError('')
      },
      (error) => setError(String(error))
    )
    return () => {
      unsubscribe()
    }
  }, [initial.id, projectId])
  return (
    <ResizablePanel id="main-content" defaultSize="60%" minSize="30%">
      <section className="flex h-full min-w-0 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-8">
          <header className="flex items-center gap-2">
            {openMobileSidebar && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={t('Open navigation')}
                onClick={openMobileSidebar}
              >
                <Menu />
              </Button>
            )}
            <h1 className="min-w-0 flex-1 break-words text-xl font-semibold">{task.draft.name}</h1>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {task.finishedAt ? (
                <SlidersHorizontal aria-hidden="true" />
              ) : (
                <Pencil aria-hidden="true" />
              )}
              {task.finishedAt ? t('View task') : t('Edit task')}
            </Button>
          </header>
          <ScheduleTiming task={task} compact labelNextRun />
          {detail?.draft.action.kind === 'send_session_message' &&
            detail.draft.action.message.trim() !== task.draft.name && (
              <p className="whitespace-pre-wrap break-words">{detail.draft.action.message}</p>
            )}
          <h2 className="border-t border-border pt-4 font-medium">{t('Results')}</h2>
          {(error || listError || detailError || navigationError) && (
            <ErrorNotice
              inline
              title={t('Schedule')}
              description={scheduleErrorText(
                error || listError || detailError || navigationError,
                t
              )}
            />
          )}
          {runs?.length === 0 && <p className="text-muted-foreground">{t('No runs yet')}</p>}
          {runs?.[0]?.runSessionId && (
            <LatestRunReply
              key={runs[0].runSessionId}
              projectId={projectId}
              scheduleId={task.id}
              run={runs[0]}
            />
          )}
          <ul className="divide-y divide-border">
            {runs?.map((run) => (
              <li key={run.scheduledAt} className="flex flex-wrap items-center gap-3 py-2">
                <time>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: task.draft.rule.timeZone
                  }).format(run.scheduledAt)}
                </time>
                <ScheduleRunStatus projectId={projectId} scheduleId={task.id} run={run} />
                {run.runSessionId && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => select(task, undefined, run.scheduledAt, run.runSessionId!)}
                  >
                    {t('Open session')}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                )}
                {run.reason &&
                  run.reason.trim().toLowerCase() !== run.status &&
                  ['failed', 'skipped', 'interrupted'].includes(run.status) && (
                    <p className="w-full break-words text-muted-foreground">
                      {scheduleReasonText(run.reason, t)}
                    </p>
                  )}
              </li>
            ))}
          </ul>
          {Boolean(runs?.length) && (
            <p className="text-xs text-muted-foreground">
              {t('Up to 30 settled run records are kept. Conversations and files are retained.')}
            </p>
          )}
        </div>
        {editing && (
          <ScheduleDialog
            task={task}
            projectId={projectId}
            onSaved={() => setEditing(false)}
            onClose={() => setEditing(false)}
          />
        )}
      </section>
    </ResizablePanel>
  )
}
