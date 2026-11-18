import { setTimeout as delay } from 'node:timers/promises'
import { withDataRootWrite } from '../storage/migration-state'
import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient, ScheduleOccurrence, SessionSchedule } from '@prisma/client'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { nextScheduleTime } from '../../shared/schedule-time'
import {
  scheduleActionSchema,
  scheduleRuleSchema,
  type ScheduleReason,
  type ScheduleRule
} from '../../shared/session-schedules'

type Work = ScheduleOccurrence & { schedule: SessionSchedule }
export type ScheduleEvidence =
  | { kind: 'missing' }
  | {
      kind: 'running' | 'succeeded' | 'failed'
      runId?: string
      reason?: ScheduleReason
      waiting?: boolean
    }
export type ScheduleExecution = {
  inspect(work: Work): Promise<ScheduleEvidence>
  dispatch(
    work: Work,
    authorize: (observedRevision?: number) => Promise<void>,
    assertPreparationCurrent: () => Promise<void>
  ): Promise<ScheduleEvidence>
}
export class ScheduleBusyError extends Error {}
export class ScheduleObservationError extends Error {}
export class ScheduleRejectedError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
const log = createLogger('schedule-dispatch')
const grace = 86400000
const retryMs = 15000
const maxConcurrentRuns = 4
const observationBudgetMs = 1000
const pastEnd = (endAt: Date | null, now: number): boolean =>
  endAt !== null && now > endAt.getTime()

async function withinBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ScheduleObservationError('Schedule observation wait budget exceeded.')),
          Math.max(0, timeoutMs)
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function latestSlot(rule: ScheduleRule, first: number, now: number): number {
  if (rule.kind === 'once') return first
  if (rule.kind === 'interval') {
    if (now < rule.anchor) return first
    const period = rule.minutes * 60000
    // A next-run override is one candidate, not a new recurrence anchor.
    return Math.max(first, rule.anchor + Math.floor((now - rule.anchor) / period) * period)
  }
  let slot = first
  // Only walk wall-clock rules in the eligible catch-up window.
  for (
    let next = nextScheduleTime(rule, Math.max(first, now - grace) - 1);
    next !== null && next <= now;
    next = nextScheduleTime(rule, next)
  )
    slot = next
  return slot
}

async function pruneHistory(tx: Prisma.TransactionClient, scheduleId: string): Promise<void> {
  const oldest = await tx.scheduleOccurrence.findFirst({
    where: { scheduleId: scheduleId, phase: 'settled' },
    orderBy: { scheduledAt: 'desc' },
    skip: 29
  })
  if (oldest)
    await tx.scheduleOccurrence.deleteMany({
      where: {
        scheduleId: scheduleId,
        phase: 'settled',
        scheduledAt: { lt: oldest.scheduledAt }
      }
    })
}

