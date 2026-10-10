import { createHash } from 'node:crypto'
import { readdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  researchDemoSourceSchema,
  researchDemoReferenceSchema,
  startResearchDemoSchema,
  type ResearchDemoSource,
  type ResearchDemoReceipt,
  type ResearchDemoHistory,
  type ResearchDemoInspection,
  researchDemoQuestionRequestSchema,
  type ResearchDemoQuestion
} from '../../shared/research-demo'
import {
  runObservationTargetSchema,
  runObservationDemoViewingAdmissionSchema,
  type RunObservationSelection
} from '../../shared/run-observation'
import { recordedObservationTargetSchema } from '../../shared/run-observation-recorded'
import type { RunObservationRecordingStatus } from '../../shared/run-observation-recording-status'
import type { ManagedExecutionService } from '../notebook/managed-execution-service'
import type { ManagedSessionCreationLookup } from '../session-persistence/create-managed-session'
import type { CallerContext } from '../caller-context'
import {
  createResearchMaterialInspectionAuthority,
  type ResearchMaterialAuthorityDependencies
} from '../notebook/research-material-authority'
import {
  readDurableJsonFile,
  writeDurableJsonFile,
  DurableJsonRecoveryBarrierError
} from '../storage/durable-json-file'
import { inspectResearchDemos, researchDemoCommand, type ResolvedResearchDemo } from './inspection'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const receiptSchema = z
  .object({
    source: researchDemoSourceSchema,
    requestId: identity,
    demoVersionId: identity,
    title: z.string().max(4096),
    substitutions: z.array(z.string().max(4096)).max(32),
    purpose: z.literal('offline-demo'),
    demoViewing: runObservationDemoViewingAdmissionSchema.optional(),
    sessionId: identity.optional(),
    operationRequestId: identity.optional(),
    runTarget: runObservationTargetSchema.optional(),
    recordingTarget: recordedObservationTargetSchema.optional(),
    state: z.enum([
      'preparing',
      'starting',
      'running',
      'saving',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'recovery-pending'
    ]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    errorCode: z
      .enum([
        'preparation-failed',
        'execution-failed',
        'recording-unavailable',
        'recovery-required'
      ])
      .optional(),
    recordingStatus: z.enum(['pending', 'saved', 'unavailable']).optional()
  })
  .strict()
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: digest,
    fingerprint: digest,
    sourceIdentity: z.string().max(4096),
    receipt: receiptSchema,
    environmentId: digest.optional(),
    operationId: identity.optional(),
    cancelled: z.boolean().optional(),
    cleanupPending: z.boolean().optional(),
    stateBeforeCleanup: receiptSchema.shape.state.optional()
  })
  .strict()
type Record = z.infer<typeof recordSchema>
const carrierSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: digest,
    source: researchDemoSourceSchema,
    generation: z.number().int().nonnegative(),
    sessionId: identity.optional()
  })
  .strict()
type Carrier = z.infer<typeof carrierSchema>
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceKey = (source: ResearchDemoSource): string =>
  hash([source.projectId, source.sourceSessionId, source.sourceImportId])
const recordKey = (source: ResearchDemoSource, requestId: string): string =>
  hash([sourceKey(source), requestId])
const terminal = (state: ResearchDemoReceipt['state']): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)

export type ResearchDemoService = Pick<
  ManagedExecutionService,
  | 'runtimes'
  | 'createSession'
  | 'prepare'
  | 'executeDemo'
  | 'getOperation'
  | 'waitOperation'
  | 'cancelOperation'
  | 'releaseEnvironment'
  | 'inspectExecution'
> & {
  recordingStatus(value: unknown): Promise<RunObservationRecordingStatus>
}

/** Ordinary-Session offline execution. Material admission, execution and publication stay with their
 * existing owners. No model, synthetic Session ID or renderer-provided command is involved. */
