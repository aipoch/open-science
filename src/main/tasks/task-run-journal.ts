import { join } from 'node:path'
import { z } from 'zod'

import type { ArtifactFile } from '../../shared/artifacts'
import {
  generatePlanContentSchema,
  type ActivePlanProjection
} from '../../shared/session-plan/contract'

import type {
  TaskRun,
  TaskRunFailureCode,
  TaskRunStatus,
  TaskRunReview
} from '../../shared/task-api'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'

const TASK_RUN_JOURNAL_FILE = 'task-runs.json'
const TASK_RUN_JOURNAL_VERSION = 1 as const

export type TaskRunJournalEntry = TaskRun & {
  promptMessageId?: string
  sessionCommitStatus?: Exclude<TaskRunStatus, 'running'>
}

type TaskRunJournalDocument = {
  version: typeof TASK_RUN_JOURNAL_VERSION
  runs: TaskRunJournalEntry[]
}

export type TaskRunJournal = {
  load(): Promise<TaskRunJournalEntry[]>
  replace(runs: readonly TaskRunJournalEntry[]): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionalFiniteNumber = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const identity = z
  .string()
  .refine((value) => value.trim().length > 0, 'Expected a nonempty identity')
const count = z.number().int().nonnegative()
const artifactSchema = z.object({
  id: identity,
  projectId: identity,
  sessionId: identity,
  messageId: identity.optional(),
  runId: identity.optional(),
  name: z.string(),
  path: z.string(),
  fileUrl: z.string(),
  mimeType: z.string().optional(),
  size: count,
  mtimeMs: z.number(),
  artifactId: identity.optional(),
  versionId: identity.optional(),
  versionNumber: count.optional(),
  isPublished: z.boolean().optional(),
  checksum: z.string().optional(),
  createdAt: z.string().optional(),
  producerRunId: identity.optional(),
  environment: z.string().optional()
}) satisfies z.ZodType<ArtifactFile>

const stepStatus = z.enum(['in_progress', 'completed', 'blocked', 'skipped'])
const planSchema = z.object({
  artifactId: identity,
  artifactVersionId: identity,
  artifactChecksum: identity,
  originatingPromptMessageId: identity.optional(),
  materializedAt: z.number().optional(),
  revision: count,
  approval: z.enum(['pending', 'approved', 'rejected']),
  lifecycle: z.enum([
    'awaiting_approval',
    'approved',
    'in_progress',
    'blocked',
    'completed',
    'rejected'
  ]),
  document: generatePlanContentSchema.extend({ schema_version: z.literal(1) }),
  stepStatuses: z.record(
    z.string(),
    z.object({
      status: stepStatus,
      updatedAt: z.number(),
      notes: z.string().optional()
    })
  ),
  stepStates: z.record(
    z.string(),
    z.object({
      status: z.enum([...stepStatus.options, 'not_started', 'not_run']),
      notes: z.string().optional()
    })
  ),
  counts: z.object({
    phases: count,
    delegations: count,
    steps: count,
    completed: count,
    inProgress: count
  })
}) satisfies z.ZodType<ActivePlanProjection>

const reviewSchema = z.object({
  started: z.boolean(),
  reason: z
    .enum([
      'already-in-flight',
      'not-found',
      'load-failed',
      'run-failed',
      'already-reviewed',
      'idempotency-check-failed'
    ])
    .optional(),
  id: identity.optional(),
  lifecycle: z.enum(['running', 'complete', 'error']).optional(),
  outcome: z.enum(['pass', 'flagged']).nullable().optional(),
  errorMessage: z.string().optional()
}) satisfies z.ZodType<TaskRunReview>

const nestedRunSchema = z.object({
  artifacts: z.array(artifactSchema),
  attention: z.object({ kind: z.literal('plan-approval'), plan: planSchema }).optional(),
  review: reviewSchema.optional()
})

const TASK_RUN_STATUSES = new Set<TaskRunStatus>(['running', 'completed', 'failed', 'cancelled'])
const TASK_RUN_FAILURE_CODES = new Set<TaskRunFailureCode>(['process_restarted'])

const decodeRun = (value: unknown): TaskRunJournalEntry => {
  if (!isRecord(value))
    throw new DurableJsonRecoveryBarrierError('Task Run journal contains a non-object Run.')
  if (
    !identity.safeParse(value.id).success ||
    !identity.safeParse(value.sessionId).success ||
    !identity.safeParse(value.projectId).success ||
    typeof value.cwd !== 'string' ||
    typeof value.status !== 'string' ||
    !TASK_RUN_STATUSES.has(value.status as TaskRunStatus) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    !isOptionalFiniteNumber(value.cancelRequestedAt) ||
    !isOptionalFiniteNumber(value.cancelledAt) ||
    !isOptionalFiniteNumber(value.completedAt) ||
    (value.output !== undefined && typeof value.output !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.failureCode !== undefined &&
      (typeof value.failureCode !== 'string' ||
        !TASK_RUN_FAILURE_CODES.has(value.failureCode as TaskRunFailureCode))) ||
    (value.promptMessageId !== undefined && typeof value.promptMessageId !== 'string') ||
    (value.sessionCommitStatus !== undefined &&
      value.sessionCommitStatus !== 'completed' &&
      value.sessionCommitStatus !== 'cancelled' &&
      value.sessionCommitStatus !== 'failed') ||
    (value.sessionCommitStatus !== undefined &&
      (!identity.safeParse(value.promptMessageId).success || value.completedAt === undefined)) ||
    !isStringArray(value.preferredComputeHostIds)
  ) {
    throw new DurableJsonRecoveryBarrierError('Task Run journal contains an invalid Run.')
  }
  const nested = nestedRunSchema.safeParse(value)
  if (!nested.success) {
    const issue = nested.error.issues[0]
    throw new DurableJsonRecoveryBarrierError(
      `Task Run journal contains an invalid Run at ${issue.path.join('.')}: ${issue.message}`
    )
  }
  // Validation must not strip unknown fields from a compatible document during recovery.
  return value as TaskRunJournalEntry
}

const decodeDocument = (contents: string): TaskRunJournalEntry[] => {
  const value = JSON.parse(contents) as unknown
  if (!isRecord(value))
    throw new DurableJsonRecoveryBarrierError('Task Run journal must contain an object.')
  if (
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version > TASK_RUN_JOURNAL_VERSION
  ) {
    throw new DurableJsonRecoveryBarrierError('Unsupported Task Run journal version.')
  }
  if (value.version !== TASK_RUN_JOURNAL_VERSION || !Array.isArray(value.runs)) {
    throw new DurableJsonRecoveryBarrierError('Task Run journal has an invalid format.')
  }
  const runs = value.runs.map(decodeRun)
  const ids = new Set<string>()
  for (const run of runs) {
    if (ids.has(run.id)) {
      throw new DurableJsonRecoveryBarrierError(
        `Task Run journal contains duplicate Run id: ${run.id}`
      )
    }
    ids.add(run.id)
  }
  return runs
}

export class FileTaskRunJournal implements TaskRunJournal {
  private readonly filePath: string

  constructor(configRoot: string) {
    this.filePath = join(configRoot, TASK_RUN_JOURNAL_FILE)
  }

  async load(): Promise<TaskRunJournalEntry[]> {
    const result = await readDurableJsonFile(this.filePath, decodeDocument)
    return result.status === 'found' ? result.value : []
  }

  async replace(runs: readonly TaskRunJournalEntry[]): Promise<void> {
    const document: TaskRunJournalDocument = {
      version: TASK_RUN_JOURNAL_VERSION,
      runs: runs.map((run) => structuredClone(run))
    }
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
