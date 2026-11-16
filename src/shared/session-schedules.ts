import { z } from 'zod'
import { PERMISSION_PROFILE_IDS } from './permission-profiles'

export const SCHEDULE_PENDING_EDIT_MESSAGE =
  'This task is waiting to run. Its instructions and schedule cannot be changed yet.'

export const scheduleReasonSchema = z.enum([
  'expired',
  'changed',
  'archived',
  'conversation_unavailable',
  'unconfirmed',
  'failed',
  'interrupted',
  'cancelled',
  'admission_rejected',
  'dispatch_failed'
])
export type ScheduleReason = z.infer<typeof scheduleReasonSchema>

const instant = z.number().int().min(0).max(8_640_000_000_000_000)
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone })
      return true
    } catch {
      return false
    }
  })
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: instant, timeZone }),
  z.strictObject({
    kind: z.literal('interval'),
    anchor: instant,
    minutes: z.number().int().positive().max(525600),
    timeZone
  }),
  z.strictObject({ kind: z.literal('daily'), time: localTime, timeZone }),
  z.strictObject({
    kind: z.literal('weekly'),
    time: localTime,
    timeZone,
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length)
  })
])
export const scheduleActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('send_session_message'),
    message: z
      .string()
      .max(64000)
      .refine((value) => Boolean(value.trim()))
  }),
  z.strictObject({
    kind: z.literal('run_script'),
    language: z.enum(['python', 'r', 'shell']),
    code: z
      .string()
      .max(256000)
      .refine((value) => Boolean(value.trim())),
    timeoutMs: z.number().int().positive().optional()
  })
])
const validScheduleLimits = (draft: {
  rule: { kind: string }
  endAt?: number
  maxRuns?: number
}): boolean =>
  !(draft.endAt !== undefined && draft.maxRuns !== undefined) &&
  (draft.rule.kind !== 'once' || (draft.endAt === undefined && draft.maxRuns === undefined))

export const scheduleDraftSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    permissionProfile: z.enum(PERMISSION_PROFILE_IDS).optional(),
    rule: scheduleRuleSchema,
    action: scheduleActionSchema,
    endAt: instant.optional(),
    maxRuns: z.number().int().positive().optional()
  })
  .refine(validScheduleLimits)

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>
export type ScheduleAction = z.infer<typeof scheduleActionSchema>
export type ScheduleDraft = z.infer<typeof scheduleDraftSchema>

const id = z.string().min(1).max(256)
export const scheduleTargetSchema = z.strictObject({
  projectId: id,
  sessionId: id,
  agentFrameId: id,
  messageBranchId: id
})
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>
const projectScheduleTargetSchema = z.strictObject({
  projectId: id,
  sessionId: z.null(),
  agentFrameId: z.null(),
  messageBranchId: z.null()
})
export const scheduleOwnerSchema = z.union([scheduleTargetSchema, projectScheduleTargetSchema])
export const scheduleRunSchema = z.object({
  scheduledAt: instant,
  promptMessageId: id.nullable().optional(),
  status: z.enum(['dispatching', 'admitted', 'succeeded', 'failed', 'interrupted', 'skipped']),
  reason: z.string().nullable(),
  runSessionId: id.nullable(),
  scriptRunId: id.nullable()
})
export const scheduleViewSchema = z.object({
  originPromptId: id.nullable(),
  currentRun: scheduleRunSchema.optional(),
  latestProblem: z
    .object({
      status: z.enum(['failed', 'interrupted', 'skipped']),
      reason: z.string().nullable(),
      scheduledAt: instant.optional(),
      scriptRunId: id.nullable().optional()
    })
    .optional(),
  id,
  target: scheduleOwnerSchema,
  revision: z.number().int().positive(),
  draft: scheduleDraftSchema,
  nextDueAt: instant.nullable(),
  pausedAt: instant.nullable(),
  finishedAt: instant.nullable(),
  finishReason: z.enum(['completed', 'cancelled']).nullable().optional(),
  pauseReason: z.string().nullable()
})
export type ScheduleView = z.infer<typeof scheduleViewSchema>
export const scheduleSummarySchema = scheduleViewSchema.extend({
  draft: z.object({
    ...scheduleDraftSchema.shape,
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('send_session_message') }),
      z.object({ kind: z.literal('run_script'), language: z.enum(['python', 'r', 'shell']) })
    ])
  })
})
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>
export const scheduleCreateSchema = z.strictObject({
  target: scheduleOwnerSchema,
  draft: scheduleDraftSchema,
  requestId: id
})
export const scheduleEditSchema = z.strictObject({
  projectId: id,
  sessionId: id.nullable(),
  scheduleId: id,
  expectedRevision: z.number().int().positive(),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('edit'), draft: scheduleDraftSchema }),
    z.strictObject({ kind: z.literal('reschedule'), at: instant }),
    z.strictObject({ kind: z.literal('pause') }),
    z.strictObject({ kind: z.literal('resume'), runOnceNow: z.literal(true).optional() }),
    z.strictObject({ kind: z.literal('close') })
  ])
})
export const scheduleDeleteSchema = scheduleEditSchema.omit({ change: true })
export type ScheduleDeleteRequest = z.infer<typeof scheduleDeleteSchema>
export const scheduleListSchema = z.strictObject({ projectId: id, sessionId: id.optional() })
export type ScheduleCreateRequest = z.infer<typeof scheduleCreateSchema>
export type ScheduleEditRequest = z.infer<typeof scheduleEditSchema>
export type ScheduleListRequest = z.infer<typeof scheduleListSchema>

