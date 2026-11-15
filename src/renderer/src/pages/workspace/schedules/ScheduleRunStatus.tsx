import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleStop,
  CircleX,
  Clock3,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '@/stores/session-store'
import { useScheduleRunSession } from './use-schedules'
import type { ScheduleRun, ScheduleSummary } from '../../../../../shared/session-schedules'

const statusStyles = {
  pending: 'text-status-warning-foreground dark:text-status-warning-dark-foreground',
  running: 'text-status-info-foreground dark:text-status-info-dark-foreground',
  success: 'text-status-success-foreground dark:text-status-success-dark-foreground',
  failure: 'text-status-failure-foreground dark:text-status-failure-dark-foreground',
  paused: 'text-status-warning-foreground dark:text-status-warning-dark-foreground',
  closed: 'text-muted-foreground',
  active: 'text-muted-foreground'
}
const statusIcons = {
  pending: CircleDashed,
  running: LoaderCircle,
  success: CircleCheck,
  failure: CircleX,
  paused: CirclePause,
  closed: CircleStop,
  active: Clock3
}
type StatusTone = keyof typeof statusStyles

function StatusIcon({
  tone,
  className
}: {
  tone: StatusTone
  className: string
}): React.JSX.Element {
  const Icon = statusIcons[tone]
  return (
    <Icon
      aria-hidden="true"
      className={`${className} shrink-0 ${statusStyles[tone]} ${tone === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`}
    />
  )
}

export function ScheduleTaskIcon({ task }: { task?: ScheduleSummary }): React.JSX.Element {
  const tone: StatusTone = task?.finishedAt
    ? task.finishReason === 'completed'
      ? 'success'
      : 'closed'
    : task?.pausedAt
      ? task.latestProblem?.status === 'failed' || task.latestProblem?.status === 'interrupted'
        ? 'failure'
        : 'paused'
      : task?.currentRun?.status === 'admitted'
        ? 'running'
        : task?.currentRun
          ? 'pending'
          : 'active'
  return <StatusIcon tone={tone} className="size-4" />
}

export function ScheduleStatus({
  tone,
  children,
  showIcon = true
}: {
  tone: StatusTone
  children: React.ReactNode
  showIcon?: boolean
}): React.JSX.Element {
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1 text-xs leading-4 ${statusStyles[tone]}`}
    >
      {showIcon && <StatusIcon tone={tone} className="size-3" />}
      <span>{children}</span>
    </span>
  )
}

/** A wait belongs to this occurrence only while its attributed prompt owns the active turn. */
export function ScheduleRunStatus({
  projectId,
  scheduleId,
  run,
  showIcon = true
}: {
  projectId: string
  scheduleId: string
  run: ScheduleRun
  showIcon?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const live = useSessionStore((state) =>
    state.sessions.find(
      (session) => session.projectId === projectId && session.id === run.runSessionId
    )
  )
  const session = useScheduleRunSession(projectId, run.status === 'admitted' ? run : undefined)
  const prompt = session?.conversationGraph?.messages.find(
    (message) =>
      message.id === session.activeRun?.promptMessageId &&
      message.attribution?.feature === 'schedule' &&
      message.attribution.scheduleId === scheduleId &&
      message.attribution.scheduledAt === run.scheduledAt
  )
  const status =
    run.status === 'admitted' &&
    prompt &&
    (!live?.activeRun || live.activeRun.promptMessageId === prompt.id)
      ? live?.activeRun?.promptMessageId === prompt.id
        ? live.status
        : session?.status
      : undefined
  const wait =
    status === 'waiting-permission'
      ? t('Waiting for permission')
      : status === 'waiting-plan-approval'
        ? t('Waiting for plan approval')
        : status === 'waiting-for-user'
          ? t('Waiting for your response')
          : undefined
  const labels: Record<ScheduleRun['status'], string> = {
    dispatching: t('Pending'),
    admitted: t('Running'),
    succeeded: t('Run completed'),
    failed: t('Failed'),
    skipped: t('Skipped'),
    interrupted: t('Interrupted')
  }
  return (
    <ScheduleStatus
      showIcon={showIcon}
      tone={
        wait
          ? 'paused'
          : run.status === 'admitted'
            ? 'running'
            : run.status === 'succeeded'
              ? 'success'
              : run.status === 'failed'
                ? 'failure'
                : 'pending'
      }
    >
      {wait ?? labels[run.status]}
    </ScheduleStatus>
  )
}
