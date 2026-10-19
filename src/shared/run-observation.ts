import { z } from 'zod'
import type { NotebookKernelKind, NotebookRunStatus } from './notebook'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const targetFields = {
  projectId: identity,
  sessionId: identity,
  operationId: identity.optional(),
  executionInvocationId: identity.optional(),
  runId: identity.optional()
}
const hasSelector = (target: {
  operationId?: string
  executionInvocationId?: string
  runId?: string
}): boolean => !!(target.operationId || target.executionInvocationId || target.runId)

/** A caller must select an exact operation, invocation or Run; never the latest Session Run. */
export const runObservationTargetSchema = z.object(targetFields).strict().refine(hasSelector)
export type RunObservationTarget = z.infer<typeof runObservationTargetSchema>
export const runObservationCursorSchema = z
  .object({
    epoch: identity,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type RunObservationCursor = z.infer<typeof runObservationCursorSchema>
export const runObservationChangesRequestSchema = z
  .object({ ...targetFields, cursor: runObservationCursorSchema })
  .strict()
  .refine(hasSelector)
export type RunObservationChangesRequest = z.infer<typeof runObservationChangesRequestSchema>
export const runObservationSelectionRequestSchema = z
  .object({
    ...targetFields,
    cursor: runObservationCursorSchema,
    stepId: z.string().min(1).max(256)
  })
  .strict()
  .refine(hasSelector)
export type RunObservationSelectionRequest = z.infer<typeof runObservationSelectionRequestSchema>

export type RunObservationIdentity = Readonly<RunObservationTarget & { environmentId?: string }>
export type RunObservationPhase =
  | 'preparing'
  | 'queued'
  | 'running'
  | 'collecting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timeout'
export type RunObservationLog = Readonly<{ text: string; truncated: boolean; redacted: boolean }>
export type RunObservationRun = Readonly<{
  runId: string
  executionInvocationId?: string
  kernelKind: NotebookKernelKind
  status: NotebookRunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  logs: Readonly<{
    stdout: RunObservationLog
    stderr: RunObservationLog
    traceback: RunObservationLog
  }>
}>
export type RunObservationArtifact = Readonly<{
  artifactId?: string
  versionId: string
  name: string
  mimeType?: string
  producerRunId?: string
  checksum?: string
  sizeBytes?: number
}>
/** Main-admitted demo lifetime; the driver still owns whether its service stays alive. */
export const runObservationDemoViewingAdmissionSchema = z
  .object({
    mode: z.enum(['process-lifetime', 'until-stop-or-timeout']),
    timeoutMs: z.number().int().min(1000).max(600_000)
  })
  .strict()
export type RunObservationDemoViewingAdmission = z.infer<
  typeof runObservationDemoViewingAdmissionSchema
>
export const runObservationDemoViewingSchema = runObservationDemoViewingAdmissionSchema
  .extend({
    endReason: z
      .enum(['process-exited', 'time-limit', 'stopped', 'failed', 'interrupted'])
      .optional()
  })
  .strict()
export type RunObservationDemoViewing = z.infer<typeof runObservationDemoViewingSchema>

/** Recorded intent and declared condition differences, never scientific success or live authority. */
export const runObservationExecutionContextSchema = z
  .object({
    purpose: z.enum(['offline-demo', 'research', 'unknown']),
    profileName: z.string().max(160).optional(),
    conditionChanges: z.array(z.string().max(2048)).max(32),
    demoViewing: runObservationDemoViewingSchema.optional()
  })
  .strict()
  .refine((context) => context.demoViewing === undefined || context.purpose === 'offline-demo')
export type RunObservationExecutionContext = Readonly<
  Omit<z.infer<typeof runObservationExecutionContextSchema>, 'conditionChanges'> & {
    conditionChanges: readonly string[]
  }
>
/** Deliberately excludes source code, launch environment, local paths and live service URLs. */
export type RunObservationSnapshot = Readonly<{
  identity: RunObservationIdentity
  cursor: RunObservationCursor
  observedAt: number
  phase: RunObservationPhase
  stepId: string
  run: RunObservationRun | null
  artifacts: readonly RunObservationArtifact[]
  artifactsTruncated: boolean
  executionContext?: RunObservationExecutionContext
}>
export type RunObservationChange = Readonly<{
  cursor: RunObservationCursor
  observedAt: number
  identity?: RunObservationIdentity
  phase?: RunObservationPhase
  stepId?: string
  run?: RunObservationRun | null
  artifacts?: readonly RunObservationArtifact[]
  artifactsTruncated?: boolean
  executionContext?: RunObservationExecutionContext
}>
export type RunObservationChanges =
  | Readonly<{
      kind: 'delta'
      from: RunObservationCursor
      cursor: RunObservationCursor
      changes: readonly RunObservationChange[]
    }>
  | Readonly<{
      kind: 'resync'
      reason: 'epoch-changed' | 'cursor-expired' | 'cursor-ahead'
      snapshot: RunObservationSnapshot
    }>
/** This immutable projection is the evidence cutoff, not a pointer to the latest mutable Run. */
export type RunObservationSelection = Readonly<{
  selectionId: string
  identity: RunObservationIdentity
  cursor: RunObservationCursor
  stepId: string
  selectedAt: number
  snapshot: RunObservationSnapshot
}>
export type RunObservationHistory = Readonly<{
  coverage: 'process-local'
  /** True means older observed revisions have expired; false does not promise pre-observer history. */
  truncated: boolean
  snapshots: readonly RunObservationSnapshot[]
}>

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const logSchema = z
  .object({ text: z.string().max(65536), truncated: z.boolean(), redacted: z.boolean() })
  .strict()
export const runObservationIdentitySchema = z
  .object({ ...targetFields, environmentId: identity.optional() })
  .strict()
  .refine(hasSelector)
export const runObservationArtifactSchema = z
  .object({
    artifactId: identity.optional(),
    versionId: identity,
    name: z.string().max(512),
    mimeType: z.string().max(128).optional(),
    producerRunId: identity.optional(),
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sizeBytes: timestamp.optional()
  })
  .strict()
export const runObservationSnapshotSchema = z
  .object({
    identity: runObservationIdentitySchema,
    cursor: runObservationCursorSchema,
    observedAt: timestamp,
    phase: z.enum([
      'preparing',
      'queued',
      'running',
      'collecting',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'timeout'
    ]),
    stepId: z.string().min(1).max(256),
    run: z
      .object({
        runId: identity,
        executionInvocationId: identity.optional(),
        kernelKind: z.enum(['python', 'r', 'repl', 'bash']),
        status: z.enum([
          'queued',
          'running',
          'completed',
          'failed',
          'timeout',
          'interrupted',
          'cancelled'
        ]),
        startedAt: timestamp,
        endedAt: timestamp.optional(),
        exitCode: z.number().int().nullable().optional(),
        logs: z.object({ stdout: logSchema, stderr: logSchema, traceback: logSchema }).strict()
      })
      .strict()
      .nullable(),
    artifacts: z.array(runObservationArtifactSchema).max(1000),
    artifactsTruncated: z.boolean(),
    executionContext: runObservationExecutionContextSchema.optional()
  })
  .strict()
  .refine(
    (snapshot) =>
      !snapshot.run ||
      (snapshot.identity.runId === snapshot.run.runId &&
        snapshot.identity.executionInvocationId === snapshot.run.executionInvocationId)
  )

const sameExecution = (before: RunObservationIdentity, after: RunObservationIdentity): boolean =>
  before.projectId === after.projectId &&
  before.sessionId === after.sessionId &&
  (['operationId', 'executionInvocationId', 'runId', 'environmentId'] as const).every(
    (field) => !before[field] || before[field] === after[field]
  )

const sameCursor = (a: RunObservationCursor, b: RunObservationCursor): boolean =>
  a.epoch === b.epoch && a.sequence === b.sequence

/** Shared by browser and Electron adapters. Out-of-order delivery must trigger a fresh snapshot. */
export function applyRunObservationChanges(
  snapshot: RunObservationSnapshot,
  update: RunObservationChanges
): RunObservationSnapshot {
  if (update.kind === 'resync') {
    if (!sameExecution(snapshot.identity, update.snapshot.identity))
      throw new Error('Observation resync does not match the selected execution.')
    if (
      update.snapshot.cursor.epoch === snapshot.cursor.epoch &&
      update.snapshot.cursor.sequence < snapshot.cursor.sequence
    )
      return snapshot
    return update.snapshot
  }
  if (
    snapshot.cursor.epoch !== update.from.epoch ||
    update.from.sequence > snapshot.cursor.sequence
  )
    throw new Error('Observation changes do not follow the current cursor.')
  let result = snapshot
  let previous = update.from
  for (const change of update.changes) {
    if (change.cursor.epoch !== previous.epoch || change.cursor.sequence !== previous.sequence + 1)
      throw new Error('Observation changes contain a cursor gap.')
    previous = change.cursor
    if (change.cursor.sequence <= result.cursor.sequence) continue
    if (change.identity && !sameExecution(result.identity, change.identity))
      throw new Error('Observation changes do not match the selected execution.')
    result = { ...result, ...change }
  }
  if (!sameCursor(previous, update.cursor)) throw new Error('Observation changes are incomplete.')
  if (result !== snapshot) runObservationSnapshotSchema.parse(result)
  return result
}
