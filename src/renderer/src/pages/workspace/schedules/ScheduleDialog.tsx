import { parseApplicationCommandError } from '../../../../../shared/application-command-contract'
import { scheduleErrorText, scheduleReasonText } from './schedule-reason'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup } from 'radix-ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ChevronDown, Clock3, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogFooterClassName,
  dialogHeaderClassName
} from '@/components/ui/dialog-chrome'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionStore } from '@/stores/session-store'
import {
  nextScheduleTime,
  scheduleEndExtended,
  formatScheduleLocalDateTime,
  scheduleLocalInstants
} from '../../../../../shared/schedule-time'
import {
  scheduleDraftSchema,
  scheduleRuleSchema,
  type ScheduleAction,
  type ScheduleDraft,
  type ScheduleRule,
  type ScheduleView,
  type ScheduleSummary,
  type ScheduleTarget
} from '../../../../../shared/session-schedules'

import type { PermissionProfileId } from '../../../../../shared/permission-profiles'
import { useScheduleDetail } from './use-schedules'
import { ScheduleExamples } from './ScheduleExamples'
import { ConversationPicker } from '../ConversationPicker'
import { changeScheduleState, scheduleToggle } from './schedule-task-actions'

type Props = {
  initialDraft?: ScheduleDraft
  initialSessionId?: string
  projectId: string
  task: ScheduleView | null
  onClose: () => void
  onSaved: (saved: ScheduleView) => void
}
function DisabledHint({
  reason,
  className = '',
  children
}: {
  reason?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!reason) return <>{children}</>
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={reason}
            className={`inline-flex min-w-0 cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ScheduleSelect({
  label,
  value,
  onValueChange,
  disabled,
  disabledReason,
  describedBy,
  placeholder,
  compact,
  children
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  disabledReason?: string
  describedBy?: string
  placeholder?: string
  compact?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <DisabledHint reason={disabled ? disabledReason : undefined}>
        <SelectTrigger
          aria-label={label}
          aria-describedby={describedBy}
          className={compact ? 'w-auto max-w-full' : 'min-w-0 max-w-full'}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </DisabledHint>
      <SelectContent>{children}</SelectContent>
    </Select>
  )
}

function ScheduleTimeInput({
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [hour = '00', minute = '00'] = value.split(':')
  return (
    <div className="flex items-center rounded-lg border border-border bg-card focus-within:border-ring">
      <Input
        {...props}
        type="time"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="w-20 border-0 bg-transparent pr-0 tabular-nums shadow-none focus-visible:ring-0 [&::-webkit-calendar-picker-indicator]:hidden"
      />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="mr-1"
            aria-label={t('Choose time')}
          >
            <Clock3 className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40 rounded-xl p-2" aria-label={t('Choose time')}>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: t('Hours'), count: 24, value: hour },
              { label: t('Minutes'), count: 60, value: minute }
            ].map((column, index) => (
              <div key={column.label} className="min-w-0">
                <div className="pb-2 text-center text-xs text-muted-foreground">{column.label}</div>
                <RadioGroup.Root
                  aria-label={column.label}
                  orientation="vertical"
                  value={column.value}
                  onValueChange={(part) =>
                    onValueChange(
                      index === 0 ? `${part}:${minute || '00'}` : `${hour || '00'}:${part}`
                    )
                  }
                  className="scrollbar-auto-hide max-h-44 space-y-1 overflow-y-auto overscroll-contain"
                >
                  {Array.from({ length: column.count }, (_, number) => {
                    const part = String(number).padStart(2, '0')
                    return (
                      <RadioGroup.Item
                        key={part}
                        value={part}
                        onFocus={() =>
                          onValueChange(
                            index === 0 ? `${part}:${minute || '00'}` : `${hour || '00'}:${part}`
                          )
                        }
                        ref={(node) => {
                          if (node && part === column.value)
                            node.parentElement!.scrollTop =
                              node.offsetTop - node.parentElement!.offsetTop - 64
                        }}
                        className="relative flex h-8 w-full shrink-0 items-center justify-center rounded-md text-sm tabular-nums hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=checked]:bg-primary/10 data-[state=checked]:font-semibold data-[state=checked]:text-primary"
                      >
                        {part}
                      </RadioGroup.Item>
                    )
                  })}
                </RadioGroup.Root>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function ScheduleDialog(
  props: Omit<Props, 'task'> & { task: ScheduleSummary | ScheduleView | null }
): React.JSX.Element {
  const { t } = useTranslation()
  const { detail, error, refresh } = useScheduleDetail(props.task)
  if (props.task && !detail)
    return (
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content className={dialogPanelClassName()} aria-describedby={undefined}>
            <header className={dialogHeaderClassName}>
              <Dialog.Title>{t('Edit task')}</Dialog.Title>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={props.onClose}
                aria-label={t('Close')}
              >
                <X />
              </Button>
            </header>
            <div className="p-5">
              {error ? (
                <ErrorNotice
                  inline
                  description={scheduleErrorText(error, t)}
                  primaryButton={{ label: t('Retry'), onClick: refresh }}
                />
              ) : (
                <LoaderCircle className="size-5 animate-spin" aria-label={t('Loading…')} />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  return (
    <LoadedScheduleDialog
      {...props}
      task={
        detail
          ? {
              ...detail,
              nextDueAt: props.task?.nextDueAt ?? null,
              pausedAt: props.task?.pausedAt ?? null,
              finishedAt: props.task?.finishedAt ?? null,
              currentRun: props.task?.currentRun
            }
          : null
      }
      loadError={error}
    />
  )
}

function LoadedScheduleDialog(props: Props & { loadError?: unknown }): React.JSX.Element {
  const [review, setReview] = useState<{ task: ScheduleView; draft?: ScheduleDraft; key: number }>()
  const [pendingRejected, setPendingRejected] = useState<ScheduleView | null>()
  return (
    <ScheduleEditor
      {...props}
      key={review?.key ?? 0}
      task={review?.task ?? props.task}
      liveTask={props.task}
      pending={
        props.task?.currentRun?.status === 'dispatching' ||
        (props.task !== null && pendingRejected === props.task)
      }
      onPendingEditRejected={() => setPendingRejected(props.task)}
      initialDraft={review ? review.draft : props.initialDraft}
      onReview={(task, draft) =>
        setReview((previous) => ({ task, draft, key: (previous?.key ?? 0) + 1 }))
      }
    />
  )
}

function ScheduleEditor({
  projectId,
  task: suppliedTask,
  onClose,
  onSaved,
  initialSessionId,
  initialDraft,
  liveTask,
  loadError,
  pending,
  onPendingEditRejected,
  onReview
}: Props & {
  liveTask: ScheduleView | null
  loadError?: unknown
  pending: boolean
  onPendingEditRejected: () => void
  onReview: (task: ScheduleView, draft?: ScheduleDraft) => void
}): React.JSX.Element {
  // The CAS baseline must advance with the draft, only after explicit review or discard.
  const [task] = useState(suppliedTask)
  const { t, i18n } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const selected = useSessionStore((s) => s.selectedSessionId)
  const eligible = sessions.filter(
    (s) =>
      s.projectId === projectId && !s.packageOrigin && !s.isPending && s.archivedAt === undefined
  )
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false)
  const [sessionId, setSession] = useState<string | null>(
    task ? task.target.sessionId : (initialSessionId ?? null)
  )
  const [now, setNow] = useState(Date.now)
  const fieldId = useId()
  const [confirmClose, setConfirmClose] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (task?.finishedAt) return
    let timer: number
    const refresh = (): void => {
      const current = Date.now()
      setNow(current)
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, 60000 - (current % 60000))
    }
    timer = window.setTimeout(refresh, 60000 - (Date.now() % 60000))
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [task?.finishedAt])
  const [loadedTarget, setTarget] = useState<ScheduleTarget>()
  const target =
    task?.target ??
    (sessionId === null
      ? ({ projectId, sessionId: null, agentFrameId: null, messageBranchId: null } as const)
      : loadedTarget?.sessionId === sessionId && loadedTarget.projectId === projectId
        ? loadedTarget
        : undefined)
  const base = initialDraft ?? task?.draft
  const [permissionProfile, setPermissionProfile] = useState<PermissionProfileId>(
    base?.permissionProfile ?? 'ask'
  )
  const [zone] = useState(base?.rule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const initialAt =
    base?.rule.kind === 'once'
      ? base.rule.at
      : base?.rule.kind === 'interval'
        ? base.rule.anchor
        : undefined
  const [preferredAt, setPreferredAt] = useState(initialAt)
  const [end, setEnd] = useState(() =>
    base?.endAt === undefined ? '' : formatScheduleLocalDateTime(base.endAt, zone)
  )
  const [ending, setEnding] = useState(
    base?.endAt !== undefined ? 'date' : base?.maxRuns !== undefined ? 'count' : 'never'
  )
  const [limit, setLimit] = useState(base?.maxRuns?.toString() ?? '')
  const [timeout, setTimeoutMs] = useState(
    base?.action.kind === 'run_script' ? (base.action.timeoutMs?.toString() ?? '') : ''
  )
  const [name, setName] = useState(base?.name ?? '')
  const [action, setAction] = useState<ScheduleAction['kind']>(
    base?.action.kind ?? 'send_session_message'
  )
  const [message, setMessage] = useState(
    base?.action.kind === 'send_session_message' ? base.action.message : ''
  )
  const [code, setCode] = useState(base?.action.kind === 'run_script' ? base.action.code : '')
  const [language, setLanguage] = useState<'python' | 'r' | 'shell'>(
    base?.action.kind === 'run_script' ? base.action.language : 'python'
  )
  const [kind, setKind] = useState<ScheduleRule['kind']>(base?.rule.kind ?? 'daily')
  const [time, setTime] = useState(
    base?.rule.kind === 'daily' || base?.rule.kind === 'weekly' ? base.rule.time : '09:00'
  )
  const [start, setStart] = useState(() =>
    formatScheduleLocalDateTime(initialAt ?? Date.now() + 3600000, zone)
  )
  const [minutes, setMinutes] = useState(base?.rule.kind === 'interval' ? base.rule.minutes : 30)
  const [days, setDays] = useState<number[]>(
    base?.rule.kind === 'weekly' ? base.rule.weekdays : [new Date().getDay()]
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>('')
  const [conflict, setConflict] = useState<ScheduleView>()
  const pendingReason = pending
    ? t('This task is waiting to run. Its instructions and schedule cannot be changed yet.')
    : undefined
  const [requestId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (task) return
    let current = true
    if (sessionId)
      void window.api.sessions
        .loadOne({ projectId, sessionId })
        .then((s) => {
          const graph = s?.conversationGraph,
            frame = graph?.frames.find((f) => f.id === graph.activeFrameId)
          if (current && frame)
            setTarget({
              projectId,
              sessionId,
              agentFrameId: frame.id,
              messageBranchId: frame.activeBranchId
            })
        })
        .catch((e) => {
          if (current) setError(e)
        })
    return () => {
      current = false
    }
  }, [sessionId, projectId, task])
  const raw = JSON.stringify({
    name,
    action,
    message,
    code,
    language,
    sessionId,
    permissionProfile: sessionId === null ? permissionProfile : undefined,
    zone,
    kind,
    time,
    start,
    preferredAt,
    minutes,
    days,
    ending,
    end,
    limit,
    timeout
  })
  const [initialRaw] = useState(raw)
  const dirty =
    raw !== initialRaw ||
    Boolean(task && initialDraft && JSON.stringify(initialDraft) !== JSON.stringify(task.draft))
  function requestClose(): void {
    if (busy || confirmClose) return
    if (dirty) setConfirmClose(true)
    else onClose()
  }
  const candidates = scheduleLocalInstants(start, zone)
  const at =
    preferredAt !== undefined && candidates.includes(Math.floor(preferredAt / 60000) * 60000)
      ? preferredAt
      : candidates.length === 1
        ? candidates[0]
        : NaN
  const rule: ScheduleRule =
    kind === 'once'
      ? { kind, at, timeZone: zone }
      : kind === 'interval'
        ? { kind, anchor: at, minutes, timeZone: zone }
        : kind === 'daily'
          ? { kind, time, timeZone: zone }
          : { kind, time, timeZone: zone, weekdays: days }
  const payload: ScheduleAction =
    action === 'run_script'
      ? {
          kind: action,
          language,
          code,
          ...(timeout ? { timeoutMs: Number(timeout) } : {})
        }
      : { kind: action, message }
  const endCandidates = end ? scheduleLocalInstants(end, zone) : []
  const endAt =
    base?.endAt !== undefined && endCandidates.includes(Math.floor(base.endAt / 60000) * 60000)
      ? base.endAt
      : endCandidates.at(-1)
  const parsed = scheduleDraftSchema.safeParse({
    ...(sessionId === null ? { permissionProfile } : {}),
    ...(ending === 'date' && kind !== 'once' ? { endAt: endAt ?? NaN } : {}),
    ...(ending === 'count' && kind !== 'once' ? { maxRuns: Number(limit) } : {}),
    name:
      name.trim() ||
      (task
        ? ''
        : action === 'run_script'
          ? t('Scheduled script')
          : message.trim().split(/\r?\n/)[0].slice(0, 80)),
    rule,
    action: payload
  })
  const sameRule =
    task &&
    parsed.success &&
    JSON.stringify(parsed.data.rule) === JSON.stringify(scheduleRuleSchema.parse(task.draft.rule))
  // Claims advance the cursor without changing the editor's CAS baseline.
  const committed = liveTask?.revision === task?.revision ? liveTask : task
  function nextExecution(after: number): number | null {
    if (!parsed.success) return null
    const rearm = task && !committed?.nextDueAt && scheduleEndExtended(task.draft, parsed.data)
    return sameRule && !rearm
      ? (committed?.nextDueAt ?? null)
      : nextScheduleTime(parsed.data.rule, after)
  }
  const nextSlot = nextExecution(now)
  const next =
    nextSlot !== null &&
    parsed.success &&
    (parsed.data.endAt === undefined || nextSlot <= parsed.data.endAt)
      ? nextSlot
      : null
  const zoneLabel =
    new Intl.DateTimeFormat(i18n.language, {
      timeZone: zone,
      timeZoneName: 'shortOffset'
    })
      .formatToParts(
        (kind === 'once' || kind === 'interval') && Number.isFinite(at) ? at : (next ?? now)
      )
      .find((part) => part.type === 'timeZoneName')?.value ?? zone
  const problems: Record<string, string> = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path.at(-1) ?? '')
      if (field === 'name' && !task && !name.trim()) continue
      problems[field] =
        field === 'timeZone'
          ? t('Choose a valid time zone.')
          : field === 'weekdays'
            ? t('Select at least one weekday.')
            : field === 'message' || field === 'code'
              ? t('Enter the task content within the allowed length.')
              : field === 'name'
                ? t('Enter a name between 1 and 200 characters.')
                : field === 'minutes'
                  ? t('Enter whole minutes between 1 and 525600.')
                  : field === 'maxRuns' || field === 'timeoutMs'
                    ? t('Enter a positive whole number.')
                    : t('Choose a valid date and time.')
    }
  }
  const expired =
    kind === 'once' &&
    Number.isFinite(at) &&
    at <= now &&
    (!task || task.draft.rule.kind !== 'once' || task.draft.rule.at !== at)
  if (expired) problems.at = t('Choose a future time.')
  if (
    parsed.success &&
    ending === 'date' &&
    kind !== 'once' &&
    nextSlot !== null &&
    endAt !== undefined &&
    endAt < nextSlot
  )
    problems.endAt = t('End time must be after the next run.')
  const invalid = Object.keys(problems).length > 0
  const pendingChanges =
    pending &&
    task &&
    (!parsed.success ||
      JSON.stringify([
        parsed.data.action,
        parsed.data.rule,
        parsed.data.endAt,
        parsed.data.maxRuns,
        parsed.data.permissionProfile
      ]) !==
        JSON.stringify([
          task.draft.action,
          task.draft.rule,
          task.draft.endAt,
          task.draft.maxRuns,
          sessionId === null ? (task.draft.permissionProfile ?? 'ask') : undefined
        ]))
  function fieldError(field: string): React.JSX.Element | null {
    const visible = touched.has(field) || (field === 'at' && expired)
    return visible && problems[field] ? (
      <span
        id={fieldId + field}
        role="alert"
        className="block w-full text-xs text-status-failure-foreground"
      >
        {problems[field]}
      </span>
    ) : null
  }
  function fieldProps(field: string): {
    name: string
    'aria-invalid': boolean
    'aria-describedby': string | undefined
  } {
    const visible = touched.has(field) || (field === 'at' && expired)
    return {
      name: field,
      'aria-invalid': Boolean(problems[field] && visible),
      'aria-describedby': problems[field] && visible ? fieldId + field : undefined
    }
  }
  async function mutationFailed(error: unknown): Promise<void> {
    if (parseApplicationCommandError(error)?.code === 'schedule-pending') {
      onPendingEditRejected()
      setError('')
      return
    }
    if (task) {
      try {
        const latest = await window.api.schedules.get({ projectId, sessionId, scheduleId: task.id })
        if (latest && latest.revision !== task.revision) {
          setConflict(latest)
          setError('')
          return
        }
      } catch {
        // Keep the draft and the original error when refreshing the definition also fails.
      }
    }
    setError(error)
  }
  function reviewChanges(): void {
    if (!conflict || !task || !parsed.success) return
    const draft = parsed.data
    const previous = task.draft
    // Treat the recurrence and stopping limits as one group to preserve their invariant.
    const changedTiming =
      JSON.stringify([draft.rule, draft.endAt, draft.maxRuns]) !==
      JSON.stringify([previous.rule, previous.endAt, previous.maxRuns])
    onReview(conflict, {
      ...(sessionId === null
        ? {
            permissionProfile:
              draft.permissionProfile !== previous.permissionProfile
                ? draft.permissionProfile
                : conflict.draft.permissionProfile
          }
        : {}),
      name: draft.name !== previous.name ? draft.name : conflict.draft.name,
      action:
        JSON.stringify(draft.action) !== JSON.stringify(previous.action)
          ? draft.action
          : conflict.draft.action,
      ...(changedTiming
        ? { rule: draft.rule, endAt: draft.endAt, maxRuns: draft.maxRuns }
        : {
            rule: conflict.draft.rule,
            endAt: conflict.draft.endAt,
            maxRuns: conflict.draft.maxRuns
          })
    })
  }
  const disabled = busy || Boolean(task?.finishedAt)
  async function submit(submittedAt: number): Promise<void> {
    setNow(submittedAt)
    if (
      kind === 'once' &&
      at <= submittedAt &&
      (!task || task.draft.rule.kind !== 'once' || task.draft.rule.at !== at)
    ) {
      setTouched((fields) => new Set([...fields, 'at']))
      return
    }
    if (
      !parsed.success ||
      invalid ||
      !target ||
      disabled ||
      conflict ||
      pendingChanges ||
      (task && !dirty)
    )
      return
    const freshNext = nextExecution(submittedAt)
    if (
      (!task && freshNext === null) ||
      (freshNext !== null && parsed.data.endAt !== undefined && parsed.data.endAt < freshNext)
    ) {
      setTouched((fields) => new Set([...fields, 'endAt']))
      return
    }
    setBusy(true)
    setError('')
    try {
      const saved = task
        ? await window.api.schedules.edit({
            projectId,
            sessionId,
            scheduleId: task.id,
            expectedRevision: task.revision,
            change: { kind: 'edit', draft: parsed.data }
          })
        : await window.api.schedules.create({ target, draft: parsed.data, requestId })
      onSaved(saved)
    } catch (e) {
      await mutationFailed(e)
      setBusy(false)
    }
  }
  const toggle = task && scheduleToggle(task, t)
  async function changeState(): Promise<void> {
    if (!task || !toggle || busy || conflict) return
    setBusy(true)
    try {
      const saved = await changeScheduleState(task, toggle.change)
      onSaved(saved)
    } catch (e) {
      await mutationFailed(e)
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          className={dialogPanelClassName(
            'flex w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <form
            className="flex min-h-0 flex-col"
            aria-busy={busy}
            noValidate
            onBlurCapture={(event) => {
              const name =
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement
                  ? event.target.name
                  : undefined
              if (name) setTouched((fields) => new Set([...fields, name]))
            }}
            onSubmit={(e) => {
              e.preventDefault()
              // eslint-disable-next-line react-hooks/purity -- This submit event rechecks wall time, not render time.
              void submit(Date.now())
            }}
          >
            <header className={dialogHeaderClassName}>
              <Dialog.Title className="font-semibold">
                {task?.finishedAt ? t('Schedule') : task ? t('Edit task') : t('Schedule a task')}
              </Dialog.Title>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                onClick={requestClose}
                aria-label={t('Close')}
              >
                <X />
              </Button>
            </header>
            <div className="min-h-0 space-y-4 overflow-y-auto p-5">
              {Boolean(loadError) && (
                <ErrorNotice inline description={scheduleErrorText(loadError, t)} />
              )}
              {task?.finishedAt && (
                <ErrorNotice
                  inline
                  level="info"
                  title={
                    task.finishReason === 'completed'
                      ? t('Completed')
                      : task.finishReason === 'cancelled'
                        ? t('Cancelled')
                        : t('Closed')
                  }
                  description={t('This task is read-only. Create a new task to run again.')}
                />
              )}
              {task && initialDraft && !conflict && (
                <ErrorNotice
                  inline
                  level="info"
                  description={t('Review the merged settings, then save.')}
                />
              )}
              {conflict && (
                <ErrorNotice
                  inline
                  level="warning"
                  title={t('This task changed while you were editing.')}
                  description={t(
                    'Your draft is kept. Review your changes against the latest task before saving.'
                  )}
                  primaryButton={
                    conflict.finishedAt
                      ? undefined
                      : {
                          label: t('Review my changes'),
                          disabled: !parsed.success || invalid,
                          onClick: reviewChanges
                        }
                  }
                  secondaryButton={{
                    label: t('Discard changes'),
                    onClick: () => onReview(conflict)
                  }}
                />
              )}
              {pendingReason && (
                <ErrorNotice
                  inline
                  level="info"
                  description={pendingReason}
                  secondaryButton={
                    pendingChanges && liveTask
                      ? {
                          label: t('Discard changes'),
                          onClick: () => onReview(liveTask)
                        }
                      : undefined
                  }
                />
              )}
              <fieldset disabled={disabled} className="min-w-0 space-y-4">
                {!task && action === 'send_session_message' && !message && (
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      {t('Start from an example')}
                    </summary>
                    <div className="mt-2">
                      <ScheduleExamples
                        onChoose={(example) => {
                          setName(example.name)
                          setMessage(example.action.message)
                          setKind(example.rule.kind)
                          setTime(example.rule.time)
                          if (example.rule.kind === 'weekly') setDays(example.rule.weekdays)
                        }}
                      />
                    </div>
                  </details>
                )}
                <label className="grid gap-1.5 text-sm">
                  {t('Name')}
                  <Input
                    autoFocus={!task && !initialDraft}
                    {...fieldProps('name')}
                    value={name}
                    placeholder={t('Name')}
                    onChange={(e) => setName(e.target.value)}
                    aria-label={t('Name')}
                  />
                  {fieldError('name')}
                </label>
                <DisabledHint reason={pendingReason} className="w-full">
                  <fieldset
                    disabled={disabled || pending}
                    className="min-w-0 w-full space-y-4 [&_input:disabled]:pointer-events-none [&_textarea:disabled]:pointer-events-none [&_button:disabled]:pointer-events-none"
                  >
                    {task ? (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                        <span>
                          {action === 'run_script' ? t('Run a script') : t('Send a message')}
                        </span>
                        <span aria-hidden="true">→</span>
                        <span className="min-w-0 break-words text-foreground">
                          {sessionId === null
                            ? t('New conversation for each run')
                            : (sessions.find((s) => s.id === sessionId)?.title ??
                              t('Conversation not found'))}
                        </span>
                      </div>
                    ) : (
                      <label className="grid gap-1.5 text-sm">
                        {t('Action')}
                        <ScheduleSelect
                          disabled={disabled}
                          describedBy={!eligible.length ? fieldId + 'script-help' : undefined}
                          label={t('Action')}
                          value={action}
                          onValueChange={(value) => {
                            setAction(value as typeof action)
                            if (value === 'run_script' && !sessionId)
                              setSession(
                                eligible.find((s) => s.id === selected)?.id ??
                                  eligible[0]?.id ??
                                  null
                              )
                          }}
                        >
                          <SelectItem value="send_session_message">
                            {t('Send a message')}
                          </SelectItem>
                          {!eligible.length ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <SelectItem
                                    value="run_script"
                                    disabled
                                    className="data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed"
                                  >
                                    {t('Run a script')}
                                  </SelectItem>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {t('Select an existing conversation to run a script.')}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <SelectItem value="run_script">{t('Run a script')}</SelectItem>
                          )}
                        </ScheduleSelect>
                        {!eligible.length && (
                          <span
                            id={fieldId + 'script-help'}
                            className="text-xs text-muted-foreground"
                          >
                            {t('Select an existing conversation to run a script.')}
                          </span>
                        )}
                      </label>
                    )}
                    {action === 'run_script' && (
                      <ScheduleSelect
                        value={language}
                        label={t('Language')}
                        disabled={disabled || pending}
                        onValueChange={(value) => setLanguage(value as typeof language)}
                      >
                        <SelectItem value="python">{t('Python')}</SelectItem>
                        <SelectItem value="r">{t('R')}</SelectItem>
                        <SelectItem value="shell">{t('Shell')}</SelectItem>
                      </ScheduleSelect>
                    )}
                    {task?.finishedAt ? (
                      <details className="group/instructions rounded-lg border border-border p-3">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm [&::-webkit-details-marker]:hidden">
                          {action === 'run_script' ? t('Script') : t('Instructions')}
                          <ChevronDown className="size-4 shrink-0 transition-transform group-open/instructions:rotate-180" />
                        </summary>
                        <div
                          className={`mt-3 whitespace-pre-wrap break-words text-sm select-text ${action === 'run_script' ? 'font-mono' : ''}`}
                        >
                          {action === 'run_script' ? code : message}
                        </div>
                      </details>
                    ) : (
                      <label className="grid gap-1.5 text-sm">
                        {action === 'run_script' ? t('Script') : t('Instructions')}
                        <Textarea
                          required
                          {...fieldProps(action === 'run_script' ? 'code' : 'message')}
                          className={action === 'run_script' ? 'min-h-32 font-mono' : 'min-h-32'}
                          aria-label={action === 'run_script' ? t('Script') : t('Instructions')}
                          placeholder={action === 'run_script' ? t('Script') : t('Instructions')}
                          value={action === 'run_script' ? code : message}
                          onChange={(e) =>
                            action === 'run_script'
                              ? setCode(e.target.value)
                              : setMessage(e.target.value)
                          }
                        />
                        {fieldError(action === 'run_script' ? 'code' : 'message')}
                      </label>
                    )}
                    {!task && (
                      <div className="space-y-3">
                        {action === 'send_session_message' && (
                          <div className="grid min-w-0 gap-1.5 text-sm">
                            <span>{t('How to run')}</span>
                            <ScheduleSelect
                              disabled={disabled}
                              label={t('How to run')}
                              describedBy={fieldId + 'conversation-mode-help'}
                              value={sessionId === null ? 'new' : 'existing'}
                              onValueChange={(value) =>
                                setSession(
                                  value === 'new'
                                    ? null
                                    : (eligible.find((s) => s.id === selected)?.id ?? '')
                                )
                              }
                            >
                              <SelectItem value="existing">
                                {t('Continue an existing conversation')}
                              </SelectItem>
                              <SelectItem value="new">
                                {t('New conversation for each run')}
                              </SelectItem>
                            </ScheduleSelect>
                            <p
                              id={fieldId + 'conversation-mode-help'}
                              className="text-xs text-muted-foreground"
                            >
                              {sessionId === null
                                ? t(
                                    'Each run starts independently, without previous conversation history.'
                                  )
                                : t(
                                    'Continue in the selected conversation, using its existing context.'
                                  )}
                            </p>
                          </div>
                        )}
                        {(sessionId !== null || action === 'run_script') && (
                          <div className="grid min-w-0 gap-1.5 text-sm">
                            <span>{t('Target conversation')}</span>
                            <Popover
                              open={conversationPickerOpen}
                              onOpenChange={setConversationPickerOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  role="combobox"
                                  aria-label={t('Target conversation')}
                                  aria-expanded={conversationPickerOpen}
                                  disabled={disabled || !eligible.length}
                                  className="w-full min-w-0 justify-between font-normal"
                                >
                                  <span className="truncate">
                                    {eligible.find((s) => s.id === sessionId)?.title ??
                                      (eligible.length
                                        ? t('Select')
                                        : t('No conversations available'))}
                                  </span>
                                  <ChevronDown
                                    className="size-4 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                align="start"
                                className="flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-1"
                              >
                                <ConversationPicker
                                  sessions={eligible}
                                  currentSessionId={selected}
                                  onSelect={(id) => {
                                    setSession(id)
                                    setConversationPickerOpen(false)
                                  }}
                                />
                              </PopoverContent>
                            </Popover>
                            {action === 'run_script' && (
                              <p className="text-xs text-muted-foreground">
                                {t('Run in the selected conversation’s Notebook.')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="divide-y divide-border rounded-xl border border-border px-3 text-sm">
                      <label className="flex flex-wrap items-center justify-between gap-3 py-3">
                        {t('Repeat')}
                        <ScheduleSelect
                          compact
                          disabled={disabled || pending}
                          label={t('Repeat')}
                          value={kind}
                          onValueChange={(value) => setKind(value as typeof kind)}
                        >
                          <SelectItem value="once">{t('Once')}</SelectItem>
                          <SelectItem value="interval">{t('Fixed interval')}</SelectItem>
                          <SelectItem value="daily">{t('Daily')}</SelectItem>
                          <SelectItem value="weekly">{t('Weekly')}</SelectItem>
                        </ScheduleSelect>
                      </label>
                      {kind === 'interval' && (
                        <label className="flex flex-wrap items-center justify-between gap-3 py-3">
                          {t('Minutes')}
                          <Input
                            className="w-auto max-w-full"
                            type="number"
                            min="1"
                            {...fieldProps('minutes')}
                            aria-label={t('Minutes')}
                            value={minutes}
                            onChange={(e) => setMinutes(e.target.valueAsNumber)}
                          />
                          {fieldError('minutes')}
                        </label>
                      )}
                      {kind === 'weekly' && (
                        <div
                          role="group"
                          aria-label={t('Repeat')}
                          aria-describedby={problems.weekdays ? fieldId + 'weekdays' : undefined}
                          className="flex flex-wrap gap-2 py-2"
                        >
                          {Array.from({ length: 7 }, (_, i) => (
                            <Button
                              key={i}
                              type="button"
                              role="checkbox"
                              aria-checked={days.includes(i)}
                              variant={days.includes(i) ? 'secondary' : 'ghost'}
                              className="min-w-9"
                              onClick={() => {
                                setTouched((fields) => new Set([...fields, 'weekdays']))
                                setDays((d) =>
                                  d.includes(i) ? d.filter((x) => x !== i) : [...d, i].sort()
                                )
                              }}
                            >
                              {new Intl.DateTimeFormat(i18n.language, {
                                weekday: 'short',
                                timeZone: 'UTC'
                              }).format(Date.UTC(2026, 10, 8 + i))}
                            </Button>
                          ))}
                          {fieldError('weekdays')}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                        {kind === 'interval' ? t('Start time') : t('Time')}
                        <div className="flex min-w-0 max-w-full items-center gap-2">
                          {kind === 'daily' || kind === 'weekly' ? (
                            <ScheduleTimeInput
                              {...fieldProps('time')}
                              aria-label={t('Time')}
                              value={time}
                              onValueChange={setTime}
                            />
                          ) : (
                            <Input
                              className="min-w-0 w-auto max-w-full"
                              type="datetime-local"
                              {...fieldProps(kind === 'once' ? 'at' : 'anchor')}
                              aria-label={kind === 'once' ? t('Time') : t('Start time')}
                              value={start}
                              onChange={(e) => setStart(e.target.value)}
                            />
                          )}
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  tabIndex={0}
                                  aria-label={t('Time zone')}
                                  className="shrink-0 cursor-default rounded text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  {zoneLabel}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>{zone}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        {fieldError(
                          kind === 'once' ? 'at' : kind === 'interval' ? 'anchor' : 'time'
                        )}
                      </div>
                    </div>
                    {candidates.length > 1 && (kind === 'once' || kind === 'interval') && (
                      <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                        {t('Time')}
                        <ScheduleSelect
                          value={Number.isFinite(at) ? String(at) : ''}
                          label={t('Time')}
                          disabled={disabled || pending}
                          placeholder={t('Select')}
                          onValueChange={(value) => setPreferredAt(Number(value))}
                        >
                          {candidates.map((candidate) => (
                            <SelectItem key={candidate} value={String(candidate)}>
                              {new Date(candidate).toISOString()}
                            </SelectItem>
                          ))}
                        </ScheduleSelect>
                      </label>
                    )}
                    {!task?.finishedAt && !task?.pausedAt && next !== null && (
                      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                        <span>{t('Next run')}</span>
                        <span>
                          {new Intl.DateTimeFormat(i18n.language, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            timeZone: zone
                          }).format(next)}
                        </span>
                      </p>
                    )}
                    <div className="space-y-1.5 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span>{t('Execution permissions')}</span>
                        {sessionId === null ? (
                          <ScheduleSelect
                            compact
                            label={t('Execution permissions')}
                            value={permissionProfile}
                            disabled={disabled || pending}
                            onValueChange={(value) =>
                              setPermissionProfile(value as PermissionProfileId)
                            }
                          >
                            <SelectItem value="ask">{t('Existing permissions only')}</SelectItem>
                            <SelectItem value="auto">{t('Auto')}</SelectItem>
                            <SelectItem value="full">{t('Full access')}</SelectItem>
                          </ScheduleSelect>
                        ) : (
                          <span className="text-muted-foreground">
                            {t('Follow conversation permissions')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'Runs without approval prompts. Actions requiring approval are declined.'
                        )}
                      </p>
                    </div>
                    {(kind !== 'once' || action === 'run_script') && (
                      <details className="group/advanced">
                        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-4 transition-transform group-open/advanced:rotate-180" />
                          {t('Advanced')}
                        </summary>
                        <div className="mt-2 space-y-3">
                          {kind !== 'once' && (
                            <label className="grid gap-1.5 text-sm">
                              {t('End condition')}
                              <ScheduleSelect
                                label={t('End condition')}
                                value={ending}
                                disabled={disabled || pending}
                                onValueChange={setEnding}
                              >
                                <SelectItem value="never">{t('No limit')}</SelectItem>
                                <SelectItem value="date">{t('End time')}</SelectItem>
                                <SelectItem value="count">{t('Maximum runs')}</SelectItem>
                              </ScheduleSelect>
                            </label>
                          )}
                          {kind !== 'once' && ending === 'date' && (
                            <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                              {t('End time')}
                              <Input
                                type="datetime-local"
                                {...fieldProps('endAt')}
                                aria-label={t('End time')}
                                value={end}
                                onChange={(e) => setEnd(e.target.value)}
                              />
                              {fieldError('endAt')}
                            </label>
                          )}
                          {kind !== 'once' && ending === 'count' && (
                            <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                              {t('Maximum runs')}
                              <Input
                                type="number"
                                min={1}
                                {...fieldProps('maxRuns')}
                                aria-label={t('Maximum runs')}
                                value={limit}
                                onChange={(e) => setLimit(e.target.value)}
                              />
                              {fieldError('maxRuns')}
                            </label>
                          )}
                          {action === 'run_script' && (
                            <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
                              {t('Timeout (ms)')}
                              <Input
                                type="number"
                                min={1}
                                {...fieldProps('timeoutMs')}
                                aria-label={t('Timeout (ms)')}
                                value={timeout}
                                onChange={(e) => setTimeoutMs(e.target.value)}
                              />
                              {fieldError('timeoutMs')}
                            </label>
                          )}
                        </div>
                      </details>
                    )}
                  </fieldset>
                </DisabledHint>
              </fieldset>
              {task?.pauseReason && (
                <ErrorNotice
                  inline
                  level="warning"
                  title={t('Paused')}
                  description={scheduleReasonText(task.pauseReason, t)}
                />
              )}
            </div>
            {Boolean(error) && (
              <div className="shrink-0 px-5 py-3">
                <ErrorNotice
                  inline
                  title={t('Schedule')}
                  description={scheduleErrorText(error, t)}
                />
              </div>
            )}
            <footer className={dialogFooterClassName}>
              {task && !task.finishedAt && (
                <DisabledHint
                  reason={
                    conflict
                      ? t('This task changed while you were editing.')
                      : dirty
                        ? t('Save your changes before changing the task status.')
                        : undefined
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || dirty || Boolean(conflict)}
                    onClick={() => void changeState()}
                  >
                    {toggle?.label}
                  </Button>
                </DisabledHint>
              )}
              <Button type="button" variant="ghost" disabled={busy} onClick={requestClose}>
                {task?.finishedAt ? t('Close') : t('Cancel')}
              </Button>
              {!task?.finishedAt && (
                <DisabledHint
                  reason={
                    conflict
                      ? t('This task changed while you were editing.')
                      : pendingChanges
                        ? pendingReason
                        : invalid
                          ? Object.values(problems)[0]
                          : !parsed.success || (!task && next === null)
                            ? t('Check the instructions and schedule settings.')
                            : sessionId === ''
                              ? t('Select a target conversation.')
                              : !target
                                ? t(
                                    'The conversation is not ready. Wait for it to load or select another conversation.'
                                  )
                                : task && !dirty
                                  ? t('No changes to save.')
                                  : undefined
                  }
                >
                  <Button
                    type="submit"
                    disabled={
                      disabled ||
                      Boolean(conflict) ||
                      Boolean(pendingChanges) ||
                      !target ||
                      invalid ||
                      !parsed.success ||
                      (!task && next === null) ||
                      (Boolean(task) && !dirty)
                    }
                  >
                    {busy && (
                      <LoaderCircle
                        aria-hidden
                        className="size-4 animate-spin motion-reduce:animate-none"
                      />
                    )}
                    {busy ? t('Saving') : task ? t('Save') : t('Create')}
                  </Button>
                </DisabledHint>
              )}
            </footer>
          </form>
          <ConfirmActionDialog
            open={confirmClose}
            title={t('Discard unsaved changes?')}
            description={t('Your changes have not been saved. Discard them and leave the editor?')}
            cancelLabel={t('Keep editing')}
            confirmLabel={t('Discard changes')}
            destructive
            onCancel={() => setConfirmClose(false)}
            onConfirm={onClose}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
