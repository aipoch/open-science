import { getI18n } from 'react-i18next'
import {
  scheduleDraftSchema,
  scheduleToolDraft,
  scheduleToolInputs,
  scheduleRuleSchema,
  scheduleActionSchema
} from '../../../../../shared/session-schedules'
import { notebookInput, type ToolSummary } from '../notebook-tool-presentation'
import type { TranslateClause } from '../workspace-translate-clause'

export function scheduleToolPresentation(
  identity: string | undefined,
  raw: unknown,
  t: TranslateClause
): { summary: ToolSummary; script?: { code: string; language: string } } | undefined {
  const match =
    /^(?:mcp__|mcp\.)?open[-_]science[-_]schedule(?:__|\/|\.|_)(create_schedule|update_schedule|close_schedule|list_schedules|manage_current_schedule)$/i.exec(
      identity ?? ''
    )
  if (!match) return undefined
  let payload = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      /* Keep malformed input out of the user-facing card. */
    }
  }
  const input = notebookInput(payload)
  const tool = match[1]
  const title =
    tool === 'create_schedule'
      ? t('Schedule a task')
      : tool === 'close_schedule'
        ? t('Close task')
        : tool === 'list_schedules'
          ? t('List scheduled tasks')
          : t('Edit task')
  const summary: ToolSummary = { title, fields: [] }
  const draft: Record<string, unknown> = input.draft
    ? { ...notebookInput(input.draft) }
    : { ...scheduleToolDraft(input), permissionProfile: input.permissionProfile }
  const inputRule = notebookInput(draft.rule)
  if (tool === 'create_schedule' && inputRule.timeZone === undefined && draft.rule) {
    draft.rule = { ...inputRule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }
  const parsed = scheduleDraftSchema.safeParse(draft)
  const ruleResult = scheduleRuleSchema.safeParse(draft.rule)
  const actionResult = scheduleActionSchema.safeParse(draft.action)
  if (typeof draft.name === 'string') summary.subtitle = draft.name
  const invalidDraft =
    (tool === 'create_schedule' || tool === 'update_schedule') &&
    (!parsed.success || (!input.draft && !scheduleToolInputs[tool].safeParse(input).success))
  if (draft.permissionProfile !== undefined)
    summary.note = t('Conversation permissions are inherited. Remove the permission override.')
  if (
    ruleResult.success &&
    ruleResult.data.kind === 'once' &&
    (draft.endAt !== undefined || draft.maxRuns !== undefined)
  )
    summary.note = t('One-time tasks run once. Remove the end time and maximum runs.')
  else if (invalidDraft && !summary.note)
    summary.note = t('Some task settings are invalid. Ask the agent to correct them.')
  if (!ruleResult.success || !actionResult.success) {
    if (typeof input.scheduleId === 'string')
      summary.fields.push({ label: t('Task ID'), value: input.scheduleId })
    if (tool === 'manage_current_schedule' && typeof input.change === 'object' && input.change) {
      const change = input.change as Record<string, unknown>
      if (change.kind === 'close') summary.title = t('Close task')
      if (
        change.kind === 'reschedule' &&
        typeof change.at === 'number' &&
        Number.isFinite(new Date(change.at).getTime())
      )
        summary.fields.push({
          label: t('Next run'),
          value: new Date(change.at).toLocaleString(getI18n()?.language)
        })
    }
    if (typeof notebookInput(draft.action).message === 'string')
      summary.fields.push({
        label: t('Instructions'),
        value: String(notebookInput(draft.action).message),
        multiline: true
      })
    return { summary }
  }
  const rule = ruleResult.data
  const action = actionResult.data
  const maxRuns = scheduleDraftSchema.shape.maxRuns.safeParse(draft.maxRuns)
  const endAt = scheduleDraftSchema.shape.endAt.safeParse(draft.endAt)
  const locale = getI18n()?.language
  const date = (at: number): string =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: rule.timeZone
    }).format(at)
  const cadence =
    rule.kind === 'once'
      ? t('Once') + ' ' + date(rule.at)
      : rule.kind === 'interval'
        ? new Intl.NumberFormat(locale, {
            style: 'unit',
            unit: 'minute',
            unitDisplay: 'long'
          }).format(rule.minutes)
        : rule.kind === 'daily'
          ? t('Daily at {{time}}', { time: rule.time })
          : rule.weekdays
              .map((day) =>
                new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
                  Date.UTC(2023, 0, 1 + day)
                )
              )
              .join(', ') +
            ' ' +
            rule.time
  summary.fields.push(
    { label: t('Repeat'), value: cadence + ' (' + rule.timeZone + ')' },
    {
      label: t('Action'),
      value:
        action.kind === 'run_script'
          ? t('Run a script') +
            ' (' +
            { python: 'Python', r: 'R', shell: t('Shell') }[action.language] +
            ')'
          : t('Send a message')
    }
  )
  if (tool === 'create_schedule')
    summary.fields.push({ label: t('Conversation'), value: t('This conversation') })
  summary.fields.push({
    label: t('Execution permissions'),
    value: t('Follow conversation permissions')
  })
  if (rule.kind === 'interval' && rule.anchor > 0)
    summary.fields.push({ label: t('Start time'), value: date(rule.anchor) })
  if (maxRuns.success && maxRuns.data !== undefined)
    summary.fields.push({ label: t('Maximum runs'), value: String(maxRuns.data) })
  if (endAt.success && endAt.data !== undefined)
    summary.fields.push({ label: t('End time'), value: date(endAt.data) })
  if (action.kind === 'send_session_message')
    summary.fields.push({ label: t('Instructions'), value: action.message, multiline: true })
  if (action.kind === 'run_script' && action.timeoutMs !== undefined)
    summary.fields.push({ label: t('Timeout (ms)'), value: String(action.timeoutMs) })
  return {
    summary,
    script:
      action.kind === 'run_script'
        ? { code: action.code, language: action.language === 'shell' ? 'bash' : action.language }
        : undefined
  }
}

