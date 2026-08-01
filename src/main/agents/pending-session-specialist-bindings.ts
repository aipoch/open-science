// Tracks approved host.agents.switch bindings for sessions that are not yet durable (fresh unsent
// drafts), so the binding is flushed to the session file on first save instead of being silently
// dropped across an app restart.
//
// Background (code-review finding): host.agents.switch persists the binding immediately (Phase 5 of
// SwitchOperation), but when the calling session is a brand-new unsent draft it does not yet exist on
// disk, so the durable writer cannot persist it. The in-memory SessionBindingService holds it, but
// nothing reconciled that back to disk on first save — so a restart before the first save lost the
// approved switch. This helper bridges that gap: the persistSessionSpecialist callback stashes a
// binding when the session is not yet durable, and the session save path flushes (and consumes) it.
//
// `has` is the source of truth for "a flush is pending" so a cleared (Main Agent) binding — stashed
// as undefined — is still flushed (the disk binding must be cleared too), not mistaken for "nothing
// pending".

export class PendingSessionSpecialistBindings {
  private readonly pending = new Map<string, string | undefined>()

  // Record a binding for a session that is not yet durable. Overwrites a prior stash for the same
  // session (last-write-wins), mirroring the live SessionBindingService.
  stash(sessionId: string, specialistId: string | undefined): void {
    this.pending.set(sessionId, specialistId)
  }

  // Whether a stashed binding is waiting to be flushed when this session is next saved. Use this
  // (not the value returned by `take`) to decide whether to flush, so a cleared binding is honored.
  has(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  // Consume and return the stashed binding for a session (possibly undefined = clear to Main),
  // removing it from the pending set. Called by the save path right after the session becomes durable.
  take(sessionId: string): string | undefined {
    const value = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    return value
  }
}
