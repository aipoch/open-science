import { scheduleErrorText } from './schedule-reason'
import { ScheduleRunProblem } from './ScheduleRunProblem'
import { useSchedules, useScheduleDetail } from './use-schedules'
import { useEffect, useRef, useState } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ChevronRight, Clock3, Search, MoreHorizontal, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ScheduleSummary } from '../../../../../shared/session-schedules'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ScheduleRunStatus, ScheduleStatus } from './ScheduleRunStatus'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import { scheduleMenuCatalog, scheduleMenuRecipe } from './schedule-menu'
import { cn } from '@/lib/utils'
import { useScheduleSelection } from './use-schedule-selection'
import { ScheduleListHeader } from './ScheduleListHeader'
import { ScheduleDialog } from './ScheduleDialog'
import { changeScheduleState, type ScheduleStateChange } from './schedule-task-actions'

const scheduleGroups = ['active', 'paused', 'closed'] as const
type ScheduleGroup = (typeof scheduleGroups)[number]

export function SchedulePage({
  projectId,
  sessionId,
  onBack,
  headerActions,
  scheduleDetailId,
  onScheduleDetail,
  onNavigate
}: {
  projectId: string
  sessionId?: string
  onBack?: () => void
  scheduleDetailId?: string
  onScheduleDetail?: (task?: ScheduleSummary) => void
  headerActions?: React.ReactNode
  onNavigate?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { tasks, error, refresh, isEmpty } = useSchedules(projectId, sessionId)
  const [query, setQuery] = useState<string | null>(null)
  const [selectedGroups, setSelectedGroups] = useState<readonly ScheduleGroup[]>(scheduleGroups)
  const scope = useNavigationStore((state) => state.scheduleScope)
  const [focusedTaskId, setFocusedTaskId] = useState(
    scope?.projectId === projectId ? scope.taskId : undefined
  )
  const listRef = useRef<HTMLElement>(null)
  const revealedRevision = useRef<number | undefined>(undefined)
  const [focusIntent, setFocusIntent] = useState(scope)
  if (scope !== focusIntent) {
    setFocusIntent(scope)
    if (scope?.projectId === projectId && scope.taskId) {
      setFocusedTaskId(scope.taskId)
      setQuery(null)
      setSelectedGroups(scheduleGroups)
    }
  }
  useEffect(() => {
    if (!focusedTaskId || !scope || revealedRevision.current === scope.revision) return
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-schedule-id="${CSS.escape(focusedTaskId)}"]`
    )
    if (!row) return
    const group = row.closest('details')
    if (group) group.open = true
    row.scrollIntoView?.({ block: 'nearest' })
    revealedRevision.current = scope.revision
  }, [focusedTaskId, scope, tasks])
  const labels = { active: t('Active'), paused: t('Paused'), closed: t('Closed') }
  const search = query?.trim().toLocaleLowerCase() ?? ''
  const filtered = Boolean(search) || selectedGroups.length !== scheduleGroups.length
  const groups: Record<ScheduleGroup, ScheduleSummary[]> = { active: [], paused: [], closed: [] }
  for (const task of tasks) {
    const group = task.finishedAt !== null ? 'closed' : task.pausedAt !== null ? 'paused' : 'active'
    if (selectedGroups.includes(group) && task.draft.name.toLocaleLowerCase().includes(search))
      groups[group].push(task)
  }
  const [editing, setEditing] = useState<ScheduleSummary | null | undefined>()
  const [copySource, setCopySource] = useState<ScheduleSummary | null>(null)
  const { detail: copyDetail, error: copyError, refresh: retryCopy } = useScheduleDetail(copySource)
  const [mutationError, setMutationError] = useState<unknown>('')
  const [closing, setClosing] = useState<ScheduleSummary>()
  const [deleting, setDeleting] = useState(false)
  const [closePending, setClosePending] = useState(false)
  const closeTrigger = useRef<HTMLButtonElement | null>(null)
  const closingInFlight = useRef(false)
  async function confirmClose(): Promise<void> {
    if (!closing || closingInFlight.current) return
    closingInFlight.current = true
    setClosePending(true)
    setMutationError('')
    try {
      if (deleting) {
        await window.api.schedules.delete({
          projectId: closing.target.projectId,
          sessionId: closing.target.sessionId,
          scheduleId: closing.id,
          expectedRevision: closing.revision
        })
        setFocusedTaskId(undefined)
        if (scheduleDetailId === closing.id) {
          onScheduleDetail?.()
          useNavigationStore.getState().openSchedule(projectId)
        }
      } else await changeScheduleState(closing, { kind: 'close' })
      setClosing(undefined)
      refresh()
    } catch (error) {
      setMutationError(error)
    } finally {
      closingInFlight.current = false
      setClosePending(false)
    }
  }
  const { selection, select, error: selectionError } = useScheduleSelection(onNavigate)
  const selectedId = useSessionStore((state) => {
    if (!selection || state.selectedSessionId !== selection.target.sessionId) return undefined
    if (selection.draft.action.kind === 'run_script') return selection.id
    const graph = state.sessions.find(
      (s) => s.id === selection.target.sessionId && s.projectId === projectId
    )?.conversationGraph
    return graph?.activeFrameId === selection.target.agentFrameId &&
      graph.frames.find((f) => f.id === graph.activeFrameId)?.activeBranchId ===
        selection.target.messageBranchId
      ? selection.id
      : undefined
  })
  function choose(task: ScheduleSummary): void {
    setFocusedTaskId(undefined)
    if (!onBack) return setEditing(task)
    if (task.target.sessionId === null) {
      onScheduleDetail?.(task)
      onNavigate?.()
    } else {
      onScheduleDetail?.()
      select(task)
    }
  }
  async function changeState(task: ScheduleSummary, change: ScheduleStateChange): Promise<void> {
    setMutationError('')
    try {
      await changeScheduleState(task, change)
      refresh()
    } catch (e) {
      setMutationError(e)
    }
  }
  return (
    <ActionMenuProvider onActionError={setMutationError}>
      <section
        ref={listRef}
        aria-label={t('Schedule')}
        className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-auto', onBack ? 'p-2' : 'p-5')}
      >
        {onBack ? (
          <ScheduleListHeader
            onBack={onBack}
            onCreate={() => setEditing(null)}
            actions={headerActions}
            query={query}
            onQuery={setQuery}
            filters={scheduleGroups.map((group) => ({
              label: labels[group],
              checked: selectedGroups.includes(group),
              toggle: () =>
                setSelectedGroups((current) =>
                  current.includes(group)
                    ? current.filter((item) => item !== group)
                    : [...current, group]
                )
            }))}
          />
        ) : (
          <header className="mb-2 flex shrink-0 items-center gap-1">
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t('Schedule')}</h1>
            {headerActions}
          </header>
        )}
        {sessionId && onBack && (
          <div className="mb-2 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
            <span className="truncate">{t('This conversation')}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Clear filters')}
              title={t('Clear filters')}
              onClick={() => useNavigationStore.getState().openSchedule(projectId)}
            >
              <X />
            </Button>
          </div>
        )}
        {!onBack && (
          <Button variant="ghost" className="mb-3 justify-start" onClick={() => setEditing(null)}>
            <Plus />
            {t('New task')}
          </Button>
        )}
        {Boolean(error || mutationError || selectionError) && (
          <ErrorNotice
            inline
            title={t('Schedule')}
            description={scheduleErrorText(error || mutationError || selectionError, t)}
          />
        )}
        {isEmpty && !filtered && !error && (
          <div className="mx-1 my-4 flex flex-col items-center gap-2 px-3 py-5 text-center text-xs text-muted-foreground">
            <Clock3 className="size-5 opacity-60" aria-hidden="true" />
            <p>{t('No scheduled tasks yet')}</p>
          </div>
        )}
        {filtered && !error && !scheduleGroups.some((group) => groups[group].length) && (
          <div className="mx-1 my-4 flex flex-col items-center gap-2 rounded-lg bg-muted/40 px-3 py-5 text-center text-xs text-muted-foreground">
            <Search className="mb-1 size-5 opacity-60" aria-hidden="true" />
            <p role="status">{t('No results found')}</p>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => {
                setQuery(query === null ? null : '')
                setSelectedGroups(scheduleGroups)
              }}
            >
              {t('Clear filters')}
            </Button>
          </div>
        )}
        {scheduleGroups.map((state) => {
          const group = groups[state]
          if (!group.length && (onBack || state !== 'active')) return null
          return (
            <details className="group/section mb-2" key={state} open>
              <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3 group-open/section:rotate-90" />
                {labels[state]}
              </summary>
              {group.map((task) => (
                <ActionMenuTarget
                  key={task.id}
                  asChild
                  targetId={'schedule-' + task.id}
                  identityKey={JSON.stringify([projectId, task.id])}
                  invocation={task}
                  catalog={scheduleMenuCatalog}
                  recipe={scheduleMenuRecipe}
                  bindings={{
                    pause: { execute: (task) => changeState(task, { kind: 'pause' }) },
                    resume: { execute: (task) => changeState(task, { kind: 'resume' }) },
                    runNow: {
                      execute: (task) => changeState(task, { kind: 'resume', runOnceNow: true })
                    },
                    edit: { execute: setEditing },
                    view: { execute: setEditing },
                    copy: { execute: setCopySource },
                    close: {
                      execute: (task) => {
                        setDeleting(false)
                        setMutationError('')
                        setClosing(task)
                      }
                    },
                    delete: {
                      disabled: task.currentRun?.status === 'admitted',
                      disabledDescription: t(
                        'This task is running. Wait for it to finish or stop the current run before deleting it.'
                      ),
                      execute: (task) => {
                        setDeleting(true)
                        setMutationError('')
                        setClosing(task)
                      }
                    }
                  }}
                  onContextMenu={(event) => {
                    closeTrigger.current = event.currentTarget.querySelector('button')
                  }}
                  onRestoreFocus={() => closeTrigger.current?.focus()}
                >
                  <div
                    data-schedule-id={task.id}
                    className={cn(
                      'rounded-lg',
                      (focusedTaskId ?? scheduleDetailId ?? selectedId) === task.id && 'bg-bg-300'
                    )}
                  >
                    <div
                      className={cn(
                        'group/row flex items-center rounded-lg hover:bg-bg-300 focus-within:bg-bg-300',
                        (focusedTaskId ?? scheduleDetailId ?? selectedId) === task.id && 'bg-bg-300'
                      )}
                    >
                      <Button
                        variant="ghost"
                        aria-current={
                          (focusedTaskId ?? scheduleDetailId ?? selectedId) === task.id
                            ? 'true'
                            : undefined
                        }
                        className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left font-normal hover:bg-transparent"
                        onClick={() => choose(task)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate" title={task.draft.name}>
                            {task.draft.name}
                          </span>
                          <ScheduleTiming task={task} compact />
                          {task.latestProblem && (
                            <ScheduleRunProblem
                              {...task.latestProblem}
                              reason={onBack ? null : task.latestProblem.reason}
                            />
                          )}
                        </span>
                      </Button>
                      <ScheduleMenuButton
                        taskId={task.id}
                        onOpen={(trigger) => {
                          closeTrigger.current = trigger
                        }}
                      />
                    </div>
                  </div>
                </ActionMenuTarget>
              ))}
            </details>
          )
        })}
        <ConfirmActionDialog
          open={Boolean(closing)}
          title={deleting ? t('Delete this task?') : t('Close this task?')}
          description={
            deleting
              ? t(
                  'Future runs will stop. The task and its run records will be deleted. Conversations and files will be kept.'
                )
              : t(
                  'Future runs will stop and this task cannot be reopened. Existing results will be kept.'
                )
          }
          destructive={deleting}
          cancelLabel={t('Cancel')}
          confirmLabel={deleting ? t('Delete task') : t('Close task')}
          loading={closePending}
          onCancel={() => setClosing(undefined)}
          onConfirm={() => void confirmClose()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (closeTrigger.current?.isConnected) closeTrigger.current.focus()
            else listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
          }}
        >
          {Boolean(mutationError) && (
            <ErrorNotice
              inline
              title={t('Schedule')}
              description={scheduleErrorText(mutationError, t)}
            />
          )}
        </ConfirmActionDialog>
        {copySource && !copyDetail && (
          <ErrorNotice
            inline
            level={copyError ? 'error' : 'info'}
            description={copyError ? scheduleErrorText(copyError, t) : t('Loading…')}
            primaryButton={copyError ? { label: t('Retry'), onClick: retryCopy } : undefined}
            secondaryButton={{ label: t('Cancel'), onClick: () => setCopySource(null) }}
          />
        )}
        {copySource && copyDetail && (
          <ScheduleDialog
            initialSessionId={copyDetail.target.sessionId ?? undefined}
            initialDraft={copyDetail.draft}
            projectId={projectId}
            task={null}
            onClose={() => setCopySource(null)}
            onSaved={(saved) => {
              setCopySource(null)
              refresh()
              if (onBack) choose(saved)
            }}
          />
        )}
        {editing !== undefined && (
          <ScheduleDialog
            initialSessionId={sessionId}
            projectId={projectId}
            task={editing ? (tasks.find((task) => task.id === editing.id) ?? editing) : null}
            onClose={() => setEditing(undefined)}
            onSaved={(saved) => {
              setEditing(undefined)
              refresh()
              if (editing === null && onBack) choose(saved)
            }}
          />
        )}
      </section>
    </ActionMenuProvider>
  )
}

function ScheduleMenuButton({
  taskId,
  onOpen
}: {
  taskId: string
  onOpen: (trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={t('More actions')}
      aria-haspopup="menu"
      className="mr-1 shrink-0 opacity-60 group-hover/row:opacity-100 focus-visible:opacity-100"
      onClick={(event) => {
        const trigger = event.currentTarget
        const bounds = trigger.getBoundingClientRect()
        onOpen(trigger)
        openMenu({
          targetId: 'schedule-' + taskId,
          pointer: { x: bounds.right, y: bounds.bottom },
          align: 'end',
          focusTarget: trigger
        })
      }}
    >
      <MoreHorizontal />
    </Button>
  )
}

export function ScheduleTiming({
  task,
  compact = false,
  labelNextRun = false,
  showStatusIcon = true
}: {
  task: ScheduleSummary
  compact?: boolean
  labelNextRun?: boolean
  showStatusIcon?: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const rule = task.draft.rule
  const repeat =
    rule.kind === 'once'
      ? t('Once')
      : rule.kind === 'daily'
        ? t('Daily')
        : rule.kind === 'weekly'
          ? t('Weekly')
          : new Intl.NumberFormat(i18n.language, {
              style: 'unit',
              unit: 'minute',
              unitDisplay: 'long'
            }).format(rule.minutes)
  const state = task.finishedAt
    ? task.finishReason === 'completed'
      ? t('Completed')
      : task.finishReason === 'cancelled'
        ? t('Cancelled')
        : t('Closed')
    : task.pausedAt
      ? t('Paused')
      : null
  const next =
    task.nextDueAt === null
      ? null
      : new Intl.DateTimeFormat(i18n.language, {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
          timeZone: rule.timeZone
        }).format(task.nextDueAt)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4 text-muted-foreground whitespace-normal">
      {!compact && <span>{repeat}</span>}
      {task.currentRun && (
        <ScheduleRunStatus
          projectId={task.target.projectId}
          scheduleId={task.id}
          run={task.currentRun}
          showIcon={showStatusIcon}
        />
      )}
      {state ? (
        <ScheduleStatus
          tone={
            task.finishedAt ? (task.finishReason === 'completed' ? 'success' : 'closed') : 'paused'
          }
          showIcon={showStatusIcon}
        >
          {state}
        </ScheduleStatus>
      ) : next ? (
        <span>
          {(labelNextRun || task.currentRun) && <>{t('Next run')} </>}
          {next}
        </span>
      ) : !task.currentRun ? (
        <ScheduleStatus tone="pending" showIcon={showStatusIcon}>
          {t('Pending')}
        </ScheduleStatus>
      ) : null}
    </span>
  )
}
