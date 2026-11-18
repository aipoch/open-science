import { scheduleErrorText } from './schedule-reason'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  scheduleViewSchema,
  type ScheduleSummary,
  type ScheduleView
} from '../../../../../shared/session-schedules'
import type { PersistedToolActivity } from '../../../../../shared/session-message-contract'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { ChatMessage } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSchedules } from './use-schedules'
import { ScheduleRunProblem } from './ScheduleRunProblem'
import { ScheduleTiming } from './SchedulePage'
import { ScheduleTaskIcon } from './ScheduleRunStatus'
import { useScheduleSelection } from './use-schedule-selection'
import { ErrorNotice } from '@/components/error-notice'
import { ScheduleRunResultDialog } from './ScheduleRunResultDialog'
import { ScheduleDialog } from './ScheduleDialog'

type DeletedTask = { id: string; name?: string; promptId: string }
const Tasks = createContext<{
  tasks: ScheduleSummary[]
  anchors: Map<string, string>
  deleted: DeletedTask[]
}>({ tasks: [], anchors: new Map(), deleted: [] })

// Read only validated successful creation receipts, never attempted tool inputs.
function createdTask(value: unknown, depth = 0): ScheduleView | undefined {
  if (depth > 6) return undefined
  const parsed = scheduleViewSchema.safeParse(value)
  if (parsed.success) return parsed.data
  if (typeof value === 'string') {
    try {
      return createdTask(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const block of value.slice(0, 16)) {
      const task = createdTask(block, depth + 1)
      if (task) return task
    }
  } else if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    if (item.isError === true) return undefined
    for (const key of ['structuredContent', 'result', 'content', 'text']) {
      if (item[key] === undefined) continue
      const task = createdTask(item[key], depth + 1)
      if (task) return task
    }
  }
  return undefined
}

export function ScheduleCardsProvider({
  projectId,
  sessionId,
  messages,
  activities,
  children
}: {
  projectId?: string
  sessionId?: string
  messages?: readonly ChatMessage[]
  activities?: readonly PersistedToolActivity[]
  children: ReactNode
}): React.JSX.Element {
  const { tasks: projectTasks, loaded, refresh } = useSchedules(sessionId ? projectId : undefined)
  const tasks = useMemo(
    () => projectTasks.filter((task) => task.target.sessionId === sessionId),
    [projectTasks, sessionId]
  )
  const historical = useMemo(() => {
    const records = new Map<string, DeletedTask>()
    for (const activity of activities ?? []) {
      if (
        activity.status !== 'completed' ||
        !/^(?:mcp__|mcp\.)?open[-_]science[-_]schedule(?:__|\/|\.|_)create_schedule$/i.test(
          activity.providerToolName ?? ''
        )
      )
        continue
      const task = createdTask(activity.rawOutput) ?? createdTask(activity.toolContent)
      const promptId = task?.originPromptId ?? activity.promptMessageId
      if (
        task &&
        promptId &&
        task.target.projectId === projectId &&
        task.target.sessionId === sessionId
      )
        records.set(task.id, { id: task.id, name: task.draft.name, promptId })
    }
    // Attribution survives task deletion and keeps the card on its last scheduled message.
    for (const message of messages ?? []) {
      if (message.role === 'user' && message.attribution?.feature === 'schedule') {
        const id = message.attribution.scheduleId
        records.set(id, { ...records.get(id), id, promptId: message.id })
      }
    }
    return [...records.values()]
  }, [activities, messages, projectId, sessionId])
  const scope = JSON.stringify([projectId, sessionId])
  const [confirmed, setConfirmed] = useState<{ scope: string; ids: Set<string> }>()
  const existing = useMemo(() => new Set(projectTasks.map((task) => task.id)), [projectTasks])
  const pendingIds = JSON.stringify(
    historical
      .filter(
        (task) =>
          !existing.has(task.id) && !(confirmed?.scope === scope && confirmed.ids.has(task.id))
      )
      .map((task) => task.id)
  )
  useEffect(() => {
    if (!loaded || pendingIds === '[]') return
    let active = true
    // A cached directory may predate a new creation receipt. Confirm absence with a later read.
    void refresh().then((success) => {
      if (!active || !success) return
      setConfirmed((previous) => ({
        scope,
        ids: new Set([
          ...(previous?.scope === scope ? previous.ids : []),
          ...(JSON.parse(pendingIds) as string[])
        ])
      }))
    })
    return () => {
      active = false
    }
  }, [scope, pendingIds, loaded, refresh])
  const value = useMemo(() => {
    const anchors = new Map<string, string>()
    for (const task of tasks) if (task.originPromptId) anchors.set(task.id, task.originPromptId)
    for (const message of messages ?? []) {
      if (message.role === 'user' && message.attribution?.feature === 'schedule')
        anchors.set(message.attribution.scheduleId, message.id)
    }
    return {
      tasks,
      anchors,
      deleted: historical.filter(
        (task) => confirmed?.scope === scope && confirmed.ids.has(task.id) && !existing.has(task.id)
      )
    }
  }, [tasks, messages, historical, existing, confirmed, scope])
  return <Tasks.Provider value={value}>{children}</Tasks.Provider>
}

