import type { ApplicationCallerLease } from './application-command-router'

type OwnedApplicationCallerLease = Readonly<{
  lease: ApplicationCallerLease
  release: () => void
}>

type LeaseState = Readonly<{
  token: object
  controller: AbortController
}>

type CallerLeaseEvent = Readonly<{ sender: object }>

const eventLeases = new WeakMap<object, ApplicationCallerLease>()

const bindCallerLeaseToEvent = (event: CallerLeaseEvent, lease: ApplicationCallerLease): void => {
  eventLeases.set(event.sender, lease)
}

const callerLeaseForEvent = (event: CallerLeaseEvent): ApplicationCallerLease => {
  const lease = eventLeases.get(event.sender)
  if (!lease) throw new Error('Application caller lease is not bound to this event.')
  return lease
}

// Owns disconnect state for application callers. Surface adapters retain the release capability;
// command handlers receive only the immutable lease and its read-only AbortSignal.
class ApplicationCallerLeaseRegistry {
  private readonly active = new Map<string, LeaseState>()
  private readonly generations = new Map<string, number>()
  private disposed = false

  acquire(leaseId: string): OwnedApplicationCallerLease {
    if (this.disposed) throw new Error('Application caller lease registry is disposed.')

    const previous = this.active.get(leaseId)
    if (previous) {
      this.active.delete(leaseId)
      previous.controller.abort()
    }

    const generation = (this.generations.get(leaseId) ?? 0) + 1
    this.generations.set(leaseId, generation)
    const controller = new AbortController()
    const token = Object.freeze({})
    const lease: ApplicationCallerLease = Object.freeze({
      leaseId,
      generation,
      signal: controller.signal,
      isCurrent: () => this.active.get(leaseId)?.token === token && !controller.signal.aborted
    })
    const state: LeaseState = { token, controller }
    this.active.set(leaseId, state)

    return Object.freeze({
      lease,
      release: () => {
        if (this.active.get(leaseId) !== state) return
        this.active.delete(leaseId)
        controller.abort()
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const active = [...this.active.values()]
    this.active.clear()
    for (const state of active) state.controller.abort()
  }
}

export { ApplicationCallerLeaseRegistry, bindCallerLeaseToEvent, callerLeaseForEvent }
export type { OwnedApplicationCallerLease }
