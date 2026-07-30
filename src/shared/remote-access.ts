export type RemoteAccessLifecycle = 'disabled' | 'starting' | 'running' | 'stopping' | 'error'
export type RemoteAccessMode = 'off' | 'remoteit' | 'remoteit-public'

export type RemoteItService = {
  id: string
  host: string
  port: number
  enabled: boolean
  ready: boolean
}

export type RemoteItInstallation = {
  installed: boolean
  loggedIn: boolean
  registered: boolean
  binaryPath?: string
  version?: string
  account?: string
  deviceId?: string
  service?: RemoteItService
  error?: string
}

export type RemotePairingRequestView = {
  id: string
  code: string
  browser: string
  platform: string
  address?: string
  requestedAt: number
  expiresAt: number
}

export type TrustedRemoteBrowserView = {
  id: string
  browser: string
  platform: string
  createdAt: number
  lastSeenAt: number
}

export type RemoteAccessSnapshot = {
  /** Controls computer-local third-party route lifecycle and installation settings. */
  canManage: boolean
  /** Controls pairing approvals and the persistent trusted-browser list. */
  canManagePairing: boolean
  mode: RemoteAccessMode
  /** Backward-compatible runtime flag. Equivalent to mode !== 'off' while running. */
  enabled: boolean
  lifecycle: RemoteAccessLifecycle
  /** Active private or public HTTPS endpoint. */
  accessUrl?: string
  /** Saved browser-access endpoint, including while locally disabled. */
  remoteItPublicUrl?: string
  error?: string
  remoteIt: RemoteItInstallation
  pendingRequests: RemotePairingRequestView[]
  trustedBrowsers: TrustedRemoteBrowserView[]
}

export type RemotePairingDecision = 'once' | 'always'

export type ApproveRemotePairingRequest = {
  requestId: string
  decision: RemotePairingDecision
}

export type RemotePairingRequestId = {
  requestId: string
}

export type RevokeRemoteBrowserRequest = {
  browserId: string
}

export type SetRemoteAccessModeRequest = {
  mode: RemoteAccessMode
}

export const REMOTE_ACCESS_CHANGED_CHANNEL = 'remote-access:changed'
