import type { ApplicationCallerLease } from './application-command-router'
import type { CallerContext } from './caller-context'

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
const leaseOwnershipKeys = new WeakMap<ApplicationCallerLease, string>()

const callerLeaseOwnershipKeyForContext = (
  identity: Pick<CallerContext, 'leaseId' | 'surface'>
): string => `${identity.surface}\u0000${identity.leaseId}`

const bindCallerLeaseToEvent = (event: CallerLeaseEvent, lease: ApplicationCallerLease): void => {
  eventLeases.set(event, lease)
}

const callerLeaseForEvent = (event: CallerLeaseEvent): ApplicationCallerLease => {
  const lease = eventLeases.get(event)
  if (!lease) throw new Error('Application caller lease is not bound to this event.')
  return lease
}

const callerLeaseOwnershipKey = (lease: ApplicationCallerLease): string => {
  const ownershipKey = leaseOwnershipKeys.get(lease)
  if (!ownershipKey) throw new Error('Application caller lease has no ownership key.')
  return ownershipKey
}

// Owns disconnect state for application callers. Surface adapters retain the release capability;
// command handlers receive only the immutable lease and its read-only AbortSignal.
class ApplicationCallerLeaseRegistry {
  private readonly active = new Map<string, LeaseState>()
  private nextGeneration = 0
  private disposed = false

  acquire(identity: Pick<CallerContext, 'leaseId' | 'surface'>): OwnedApplicationCallerLease {
    if (this.disposed) throw new Error('Application caller lease registry is disposed.')
    const { leaseId } = identity
    const ownershipKey = callerLeaseOwnershipKeyForContext(identity)

    const previous = this.active.get(ownershipKey)
    if (previous) {
      this.active.delete(ownershipKey)
      previous.controller.abort()
    }

    const generation = ++this.nextGeneration
    const controller = new AbortController()
    const token = Object.freeze({})
    const lease: ApplicationCallerLease = Object.freeze({
      leaseId,
      generation,
      signal: controller.signal,
      isCurrent: () => this.active.get(ownershipKey)?.token === token && !controller.signal.aborted
    })
    leaseOwnershipKeys.set(lease, ownershipKey)
    const state: LeaseState = { token, controller }
    this.active.set(ownershipKey, state)

    return Object.freeze({
      lease,
      release: () => {
        if (this.active.get(ownershipKey) !== state) return
        this.active.delete(ownershipKey)
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

export {
  ApplicationCallerLeaseRegistry,
  bindCallerLeaseToEvent,
  callerLeaseForEvent,
  callerLeaseOwnershipKey,
  callerLeaseOwnershipKeyForContext
}
export type { OwnedApplicationCallerLease }
