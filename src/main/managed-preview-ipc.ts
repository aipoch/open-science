import { type IpcMainInvokeEvent } from 'electron'

import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent, callerLeaseOwnershipKey } from './caller-lifecycle'
import { ipcMainHandle } from './ipc-handler-registry'

import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'
import type { AcquireManagedPreviewOptions } from './managed-preview-resources'

type ManagedPreviewHandlers = {
  acquire: (
    ownerId: number,
    request: AcquireManagedPreviewRequest,
    options?: AcquireManagedPreviewOptions
  ) => Promise<ManagedPreviewResource>
  readRange: (
    ownerId: number,
    request: ReadManagedPreviewRangeRequest
  ) => Promise<ManagedPreviewRangeResult>
  release: (ownerId: number, request: ReleaseManagedPreviewRequest) => void
  releaseOwner: (ownerId: number) => void
}

type OwnerTicket = { ownerId: number; ownershipKey: string; generation: number }
type ManagedPreviewOwnerRegistry = {
  acquire: (
    lease: ApplicationCallerLease,
    request: AcquireManagedPreviewRequest,
    prepareOptions?: () => Promise<AcquireManagedPreviewOptions>
  ) => Promise<ManagedPreviewResource>
  register: (lease: ApplicationCallerLease) => OwnerTicket
}

// Couples every capability to the current surface-owned caller lease.
const createManagedPreviewOwnerRegistry = (
  handlers: ManagedPreviewHandlers
): ManagedPreviewOwnerRegistry => {
  const active = new Map<string, OwnerTicket>()
  let nextOwnerId = 0

  // Preview resources use opaque negative handles; renderer ids remain transport details.
  const register = (lease: ApplicationCallerLease): OwnerTicket => {
    if (lease.signal.aborted || !lease.isCurrent()) {
      throw new Error('Managed preview owner is no longer available.')
    }
    const ownershipKey = callerLeaseOwnershipKey(lease)
    const current = active.get(ownershipKey)
    if (current?.generation === lease.generation) return current
    if (current) {
      active.delete(ownershipKey)
      handlers.releaseOwner(current.ownerId)
    }
    const ticket = {
      ownerId: --nextOwnerId,
      ownershipKey,
      generation: lease.generation
    }
    active.set(ownershipKey, ticket)
    const releaseOwner = (): void => {
      if (active.get(ownershipKey) !== ticket) return
      active.delete(ownershipKey)
      handlers.releaseOwner(ticket.ownerId)
    }
    lease.signal.addEventListener('abort', releaseOwner, { once: true })
    if (lease.signal.aborted || !lease.isCurrent()) {
      releaseOwner()
      throw new Error('Managed preview owner is no longer available.')
    }
    return ticket
  }

  const isActive = (ticket: OwnerTicket, lease: ApplicationCallerLease): boolean =>
    active.get(ticket.ownershipKey) === ticket && !lease.signal.aborted && lease.isCurrent()

  const acquire = async (
    lease: ApplicationCallerLease,
    request: AcquireManagedPreviewRequest,
    prepareOptions?: () => Promise<AcquireManagedPreviewOptions>
  ): Promise<ManagedPreviewResource> => {
    const ticket = register(lease)
    let resource: ManagedPreviewResource
    if (prepareOptions) {
      const options = await prepareOptions()
      if (!isActive(ticket, lease)) {
        throw new Error('Managed preview owner is no longer available.')
      }
      resource = await handlers.acquire(ticket.ownerId, request, options)
    } else {
      resource = await handlers.acquire(ticket.ownerId, request)
    }

    // Acquisition may finish after renderer teardown; immediately revoke that late capability.
    if (!isActive(ticket, lease)) {
      handlers.release(ticket.ownerId, { resourceId: resource.id })
      throw new Error('Managed preview owner is no longer available.')
    }

    return resource
  }

  return { acquire, register }
}

const registerManagedPreviewIpcHandlers = (resources: ManagedPreviewResources): void => {
  const owners = createManagedPreviewOwnerRegistry(resources)
  const callerLease = (event: IpcMainInvokeEvent): ApplicationCallerLease =>
    callerLeaseForEvent(event)
  const ownerId = (event: IpcMainInvokeEvent): number => owners.register(callerLease(event)).ownerId

  ipcMainHandle(
    'preview-resources:acquire',
    async (event, { maxBytes, ...request }: AcquireManagedPreviewRequest) => {
      const lease = callerLease(event)
      if (maxBytes === undefined) return owners.acquire(lease, request)
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Invalid managed preview byte limit.')
      }

      return owners.acquire(lease, request, async () => ({
        snapshot: await resources.inspect(request),
        maxBytes
      }))
    }
  )
  ipcMainHandle('preview-resources:read-range', (event, request: ReadManagedPreviewRangeRequest) =>
    resources.readRange(ownerId(event), request)
  )
  ipcMainHandle('preview-resources:release', (event, request: ReleaseManagedPreviewRequest) =>
    resources.release(ownerId(event), request)
  )
}

export { createManagedPreviewOwnerRegistry, registerManagedPreviewIpcHandlers }
export type { ManagedPreviewHandlers }
