import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '@aipoch/durable-files'
import type { StartTaskRunRequest, TaskRun, TaskSubmission } from '../../shared/task-api'
import type { TaskRunJournalEntry } from './task-run-journal'
import { TaskRunnerError } from './task-runner'

const log = createLogger('task-submissions')

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const receiptSchema = z
  .object({
    requestId: requestIdSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['pending', 'accepted', 'failed', 'interrupted']),
    createdAt: z.number().finite(),
    runId: z.string().min(1).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional()
  })
  .passthrough()
  .superRefine((entry, context) => {
    if ((entry.status === 'accepted') !== (entry.runId !== undefined))
      context.addIssue({ code: 'custom', message: 'Invalid submission Run mapping.' })
  })
const documentSchema = z.object({ version: z.literal(1), submissions: z.array(receiptSchema) })
type Receipt = z.infer<typeof receiptSchema>

// JSON object property order is not request identity; array order remains significant.
const canonicalRequest = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalRequest)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, canonicalRequest(field)])
    )
  return value
}
const snapshot = (receipt: Receipt): TaskSubmission =>
  structuredClone({
    requestId: receipt.requestId,
    status: receipt.status,
    createdAt: receipt.createdAt,
    ...(receipt.runId ? { runId: receipt.runId } : {}),
    ...(receipt.error ? { error: receipt.error } : {})
  })

/** Local authenticated automation admission. Receipts outlive Run history pruning. */
export class TaskSubmissions {
  private readonly path: string
  private entries = new Map<string, Receipt>()
  private initialization?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private writeFailure: unknown

  constructor(
    configRoot: string,
    private readonly dependencies: {
      loadRuns(): Promise<TaskRunJournalEntry[]>
      startRun(request: StartTaskRunRequest, requestId: string): Promise<TaskRun>
      now?: () => number
      capacity?: number
    }
  ) {
    this.path = join(configRoot, 'task-submissions.json')
  }

  initialize(): Promise<void> {
    return (this.initialization ??= this.restore())
  }

  private async restore(): Promise<void> {
    const result = await readDurableJsonFile(this.path, (contents) => {
      const value = JSON.parse(contents)
      const parsed = documentSchema.safeParse(value)
      if (!parsed.success)
        throw new DurableJsonRecoveryBarrierError(
          'Invalid or unsupported submission journal. Preserve it for recovery.'
        )
      if (
        new Set(parsed.data.submissions.map(({ requestId }) => requestId)).size !==
        parsed.data.submissions.length
      )
        throw new DurableJsonRecoveryBarrierError('Duplicate submission identity.')
      return parsed.data.submissions
    })
    if (result.status !== 'found') return
    this.entries = new Map(result.value.map((entry) => [entry.requestId, entry]))
    if (![...this.entries.values()].some(({ status }) => status === 'pending')) return
    const runs = await this.dependencies.loadRuns()
    for (const entry of this.entries.values()) {
      if (entry.status !== 'pending') continue
      const matches = runs.filter(({ requestId }) => requestId === entry.requestId)
      if (matches.length > 1) throw new Error('Multiple Runs claim a submission identity.')
      if (matches[0]) {
        entry.status = 'accepted'
        entry.runId = matches[0].id
      } else {
        entry.status = 'interrupted'
        entry.error = {
          code: 'submission_interrupted',
          message: 'The service restarted during preparation. This request will not be replayed.'
        }
      }
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      await writeDurableJsonFile(
        this.path,
        JSON.stringify({ version: 1, submissions: [...this.entries.values()] })
      )
    } catch (error) {
      // An unsuccessful write can still have committed. Only restart recovery may resolve it.
      this.writeFailure = error
      throw error
    }
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = this.tail.then(async () => {
      await this.initialize()
      if (this.writeFailure)
        throw new TaskRunnerError(
          'submission_unavailable',
          'Submission storage needs recovery. Restart the service before retrying this request ID.'
        )
      return operation()
    })
    this.tail = next.catch(() => undefined)
    return next
  }

  async submit(requestId: string, request: StartTaskRunRequest): Promise<TaskSubmission> {
    if (!requestIdSchema.safeParse(requestId).success)
      throw new TaskRunnerError(
        'invalid_request',
        'Request ID must contain 1–128 letters, digits, underscores or hyphens.'
      )
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new TaskRunnerError('invalid_request', 'Run request must be an object.')
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonicalRequest(request)))
      .digest('hex')
    return this.serialize(async () => {
      if (this.stopped)
        throw new TaskRunnerError('submission_unavailable', 'The service is stopping.')
      const existing = this.entries.get(requestId)
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new TaskRunnerError(
            'submission_conflict',
            'This request ID was already used with different input.'
          )
        return snapshot(existing)
      }
      // Never silently evict a deduplication identity when Run history reaches its retention limit.
      if (this.entries.size >= (this.dependencies.capacity ?? 10_000))
        throw new TaskRunnerError(
          'submission_unavailable',
          'Submission receipt capacity is full; no task was started.'
        )
      const entry: Receipt = {
        requestId,
        fingerprint,
        status: 'pending',
        createdAt: (this.dependencies.now ?? Date.now)()
      }
      this.entries.set(requestId, entry)
      await this.persist()
      // Preparation is owned by the service, not by the lifetime of the HTTP response.
      void this.prepare(entry, structuredClone(request))
      return snapshot(entry)
    })
  }

  private async prepare(entry: Receipt, request: StartTaskRunRequest): Promise<void> {
    let run: TaskRun | undefined
    let failure: unknown
    try {
      run = await this.dependencies.startRun(request, entry.requestId)
    } catch (error) {
      failure = error
      log.error('Task submission preparation failed.', { requestId: entry.requestId, error })
    }
    try {
      await this.serialize(async () => {
        if (this.stopped) return
        if (run) {
          entry.status = 'accepted'
          entry.runId = run.id
        } else {
          entry.status = 'failed'
          entry.error =
            failure instanceof TaskRunnerError
              ? { code: failure.code, message: failure.message }
              : {
                  code: 'preparation_failed',
                  message: 'Run preparation failed. Inspect the service diagnostics.'
                }
        }
        await this.persist()
      })
    } catch (error) {
      log.error('Task submission receipt needs restart recovery.', {
        requestId: entry.requestId,
        runId: run?.id,
        error
      })
      // Keep the durable pending receipt and Run link for restart reconciliation. Never resubmit.
    }
  }

  get(requestId: string): Promise<TaskSubmission> {
    return this.serialize(async () => {
      const entry = this.entries.get(requestId)
      if (!entry)
        throw new TaskRunnerError('submission_not_found', `Submission not found: ${requestId}`)
      return snapshot(entry)
    })
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.tail
    // Pending preparation is reconciled on restart; shutdown must not wait for a provider.
  }
}
