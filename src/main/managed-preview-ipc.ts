import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'

type ManagedPreviewHandlers = {
  acquire: (
    ownerId: number,
    request: AcquireManagedPreviewRequest
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
    request: AcquireManagedPreviewRequest
  ) => Promise<ManagedPreviewResource>
  register: (event: IpcMainInvokeEvent) => OwnerTicket
}

const createManagedPreviewHandlers = (
  resources: ManagedPreviewResources
): ManagedPreviewHandlers => ({
  acquire: (ownerId, request) => resources.acquire(ownerId, request),
  readRange: (ownerId, request) => resources.readRange(ownerId, request),
  release: (ownerId, request) => resources.release(ownerId, request),
  releaseOwner: (ownerId) => resources.releaseOwner(ownerId)
})

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
    request: AcquireManagedPreviewRequest
  ): Promise<ManagedPreviewResource> => {
    const ticket = register(event)
    const resource = await handlers.acquire(ticket.ownerId, request)

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
  const handlers = createManagedPreviewHandlers(resources)
  const owners = createManagedPreviewOwnerRegistry(handlers)
  const ownerId = (event: IpcMainInvokeEvent): number => owners.register(event).ownerId

  ipcMain.handle('preview-resources:acquire', (event, request: AcquireManagedPreviewRequest) =>
    owners.acquire(event, request)
  )
  ipcMain.handle('preview-resources:read-range', (event, request: ReadManagedPreviewRangeRequest) =>
    handlers.readRange(ownerId(event), request)
  )
  ipcMain.handle('preview-resources:release', (event, request: ReleaseManagedPreviewRequest) =>
    handlers.release(ownerId(event), request)
  )
}

export {
  createManagedPreviewHandlers,
  createManagedPreviewOwnerRegistry,
  registerManagedPreviewIpcHandlers
}
export type { ManagedPreviewHandlers }
