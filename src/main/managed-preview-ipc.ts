import { type IpcMainInvokeEvent } from 'electron'

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

type OwnerTicket = { ownerId: number; generation: number }
type ManagedPreviewOwnerRegistry = {
  acquire: (
    event: IpcMainInvokeEvent,
    request: AcquireManagedPreviewRequest,
    prepareOptions?: () => Promise<AcquireManagedPreviewOptions>
  ) => Promise<ManagedPreviewResource>
  register: (event: IpcMainInvokeEvent) => OwnerTicket
}

// Couples every capability to the renderer process that acquired it.
const createManagedPreviewOwnerRegistry = (
  handlers: ManagedPreviewHandlers
): ManagedPreviewOwnerRegistry => {
  const activeGenerations = new Map<number, number>()
  let nextGeneration = 0

  // Generations prevent a stale crash listener from releasing resources after an owner id is reused.
  const register = (event: IpcMainInvokeEvent): OwnerTicket => {
    const ownerId = event.sender.id
    const activeGeneration = activeGenerations.get(ownerId)
    if (activeGeneration !== undefined) return { ownerId, generation: activeGeneration }

    const ticket = { ownerId, generation: ++nextGeneration }
    activeGenerations.set(ownerId, ticket.generation)
    const releaseOwner = (): void => {
      if (activeGenerations.get(ownerId) !== ticket.generation) return
      activeGenerations.delete(ownerId)
      handlers.releaseOwner(ownerId)
    }
    event.sender.once('destroyed', releaseOwner)
    event.sender.once('render-process-gone', releaseOwner)
    return ticket
  }

  const isActive = (ticket: OwnerTicket): boolean =>
    activeGenerations.get(ticket.ownerId) === ticket.generation

  const acquire = async (
    event: IpcMainInvokeEvent,
    request: AcquireManagedPreviewRequest,
    prepareOptions?: () => Promise<AcquireManagedPreviewOptions>
  ): Promise<ManagedPreviewResource> => {
    const ticket = register(event)
    let resource: ManagedPreviewResource
    if (prepareOptions) {
      const options = await prepareOptions()
      if (!isActive(ticket)) {
        throw new Error('Managed preview owner is no longer available.')
      }
      resource = await handlers.acquire(ticket.ownerId, request, options)
    } else {
      resource = await handlers.acquire(ticket.ownerId, request)
    }

    // Acquisition may finish after renderer teardown; immediately revoke that late capability.
    if (!isActive(ticket)) {
      handlers.release(ticket.ownerId, { resourceId: resource.id })
      throw new Error('Managed preview owner is no longer available.')
    }

    return resource
  }

  return { acquire, register }
}

const registerManagedPreviewIpcHandlers = (resources: ManagedPreviewResources): void => {
  const owners = createManagedPreviewOwnerRegistry(resources)
  const ownerId = (event: IpcMainInvokeEvent): number => owners.register(event).ownerId

  ipcMainHandle(
    'preview-resources:acquire',
    async (event, { maxBytes, ...request }: AcquireManagedPreviewRequest) => {
      if (maxBytes === undefined) return owners.acquire(event, request)
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Invalid managed preview byte limit.')
      }

      return owners.acquire(event, request, async () => ({
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