export class ResearchDemoOwner {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly active = new Map<
    string,
    { controller: AbortController; completion: Promise<void>; source: ResearchDemoSource }
  >()
  private readonly starting = new Set<{
    controller: AbortController
    completion: Promise<unknown>
    source: ResearchDemoSource
  }>()
  private closed = false
  constructor(
    private readonly dependencies: {
      dataRoot: string
      materials: ResearchMaterialAuthorityDependencies
      service: ResearchDemoService
      createCarrierSession?(request: unknown): ReturnType<ManagedExecutionService['createSession']>
      findCarrierSession?(request: {
        projectId: string
        requestId: string
      }): Promise<ManagedSessionCreationLookup | undefined>
      /** Track even admitted cleanup after hold; the caller gates new admission separately. */
      track?<T>(operation: () => Promise<T>): Promise<T>
      onCarrierCreated?(projectId: string, sessionId: string): Promise<void>
      readSelection?(
        viewerId: string,
        caller: CallerContext
      ): Promise<RunObservationSelection | null>
      findPreparedEnvironment?(scope: {
        projectId: string
        sessionId: string
        requestId: string
      }): Promise<{ environmentId: string } | undefined>
      sessionExists(projectId: string, sessionId: string): Promise<boolean>
      assertOpen(scope?: { projectId: string; sessionId: string }): void
    }
  ) {}

