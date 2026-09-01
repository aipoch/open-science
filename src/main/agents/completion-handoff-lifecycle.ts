// Durable, application-owned lifecycle for a completion captured after an approved specialist
// switch. The lifecycle intentionally has no renderer dependency: only its repository state and
// provider-facing runtime requests decide whether an old prompt can resume.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'

import type {
  CompletionDisposition,
  CompletionGateRuntime,
  ToolCompletionEnvelope,
  TrustedToolCompletionContext
} from './completion-gate'
import { completionHandoffKey } from './completion-gate'
import type { ApprovedSwitchReadback } from '../../shared/agents-contract'
import type {
  CompletionHandoffLifecycleEvent,
  CompletionHandoffPhase,
  CompletionHandoffRetryFrom
} from '../../shared/specialist'
import type { HandoffApprovalContext } from '../../shared/handoff-lifecycle'

export type CompletionHandoffStage = CompletionHandoffPhase
export type CompletionHandoffRetryStage = CompletionHandoffRetryFrom

export type CompletionHandoffProvenance = {
  originatingTurnId: string
  originatingUserMessageId?: string
  attachmentIds: string[]
  artifactIds: string[]
}

export type CompletionHandoffContinuation = {
  outcome: string
  switchReadback?: ApprovedSwitchReadback
}

export type DurableCompletionHandoff = {
  id: string
  context: TrustedToolCompletionContext
  targetName: string | null
  approvedSpecialistId?: string
  approvedSpecialistRevision?: number
  generation: number
  sequence: number
  commitOrder?: number
  observedAt: number
  provenance: CompletionHandoffProvenance
  stage: CompletionHandoffStage
  envelope?: ToolCompletionEnvelope
  retryFrom?: CompletionHandoffRetryStage
  cancelled: boolean
  failureMessage?: string
  continuation?: CompletionHandoffContinuation
}

// Renderer adapters consume this projection as read-only data. The lifecycle owns the durable
// authority; this shape merely prevents every adapter from inventing a subtly different mapping.
export const toCompletionHandoffLifecycleEvent = (
  handoff: DurableCompletionHandoff
): CompletionHandoffLifecycleEvent => ({
  id: handoff.id,
  sessionId: handoff.context.sessionId,
  sequence: handoff.sequence,
  ...(handoff.commitOrder !== undefined ? { commitOrder: handoff.commitOrder } : {}),
  observedAt: handoff.observedAt,
  phase: handoff.stage,
  target: handoff.targetName,
  provenance: handoff.provenance,
  ...(handoff.continuation
    ? { continuation: toRendererSafeContinuation(handoff.continuation) }
    : {}),
  ...(handoff.stage === 'failed' && handoff.retryFrom && handoff.failureMessage
    ? { failure: { retryFrom: handoff.retryFrom, message: handoff.failureMessage } }
    : {})
})

const toRendererSafeContinuation = (
  continuation: CompletionHandoffContinuation
): CompletionHandoffLifecycleEvent['continuation'] => {
  if (!continuation.switchReadback) return { outcome: continuation.outcome }
  const binding = continuation.switchReadback.binding
  const safeBinding = {
    sessionId: binding.sessionId,
    targetName: binding.targetName,
    ...(binding.revision !== undefined ? { revision: binding.revision } : {})
  }
  return {
    outcome: continuation.outcome,
    switchReadback: {
      ...continuation.switchReadback,
      binding: safeBinding
    }
  }
}

