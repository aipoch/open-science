/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { TranslationCallerLease } from '../../src/ports.js'
/** Test consumer: the package receives leases and never owns the host's registry. */
export class TestCallerRegistry {
  private readonly active = new Map<string, { controller: AbortController; generation: number }>()
  private generation = 0
  acquire(input: { leaseId: string; surface?: string }) {
    this.active.get(input.leaseId)?.controller.abort()
    const entry = { controller: new AbortController(), generation: ++this.generation }
    this.active.set(input.leaseId, entry)
    const lease: TranslationCallerLease = {
      leaseId: input.leaseId,
      generation: entry.generation,
      signal: entry.controller.signal,
      isCurrent: () => this.active.get(input.leaseId) === entry && !entry.controller.signal.aborted
    }
    return {
      lease,
      release: () => {
        entry.controller.abort()
        if (this.active.get(input.leaseId) === entry) this.active.delete(input.leaseId)
      }
    }
  }
  dispose() {
    for (const entry of this.active.values()) entry.controller.abort()
    this.active.clear()
  }
}