  private assertOpen(source?: ResearchDemoSource): void {
    if (this.closed) throw new Error('research-demo-unavailable')
    this.dependencies.assertOpen(
      source ? { projectId: source.projectId, sessionId: source.sourceSessionId } : undefined
    )
  }
  private tracked<T>(operation: () => Promise<T>): Promise<T> {
    return this.dependencies.track ? this.dependencies.track(operation) : operation()
  }
  private path(key: string): string {
    return join(this.dependencies.dataRoot, 'research-demos', 'runs', key + '.json')
  }
  private carrierPath(key: string): string {
    return join(this.dependencies.dataRoot, 'research-demos', 'carriers', key + '.json')
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(key, next)
    try {
      return await next
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }
  private async read(key: string): Promise<Record | undefined> {
    const read = await readDurableJsonFile(
      this.path(key),
      (text) => {
        const record = recordSchema.parse(JSON.parse(text))
        if (
          record.key !== key ||
          recordKey(record.receipt.source, record.receipt.requestId) !== key
        )
          throw new DurableJsonRecoveryBarrierError('Invalid demo execution identity.')
        return record
      },
      {},
      { maxBytes: 128 * 1024 }
    )
    return read.status === 'found' ? read.value : undefined
  }
  private async update(key: string, change: (record: Record) => void): Promise<Record> {
    return this.locked('record:' + key, async () => {
      const record = await this.read(key)
      if (!record) throw new Error('research-demo-not-found')
      const before = JSON.stringify(record)
      change(record)
      if (JSON.stringify(record) === before) return record
      record.receipt.updatedAt = Date.now()
      await writeDurableJsonFile(this.path(key), JSON.stringify(recordSchema.parse(record)))
      return record
    })
  }
  private async keys(kind: 'runs' | 'carriers'): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(join(this.dependencies.dataRoot, 'research-demos', kind))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (names.length > 10000) throw new Error('research-demo-history-limit')
    return names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5))
  }
  private async resolve(
    source: ResearchDemoSource,
    expectedSourceIdentity?: string,
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<typeof inspectResearchDemos>>> {
    this.assertOpen(source)
    const authority = await createResearchMaterialInspectionAuthority(this.dependencies.materials, {
      ...source,
      expectedSourceIdentity,
      signal
    })
    const runtimes = await this.dependencies.service.runtimes()
    const result = await inspectResearchDemos(source, authority, runtimes, signal)
    await createResearchMaterialInspectionAuthority(this.dependencies.materials, {
      ...source,
      expectedSourceIdentity: authority.source.identity,
      signal
    })
    this.assertOpen(source)
    return result
  }
  async inspect(value: unknown, signal?: AbortSignal): Promise<ResearchDemoInspection> {
    const source = researchDemoSourceSchema.parse(value)
    this.assertOpen(source)
    return this.tracked(async () => (await this.resolve(source, undefined, signal)).inspection)
  }
  private async readCarrier(key: string): Promise<Carrier | undefined> {
    const read = await readDurableJsonFile(
      this.carrierPath(key),
      (text) => {
        const carrier = carrierSchema.parse(JSON.parse(text))
        if (carrier.key !== key || sourceKey(carrier.source) !== key)
          throw new DurableJsonRecoveryBarrierError('Invalid demo storage identity.')
        return carrier
      },
      {},
      { maxBytes: 16384 }
    )
    return read.status === 'found' ? read.value : undefined
  }
  private async reconcileCarrier(carrier: Carrier): Promise<Carrier> {
    if (carrier.sessionId || !this.dependencies.findCarrierSession) return carrier
    const found = await this.dependencies.findCarrierSession({
      projectId: carrier.source.projectId,
      requestId: 'replay-demo-' + carrier.key + '-' + carrier.generation
    })
    if (!found) return carrier // No creation was admitted: recovery must not create one.
    const next =
      found.state === 'available'
        ? { ...carrier, sessionId: found.sessionId }
        : { ...carrier, generation: carrier.generation + 1 }
    await writeDurableJsonFile(
      this.carrierPath(carrier.key),
      JSON.stringify(carrierSchema.parse(next))
    )
    if (next.sessionId)
      await this.dependencies.onCarrierCreated?.(carrier.source.projectId, next.sessionId)
    return next
  }
  private async carrier(source: ResearchDemoSource): Promise<string> {
    const key = sourceKey(source)
    return this.locked('carrier:' + key, async () => {
      const stored = await this.readCarrier(key)
      const previous = stored ? await this.reconcileCarrier(stored) : undefined
      if (
        previous?.sessionId &&
        (await this.dependencies.sessionExists(source.projectId, previous.sessionId))
      )
        return previous.sessionId
      const generation = previous ? previous.generation + (previous.sessionId ? 1 : 0) : 0
      const receipt = carrierSchema.parse({ schemaVersion: 1, key, source, generation })
      // Creation intent precedes the existing idempotent ordinary-Session workflow.
      await writeDurableJsonFile(this.carrierPath(key), JSON.stringify(receipt))
      const create =
        this.dependencies.createCarrierSession ??
        this.dependencies.service.createSession.bind(this.dependencies.service)
      const created = await create({
        projectId: source.projectId,
        requestId: 'replay-demo-' + key + '-' + generation,
        title: 'Replay offline demonstrations'
      })
      await writeDurableJsonFile(
        this.carrierPath(key),
        JSON.stringify({ ...receipt, sessionId: created.sessionId })
      )
      await this.dependencies.onCarrierCreated?.(source.projectId, created.sessionId)
      return created.sessionId
    })
  }
  async carriers(
    value: unknown
  ): Promise<Array<{ sessionId: string; source: ResearchDemoSource }>> {
    this.assertOpen()
    return this.tracked(() => this.carriersInternal(value))
  }
  private async carriersInternal(
    value: unknown
  ): Promise<Array<{ sessionId: string; source: ResearchDemoSource }>> {
    const { projectId } = z.object({ projectId: identity }).strict().parse(value)
    const result: Array<{ sessionId: string; source: ResearchDemoSource }> = []
    for (const key of await this.keys('carriers')) {
      const carrier = await this.readCarrier(key)
      if (
        carrier?.source.projectId === projectId &&
        carrier.sessionId &&
        (await this.dependencies.sessionExists(projectId, carrier.sessionId))
      )
        result.push({ sessionId: carrier.sessionId, source: carrier.source })
    }
    return result
  }
  async list(value: unknown): Promise<ResearchDemoHistory> {
    const source = researchDemoSourceSchema.parse(value)
    this.assertOpen(source)
    return this.tracked(() => this.listInternal(source))
  }
  /** Immutable historical projection. Does not refresh execution, reconcile or repair journals. */
  async readHistory(value: unknown): Promise<ResearchDemoHistory> {
    const source = researchDemoSourceSchema.parse(value)
    this.assertOpen(source)
    return this.tracked(async () => {
      await createResearchMaterialInspectionAuthority(this.dependencies.materials, source)
      const receipts: ResearchDemoReceipt[] = []
      for (const key of await this.keys('runs')) {
        const record = await this.readHistoricalRecord(key)
        if (record && sourceKey(record.receipt.source) === sourceKey(source))
          receipts.push(record.receipt)
      }
      this.assertOpen(source)
      return { receipts: receipts.sort((a, b) => b.createdAt - a.createdAt) }
    })
  }
  async readReceipt(value: unknown): Promise<ResearchDemoReceipt> {
    const request = researchDemoReferenceSchema.parse(value)
    const source = researchDemoSourceSchema.parse({
      projectId: request.projectId,
      sourceSessionId: request.sourceSessionId,
      sourceImportId: request.sourceImportId
    })
    this.assertOpen(source)
    return this.tracked(async () => {
      await createResearchMaterialInspectionAuthority(this.dependencies.materials, source)
      const record = await this.readHistoricalRecord(recordKey(source, request.requestId))
      if (!record) throw new Error('research-demo-not-found')
      this.assertOpen(source)
      return record.receipt
    })
  }
  private async readHistoricalRecord(key: string): Promise<Record | undefined> {
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(this.path(key), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const limit = 128 * 1024
      if ((await file.stat()).size > limit) throw new Error('research-demo-history-limit')
      const bytes = Buffer.alloc(limit + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > limit) throw new Error('research-demo-history-limit')
      const record = recordSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')))
      if (record.key !== key || recordKey(record.receipt.source, record.receipt.requestId) !== key)
        throw new Error('research-demo-history-identity')
      return record
    } finally {
      await file.close()
    }
  }
  private async listInternal(value: unknown): Promise<ResearchDemoHistory> {
    const source = researchDemoSourceSchema.parse(value)
    await createResearchMaterialInspectionAuthority(this.dependencies.materials, source)
    const receipts: ResearchDemoReceipt[] = []
    for (const key of await this.keys('runs')) {
      const record = await this.read(key)
      if (record && sourceKey(record.receipt.source) === sourceKey(source))
        receipts.push((await this.refresh(record)).receipt)
    }
    const carrier = (await this.carriersInternal({ projectId: source.projectId })).find(
      (item) => sourceKey(item.source) === sourceKey(source)
    )
    return {
      receipts: receipts.sort((a, b) => b.createdAt - a.createdAt),
      ...(carrier ? { carrierSessionId: carrier.sessionId } : {})
    }
  }
  async start(value: unknown, signal?: AbortSignal): Promise<ResearchDemoReceipt> {
    this.assertOpen()
    const request = startResearchDemoSchema.parse(value)
    const source = researchDemoSourceSchema.parse({
      projectId: request.projectId,
      sourceSessionId: request.sourceSessionId,
      sourceImportId: request.sourceImportId
    })
    this.assertOpen(source)
    const controller = new AbortController()
    const admissionSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const completion = this.tracked(() =>
      this.locked('source:' + sourceKey(source), async () => {
        this.assertOpen(source)
        admissionSignal.throwIfAborted()
        const key = recordKey(source, request.requestId)
        const fingerprint = hash(request)
        const previous = await this.read(key)
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new Error('research-demo-request-conflict')
          return (await this.refresh(previous)).receipt
        }
        const history = await this.listInternal(source)
        if (
          history.receipts.some((receipt) => !terminal(receipt.state)) ||
          [...this.active.values()].some((entry) => sourceKey(entry.source) === sourceKey(source))
        )
          throw new Error('research-demo-already-running')
        const resolution = await this.resolve(
          source,
          request.expectedSourceIdentity,
          admissionSignal
        )
        const demo = resolution.resolved.find(
          (entry) => entry.candidate.demoVersionId === request.demoVersionId
        )
        if (demo?.candidate.status !== 'ready') throw new Error('research-demo-not-ready')
        const record: Record = {
          schemaVersion: 1,
          key,
          fingerprint,
          sourceIdentity: request.expectedSourceIdentity,
          receipt: {
            source,
            requestId: request.requestId,
            demoVersionId: request.demoVersionId,
            purpose: 'offline-demo',
            demoViewing: demo.candidate.demoViewing,
            title: demo.candidate.title,
            substitutions: demo.candidate.substitutions,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            state: 'preparing'
          }
        }
        admissionSignal.throwIfAborted()
        this.assertOpen(source)
        await writeDurableJsonFile(this.path(key), JSON.stringify(recordSchema.parse(record)))
        const completion = this.tracked(() => this.launch(record, demo, controller.signal)).finally(
          () => this.active.delete(key)
        )
        this.active.set(key, { controller, completion, source })
        // The Main owner retains this operation beyond the originating renderer's lifetime.
        void completion.catch(() => undefined)
        return structuredClone(record.receipt)
      })
    )
    const admission = { controller, completion, source }
    this.starting.add(admission)
    try {
      return await completion
    } finally {
      this.starting.delete(admission)
    }
  }
  private async launch(
    record: Record,
    selected: ResolvedResearchDemo,
    signal: AbortSignal
  ): Promise<void> {
    const { source } = record.receipt
    const service = this.dependencies.service
    try {
      signal.throwIfAborted()
      const sessionId = await this.carrier(source)
      record = await this.update(record.key, (next) => {
        next.receipt.sessionId = sessionId
      })
      signal.throwIfAborted()
      const resolution = await this.resolve(source, record.sourceIdentity, signal)
      const demo = resolution.resolved.find(
        (entry) => entry.candidate.demoVersionId === selected.candidate.demoVersionId
      )
      if (
        !demo?.description ||
        demo.candidate.status !== 'ready' ||
        !demo.descriptorVersionId ||
        !demo.runtimeId ||
        !demo.materialKeys ||
        !demo.materialVersions
      )
        throw new Error('research-demo-not-ready')
      const prepared = (await service.prepare(
        {
          projectId: source.projectId,
          sessionId,
          sourceSessionId: source.sourceSessionId,
          sourceIdentity: record.sourceIdentity,
          requestId: 'demo-prepare-' + record.key,
          runtimeId: demo.runtimeId,
          materials: {
            descriptorVersionId: demo.descriptorVersionId,
            materialKeys: demo.materialKeys,
            materialVersions: demo.materialVersions
          }
        },
        signal
      )) as { environmentId: string }
      record = await this.update(record.key, (next) => {
        next.environmentId = digest.parse(prepared.environmentId)
        next.receipt.state = 'starting'
      })
      signal.throwIfAborted()
      const operationRequestId = 'demo-execute-' + record.key
      record = await this.update(record.key, (next) => {
        next.receipt.operationRequestId = operationRequestId
      })
      const operation = await service.executeDemo(
        {
          projectId: source.projectId,
          sessionId,
          environmentId: prepared.environmentId,
          requestId: operationRequestId,
          command: researchDemoCommand(demo),
          timeoutMs: demo.description.timeoutMs,
          outputs: demo.description.outputs,
          localServicePort: demo.description.localServicePort,
          projectView: demo.description.projectView,
          recordObservation: true,
          description:
            'Start the selected Replay offline demonstration. This is not scientific reproduction.\n' +
            demo.description.substitutions.join('\n').slice(0, 15000)
        },
        {
          inputVersionIds: [record.receipt.demoVersionId],
          demoViewing: {
            mode: demo.description.viewing?.mode ?? 'process-lifetime',
            timeoutMs: demo.description.timeoutMs
          }
        }
      )
      record = await this.update(record.key, (next) => {
        next.operationId = operation.operationId
        next.receipt.runTarget = {
          projectId: source.projectId,
          sessionId,
          operationId: operation.operationId
        }
        next.receipt.state = 'running'
      })
      if (signal.aborted || record.cancelled)
        await service.cancelOperation({
          projectId: source.projectId,
          sessionId,
          requestId: operationRequestId
        })
      for (;;) {
        const current = await service.waitOperation({
          projectId: source.projectId,
          sessionId,
          requestId: operationRequestId,
          timeoutMs: 1000
        })
        if (!current) throw new Error('research-demo-operation-unavailable')
        record = await this.refresh((await this.read(record.key))!)
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) break
      }
    } catch {
      record = await this.update(record.key, (next) => {
        next.receipt.state = signal.aborted || next.cancelled ? 'cancelled' : 'failed'
        if (!signal.aborted && !next.cancelled)
          next.receipt.errorCode = next.operationId ? 'execution-failed' : 'preparation-failed'
      })
    } finally {
      // Prepare may have committed before a lost reply or a failed owner-journal write.
      await this.cleanup((await this.read(record.key)) ?? record)
    }
  }
  private async cleanup(record: Record): Promise<void> {
    if (!record.receipt.sessionId) return
    try {
      if (!record.environmentId) {
        const found = await this.dependencies.findPreparedEnvironment?.({
          projectId: record.receipt.source.projectId,
          sessionId: record.receipt.sessionId,
          requestId: 'demo-prepare-' + record.key
        })
        if (found)
          record = await this.update(record.key, (next) => {
            next.environmentId = digest.parse(found.environmentId)
          })
      }
      if (record.environmentId) {
        const released = (await this.dependencies.service.releaseEnvironment({
          projectId: record.receipt.source.projectId,
          sessionId: record.receipt.sessionId!,
          environmentId: record.environmentId
        })) as { state?: string }
        if (released?.state !== 'released') throw new Error('research-demo-cleanup-pending')
      }
      if (record.cleanupPending)
        await this.update(record.key, (next) => {
          next.receipt.state = next.stateBeforeCleanup ?? 'interrupted'
          delete next.cleanupPending
          delete next.stateBeforeCleanup
          if (next.receipt.errorCode === 'recovery-required') delete next.receipt.errorCode
        })
    } catch {
      await this.update(record.key, (next) => {
        next.cleanupPending = true
        if (next.receipt.state !== 'recovery-pending') next.stateBeforeCleanup = next.receipt.state
        next.receipt.state = 'recovery-pending'
        next.receipt.errorCode = 'recovery-required'
      })
    }
  }
  private async refresh(record: Record): Promise<Record> {
    if (!record.receipt.sessionId || !record.receipt.operationRequestId) return record
    const service = this.dependencies.service
    const scope = {
      projectId: record.receipt.source.projectId,
      sessionId: record.receipt.sessionId,
      requestId: record.receipt.operationRequestId
    }
    const operation = await service.getOperation(scope)
    if (!operation) return record
    const target = {
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      operationId: operation.operationId
    }
    const execution = await service.inspectExecution(target)
    const recording = execution
      ? await service.recordingStatus(target).catch(() => undefined)
      : undefined
    return this.update(record.key, (next) => {
      next.operationId = operation.operationId
      next.receipt.runTarget = execution
        ? {
            ...target,
            executionInvocationId: execution.identity.executionInvocationId,
            ...(execution.identity.runId ? { runId: execution.identity.runId } : {})
          }
        : target
      if (next.cleanupPending || operation.recoveryPending) {
        next.receipt.state = 'recovery-pending'
        next.receipt.errorCode = 'recovery-required'
      } else if (['completed', 'failed', 'cancelled', 'interrupted'].includes(operation.status)) {
        next.receipt.state = operation.status as ResearchDemoReceipt['state']
        if (operation.status === 'failed') next.receipt.errorCode = 'execution-failed'
      } else next.receipt.state = execution?.run?.endedAt ? 'saving' : 'running'
      if (recording?.archive) {
        next.receipt.recordingTarget = recording.archive
        next.receipt.recordingStatus = 'saved'
      } else next.receipt.recordingStatus = terminal(next.receipt.state) ? 'unavailable' : 'pending'
    })
  }
  async get(value: unknown): Promise<ResearchDemoReceipt> {
    this.assertOpen()
    return this.tracked(() => this.getInternal(value))
  }
  private async getInternal(value: unknown): Promise<ResearchDemoReceipt> {
    const request = researchDemoReferenceSchema.parse(value)
    const record = await this.read(recordKey(request, request.requestId))
    if (!record) throw new Error('research-demo-not-found')
    return (await this.refresh(record)).receipt
  }
  async question(value: unknown, caller: CallerContext): Promise<ResearchDemoQuestion> {
    this.assertOpen()
    return this.tracked(() => this.questionInternal(value, caller))
  }
  private async questionInternal(
    value: unknown,
    caller: CallerContext
  ): Promise<ResearchDemoQuestion> {
    const request = researchDemoQuestionRequestSchema.parse(value)
    const record = await this.read(recordKey(request, request.requestId))
    if (!record?.operationId || !record.receipt.sessionId || !this.dependencies.readSelection)
      throw new Error('research-demo-selection-unavailable')
    await createResearchMaterialInspectionAuthority(this.dependencies.materials, {
      ...record.receipt.source,
      expectedSourceIdentity: record.sourceIdentity
    })
    if (
      request.destinationSessionId &&
      !(await this.dependencies.sessionExists(request.projectId, request.destinationSessionId))
    )
      throw new Error('research-demo-destination-unavailable')
    const selection = await this.dependencies.readSelection(request.viewerId, caller)
    if (
      !selection ||
      selection.selectionId !== request.selectionId ||
      selection.identity.projectId !== request.projectId ||
      selection.identity.sessionId !== record.receipt.sessionId ||
      selection.identity.operationId !== record.operationId
    )
      throw new Error('research-demo-selection-unavailable')
    this.assertOpen()
    if (!caller.isAuthorizationCurrent()) throw new Error('research-demo-unauthorized')
    return {
      selection,
      source: record.receipt.source,
      requestId: request.requestId,
      purpose: 'offline-demo',
      destination: {
        projectId: request.projectId,
        ...(request.destinationSessionId ? { sessionId: request.destinationSessionId } : {})
      }
    }
  }
  async stop(value: unknown): Promise<ResearchDemoReceipt> {
    this.assertOpen()
    return this.tracked(() => this.stopInternal(value))
  }
  private async stopInternal(value: unknown): Promise<ResearchDemoReceipt> {
    const request = researchDemoReferenceSchema.parse(value)
    const key = recordKey(request, request.requestId)
    const record = await this.update(key, (next) => {
      next.cancelled = true
    })
    this.active.get(key)?.controller.abort()
    if (record.receipt.sessionId && record.receipt.operationRequestId)
      await this.dependencies.service.cancelOperation({
        projectId: request.projectId,
        sessionId: record.receipt.sessionId,
        requestId: record.receipt.operationRequestId
      })
    return (await this.refresh(record)).receipt
  }
  async stopScope(scope?: { projectId: string; sessionId?: string }): Promise<void> {
    // A carrier can have committed before its ID reaches the per-run receipt. Resolve its
    // durable ownership too, so deleting that Session still joins the admitted launch.
    const matches = async (source: ResearchDemoSource, sessionId?: string): Promise<boolean> => {
      if (!scope) return true
      if (source.projectId !== scope.projectId) return false
      if (
        !scope.sessionId ||
        source.sourceSessionId === scope.sessionId ||
        sessionId === scope.sessionId
      )
        return true
      return (await this.readCarrier(sourceKey(source)))?.sessionId === scope.sessionId
    }
    const starting = [] as Array<typeof this.starting extends Set<infer Entry> ? Entry : never>
    for (const entry of this.starting) if (await matches(entry.source)) starting.push(entry)
    for (const entry of starting) entry.controller.abort()
    await Promise.allSettled(starting.map((entry) => entry.completion))
    const pending = [...this.active.entries()]
    const completions: Promise<void>[] = []
    for (const [key, entry] of pending) {
      const record = await this.read(key)
      if (!(await matches(entry.source, record?.receipt.sessionId))) continue
      entry.controller.abort()
      if (record?.receipt.sessionId && record.receipt.operationRequestId)
        await this.dependencies.service.cancelOperation({
          projectId: entry.source.projectId,
          sessionId: record.receipt.sessionId,
          requestId: record.receipt.operationRequestId
        })
      completions.push(entry.completion)
    }
    await Promise.allSettled(completions)
  }
  async recover(): Promise<void> {
    await this.tracked(async () => {
      for (const key of await this.keys('carriers')) {
        await this.locked('carrier:' + key, async () => {
          const carrier = await this.readCarrier(key)
          if (carrier) await this.reconcileCarrier(carrier)
        })
      }
      for (const key of await this.keys('runs')) {
        const record = await this.read(key)
        if (!record || this.active.has(key)) continue
        let refreshed = await this.refresh(record)
        if (
          !refreshed.operationId &&
          !terminal(refreshed.receipt.state) &&
          !refreshed.cleanupPending
        )
          refreshed = await this.update(key, (next) => {
            next.receipt.state = 'interrupted'
            next.receipt.errorCode = 'recovery-required'
          })
        if (terminal(refreshed.receipt.state) || refreshed.receipt.state === 'recovery-pending')
          await this.cleanup(refreshed)
      }
    })
  }
  async close(): Promise<void> {
    this.closed = true
    await this.stopScope()
  }
}