export class ScheduleDispatcher {
  private readonly live = new Map<string, Promise<void>>()
  private readonly observations = new Map<string, Promise<ScheduleEvidence>>()
  private readonly occupied = new Set<string>()
  private readonly waiting = new Map<string, number>()
  private readonly claimRetryAt = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private started = false
  private scanning?: Promise<void>
  private rescanRequested = false
  constructor(
    private readonly database: () => Promise<PrismaClient>,
    private readonly executor: ScheduleExecution,
    private readonly changed?: (projectId: string, sessionId: string | null) => void
  ) {}
  start(): void {
    this.started = true
    this.stopped = false
    this.wake()
  }
  wake(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.scanning) this.rescanRequested = true
    else this.arm(0)
  }
  private arm(delay: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
        .then(() => this.armNext())
        .catch((error) => {
          log.warn('Schedule scan failed', diagnosticErrorFields(error))
          this.arm(retryMs)
        })
    }, delay)
    this.timer.unref()
  }
  private deferredClaims(now: number): string[] {
    for (const [id, at] of this.claimRetryAt) if (at <= now) this.claimRetryAt.delete(id)
    return [...this.claimRetryAt.keys()]
  }
  private async armNext(): Promise<void> {
    if (this.stopped || this.timer) return
    if (this.rescanRequested) {
      this.rescanRequested = false
      this.arm(0)
      return
    }
    const db = await this.database()
    const deferred = this.deferredClaims(Date.now())
    const [due, pending] = await Promise.all([
      db.sessionSchedule.findFirst({
        where: {
          pausedAt: null,
          finishedAt: null,
          nextDueAt: { not: null },
          id: deferred.length ? { notIn: deferred } : undefined,
          occurrences: { none: { phase: { not: 'settled' } } }
        },
        orderBy: { nextDueAt: 'asc' },
        select: { nextDueAt: true }
      }),
      db.scheduleOccurrence.findFirst({
        where: {
          phase: { not: 'settled' },
          ...(this.live.size ? { id: { notIn: [...this.live.keys()] } } : {})
        },
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true }
      })
    ])
    const now = Date.now()
    // A minute ceiling detects wall-clock jumps on desktop and headless hosts. Active
    // provider calls retain the short observation interval for permission-wait receipts.
    this.arm(
      Math.max(
        0,
        Math.min(
          this.live.size ? retryMs : 60000,
          ...Array.from(this.claimRetryAt.values(), (at) => at - now),
          due?.nextDueAt ? due.nextDueAt.getTime() - now : Infinity,
          pending ? (pending.nextAttemptAt?.getTime() ?? now) - now : Infinity
        )
      )
    )
  }
  suspend(): void {
    this.started = false
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
  }
  async dispose(timeoutMs = 5000): Promise<void> {
    this.suspend()
    const deadline = Date.now() + timeoutMs
    try {
      await withinBudget(this.drain(deadline), timeoutMs)
    } catch (error) {
      if (!(error instanceof ScheduleObservationError)) throw error
      log.warn('schedule shutdown observation deadline reached')
    }
  }
  private async drain(deadline: number): Promise<void> {
    await this.scanning
    if (!this.live.size || Date.now() >= deadline) return
    const db = await this.database()
    await Promise.all(
      [...this.live].map(async ([id, completion]) => {
        while (this.live.has(id) && Date.now() < deadline) {
          const work = await db.scheduleOccurrence.findUnique({
            where: { id },
            include: { schedule: true }
          })
          // Durable permission waits can outlive the process. Their receipt permits recovery.
          if (!work || work.phase !== 'dispatching' || Date.now() >= deadline) return
          const evidence = await this.inspect(work).catch((error) => {
            if (error instanceof ScheduleObservationError) return { kind: 'missing' } as const
            throw error
          })
          if (Date.now() >= deadline) return
          if (evidence.kind !== 'missing') {
            await withDataRootWrite(() => this.markAdmitted(db, work, new Date(), evidence.runId))
            return
          }
          // Observe queued admission independently of provider completion. Never erase an
          // ambiguous authorization; the application deadline still bounds a stuck storage call.
          await Promise.race([completion, delay(20)])
        }
        if (this.live.has(id))
          log.warn('schedule shutdown admission deadline reached', { occurrenceId: id })
      })
    )
  }

  private inspect(work: Work): Promise<ScheduleEvidence> {
    const key = JSON.stringify([work.id, work.attemptCount])
    let observation = this.observations.get(key)
    if (!observation) {
      observation = Promise.resolve()
        .then(() => this.executor.inspect(work))
        .finally(() => this.observations.delete(key))
      this.observations.set(key, observation)
    }
    // Timeout only abandons this read's result. Keep the underlying read deduplicated
    // until it settles; late evidence must not mutate a timed-out attempt or redispatch it.
    return withinBudget(observation, observationBudgetMs)
  }

  tick(now = Date.now()): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.scan(now).finally(() => {
        this.scanning = undefined
      })
    }
    return this.scanning
  }
  private async scan(now: number): Promise<void> {
    const db = await this.database()
    if (this.stopped) return
    // Reconstruct capacity before admitting new work, including background scripts and restart recovery.
    const active = await db.scheduleOccurrence.findMany({
      where: {
        phase: { not: 'settled' },
        OR: [{ admittedAt: { not: null } }, { dispatchAuthorizedAt: { not: null } }]
      },
      select: { id: true, attemptCount: true }
    })
    const durable = new Set(active.map(({ id }) => id))
    for (const id of this.occupied)
      if (!durable.has(id) && !this.live.has(id)) this.occupied.delete(id)
    for (const id of this.waiting.keys()) if (!durable.has(id)) this.waiting.delete(id)
    for (const { id, attemptCount } of active) {
      const wait = this.waiting.get(id)
      // A recovery sweep can exceed the retry interval. Keep the last observed wait until
      // its next observation; failed reads, changed attempts and deleted receipts invalidate it.
      if (wait === attemptCount) this.occupied.delete(id)
      else {
        this.waiting.delete(id)
        this.occupied.add(id)
      }
    }
    const deferred = this.deferredClaims(now)
    const due = await db.sessionSchedule.findMany({
      where: {
        pausedAt: null,
        finishedAt: null,
        nextDueAt: { lte: new Date(now) },
        id: deferred.length ? { notIn: deferred } : undefined,
        occurrences: { none: { phase: { not: 'settled' } } }
      },
      orderBy: { nextDueAt: 'asc' },
      take: 32
    })
    for (const row of due) {
      if (this.stopped) return
      try {
        const rule = scheduleRuleSchema.parse(JSON.parse(row.ruleJson))
        const first = row.nextDueAt!.getTime(),
          latest = latestSlot(rule, first, Math.min(now, row.endAt?.getTime() ?? now))
        const expired = latest < now - grace || pastEnd(row.endAt, now)
        const next = nextScheduleTime(rule, now)
        const nextDue =
          next !== null && (!row.endAt || next <= row.endAt.getTime()) ? new Date(next) : null
        const action = scheduleActionSchema.parse(JSON.parse(row.actionJson))
        const exhausted = row.maxRuns !== null && row.admittedCount >= row.maxRuns
        const occurrenceId = randomUUID()
        const claimed = await withDataRootWrite(() =>
          db.$transaction(async (tx) => {
            const consumed = await tx.scheduleOccurrence.findUnique({
              where: {
                scheduleId_scheduledAt: { scheduleId: row.id, scheduledAt: new Date(latest) }
              },
              select: { id: true }
            })
            const claimed = await tx.sessionSchedule.updateMany({
              where: {
                id: row.id,
                revision: row.revision,
                admittedCount: row.admittedCount,
                finishedAt: null,
                pausedAt: null,
                nextDueAt: row.nextDueAt,
                occurrences: { none: { phase: { not: 'settled' } } }
              },
              data: {
                nextDueAt: exhausted ? null : nextDue,
                ...(exhausted || ((expired || consumed) && !nextDue)
                  ? { finishedAt: new Date(now), finishReason: 'completed' }
                  : {})
              }
            })
            if (!claimed.count) return false
            if (exhausted) return 'exhausted'
            // A clock rollback can re-arm a consumed slot. Advance without replaying its receipt.
            if (consumed) return 'consumed'
            await tx.scheduleOccurrence.create({
              data: {
                id: occurrenceId,
                scheduleId: row.id,
                scheduleRevision: row.revision,
                scheduledAt: new Date(latest),
                actionSnapshot: row.actionJson,
                runSessionId: !expired && !row.sessionId ? randomUUID() : null,
                phase: expired ? 'settled' : 'dispatching',
                promptMessageId: action.kind === 'send_session_message' ? randomUUID() : null,
                ...(expired
                  ? { outcome: 'skipped', reason: 'expired', settledAt: new Date(now) }
                  : {})
              }
            })
            if (expired) await pruneHistory(tx, row.id)
            return 'claimed'
          })
        )
        if (claimed) {
          log.info(
            claimed === 'consumed'
              ? 'schedule consumed slot advanced'
              : exhausted
                ? 'schedule reached run limit'
                : 'schedule occurrence claimed',
            {
              scheduleId: row.id,
              projectId: row.projectId,
              sessionId: row.sessionId,
              ...(exhausted
                ? { admittedCount: row.admittedCount, maxRuns: row.maxRuns }
                : {
                    ...(claimed === 'claimed' ? { occurrenceId } : {}),
                    scheduledAt: latest,
                    expired,
                    actionKind: action.kind
                  })
            }
          )
          this.changed?.(row.projectId, row.sessionId)
        }
      } catch (error) {
        this.claimRetryAt.set(row.id, Math.max(now, Date.now()) + retryMs)
        log.warn('schedule claim failed; retrying', {
          scheduleId: row.id,
          projectId: row.projectId,
          ...diagnosticErrorFields(error)
        })
      }
    }
    // A provider prompt can keep dispatch() open for days while waiting for permission.
    // Read its committed prompt like recovery does, without starting another dispatch.
    if (this.live.size) {
      const inflight = await db.scheduleOccurrence.findMany({
        where: {
          id: { in: [...this.live.keys()] },
          phase: { not: 'settled' },
          dispatchAuthorizedAt: { not: null },
          promptMessageId: { not: null }
        },
        include: { schedule: true }
      })
      await Promise.all(
        inflight.map(async (work) => {
          try {
            const evidence = await this.inspect(work)
            if (evidence.kind === 'running') {
              this.observeCapacity(work, evidence.waiting)
              await withDataRootWrite(() => this.markAdmitted(db, work, new Date(now + retryMs)))
            }
          } catch (error) {
            this.observeCapacity(work, false)
            log.warn('Scheduled prompt observation failed', diagnosticErrorFields(error))
          }
        })
      )
    }
    const pending = await db.scheduleOccurrence.findMany({
      where: {
        phase: { not: 'settled' },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }],
        ...(this.live.size ? { id: { notIn: [...this.live.keys()] } } : {})
      },
      include: { schedule: true },
      orderBy: [{ nextAttemptAt: 'asc' }, { scheduledAt: 'asc' }, { id: 'asc' }],
      take: 32
    })
    const launch = (work: Work): Promise<void> | undefined => {
      if (this.stopped || this.live.has(work.id)) return
      const run = withDataRootWrite(() => this.process(db, work, now))
        .catch((error) =>
          log.warn('Schedule occurrence failed', {
            scheduleId: work.scheduleId,
            occurrenceId: work.id,
            attemptCount: work.attemptCount,
            ...diagnosticErrorFields(error)
          })
        )
        .finally(() => {
          this.live.delete(work.id)
          if (this.started) this.wake()
        })
      this.live.set(work.id, run)
      return run
    }
    // Authorized work only observes durable evidence. Reconcile its capacity before
    // competing admissions; a slow permission-wait read must not starve new work.
    await Promise.all(
      pending.filter((work) => work.dispatchAuthorizedAt || work.admittedAt).map(launch)
    )
    for (const work of pending) if (!work.dispatchAuthorizedAt && !work.admittedAt) launch(work)
  }

  private observeCapacity(work: Work, waiting: boolean | undefined): void {
    const { id, attemptCount } = work
    if (waiting) {
      this.waiting.set(id, attemptCount)
      this.occupied.delete(id)
    } else {
      this.waiting.delete(id)
      this.occupied.add(id)
    }
  }

  private async markAdmitted(
    db: PrismaClient,
    work: Work,
    nextAttemptAt: Date,
    runId?: string
  ): Promise<void> {
    let changedCount = 0
    await db.$transaction(async (tx) => {
      const changed = await tx.scheduleOccurrence.updateMany({
        where: { id: work.id, attemptCount: work.attemptCount, phase: work.phase },
        data: {
          phase: 'admitted',
          admittedAt: work.admittedAt ?? new Date(),
          scriptRunId: runId,
          nextAttemptAt
        }
      })
      changedCount = changed.count
      if (changed.count && !work.admittedAt)
        await tx.sessionSchedule.updateMany({
          where: { id: work.scheduleId },
          data: { admittedCount: { increment: 1 } }
        })
    })
    if (changedCount) {
      log.info('schedule occurrence admitted', {
        scheduleId: work.scheduleId,
        occurrenceId: work.id,
        attemptCount: work.attemptCount,
        ...(runId ? { runId } : {})
      })
    }
    if (!work.admittedAt) this.changed?.(work.schedule.projectId, work.schedule.sessionId)
  }
  private async process(db: PrismaClient, work: Work, now: number): Promise<void> {
    const id = work.id
    const scope = { id, attemptCount: work.attemptCount, phase: work.phase }
    const definition = {
      id: work.scheduleId,
      revision: work.scheduleRevision,
      pausedAt: null,
      finishedAt: null
    }
    const nextAttemptAt = new Date(now + retryMs)
    const inspect = async (): Promise<ScheduleEvidence | undefined> => {
      try {
        return await this.inspect(work)
      } catch (error) {
        this.observeCapacity(work, false)
        if (!(error instanceof ScheduleObservationError)) throw error
        log.warn('schedule evidence temporarily unavailable; retrying observation', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          ...diagnosticErrorFields(error)
        })
        await db.scheduleOccurrence.updateMany({ where: scope, data: { nextAttemptAt } })
        return undefined
      }
    }
    const finish = async (
      outcome: string,
      reason?: ScheduleReason,
      admitted = false,
      runId?: string
    ): Promise<void> => {
      let settled = false
      await db.$transaction(async (tx) => {
        const changed = await tx.scheduleOccurrence.updateMany({
          where: scope,
          data: {
            phase: 'settled',
            outcome,
            reason,
            settledAt: new Date(),
            scriptRunId: runId,
            ...(admitted && !work.admittedAt ? { admittedAt: new Date() } : {})
          }
        })
        if (!changed.count) return
        settled = true
        if (admitted && !work.admittedAt)
          await tx.sessionSchedule.updateMany({
            where: { id: work.scheduleId },
            data: { admittedCount: { increment: 1 } }
          })
        if (outcome === 'interrupted' || outcome === 'failed')
          await tx.sessionSchedule.updateMany({
            // A receipt cannot pause a definition edited after this occurrence was claimed.
            where: {
              id: work.scheduleId,
              pausedAt: null,
              finishedAt: null,
              revision: work.scheduleRevision
            },
            data: {
              pausedAt: new Date(),
              pauseReason: reason ?? outcome,
              revision: { increment: 1 }
            }
          })
        // Exhaustion belongs to the current definition, independently of the old run outcome.
        await tx.sessionSchedule.updateMany({
          where: {
            id: work.scheduleId,
            pausedAt: null,
            finishedAt: null,
            OR: [{ nextDueAt: null }, { admittedCount: { gte: tx.sessionSchedule.fields.maxRuns } }]
          },
          data: {
            finishedAt: new Date(),
            finishReason: 'completed',
            nextDueAt: null,
            revision: { increment: 1 }
          }
        })
        await pruneHistory(tx, work.scheduleId)
      })
      if (settled)
        log.info('schedule occurrence settled', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          attemptCount: work.attemptCount,
          outcome,
          admitted,
          ...(runId ? { runId } : {})
        })
      this.changed?.(work.schedule.projectId, work.schedule.sessionId)
    }
    const observe = async (e: Exclude<ScheduleEvidence, { kind: 'missing' }>): Promise<void> => {
      if (e.kind !== 'running') return finish(e.kind, e.reason, true, e.runId)
      this.observeCapacity(work, e.waiting)
      await this.markAdmitted(db, work, nextAttemptAt, e.runId)
    }
    try {
      if (!work.schedule.sessionId && !work.runSessionId)
        return await finish('skipped', 'conversation_unavailable')
      const e = await inspect()
      if (!e) return
      if (e.kind !== 'missing') return await observe(e)
      if (work.dispatchAuthorizedAt || work.admittedAt)
        return await finish('interrupted', 'unconfirmed')
      const expired =
        work.scheduledAt.getTime() < now - grace ||
        pastEnd(work.schedule.endAt, Math.max(now, Date.now()))
      if (
        work.schedule.revision !== work.scheduleRevision ||
        work.schedule.pausedAt ||
        work.schedule.finishedAt ||
        expired
      )
        return await finish('skipped', expired ? 'expired' : 'changed')
      if (this.occupied.size >= maxConcurrentRuns)
        throw new ScheduleBusyError('Schedule execution capacity is full.')
      this.occupied.add(id)
      const result = await this.executor.dispatch(
        work,
        async (observedRevision) => {
          if (this.stopped) throw new ScheduleBusyError('Schedule host is stopping.')
          if (pastEnd(work.schedule.endAt, Date.now()))
            throw new ScheduleBusyError('The schedule reached its end before dispatch.')
          const authorized = await db.scheduleOccurrence.updateMany({
            where: {
              ...scope,
              runSessionId: work.runSessionId,
              dispatchAuthorizedAt: null,
              schedule: definition
            },
            data: { dispatchAuthorizedAt: new Date() }
          })
          if (!authorized.count)
            throw new ScheduleBusyError('The schedule changed before dispatch.')
          log.debug('schedule dispatch authorized', {
            scheduleId: work.scheduleId,
            occurrenceId: work.id,
            attemptCount: work.attemptCount,
            ...(observedRevision === undefined ? {} : { observedSessionRevision: observedRevision })
          })
        },
        async () => {
          if (
            this.stopped ||
            pastEnd(work.schedule.endAt, Date.now()) ||
            !(await db.scheduleOccurrence.count({
              where: {
                ...scope,
                runSessionId: work.runSessionId,
                dispatchAuthorizedAt: null,
                schedule: definition
              }
            }))
          )
            throw new ScheduleBusyError('The schedule changed before session creation.')
        }
      )
      if (result.kind !== 'missing') await observe(result)
    } catch (error) {
      if (error instanceof ScheduleRejectedError) {
        const witness = await inspect()
        if (!witness) return
        if (witness.kind !== 'missing') return await observe(witness)
        if (!error.retry) {
          log.warn('schedule dispatch rejected', {
            scheduleId: work.scheduleId,
            occurrenceId: work.id,
            attemptCount: work.attemptCount,
            retry: false,
            ...diagnosticErrorFields(error)
          })
          return await finish('failed', 'admission_rejected')
        }
        log.warn('schedule dispatch rejected; retrying', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          attemptCount: work.attemptCount,
          retry: true,
          ...diagnosticErrorFields(error)
        })
        await db.scheduleOccurrence.updateMany({
          where: scope,
          data: { dispatchAuthorizedAt: null, nextAttemptAt, attemptCount: { increment: 1 } }
        })
        return
      }
      if (error instanceof ScheduleBusyError) {
        log.debug('schedule occurrence busy; retrying', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          attemptCount: work.attemptCount
        })
        await db.scheduleOccurrence.updateMany({
          where: { ...scope, dispatchAuthorizedAt: null },
          data: { nextAttemptAt, attemptCount: { increment: 1 } }
        })
        return
      }
      const row = await db.scheduleOccurrence.findUnique({ where: { id } })
      if (!row) {
        log.warn('schedule occurrence disappeared during processing', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          attemptCount: work.attemptCount,
          ...diagnosticErrorFields(error)
        })
        return
      }
      if (row.phase === 'settled') {
        log.debug('schedule occurrence already settled', {
          scheduleId: work.scheduleId,
          occurrenceId: work.id,
          attemptCount: work.attemptCount
        })
        return
      }
      if (row.dispatchAuthorizedAt) {
        const witness = await inspect().catch(() => ({ kind: 'missing' }) as const)
        if (!witness) return
        if (witness.kind !== 'missing') return await observe(witness)
      }
      log.warn('schedule execution failed', {
        scheduleId: work.scheduleId,
        occurrenceId: work.id,
        ...diagnosticErrorFields(error)
      })
      await finish(
        row.dispatchAuthorizedAt ? 'interrupted' : 'failed',
        row.dispatchAuthorizedAt ? 'unconfirmed' : 'dispatch_failed'
      )
    } finally {
      const row = await db.scheduleOccurrence.findUnique({
        where: { id },
        select: { phase: true, dispatchAuthorizedAt: true, admittedAt: true }
      })
      if (!row || row.phase === 'settled' || (!row.dispatchAuthorizedAt && !row.admittedAt)) {
        this.waiting.delete(id)
        this.occupied.delete(id)
      }
    }
  }
}
