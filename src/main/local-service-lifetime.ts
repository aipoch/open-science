import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'

export const LOCAL_SERVICE_STOP_BUDGET_MS = 20_000
export const LOCAL_SERVICE_STOP_ESCALATION_MS = 3_500
export const LOCAL_SERVICE_DISCONNECT_GRACE_MS = 20_000
export const LOCAL_SERVICE_FIRST_CONNECTION_MS = 60_000
export const serviceLifetimeRecordSchema = z
  .object({
    version: z.literal(1),
    generation: z.string().uuid(),
    explicit: z.boolean(),
    stopping: z.boolean(),
    reason: z.enum(['app-exit', 'disconnect', 'user-stop', 'restart', 'update']).optional()
  })
  .strict()
export type ServiceLifetimeRecord = z.infer<typeof serviceLifetimeRecordSchema>
export type ServiceLifetimeSnapshot = ServiceLifetimeRecord & { apps: number }
export type ServiceStopOptions = { deadlineAt?: number; requireCleanExit?: boolean }
export type AppLeaveAttempt = { attemptId: string; deadlineAt: number }
export type AppLeaveOptions = Partial<AppLeaveAttempt>
export class LocalServiceStopIntentError extends Error {
  readonly code = 'service-stop-intent-timeout'
  constructor() {
    super('The local service stop intent could not be confirmed before its deadline.')
    this.name = 'LocalServiceStopIntentError'
  }
}

export function serviceStopDeadline(deadlineAt?: number): number {
  return Math.min(deadlineAt ?? Infinity, Date.now() + LOCAL_SERVICE_STOP_BUDGET_MS)
}

