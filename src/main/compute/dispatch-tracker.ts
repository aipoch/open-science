// Tracks jobs whose background dispatch is currently in flight (mkdir + input staging + launch).
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
  private readonly inFlight = new Set<string>()

  // Marks a job's dispatch as started. Call synchronously before the first await of dispatchJob so
  // the poller can never observe the job as untracked while its dispatch is genuinely running.
  begin(jobId: string): void {
    this.inFlight.add(jobId)
  }

  // Marks a job's dispatch as finished (success or failure). Always call from a finally block.
  end(jobId: string): void {
    this.inFlight.delete(jobId)
  }

  // Whether a job's dispatch is currently in flight in this process.
  has(jobId: string): boolean {
    return this.inFlight.has(jobId)
  }
}

// Process-wide shared tracker. ComputeService's dispatchJob writes to it; JobPoller reads from it.
// Both default to this instance so production wiring shares one tracker without threading it through
// every constructor. Tests inject their own DispatchTracker for isolation.
export const sharedDispatchTracker = new DispatchTracker()
