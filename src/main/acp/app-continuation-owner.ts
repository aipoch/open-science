import type { AcpPromptRequest } from '../../shared/acp'

type AcpAppContinuationOwnerOptions = Readonly<{
  activityChanged: () => void
}>

type AcpAppContinuation = Readonly<{
  request: AcpPromptRequest
  condition: 'always' | 'provider-cancelled'
}>

// Owns app-authored continuations parked between a durable interaction response and the next
// provider turn. Generation retirement observes only hasPending(); Runtime consumes the request.
class AcpAppContinuationOwner {
  private readonly pending = new Map<string, AcpAppContinuation>()
  private readonly activeSessionIds = new Set<string>()

  constructor(private readonly options: AcpAppContinuationOwnerOptions) {}

  hasPending(): boolean {
    return this.pending.size > 0 || this.activeSessionIds.size > 0
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  get(sessionId: string): AcpAppContinuation | undefined {
    return this.pending.get(sessionId)
  }

  set(sessionId: string, continuation: AcpAppContinuation): void {
    this.change(() => this.pending.set(sessionId, continuation))
  }

  takeAndActivate(sessionId: string): AcpAppContinuation | undefined {
    let continuation: AcpAppContinuation | undefined
    this.change(() => {
      continuation = this.pending.get(sessionId)
      this.pending.delete(sessionId)
      if (continuation) this.activeSessionIds.add(sessionId)
    })
    return continuation
  }

  complete(sessionId: string): void {
    this.change(() => this.activeSessionIds.delete(sessionId))
  }

  sessionIds(): string[] {
    return Array.from(new Set([...this.pending.keys(), ...this.activeSessionIds]))
  }

  delete(sessionId: string): boolean {
    let deleted = false
    this.change(() => {
      const pendingDeleted = this.pending.delete(sessionId)
      const activeDeleted = this.activeSessionIds.delete(sessionId)
      deleted = pendingDeleted || activeDeleted
    })
    return deleted
  }

  clear(): void {
    this.change(() => {
      this.pending.clear()
      this.activeSessionIds.clear()
    })
  }

  private change(update: () => void): void {
    const wasPending = this.hasPending()
    update()
    if (wasPending !== this.hasPending()) this.options.activityChanged()
  }
}

export { AcpAppContinuationOwner }
export type { AcpAppContinuation }