function DeletedScheduleCard({ task }: { task: DeletedTask }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className="flex-row items-center gap-3 p-3 text-muted-foreground">
      <Trash2 className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs">
        {task.name && <span className="block truncate font-medium">{task.name}</span>}
        <span>{t('Task deleted')}</span>
      </div>
    </Card>
  )
}

export function ScheduleMessageCards({ promptId }: { promptId: string }): React.JSX.Element | null {
  const { tasks, deleted } = useContext(Tasks)
  const { t } = useTranslation()
  const [edit, setEdit] = useState<ScheduleSummary>()
  const [failed, setFailed] = useState<{ task: ScheduleSummary; trigger?: HTMLElement }>()
  const { select, error } = useScheduleSelection()
  const cards = tasks.filter((item) => item.originPromptId === promptId)
  const removed = deleted.filter((task) => task.promptId === promptId)
  if (!cards.length && !removed.length) return null
  return (
    <div className="space-y-2">
      {removed.map((task) => (
        <DeletedScheduleCard key={task.id} task={task} />
      ))}
      {cards.map((task) => (
        <Card key={task.id} className="flex-row items-center gap-3 p-3">
          <ScheduleTaskIcon task={task} />
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-sm">{task.draft.name}</strong>
            <ScheduleTiming task={task} showStatusIcon={false} />
            {task.latestProblem && (
              <ScheduleRunProblem
                {...task.latestProblem}
                onOpenRun={(runId, trigger) =>
                  runId ? select(task, runId) : setFailed({ task, trigger })
                }
              />
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEdit(task)}>
            {t('Open')}
          </Button>
        </Card>
      ))}
      {error && (
        <ErrorNotice inline title={t('Results')} description={scheduleErrorText(error, t)} />
      )}
      {failed && (
        <ScheduleRunResultDialog
          task={failed.task}
          returnFocus={failed.trigger}
          onClose={() => setFailed(undefined)}
        />
      )}
      {edit && (
        <ScheduleDialog
          projectId={edit.target.projectId}
          task={tasks.find((task) => task.id === edit.id) ?? edit}
          onSaved={() => setEdit(undefined)}
          onClose={() => setEdit(undefined)}
        />
      )}
    </div>
  )
}
export function SessionScheduleBanner({
  promptId,
  latest = true
}: {
  promptId?: string
  latest?: boolean
}): React.JSX.Element | null {
  const context = useContext(Tasks)
  const tasks = context.tasks.filter((task) => {
    if (promptId && task.originPromptId === promptId) return false
    return task.finishedAt || task.pausedAt ? context.anchors.get(task.id) === promptId : latest
  })
  const { t } = useTranslation()
  if (!tasks.length) return null
  const visible = tasks
  const first = visible[0]
  return (
    <div className="mt-3 mb-2" data-testid="session-schedule-banner">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-bg-100 px-3 py-2 text-left hover:bg-bg-200"
        onClick={() =>
          useNavigationStore
            .getState()
            .openSchedule(
              first.target.projectId,
              first.target.sessionId ?? undefined,
              visible.length === 1 ? first.id : undefined
            )
        }
      >
        <ScheduleTaskIcon
          task={
            visible.length === 1
              ? first
              : visible.every((task) => task.finishedAt)
                ? {
                    ...first,
                    finishReason: visible.every((task) => task.finishReason === 'completed')
                      ? 'completed'
                      : null
                  }
                : undefined
          }
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {visible.length === 1
              ? first.draft.name
              : t('{{count}} scheduled tasks', {
                  count: visible.length,
                  defaultValue_one: '{{count}} scheduled task'
                })}
          </div>
          {visible.length === 1 && <ScheduleTiming task={first} showStatusIcon={false} />}
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  )
}