// MCP describes the requested work; storage keeps the normalized ScheduleDraft.
const scheduleToolLimitsMessage =
  'One-time tasks must omit endAt and maxRuns. Recurring tasks may set either endAt or maxRuns, not both.'
const optionalToolTimeZone = timeZone
  .optional()
  .describe(
    'Optional IANA timezone. Omit to use the computer timezone; the resolved zone is saved with the task.'
  )
const createToolRule = z.discriminatedUnion('kind', [
  scheduleRuleSchema.options[0].extend({ timeZone: optionalToolTimeZone }),
  scheduleRuleSchema.options[1].extend({ timeZone: optionalToolTimeZone }),
  scheduleRuleSchema.options[2].extend({ timeZone: optionalToolTimeZone }),
  scheduleRuleSchema.options[3].extend({ timeZone: optionalToolTimeZone })
])
const scheduleToolFields = {
  name: scheduleDraftSchema.shape.name.describe('Short task name.'),
  message: scheduleActionSchema.options[0].shape.message
    .optional()
    .describe(
      'Instructions to send to this conversation when due. Use this for research, connector calls and summaries. Omit script.'
    ),
  script: scheduleActionSchema.options[1]
    .omit({ kind: true })
    .optional()
    .describe(
      'Only for explicitly requested executable code or standalone computation. Omit message. Printing instructions does not invoke agent tools.'
    ),
  endAt: scheduleDraftSchema.shape.endAt.describe(
    'Recurring tasks only. Omit for once. Do not combine with maxRuns.'
  ),
  maxRuns: scheduleDraftSchema.shape.maxRuns.describe(
    'Recurring tasks only. Omit for once. Do not combine with endAt.'
  )
}
const validToolAction = (input: { message?: string; script?: unknown }): boolean =>
  (input.message !== undefined) !== (input.script !== undefined)
