import { type IpcMainInvokeEvent } from 'electron'

import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent, callerLeaseOwnershipKey } from './caller-lifecycle'
import { ipcMainHandle } from './ipc-handler-registry'
import {
  registerManagedPreviewProtocol,
  type PreviewProtocolRegistrar
} from './managed-preview-protocol'

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
  inspect: (
    request: AcquireManagedPreviewRequest
  ) => Promise<AcquireManagedPreviewOptions['snapshot']>
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
    request: AcquireManagedPreviewRequest
  ) => Promise<ManagedPreviewResource>
  readRange: (
    lease: ApplicationCallerLease,
    request: ReadManagedPreviewRangeRequest
  ) => Promise<ManagedPreviewRangeResult>
  release: (lease: ApplicationCallerLease, request: ReleaseManagedPreviewRequest) => void
  register: (lease: ApplicationCallerLease) => OwnerTicket
}

// All adapters for one resource authority must share owner ids and lease teardown state.
const ownerRegistries = new WeakMap<ManagedPreviewHandlers, ManagedPreviewOwnerRegistry>()

// Couples every capability to the current surface-owned caller lease.
const buildManagedPreviewOwnerRegistry = (
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
    request: AcquireManagedPreviewRequest
  ): Promise<ManagedPreviewResource> => {
    const { maxBytes, ...resourceRequest } = request
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new Error('Invalid managed preview byte limit.')
    }

    const ticket = register(lease)
    let resource: ManagedPreviewResource
    if (maxBytes !== undefined) {
      const snapshot = await handlers.inspect(resourceRequest)
      if (!isActive(ticket, lease)) {
        throw new Error('Managed preview owner is no longer available.')
      }
      resource = await handlers.acquire(ticket.ownerId, resourceRequest, { snapshot, maxBytes })
    } else {
      resource = await handlers.acquire(ticket.ownerId, resourceRequest)
    }

    // Acquisition may finish after renderer teardown; immediately revoke that late capability.
    if (!isActive(ticket, lease)) {
      handlers.release(ticket.ownerId, { resourceId: resource.id })
      throw new Error('Managed preview owner is no longer available.')
    }

    return resource
  }

  const readRange = (
    lease: ApplicationCallerLease,
    request: ReadManagedPreviewRangeRequest
  ): Promise<ManagedPreviewRangeResult> => handlers.readRange(register(lease).ownerId, request)

  const release = (lease: ApplicationCallerLease, request: ReleaseManagedPreviewRequest): void =>
    handlers.release(register(lease).ownerId, request)

  return { acquire, readRange, register, release }
}

const createManagedPreviewOwnerRegistry = (
  handlers: ManagedPreviewHandlers
): ManagedPreviewOwnerRegistry => {
  const existing = ownerRegistries.get(handlers)
  if (existing) return existing

  const registry = buildManagedPreviewOwnerRegistry(handlers)
  ownerRegistries.set(handlers, registry)
  return registry
}

const registerManagedPreviewIpcHandlers = (
  resources: ManagedPreviewResources,
  injectedOwners?: ManagedPreviewOwnerRegistry
): (() => void) => {
  const existingOwners = ownerRegistries.get(resources)
  if (injectedOwners && existingOwners && existingOwners !== injectedOwners) {
    throw new Error('Managed preview resources already have a different owner registry.')
  }
  const owners = injectedOwners ?? existingOwners ?? buildManagedPreviewOwnerRegistry(resources)
  const bindsOwners = existingOwners === undefined

  const callerLease = (event: IpcMainInvokeEvent): ApplicationCallerLease =>
    callerLeaseForEvent(event)

  ipcMainHandle('preview-resources:acquire', (event, request: AcquireManagedPreviewRequest) =>
    owners.acquire(callerLease(event), request)
  )
  ipcMainHandle('preview-resources:read-range', (event, request: ReadManagedPreviewRangeRequest) =>
    owners.readRange(callerLease(event), request)
  )
  ipcMainHandle('preview-resources:release', (event, request: ReleaseManagedPreviewRequest) =>
    owners.release(callerLease(event), request)
  )
  ownerRegistries.set(resources, owners)
  return () => {
    if (bindsOwners && ownerRegistries.get(resources) === owners) {
      ownerRegistries.delete(resources)
    }
  }
}

const installManagedPreviewElectronAdapter = (
  resources: ManagedPreviewResources,
  targetProtocol?: PreviewProtocolRegistrar,
  injectedOwners?: ManagedPreviewOwnerRegistry
): (() => void) => {
  const cleanupOwners = registerManagedPreviewIpcHandlers(resources, injectedOwners)
  try {
    const unregisterProtocol = registerManagedPreviewProtocol(resources, targetProtocol)
    return () => {
      try {
        unregisterProtocol()
      } finally {
        cleanupOwners()
      }
    }
  } catch (error) {
    cleanupOwners()
    throw error
  }
}

export {
  createManagedPreviewOwnerRegistry,
  installManagedPreviewElectronAdapter,
  registerManagedPreviewIpcHandlers
}
export type { ManagedPreviewHandlers, ManagedPreviewOwnerRegistry }