export async function readServiceLifetime(
  configRoot: string
): Promise<ServiceLifetimeRecord | undefined> {
  try {
    return serviceLifetimeRecordSchema.parse(
      JSON.parse(await readFile(join(configRoot, 'service-lifetime.json'), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // A malformed intent must never be interpreted as permission for automatic recovery.
    throw error
  }
}

export type LocalServiceLifetime = {
  snapshot(): ServiceLifetimeSnapshot
  connect(appId: string, connectionId: string): void
  disconnect(appId: string, connectionId: string): void
  prepareLeave(appId: string, connectionId: string, attempt: AppLeaveAttempt): Promise<boolean>
  abortLeave(appId: string, connectionId: string, attemptId: string): Promise<void>
  leave(
    appId: string,
    connectionId: string,
    attempt?: AppLeaveOptions
  ): Promise<ServiceLifetimeSnapshot>
  start(): Promise<ServiceLifetimeSnapshot>
  stop(
    force?: boolean,
    reason?: NonNullable<ServiceLifetimeRecord['reason']>,
    deadlineAt?: number
  ): Promise<ServiceLifetimeSnapshot>
  close(): void
}

/** Only App runs and explicit start hold a service. All committing mutations share one queue. */
export async function createLocalServiceLifetime(options: {
  configRoot: string
  generation: string
  explicitStart: boolean
  stop(reason: NonNullable<ServiceLifetimeRecord['reason']>, deadlineAt?: number): void
  onStoppingAdmission?(): void
  report(error: unknown): void
  disconnectGraceMs?: number
  firstConnectionMs?: number
}): Promise<LocalServiceLifetime> {
  const previous = await readServiceLifetime(options.configRoot)
  let record: ServiceLifetimeRecord = {
    version: 1,
    generation: options.generation,
    stopping: false,
    explicit:
      options.explicitStart ||
      Boolean(
        previous?.explicit &&
        (!previous.stopping || previous.reason === 'restart' || previous.reason === 'update')
      )
  }
  const persist = (next: ServiceLifetimeRecord): Promise<void> =>
    writeDurableJsonFile(
      join(options.configRoot, 'service-lifetime.json'),
      JSON.stringify(serviceLifetimeRecordSchema.parse(next))
    )
  await persist(record)
  const apps = new Map<string, Set<string>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let noAppsDeadline = Date.now() + (options.firstConnectionMs ?? LOCAL_SERVICE_FIRST_CONNECTION_MS)
  let reservation: (AppLeaveAttempt & { appId: string; connectionId: string }) | undefined
  let uncertainWrite = false
  let stopAdmissionRetired = false
  let reconciliation: Promise<void> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const bounded = async <T>(operation: Promise<T>, deadlineAt: number): Promise<T> => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new LocalServiceStopIntentError()),
            Math.max(0, deadlineAt - Date.now())
          )
          deadlineTimer.unref?.()
        })
      ])
    } finally {
      clearTimeout(deadlineTimer)
    }
  }
  const serialize = <T>(operation: () => Promise<T>, deadlineAt?: number): Promise<T> => {
    const result = queue.then(() => {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt)
        throw new LocalServiceStopIntentError()
      return operation()
    })
    queue = result.catch(() => undefined)
    return deadlineAt === undefined ? result : bounded(result, deadlineAt)
  }
  const persistIntent = async (
    next: ServiceLifetimeRecord,
    rollback: ServiceLifetimeRecord,
    deadlineAt: number
  ): Promise<void> => {
    if (Date.now() >= deadlineAt) throw new LocalServiceStopIntentError()
    // Another process may capture a published stop grant before this writer reports failure.
    // Revoking the disk record cannot revoke that capture, so this generation never admits a
    // new App/start again. Only a confirmed stop and a new generation can reopen admission.
    serviceLifetimeRecordSchema.parse(next)
    if (next.stopping && !stopAdmissionRetired) {
      stopAdmissionRetired = true
      options.onStoppingAdmission?.()
    }
    const writing = persist(next)
    try {
      await bounded(writing, deadlineAt)
      if (Date.now() >= deadlineAt) throw new LocalServiceStopIntentError()
      uncertainWrite = false
    } catch (error) {
      uncertainWrite = true
      // Even an ordinary I/O rejection can follow rename (for example directory fsync failed).
      // Reconciliation clears only the pending-write fence; generation retirement is permanent.
      const compensation = writing
        .catch(() => undefined)
        .then(() => persist(rollback))
        .then(() => {
          uncertainWrite = false
          grace(options.disconnectGraceMs ?? LOCAL_SERVICE_DISCONNECT_GRACE_MS)
        })
      reconciliation = compensation
      void compensation
        .finally(() => {
          if (reconciliation === compensation) reconciliation = undefined
        })
        .catch(options.report)
      throw error
    }
  }
  const assertCertain = (): void => {
    if (uncertainWrite) throw new LocalServiceStopIntentError()
  }
  const waitForStopReconciliation = async (deadlineAt: number): Promise<void> => {
    if (reconciliation)
      await bounded(
        reconciliation.catch(() => undefined),
        deadlineAt
      )
    // Settlement permits an explicit retry to write again. Only that durable write succeeding
    // can clear uncertainty; a leave that only removes an App hold must keep the fence.
  }
  const snapshot = (): ServiceLifetimeSnapshot => ({
    ...record,
    stopping: record.stopping || stopAdmissionRetired,
    apps: apps.size
  })
  const commit = async (
    reason: NonNullable<ServiceLifetimeRecord['reason']>,
    force = false,
    deadlineAt?: number,
    retryUncertainWrite = false
  ): Promise<void> => {
    if (!retryUncertainWrite) assertCertain()
    if (record.stopping || (!force && (record.explicit || apps.size))) return
    const deadline = serviceStopDeadline(deadlineAt)
    const previous = record
    record = {
      ...record,
      explicit: (reason === 'restart' || reason === 'update') && record.explicit,
      stopping: true,
      reason
    }
    try {
      await persistIntent(record, previous, deadline)
    } catch (error) {
      record = previous
      // Keep the last App hold while this retired generation awaits an explicit stop retry.
      grace(options.disconnectGraceMs ?? LOCAL_SERVICE_DISCONNECT_GRACE_MS, false)
      throw error
    }
    clearTimeout(timer)
    reservation = undefined
    options.stop(reason, deadline)
  }
  const grace = (milliseconds: number, keepDeadline = true): void => {
    clearTimeout(timer)
    if (
      closed ||
      uncertainWrite ||
      stopAdmissionRetired ||
      reservation ||
      record.explicit ||
      record.stopping ||
      apps.size
    )
      return
    timer = setTimeout(
      () => {
        const deadlineAt = serviceStopDeadline()
        void serialize(() => commit('disconnect', false, deadlineAt), deadlineAt).catch(
          options.report
        )
      },
      keepDeadline ? Math.max(0, Math.min(milliseconds, noAppsDeadline - Date.now())) : milliseconds
    )
    timer.unref?.()
  }
  grace(options.firstConnectionMs ?? LOCAL_SERVICE_FIRST_CONNECTION_MS)
  return {
    snapshot,
    connect(appId: string, connectionId: string): void {
      assertCertain()
      if (record.stopping || stopAdmissionRetired) throw new Error('The local service is stopping.')
      if (reservation && !apps.get(appId)?.has(connectionId))
        throw new Error(
          'The local service is preparing to stop. Retry after the App finishes quitting.'
        )
      const connections = apps.get(appId) ?? new Set<string>()
      connections.add(connectionId)
      apps.set(appId, connections)
      clearTimeout(timer)
    },
    disconnect(appId: string, connectionId: string): void {
      const connections = apps.get(appId)
      if (!connections?.delete(connectionId)) return
      if (!connections.size) apps.delete(appId)
      if (!apps.size)
        noAppsDeadline =
          Date.now() + (options.disconnectGraceMs ?? LOCAL_SERVICE_DISCONNECT_GRACE_MS)
      grace(options.disconnectGraceMs ?? LOCAL_SERVICE_DISCONNECT_GRACE_MS)
    },
    prepareLeave: (appId, connectionId, attempt) =>
      serialize(async () => {
        assertCertain()
        if (record.stopping || stopAdmissionRetired)
          throw new Error('The local service is stopping.')
        if (!apps.get(appId)?.has(connectionId))
          throw new Error('App session is no longer attached.')
        if (reservation) {
          if (
            reservation.appId === appId &&
            reservation.connectionId === connectionId &&
            reservation.attemptId === attempt.attemptId
          )
            return true
          throw new Error(
            'The local service is preparing to stop. Retry after the App finishes quitting.'
          )
        }
        if (record.explicit || apps.size > 1 || apps.get(appId)!.size > 1) return false
        reservation = {
          appId,
          connectionId,
          ...attempt,
          deadlineAt: serviceStopDeadline(attempt.deadlineAt)
        }
        clearTimeout(timer)
        return true
      }, attempt.deadlineAt),
    abortLeave: (appId, connectionId, attemptId) =>
      serialize(async () => {
        if (
          reservation?.appId !== appId ||
          reservation.connectionId !== connectionId ||
          reservation.attemptId !== attemptId
        )
          return
        reservation = undefined
        grace(options.disconnectGraceMs ?? LOCAL_SERVICE_DISCONNECT_GRACE_MS)
      }),
    leave: (appId: string, connectionId: string, attempt): Promise<ServiceLifetimeSnapshot> => {
      const deadlineAt = serviceStopDeadline(attempt?.deadlineAt)
      return serialize(async () => {
        await waitForStopReconciliation(deadlineAt)
        const connections = apps.get(appId)
        if (
          reservation &&
          (reservation.appId !== appId ||
            reservation.connectionId !== connectionId ||
            reservation.attemptId !== attempt?.attemptId)
        )
          throw new Error('The App quit attempt no longer owns service preparation.')
        const lastConnection =
          connections?.has(connectionId) && connections.size === 1 && apps.size === 1
        if (stopAdmissionRetired || (lastConnection && !record.explicit)) {
          // The hold is removed only after the durable transition succeeds. A concurrent socket
          // disconnect can still remove it, in which case failed persistence rearms the grace.
          await commit(
            'app-exit',
            true,
            Math.min(reservation?.deadlineAt ?? Infinity, deadlineAt),
            true
          )
        } else assertCertain()
        connections?.delete(connectionId)
        if (!connections?.size) apps.delete(appId)
        return snapshot()
      }, deadlineAt)
    },
    start: (): Promise<ServiceLifetimeSnapshot> =>
      serialize(async () => {
        assertCertain()
        if (record.stopping || stopAdmissionRetired || reservation)
          throw new Error(
            'The local service is stopping. Wait for it to exit before starting again.'
          )
        await persist({ ...record, explicit: true })
        record = { ...record, explicit: true }
        clearTimeout(timer)
        return snapshot()
      }),
    stop: (
      force = false,
      reason: NonNullable<ServiceLifetimeRecord['reason']> = 'user-stop',
      deadlineAt?: number
    ): Promise<ServiceLifetimeSnapshot> => {
      const deadline = serviceStopDeadline(deadlineAt)
      return serialize(async () => {
        await waitForStopReconciliation(deadline)
        if (!record.stopping) {
          if (force || stopAdmissionRetired || apps.size === 0)
            await commit(reason, true, deadline, true)
          else {
            const next = { ...record, explicit: false }
            await persistIntent(next, record, deadline)
            record = next
            // A user stop and the final App disconnect may overlap the durable write. The explicit
            // stop now has no remaining App hold, so commit immediately instead of adding a grace.
            if (apps.size === 0) await commit(reason, true, deadline)
          }
        }
        return snapshot()
      }, deadline)
    },
    close: (): void => {
      closed = true
      clearTimeout(timer)
    }
  }
}
