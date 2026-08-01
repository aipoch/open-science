import type { IpcMainInvokeEvent } from 'electron'

import type {
  ApproveRemotePairingRequest,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  SetRemoteAccessModeRequest
} from '../../shared/remote-access'
import { callerContextForEvent } from '../caller-context'
import { ipcMainHandle, isRemotePairingManagerSender } from '../ipc-handler-registry'
import { RemoteAccessService } from './service'

const isDesktopSender = (event: IpcMainInvokeEvent): boolean =>
  callerContextForEvent(event).surface === 'electron'

const requireDesktopSender = (event: IpcMainInvokeEvent): void => {
  if (!isDesktopSender(event)) {
    throw new Error('This action must be approved from the Open Science desktop app.')
  }
}

const canManagePairing = (event: IpcMainInvokeEvent): boolean =>
  isDesktopSender(event) || isRemotePairingManagerSender(event)

const requirePairingManager = (event: IpcMainInvokeEvent): void => {
  if (!canManagePairing(event)) {
    throw new Error(
      'Pairing can only be managed from the Open Science desktop app or an approved browser.'
    )
  }
}

export const registerRemoteAccessIpcHandlers = (service: RemoteAccessService): void => {
  ipcMainHandle('remote-access:get-snapshot', (event) => {
    const desktop = isDesktopSender(event)
    return service.snapshot(desktop, canManagePairing(event))
  })
  ipcMainHandle('remote-access:detect', async (event) => {
    requireDesktopSender(event)
    return service.detect()
  })
  ipcMainHandle('remote-access:set-mode', async (event, request: SetRemoteAccessModeRequest) => {
    requireDesktopSender(event)
    return service.setMode(request.mode)
  })
  ipcMainHandle('remote-access:disable', async (event) => {
    requireDesktopSender(event)
    return service.disable()
  })
  ipcMainHandle('remote-access:approve', async (event, request: ApproveRemotePairingRequest) => {
    requirePairingManager(event)
    const desktop = isDesktopSender(event)
    return service.approve(request, desktop, canManagePairing(event))
  })
  ipcMainHandle('remote-access:reject', (event, request: RemotePairingRequestId) => {
    requirePairingManager(event)
    const desktop = isDesktopSender(event)
    return service.reject(request.requestId, desktop, canManagePairing(event))
  })
  ipcMainHandle(
    'remote-access:revoke-browser',
    async (event, request: RevokeRemoteBrowserRequest) => {
      requirePairingManager(event)
      const desktop = isDesktopSender(event)
      return service.revoke(request.browserId, desktop, canManagePairing(event))
    }
  )
}

export { canManagePairing, isDesktopSender, requireDesktopSender, requirePairingManager }
