// A timeout describes the caller's deadline, never completion of the underlying teardown.
const pending = new Set<Promise<unknown>>()
export function trackLifecycleSettlement<T>(work: Promise<T>): Promise<T> {
  pending.add(work)
  void work.finally(() => pending.delete(work)).catch(() => undefined)
  return work
}
export function hasPendingLifecycleSettlement(): boolean {
  return pending.size > 0
}
export async function waitForLifecycleSettlement(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending])
}
