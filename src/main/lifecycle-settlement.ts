import { createLogger } from '@aipoch/diagnostics/node'

// Tracks teardown work that must finish before new work is admitted. A caller's timeout describes its
// own deadline, never completion of the underlying teardown, so every entry is bounded: once it has been
// pending for too long it is ABANDONED. An abandoned entry no longer fences admission or waiters; it is
// only kept for diagnostics until the underlying work eventually settles. Only a committed quit latches
// admission closed, and that latch lives with the owner of the quit, not in this set.

export const DEFAULT_SETTLEMENT_ABANDON_MS = 20_000
export const DEFAULT_SETTLEMENT_WAIT_MS = 10_000
const MAX_ABANDONED_ENTRIES = 32

export type LifecycleSettlementOwner = 'backend-shutdown' | 'quit-preparation' | 'other'

type Entry = {
  owner: LifecycleSettlementOwner
  startedAt: number
  abandonedAt?: number
  timer?: ReturnType<typeof setTimeout>
}

const entries = new Map<Promise<unknown>, Entry>()
const waiters = new Set<() => void>()
const logger = createLogger('lifecycle-settlement')

const notifyWaiters = (): void => {
  for (const waiter of [...waiters]) waiter()
}

const livePending = (): Promise<unknown>[] =>
  [...entries].filter(([, entry]) => entry.abandonedAt === undefined).map(([work]) => work)

export function abandonLifecycleSettlement(work: Promise<unknown>, reason = 'deadline'): void {
  const entry = entries.get(work)
  if (!entry || entry.abandonedAt !== undefined) return
  entry.abandonedAt = Date.now()
  if (entry.timer) clearTimeout(entry.timer)
  try {
    logger.warn('lifecycle settlement abandoned', {
      owner: entry.owner,
      reason,
      pendingMs: entry.abandonedAt - entry.startedAt
    })
  } catch {
    // Diagnostics are best-effort; abandonment must always release the fence.
  }
  // Bound diagnostics memory: forget the oldest abandoned entries.
  const abandoned = [...entries].filter(([, value]) => value.abandonedAt !== undefined)
  for (const [stale] of abandoned.slice(0, Math.max(0, abandoned.length - MAX_ABANDONED_ENTRIES)))
    entries.delete(stale)
  notifyWaiters()
}

export function trackLifecycleSettlement<T>(
  work: Promise<T>,
  options: { owner?: LifecycleSettlementOwner; abandonAfterMs?: number } = {}
): Promise<T> {
  if (entries.has(work)) return work
  const entry: Entry = { owner: options.owner ?? 'other', startedAt: Date.now() }
  entries.set(work, entry)
  entry.timer = setTimeout(
    () => abandonLifecycleSettlement(work, 'deadline'),
    options.abandonAfterMs ?? DEFAULT_SETTLEMENT_ABANDON_MS
  )
  entry.timer.unref?.()
  void work
    .finally(() => {
      if (entry.timer) clearTimeout(entry.timer)
      entries.delete(work)
      notifyWaiters()
    })
    .catch(() => undefined)
  return work
}

// True only while non-abandoned teardown is still running.
export function hasPendingLifecycleSettlement(): boolean {
  return livePending().length > 0
}

// Resolves when no live teardown remains, or when the deadline elapses (never rejects, never hangs).
export function waitForLifecycleSettlement(options: { timeoutMs?: number } = {}): Promise<void> {
  if (!hasPendingLifecycleSettlement()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      waiters.delete(check)
      resolve()
    }
    const check = (): void => {
      if (!hasPendingLifecycleSettlement()) finish()
    }
    const timer = setTimeout(finish, options.timeoutMs ?? DEFAULT_SETTLEMENT_WAIT_MS)
    timer.unref?.()
    waiters.add(check)
  })
}

export function getLifecycleSettlementDiagnostics(): {
  pending: { owner: LifecycleSettlementOwner; pendingMs: number }[]
  abandoned: { owner: LifecycleSettlementOwner; pendingMs: number }[]
} {
  const now = Date.now()
  const rows = [...entries.values()]
  return {
    pending: rows
      .filter((entry) => entry.abandonedAt === undefined)
      .map((entry) => ({ owner: entry.owner, pendingMs: now - entry.startedAt })),
    abandoned: rows
      .filter((entry) => entry.abandonedAt !== undefined)
      .map((entry) => ({ owner: entry.owner, pendingMs: now - entry.startedAt }))
  }
}
