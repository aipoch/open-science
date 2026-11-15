import type { TFunction } from 'i18next'
import type {
  ScheduleEditRequest,
  ScheduleSummary,
  ScheduleView
} from '../../../../../shared/session-schedules'

export type ScheduleStateChange = Exclude<ScheduleEditRequest['change'], { kind: 'edit' }>

export function scheduleToggle(
  task: ScheduleSummary,
  t: TFunction
): { label: string; change: ScheduleStateChange } {
  if (task.pausedAt === null) return { label: t('Pause'), change: { kind: 'pause' } }
  const rule = task.draft.rule
  if (rule.kind === 'once' && rule.at <= Date.now())
    return { label: t('Run now'), change: { kind: 'resume', runOnceNow: true } }
  return { label: t('Resume'), change: { kind: 'resume' } }
}

export function changeScheduleState(
  task: ScheduleSummary,
  change: ScheduleStateChange
): Promise<ScheduleView> {
  return window.api.schedules.edit({
    projectId: task.target.projectId,
    sessionId: task.target.sessionId,
    scheduleId: task.id,
    expectedRevision: task.revision,
    change
  })
}
