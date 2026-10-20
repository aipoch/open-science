import type {
  ApproveRemotePairingRequest,
  RemoteAccessMode,
  RemoteAccessSnapshot
} from '../../shared/remote-access'

export type RemoteAccessCommandPort = {
  snapshot(canManage: boolean, canManagePairing?: boolean): RemoteAccessSnapshot
  probe(): Promise<RemoteAccessSnapshot>
  detect(): Promise<RemoteAccessSnapshot>
  setMode(
    mode: RemoteAccessMode,
    options?: {
      persistPreference?: boolean
      forceReconcile?: boolean
    }
  ): Promise<RemoteAccessSnapshot>
  disable(): Promise<RemoteAccessSnapshot>
  approve(
    request: ApproveRemotePairingRequest,
    canManage?: boolean,
    canManagePairing?: boolean
  ): Promise<RemoteAccessSnapshot>
  reject(
    requestId: string,
    canManage?: boolean,
    canManagePairing?: boolean
  ): Promise<RemoteAccessSnapshot>
  revoke(
    browserId: string,
    canManage?: boolean,
    canManagePairing?: boolean
  ): Promise<RemoteAccessSnapshot>
  revokeBrowsers(
    browserIds: string[],
    canManage?: boolean,
    canManagePairing?: boolean
  ): Promise<RemoteAccessSnapshot>
}
