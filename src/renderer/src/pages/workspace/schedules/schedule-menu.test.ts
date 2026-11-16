import { expect, it, vi } from 'vitest'
import { resolveActionMenuEntries } from '@/components/action-menu'
import type { ScheduleSummary } from '../../../../../shared/session-schedules'
import { scheduleMenuCatalog, scheduleMenuRecipe } from './schedule-menu'

it('resolves the same available actions for active, paused, overdue and finished tasks', () => {
  const task: ScheduleSummary = {
    id: 'task',
    revision: 1,
    originPromptId: null,
    target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
    pausedAt: null,
    finishedAt: null,
    pauseReason: null,
    nextDueAt: Date.now() + 60000,
    draft: {
      name: 'Review',
      action: { kind: 'send_session_message' },
      rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' }
    }
  }
  const execute = vi.fn()
  const spec = {
    identityKey: task.id,
    catalog: scheduleMenuCatalog,
    recipe: scheduleMenuRecipe,
    bindings: Object.fromEntries(Object.keys(scheduleMenuCatalog).map((key) => [key, { execute }]))
  }
  const labels = (value: ScheduleSummary): string[] =>
    resolveActionMenuEntries(spec, value).flatMap((entry) =>
      entry.kind === 'action' ? entry.labelKey : []
    )
  expect(labels(task)).toEqual([
    'Pause',
    'Edit task',
    'Create similar task',
    'Close task',
    'Delete task'
  ])
  expect(labels({ ...task, pausedAt: 1 })).toEqual([
    'Resume',
    'Edit task',
    'Create similar task',
    'Close task',
    'Delete task'
  ])
  expect(
    labels({
      ...task,
      pausedAt: 1,
      draft: { ...task.draft, rule: { kind: 'once', at: 1, timeZone: 'UTC' } }
    })
  ).toEqual(['Run now', 'Edit task', 'Create similar task', 'Close task', 'Delete task'])
  expect(labels({ ...task, finishedAt: 1 })).toEqual([
    'View task',
    'Create similar task',
    'Delete task'
  ])
  expect(execute).not.toHaveBeenCalled()
})
