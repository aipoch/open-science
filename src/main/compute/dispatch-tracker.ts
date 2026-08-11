// Tracks jobs whose dispatch handoff or background work is in flight (mkdir + staging + launch).
//
// Why this exists: a job sits in status 'submitted' with no remote_handle for the entire dispatch
// window. Since input staging can scp GB-scale files with a 30-minute timeout (scp-runner.ts), that
// window can span many 15s poller ticks. The JobPoller otherwise treats any 'submitted'+no-handle
// job as "dispatch interrupted by restart" and flips it to error/dispatch_failed (design.md §8
// boundary 3) — which would falsely kill a job mid-upload and orphan its remote files.
//
// This tracker lets the poller distinguish the two cases:
//   - jobId present  → dispatch is actively running in THIS process → skip it, let dispatch finish.
//   - jobId absent   → no live dispatch → it's a restart-orphaned job → dispatch_failed is correct.
//
// Because the tracker is in-memory, an app restart starts it empty: any job left in 'submitted'+
// no-handle from before the restart is correctly seen as orphaned. This is exactly the semantics
// design.md §8 boundary 3 asks for.
export class DispatchTracker {
  private readonly inFlight = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()

  // Acquires one dispatch lease. The submit path holds a handoff lease before publishing the row;
  // dispatchJob acquires its own lease synchronously before its first await.
  begin(jobId: string): void {
    this.inFlight.set(jobId, (this.inFlight.get(jobId) ?? 0) + 1)
  }

  // Releases one lease and wakes waiters only after the final overlapping lease is released.
  end(jobId: string): void {
    const leases = this.inFlight.get(jobId)
    if (leases === undefined) return
    if (leases > 1) {
      this.inFlight.set(jobId, leases - 1)
      return
    }
    this.inFlight.delete(jobId)
    const waiters = this.waiters.get(jobId)
    this.waiters.delete(jobId)
    for (const resolve of waiters ?? []) resolve()
  }

  // Whether a job's dispatch is currently in flight in this process.
  has(jobId: string): boolean {
    return this.inFlight.has(jobId)
  }

  async waitFor(jobIds: readonly string[]): Promise<void> {
    await Promise.all(
      [...new Set(jobIds)].map((jobId) => {
        if (!this.inFlight.has(jobId)) return Promise.resolve()
        return new Promise<void>((resolve) => {
          const waiters = this.waiters.get(jobId) ?? new Set()
          waiters.add(resolve)
          this.waiters.set(jobId, waiters)
        })
      })
    )
  }
}

// Process-wide shared tracker. Submit handoff and dispatchJob write to it; JobPoller and owner
// deletion read from it. Defaults keep production wiring on one tracker without constructor plumbing.
export const sharedDispatchTracker = new DispatchTracker()