export type CompletionHandoffRepository = {
  get(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff | undefined>
  save(handoff: DurableCompletionHandoff): Promise<void>
  update(
    context: TrustedToolCompletionContext,
    updater: (current: DurableCompletionHandoff | undefined) => DurableCompletionHandoff | undefined
  ): Promise<DurableCompletionHandoff | undefined>
  remove(context: TrustedToolCompletionContext): Promise<void>
  list(): Promise<DurableCompletionHandoff[]>
}

// This test/adapter-friendly repository defines the lifecycle's storage boundary. Production wiring
// supplies durable session-backed storage; keeping it separate makes restart recovery testable
// without a renderer, timer, or provider acknowledgement shortcut.
export class InMemoryCompletionHandoffRepository implements CompletionHandoffRepository {
  private readonly handoffs = new Map<string, DurableCompletionHandoff>()
  private commitSequence = 0

  async get(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff | undefined> {
    const handoff = this.handoffs.get(completionHandoffKey(context))
    return handoff ? clone(handoff) : undefined
  }

  async save(handoff: DurableCompletionHandoff): Promise<void> {
    const committed = this.assignCommitOrder(handoff)
    this.handoffs.set(completionHandoffKey(handoff.context), clone(committed))
  }

  async update(
    context: TrustedToolCompletionContext,
    updater: (current: DurableCompletionHandoff | undefined) => DurableCompletionHandoff | undefined
  ): Promise<DurableCompletionHandoff | undefined> {
    const key = completionHandoffKey(context)
    const current = this.handoffs.has(key) ? clone(this.handoffs.get(key)!) : undefined
    const next = updater(current)
    if (!next || next === current) return next ? clone(next) : undefined
    const committed = this.assignCommitOrder(next)
    this.handoffs.set(key, clone(committed))
    return clone(committed)
  }

  async remove(context: TrustedToolCompletionContext): Promise<void> {
    this.handoffs.delete(completionHandoffKey(context))
  }

  async list(): Promise<DurableCompletionHandoff[]> {
    return [...this.handoffs.values()].map(clone)
  }

  private assignCommitOrder(handoff: DurableCompletionHandoff): DurableCompletionHandoff {
    this.commitSequence = Math.max(this.commitSequence, handoff.commitOrder ?? 0) + 1
    return { ...handoff, commitOrder: this.commitSequence }
  }
}

// Binary V8 records retain the captured envelope's runtime values (including Errors and bigint),
// unlike JSON's lossy representation. Each replacement is atomic, so a process interruption leaves
// either the old valid lifecycle record or the new valid lifecycle record -- never a partial handoff
// that could be interpreted as permission to revive the old prompt.
export class FileCompletionHandoffRepository implements CompletionHandoffRepository {
  private writeQueue: Promise<void> = Promise.resolve()
  private writeSequence = 0
  private commitSequence: number | undefined

  constructor(private readonly storageDir: string) {}

  async get(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff | undefined> {
    await this.writeQueue
    return this.read(context)
  }

  private async read(
    context: TrustedToolCompletionContext
  ): Promise<DurableCompletionHandoff | undefined> {
    try {
      return parseHandoff(await readFile(this.filePath(context)))
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async save(handoff: DurableCompletionHandoff): Promise<void> {
    const record = clone(handoff)
    const write = this.writeQueue.then(() => this.write(record)).then(() => undefined)
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  async update(
    context: TrustedToolCompletionContext,
    updater: (current: DurableCompletionHandoff | undefined) => DurableCompletionHandoff | undefined
  ): Promise<DurableCompletionHandoff | undefined> {
    let result: DurableCompletionHandoff | undefined
    const operation = this.writeQueue.then(async () => {
      const current = await this.read(context)
      const editable = current ? clone(current) : undefined
      const next = updater(editable)
      if (next) {
        if (next === editable) {
          result = clone(next)
        } else {
          result = clone(await this.write(next))
        }
      }
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
    return result
  }

  async remove(context: TrustedToolCompletionContext): Promise<void> {
    const operation = this.writeQueue.then(() => rm(this.filePath(context), { force: true }))
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }

  private async write(handoff: DurableCompletionHandoff): Promise<DurableCompletionHandoff> {
    await mkdir(this.handoffsDir, { recursive: true })
    const committed = { ...handoff, commitOrder: await this.nextCommitOrder() }
    const destination = this.filePath(committed.context)
    const temporary = `${destination}.${this.writeSequence++}.tmp`
    await writeFile(temporary, serialize(committed))
    await rename(temporary, destination)
    return committed
  }

  private async nextCommitOrder(): Promise<number> {
    if (this.commitSequence === undefined) {
      let names: string[] = []
      try {
        names = await readdir(this.handoffsDir)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.bin'))
          .map(async (name) => parseHandoff(await readFile(join(this.handoffsDir, name))))
      )
      this.commitSequence = records.reduce(
        (maximum, record) => Math.max(maximum, record.commitOrder ?? 0),
        0
      )
    }
    this.commitSequence += 1
    return this.commitSequence
  }

  async list(): Promise<DurableCompletionHandoff[]> {
    await this.writeQueue
    let names: string[]
    try {
      names = await readdir(this.handoffsDir)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith('.bin'))
        .map(async (name) => parseHandoff(await readFile(join(this.handoffsDir, name))))
    )
  }

  private get handoffsDir(): string {
    return join(this.storageDir, 'completion-handoffs')
  }

  private filePath(context: TrustedToolCompletionContext): string {
    return join(
      this.handoffsDir,
      `${Buffer.from(completionHandoffKey(context)).toString('base64url')}.bin`
    )
  }
}

export type CompletionHandoffRuntime = CompletionGateRuntime

export type ApproveCompletionHandoff = {
  context: TrustedToolCompletionContext
  targetName: string | null
  generation: number
  provenance?: Omit<CompletionHandoffProvenance, 'originatingTurnId'>
  continuation?: CompletionHandoffContinuation
}

export type ApprovedSpecialistIdentity = {
  specialistId: string
  revision: number
}

export class CompletionHandoffLifecycle {
  private readonly retryLifecycles = new Map<string, Promise<DurableCompletionHandoff>>()

  constructor(
    private readonly repository: CompletionHandoffRepository,
    private readonly runtime: CompletionHandoffRuntime,
    private readonly now: () => number = Date.now,
    private readonly onEvent?: (event: CompletionHandoffLifecycleEvent) => void,
    private readonly resolveApprovedSpecialist?: (
      input: ApproveCompletionHandoff
    ) => Promise<ApprovedSpecialistIdentity | undefined>
  ) {}

  // Called only after the switch operation has durably committed its binding. An unapproved
  // cancellation never writes a record, while an approved cancellation leaves this target binding
  // authoritative and makes the lifecycle fail closed.
  async approve(input: ApproveCompletionHandoff): Promise<DurableCompletionHandoff> {
    const identity =
      input.targetName === null ? undefined : await this.resolveApprovedSpecialist?.(input)
    if (input.targetName !== null && this.resolveApprovedSpecialist && !identity) {
      throw new Error('The approved Specialist identity could not be resolved.')
    }
    const saved = await this.repository.update(input.context, (existing) => {
      if (existing && existing.generation >= input.generation) return existing
      return this.observe({
        id: handoffId(input.context),
        context: input.context,
        targetName: input.targetName,
        ...(identity
          ? {
              approvedSpecialistId: identity.specialistId,
              approvedSpecialistRevision: identity.revision
            }
          : {}),
        generation: input.generation,
        sequence: existing?.sequence ?? 0,
        observedAt: existing?.observedAt ?? 0,
        provenance: {
          originatingTurnId: input.context.originatingTurnId ?? input.context.turnId,
          originatingUserMessageId: input.provenance?.originatingUserMessageId,
          attachmentIds: input.provenance?.attachmentIds ?? [],
          artifactIds: input.provenance?.artifactIds ?? []
        },
        stage: 'awaiting-approval',
        cancelled: false,
        ...(input.continuation ? { continuation: input.continuation } : {})
      })
    })
    if (!saved) throw new Error('Failed to persist approved completion handoff.')
    this.emit(saved)
    return saved
  }

  // Starts the durable renderer projection before the permission card is shown. It deliberately
  // does not arm a completion or resolve an approved Specialist identity; those happen only after
  // the renderer explicitly approves and the SwitchOperation commits its binding.
  async onAwaitingApproval(context: HandoffApprovalContext): Promise<void> {
    const trusted = approvalContextToTrustedContext(context)
    const saved = await this.repository.update(trusted, (existing) => {
      if (existing) return existing
      return this.observe({
        id: handoffId(trusted),
        context: trusted,
        targetName: context.target.kind === 'specialist' ? context.target.name : null,
        generation: 0,
        sequence: 0,
        observedAt: 0,
        provenance: {
          originatingTurnId: context.originatingTurnId,
          originatingUserMessageId: context.originatingUserMessageId,
          attachmentIds: context.attachmentIds,
          artifactIds: context.artifactIds
        },
        stage: 'awaiting-approval',
        cancelled: false
      })
    })
    if (saved) this.emit(saved)
  }

  // A rejected, cancelled, or failed approval has no committed binding and must leave no durable
  // handoff to recover or render. Approval success is retained for approve() to atomically upgrade.
  async settleApproval(context: HandoffApprovalContext, approved: boolean): Promise<void> {
    if (approved) return
    const trusted = approvalContextToTrustedContext(context)
    const pending = await this.repository.get(trusted)
    if (!pending || pending.stage !== 'awaiting-approval' || pending.generation !== 0) return
    await this.repository.remove(trusted)
    this.emit(pending, true)
  }

  // Capturing occurs before the old-prompt tool-result callback. The envelope remains in
  // application-owned storage and is never handed back to that callback after this point.
  async capture(
    context: TrustedToolCompletionContext,
    envelope: ToolCompletionEnvelope
  ): Promise<DurableCompletionHandoff> {
    const captured = await this.repository.update(context, (current) => {
      if (!current) return undefined
      if (current.envelope) return current
      return this.observe({
        ...current,
        envelope,
        stage: current.cancelled ? 'failed' : 'switching',
        ...(current.cancelled ? { retryFrom: 'switching' as const } : {})
      })
    })
    if (!captured) throw new Error('No approved completion handoff exists for this invocation.')
    this.emit(captured)
    return captured
  }

  // Cancellation is intentionally not a rollback. Once approved, the durable binding remains and
  // no old identity is eligible to receive a completion. A caller can later retry from the saved
  // safe stage if its product policy permits it.
  async cancel(context: TrustedToolCompletionContext): Promise<void> {
    const cancelled = await this.repository.update(context, (current) => {
      if (!current || current.stage === 'continued') return current
      return this.observe({
        ...current,
        stage: 'failed',
        cancelled: true,
        retryFrom: current.envelope ? stageFor(current) : 'switching',
        failureMessage: 'Approved handoff generation was cancelled.'
      })
    })
    if (cancelled) this.emit(cancelled)
  }

  async run(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff> {
    const handoff = await this.require(context)
    if (handoff.cancelled || handoff.stage === 'failed' || handoff.stage === 'continued') {
      return handoff
    }
    if (!handoff.envelope) {
      return this.fail(handoff, 'switching', new Error('Completion capture was interrupted.'))
    }

    if (handoff.stage === 'awaiting-approval' || handoff.stage === 'switching') {
      const switching = await this.saveStage(handoff, 'switching')
      if (switching.cancelled || switching.stage === 'failed') return switching
      try {
        await this.runtime.stopOldPrompt(switching.context)
        await this.runtime.waitForOwnershipRelease(switching.context)
      } catch (error) {
        return this.fail(switching, 'switching', error)
      }
      const current = await this.require(context)
      if (current.cancelled || current.stage === 'failed') return current
      return this.runReconfigure(current)
    }

    if (handoff.stage === 'continuation-start') return this.runContinuation(handoff)
    return this.runReconfigure(handoff)
  }

  // Retrying never asks the user to approve the same committed binding again. It resumes at the
  // earliest safe stage recorded by the failed attempt: reconfigure after ownership was released,
  // otherwise the approved continuation start.
  retry(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff> {
    const key = completionHandoffKey(context)
    const existing = this.retryLifecycles.get(key)
    if (existing) return existing

    const retry = this.retryOnce(context).finally(() => {
      if (this.retryLifecycles.get(key) === retry) this.retryLifecycles.delete(key)
    })
    this.retryLifecycles.set(key, retry)
    return retry
  }

  private async retryOnce(
    context: TrustedToolCompletionContext
  ): Promise<DurableCompletionHandoff> {
    const handoff = await this.require(context)
    if (handoff.stage !== 'failed' || !handoff.retryFrom) return handoff
    const resumed = await this.repository.update(context, (current) => {
      if (
        !current ||
        current.generation !== handoff.generation ||
        current.sequence !== handoff.sequence ||
        current.stage !== 'failed' ||
        !current.retryFrom
      ) {
        return current
      }
      return this.observe({
        ...current,
        stage: current.retryFrom,
        cancelled: false,
        retryFrom: undefined,
        failureMessage: undefined
      })
    })
    if (!resumed) throw new Error('Approved completion handoff disappeared during retry.')
    this.emit(resumed)
    return this.run(context)
  }

  // A generation-zero awaiting record exists only while the approval card is unresolved: it has no
  // committed binding and must not survive a restart as a retryable handoff. Approved generations
  // remain fail-closed and recover through their durable ownership path.
  async recover(): Promise<DurableCompletionHandoff[]> {
    const handoffs = await this.repository.list()
    const recovered = await Promise.all(
      handoffs.map(async (handoff) => {
        if (handoff.generation === 0 && handoff.stage === 'awaiting-approval') {
          await this.repository.remove(handoff.context)
          this.emit(handoff, true)
          return undefined
        }
        if (handoff.stage === 'continued' || handoff.cancelled) return handoff
        if (handoff.stage === 'failed') {
          if (!handoff.retryFrom) return handoff
          return this.retry(handoff.context)
        }
        return this.run(handoff.context)
      })
    )
    return recovered.filter((handoff): handoff is DurableCompletionHandoff => handoff !== undefined)
  }

  private async runReconfigure(
    handoff: DurableCompletionHandoff
  ): Promise<DurableCompletionHandoff> {
    const reconfiguring = await this.saveStage(handoff, 'reconfiguring')
    if (reconfiguring.cancelled || reconfiguring.stage === 'failed') return reconfiguring
    try {
      await this.runtime.reconfigure(asCapturedDisposition(reconfiguring), reconfiguring.context)
    } catch (error) {
      return this.fail(reconfiguring, 'reconfiguring', error)
    }

    const current = await this.require(handoff.context)
    if (current.cancelled || current.stage === 'failed') return current
    const continuing = await this.saveStage(current, 'continuation-start')
    return this.runContinuation(continuing)
  }

  private async runContinuation(
    handoff: DurableCompletionHandoff
  ): Promise<DurableCompletionHandoff> {
    const continuing = await this.saveStage(handoff, 'continuation-start')
    if (continuing.cancelled || continuing.stage === 'failed') return continuing
    try {
      const disposition = asCapturedDisposition(continuing)
      await this.runtime.continueAsApproved(
        disposition,
        continuing.context,
        disposition.continuationContext
      )
      return this.saveStage(
        {
          ...continuing,
          continuation: { ...continuing.continuation, outcome: 'continued' }
        },
        'continued'
      )
    } catch (error) {
      return this.fail(continuing, 'continuation-start', error)
    }
  }

  private async saveStage(
    handoff: DurableCompletionHandoff,
    stage: CompletionHandoffStage
  ): Promise<DurableCompletionHandoff> {
    const next = await this.repository.update(handoff.context, (current) => {
      if (
        !current ||
        current.generation !== handoff.generation ||
        current.sequence !== handoff.sequence
      ) {
        return current
      }
      return this.observe({ ...current, ...handoff, stage })
    })
    if (!next) throw new Error('Approved completion handoff disappeared during transition.')
    this.emit(next)
    return next
  }

  private async fail(
    handoff: DurableCompletionHandoff,
    retryFrom: CompletionHandoffRetryStage,
    error: unknown
  ): Promise<DurableCompletionHandoff> {
    const failed = await this.repository.update(handoff.context, (current) => {
      if (
        !current ||
        current.generation !== handoff.generation ||
        current.sequence !== handoff.sequence
      ) {
        return current
      }
      return this.observe({
        ...current,
        stage: 'failed',
        retryFrom,
        failureMessage: failureMessageFor(retryFrom)
      })
    })
    if (!failed) throw new Error('Approved completion handoff disappeared while failing closed.')
    this.emit(failed)
    try {
      await this.runtime.reportHandoffFailure(error, asCapturedDisposition(failed), failed.context)
    } catch {
      // Reporting belongs to the approved ownership path too. Never use a reporting failure to
      // re-open the old prompt's completion route.
    }
    return failed
  }

  private async require(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff> {
    const handoff = await this.repository.get(context)
    if (!handoff) throw new Error('No approved completion handoff exists for this invocation.')
    return handoff
  }

  private observe(handoff: DurableCompletionHandoff): DurableCompletionHandoff {
    return { ...handoff, sequence: handoff.sequence + 1, observedAt: this.now() }
  }

  async getEvents(sessionId: string): Promise<CompletionHandoffLifecycleEvent[]> {
    return (await this.repository.list())
      .filter((handoff) => handoff.context.sessionId === sessionId)
      .map(toCompletionHandoffLifecycleEvent)
      .sort(
        (left, right) =>
          compareCommitOrder(left, right) ||
          left.sequence - right.sequence ||
          left.id.localeCompare(right.id)
      )
  }

  async retryById(id: string, sessionId: string): Promise<DurableCompletionHandoff | undefined> {
    const handoff = await this.findById(id, sessionId)
    return handoff ? this.retry(handoff.context) : undefined
  }

  async cancelById(id: string, sessionId: string): Promise<void> {
    const handoff = await this.findById(id, sessionId)
    if (handoff) await this.cancel(handoff.context)
  }

  async cancelSession(sessionId: string): Promise<void> {
    const handoffs = (await this.repository.list()).filter(
      (handoff) => handoff.context.sessionId === sessionId && handoff.stage !== 'continued'
    )
    await Promise.all(handoffs.map((handoff) => this.cancel(handoff.context)))
  }

  private async findById(
    id: string,
    sessionId: string
  ): Promise<DurableCompletionHandoff | undefined> {
    return (await this.repository.list()).find(
      (handoff) => handoff.id === id && handoff.context.sessionId === sessionId
    )
  }

  private emit(handoff: DurableCompletionHandoff, removed = false): void {
    try {
      const event = toCompletionHandoffLifecycleEvent(handoff)
      this.onEvent?.(removed ? { ...event, removed: true } : event)
    } catch {
      // Renderer projection is best-effort and never participates in handoff authority.
    }
  }

  async canStartUserPrompt(sessionId: string): Promise<boolean> {
    const latest = (await this.repository.list())
      .filter((handoff) => handoff.context.sessionId === sessionId)
      .sort(compareHandoffs)
      .at(-1)
    return (
      !latest ||
      latest.stage === 'continued' ||
      (latest.stage === 'failed' && latest.retryFrom === 'continuation-start')
    )
  }
}

const compareHandoffs = (left: DurableCompletionHandoff, right: DurableCompletionHandoff): number =>
  compareCommitOrder(left, right) ||
  left.sequence - right.sequence ||
  left.id.localeCompare(right.id)

const compareCommitOrder = (
  left: Pick<DurableCompletionHandoff, 'commitOrder' | 'observedAt'>,
  right: Pick<DurableCompletionHandoff, 'commitOrder' | 'observedAt'>
): number => {
  if (left.commitOrder !== undefined || right.commitOrder !== undefined) {
    if (left.commitOrder === undefined) return -1
    if (right.commitOrder === undefined) return 1
    return left.commitOrder - right.commitOrder
  }
  return left.observedAt - right.observedAt
}

const stageFor = (handoff: DurableCompletionHandoff): CompletionHandoffRetryStage =>
  handoff.stage === 'reconfiguring' || handoff.stage === 'continuation-start'
    ? handoff.stage
    : 'switching'

const asCapturedDisposition = (
  handoff: DurableCompletionHandoff
): Extract<CompletionDisposition, { kind: 'capture-for-handoff' }> => {
  if (!handoff.envelope) throw new Error('A captured completion envelope is required for handoff.')
  return {
    kind: 'capture-for-handoff',
    envelope: handoff.envelope,
    targetName: handoff.targetName,
    generation: handoff.generation,
    handoffGeneration: handoff.generation,
    continuationContext: {
      sessionId: handoff.context.sessionId,
      originatingTurnId: handoff.context.originatingTurnId ?? handoff.context.turnId,
      originatingUserMessageId:
        handoff.context.originatingUserMessageId ??
        handoff.context.originatingTurnId ??
        handoff.context.turnId,
      toolInvocationId: handoff.context.toolInvocationId,
      target:
        handoff.targetName === null
          ? { kind: 'main' }
          : { kind: 'specialist', name: handoff.targetName },
      completion: handoff.envelope,
      switchReadback: {
        target:
          handoff.targetName === null
            ? { kind: 'main' }
            : { kind: 'specialist', name: handoff.targetName }
      },
      attachmentIds: handoff.provenance.attachmentIds,
      artifactIds: handoff.provenance.artifactIds
    },
    ...(handoff.approvedSpecialistId ? { approvedSpecialistId: handoff.approvedSpecialistId } : {}),
    ...(handoff.approvedSpecialistRevision !== undefined
      ? { approvedSpecialistRevision: handoff.approvedSpecialistRevision }
      : {}),
    ...(handoff.continuation?.switchReadback
      ? { switchReadback: handoff.continuation.switchReadback }
      : {})
  }
}

const handoffId = (context: TrustedToolCompletionContext): string =>
  Buffer.from(completionHandoffKey(context)).toString('base64url')

const approvalContextToTrustedContext = (
  context: HandoffApprovalContext
): TrustedToolCompletionContext => ({
  sessionId: context.sessionId,
  turnId: context.turnId,
  controlInvocationGeneration: context.controlInvocationGeneration,
  toolInvocationId: context.toolInvocationId,
  originatingTurnId: context.originatingTurnId,
  originatingUserMessageId: context.originatingUserMessageId,
  attachmentIds: context.attachmentIds,
  artifactIds: context.artifactIds
})

const failureMessageFor = (retryFrom: CompletionHandoffRetryStage): string => {
  switch (retryFrom) {
    case 'switching':
      return 'Handoff ownership release failed.'
    case 'reconfiguring':
      return 'Handoff reconfiguration failed.'
    case 'continuation-start':
      return 'Handoff continuation start failed.'
  }
}

const clone = <T>(value: T): T => structuredClone(value)

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const parseHandoff = (serialized: Buffer): DurableCompletionHandoff => {
  const parsed: unknown = deserialize(serialized)
  if (!isHandoff(parsed)) throw new Error('Invalid durable completion handoff record.')
  return parsed
}

const isHandoff = (value: unknown): value is DurableCompletionHandoff => {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const context = record.context
  return (
    (typeof record.targetName === 'string' || record.targetName === null) &&
    typeof record.id === 'string' &&
    typeof record.generation === 'number' &&
    typeof record.sequence === 'number' &&
    typeof record.observedAt === 'number' &&
    typeof record.stage === 'string' &&
    typeof record.cancelled === 'boolean' &&
    !!context &&
    typeof context === 'object' &&
    typeof (context as Record<string, unknown>).sessionId === 'string' &&
    typeof (context as Record<string, unknown>).turnId === 'string' &&
    typeof (context as Record<string, unknown>).toolInvocationId === 'string'
  )
}