const actionIssue = { message: 'Provide message or script, exactly one.' }
const proof = z.string().min(1).max(100)
const scoped = {
  turnRef: proof
    .optional()
    .describe(
      'Private reference from the current prompt. Required unless the host supplies it through trusted tool context.'
    )
}
export const SCHEDULE_MCP_NAME = 'open-science-schedule'
export const SCHEDULE_TURN_META = 'open-science/schedule-turn'
export const SCHEDULE_INVOCATION_META = 'open-science/schedule-invocation'
export const scheduleToolInputs = {
  list_schedules: z.strictObject({ ...scoped, scheduleId: id.optional() }),
  manage_current_schedule: z.strictObject({
    ...scoped,
    change: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('close') }),
      z.strictObject({ kind: z.literal('reschedule'), at: instant })
    ])
  }),
  create_schedule: z
    .strictObject({
      ...scoped,
      requestId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          'Stable creation key; reuse on retry. Required unless the host supplies a stable invocation identity.'
        ),
      ...scheduleToolFields,
      rule: createToolRule
    })
    .refine(validScheduleLimits, { message: scheduleToolLimitsMessage })
    .refine(validToolAction, actionIssue),
  update_schedule: z
    .strictObject({
      ...scoped,
      scheduleId: id,
      expectedRevision: z.number().int().positive(),
      ...scheduleToolFields,
      rule: scheduleRuleSchema
    })
    .refine(validScheduleLimits, { message: scheduleToolLimitsMessage })
    .refine(validToolAction, actionIssue),
  close_schedule: z.strictObject({
    ...scoped,
    scheduleId: id,
    expectedRevision: z.number().int().positive()
  })
}

// Also used to present unvalidated tool input without exposing JSON to the user.
export function scheduleToolDraft(input: Record<string, unknown>): Record<string, unknown> {
  return {
    name: input.name,
    rule: input.rule,
    action:
      input.message !== undefined
        ? { kind: 'send_session_message', message: input.message }
        : input.script && typeof input.script === 'object' && !Array.isArray(input.script)
          ? { ...input.script, kind: 'run_script' }
          : undefined,
    endAt: input.endAt,
    maxRuns: input.maxRuns
  }
}

export const scheduleToolDescriptions = {
  list_schedules:
    'List schedule summaries in the current scope. Pass scheduleId to read the complete definition before editing it.',
  create_schedule:
    'Create a task requested in this conversation. For research, connector calls or summaries, pass name, message and rule. Example: {"name":"PubMed update","message":"Search PubMed and report new papers here.","rule":{"kind":"once","at":FUTURE_UNIX_MILLISECONDS}}. Replace the placeholder with a future numeric timestamp. Do not wrap in draft or action. Use script instead of message only for explicitly requested code. Omit rule.timeZone to use the computer timezone. Target and permissions are inherited; never pass permissionProfile or target. For once, omit maxRuns and endAt; it completes automatically after a successful run, without a close call. A recurring task may set one stopping limit. When the host does not supply identity, pass the private turnRef from this prompt and a requestId reused for retries.',
  update_schedule:
    'Read the task with list_schedules(scheduleId), then pass scheduleId, expectedRevision and its replacement name, rule, message or script, and any recurring limit. Copy draft.action.message to message, or draft.action code/language/timeoutMs to script; do not pass draft or action. Preserve the saved rule.timeZone unless asked to change it. Permissions cannot be changed here. For once, omit maxRuns and endAt. Waiting tasks allow name-only edits; paused tasks stay paused. During a scheduled wake use manage_current_schedule for the next run time. Supply the current private turnRef unless provided by the host.',
  close_schedule:
    'Cancel future runs of a task in this conversation using its scheduleId and revision. This records the task as cancelled, not completed, and does not stop an already running turn. Do not call this to report success: one-time tasks complete automatically after a successful run. Supply the current private turnRef unless provided by the host. During a scheduled wake use manage_current_schedule.',
  manage_current_schedule:
    'During a scheduled wake only: cancel future runs with close, or reschedule the next execution to a future Unix millisecond timestamp. Close records the task as cancelled, not completed, and does not stop this running turn. Do not close merely because the current run succeeded: one-time tasks complete automatically, and recurring tasks keep their schedule. The host selects the task. Supply the current private turnRef unless provided by the host. Instructions, script, limits and target cannot be changed here.'
} satisfies Record<keyof typeof scheduleToolInputs, string>

export const scheduleHistoryRequestSchema = z.strictObject({
  projectId: id,
  sessionId: id.nullable(),
  scheduleId: id
})
export type ScheduleHistoryRequest = z.infer<typeof scheduleHistoryRequestSchema>
export type ScheduleRun = z.infer<typeof scheduleRunSchema>

export type ScheduleTurnOrigin = {
  scheduleId: string
  revision: number
  ownerSessionId: string | null
}
