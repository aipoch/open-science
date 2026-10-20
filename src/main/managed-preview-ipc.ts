import type { IpcMainInvokeEvent } from 'electron'

import type { ApplicationCallerLease } from './application-command-router'
import { callerLeaseForEvent } from './caller-lifecycle'
import { ipcMainHandle } from './ipc-handler-registry'
import {
  registerManagedPreviewProtocol,
  type PreviewProtocolRegistrar
} from './managed-preview-protocol'

import type {
  AcquireManagedPreviewRequest,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'
import {
  createManagedPreviewOwnerRegistry,
  ownerRegistries,
  buildManagedPreviewOwnerRegistry,
  type ManagedPreviewOwnerRegistry,
  type ManagedPreviewHandlers
} from './managed-preview-owner-registry'

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
