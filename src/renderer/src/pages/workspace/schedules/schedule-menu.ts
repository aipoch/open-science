import { CircleStop, CopyPlus, Pause, Pencil, Play, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { ActionMenuRecipeEntry } from '@/components/action-menu'
import type { ScheduleSummary } from '../../../../../shared/session-schedules'

export const scheduleMenuCatalog = {
  pause: { labelKey: 'Pause', icon: Pause },
  resume: { labelKey: 'Resume', icon: Play },
  runNow: { labelKey: 'Run now', icon: Play },
  edit: { labelKey: 'Edit task', icon: Pencil },
  view: { labelKey: 'View task', icon: SlidersHorizontal },
  copy: { labelKey: 'Create similar task', icon: CopyPlus },
  close: { labelKey: 'Close task', icon: CircleStop },
  delete: { labelKey: 'Delete task', icon: Trash2, danger: true }
}

export function scheduleMenuRecipe(
  task: ScheduleSummary
): readonly ActionMenuRecipeEntry<keyof typeof scheduleMenuCatalog>[] {
  if (task.finishedAt !== null)
    return [
      { kind: 'action', action: 'view' },
      { kind: 'action', action: 'copy' },
      { kind: 'separator' },
      { kind: 'action', action: 'delete' }
    ]
  const toggle =
    task.pausedAt === null
      ? 'pause'
      : task.draft.rule.kind === 'once' && task.draft.rule.at <= Date.now()
        ? 'runNow'
        : 'resume'
  return [
    { kind: 'action', action: toggle },
    { kind: 'action', action: 'edit' },
    { kind: 'action', action: 'copy' },
    { kind: 'action', action: 'close' },
    { kind: 'separator' },
    { kind: 'action', action: 'delete' }
  ]
}
