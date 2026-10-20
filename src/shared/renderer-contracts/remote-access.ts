import type {
  ApproveRemotePairingRequest,
  RemoteAccessSnapshot,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  RevokeRemoteBrowsersRequest,
  SetRemoteAccessModeRequest
} from '../remote-access'

import { callable, ELECTRON, LOCAL, type RemoveListener, EVENT } from './definition'

export const contracts = {
  'remoteAccess.approve': callable<
    (request: ApproveRemotePairingRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:approve']),
  'remoteAccess.detect': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:detect',
    ELECTRON
  ]),
  'remoteAccess.probe': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:probe',
    LOCAL
  ]),
  'remoteAccess.disable': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:disable',
    ELECTRON
  ]),
  'remoteAccess.getSnapshot': callable<() => Promise<RemoteAccessSnapshot>>()('remote-access', [
    'remote-access:get-snapshot'
  ]),
  'remoteAccess.onChanged': callable<(listener: () => void) => RemoveListener>()('remote-access', [
    'remote-access:changed',
    EVENT
  ]),
  'remoteAccess.reject': callable<
    (request: RemotePairingRequestId) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:reject']),
  'remoteAccess.revokeBrowser': callable<
    (request: RevokeRemoteBrowserRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:revoke-browser']),
  'remoteAccess.revokeBrowsers': callable<
    (request: RevokeRemoteBrowsersRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:revoke-browsers']),
  'remoteAccess.setMode': callable<
    (request: SetRemoteAccessModeRequest) => Promise<RemoteAccessSnapshot>
  >()('remote-access', ['remote-access:set-mode', ELECTRON])
} as const