// MCP transports may return an object, JSON text or content blocks. Only task facts reach the UI.
export function scheduleToolResult(
  summary: ToolSummary,
  output: unknown,
  failed: boolean,
  t: TranslateClause
): ToolSummary {
  const unwrap = (value: unknown, depth = 0): unknown => {
    if (depth > 5) return undefined
    if (typeof value === 'string') {
      try {
        return unwrap(JSON.parse(value), depth + 1)
      } catch {
        return value
      }
    }
    const item = notebookInput(value)
    if (item.isError === true) failed = true
    if (item.structuredContent !== undefined) return unwrap(item.structuredContent, depth + 1)
    if (item.result !== undefined) return unwrap(item.result, depth + 1)
    if (Array.isArray(item.content)) {
      const texts = item.content
        .map((block) => notebookInput(block).text)
        .filter((value) => typeof value === 'string')
      return texts.length === 1 ? unwrap(texts[0], depth + 1) : texts.join('\n')
    }
    return value
  }
  const value = unwrap(output)
  if (failed) {
    const text = typeof value === 'string' ? value : ''
    const reason =
      summary.note ??
      (text.includes('Schedule permissions can only be changed')
        ? t('Conversation permissions are inherited. Remove the permission override.')
        : /Input validation error|Invalid arguments/i.test(text)
          ? t('Some task settings are invalid. Ask the agent to correct them.')
          : text.includes('This task is waiting to run.')
            ? t('This task is waiting to run. Its instructions and schedule cannot be changed yet.')
            : t('Could not complete the schedule request. Try again.'))
    return { ...summary, note: undefined, error: reason }
  }
  const task = notebookInput(value)
  const draft = notebookInput(task.draft)
  if (typeof draft.name === 'string' && !summary.subtitle)
    summary = { ...summary, subtitle: draft.name }
  if (Array.isArray(value)) {
    const rows = value.flatMap((item) => {
      const task = notebookInput(item)
      const draft = notebookInput(task.draft)
      if (typeof draft.name !== 'string') return []
      return [
        {
          title: draft.name,
          status: task.finishedAt
            ? task.finishReason === 'completed'
              ? t('Completed')
              : task.finishReason === 'cancelled'
                ? t('Cancelled')
                : t('Closed')
            : task.pausedAt
              ? t('Paused')
              : t('Active'),
          ...(typeof task.nextDueAt === 'number' &&
          Number.isFinite(new Date(task.nextDueAt).getTime())
            ? { detail: new Date(task.nextDueAt).toLocaleString(getI18n()?.language) }
            : {})
        }
      ]
    })
    return {
      ...summary,
      rows: rows.slice(0, 30),
      note:
        value.length === 0
          ? t('No scheduled tasks yet')
          : rows.length > 30
            ? t('Output truncated')
            : summary.note
    }
  }
  return summary
}
