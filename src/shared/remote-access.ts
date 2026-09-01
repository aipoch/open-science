import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

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
  expiresAt: number
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

export const remoteAccessModeSchema: z.ZodType<RemoteAccessMode> = z.enum([
  'off',
  'remoteit',
  'remoteit-public'
])
export const remotePairingDecisionSchema: z.ZodType<RemotePairingDecision> = z.enum([
  'once',
  'always'
])
export const approveRemotePairingRequestSchema: z.ZodType<ApproveRemotePairingRequest> = z
  .object({
    requestId: z.string().min(1),
    decision: remotePairingDecisionSchema
  })
  .strict()
export const remotePairingRequestIdSchema: z.ZodType<RemotePairingRequestId> = z
  .object({ requestId: z.string().min(1) })
  .strict()
export const revokeRemoteBrowserRequestSchema: z.ZodType<RevokeRemoteBrowserRequest> = z
  .object({ browserId: z.string().min(1) })
  .strict()
export const setRemoteAccessModeRequestSchema: z.ZodType<SetRemoteAccessModeRequest> = z
  .object({ mode: remoteAccessModeSchema })
  .strict()

const remoteAccessLifecycleSchema: z.ZodType<RemoteAccessLifecycle> = z.enum([
  'disabled',
  'starting',
  'running',
  'stopping',
  'error'
])
const remoteItServiceSchema: z.ZodType<RemoteItService> = z
  .object({
    id: z.string(),
    host: z.string(),
    port: z.number().int().nonnegative().max(65535),
    enabled: z.boolean(),
    ready: z.boolean()
  })
  .strict()
const remoteItInstallationSchema: z.ZodType<RemoteItInstallation> = z
  .object({
    installed: z.boolean(),
    loggedIn: z.boolean(),
    registered: z.boolean(),
    binaryPath: z.string().optional(),
    version: z.string().optional(),
    account: z.string().optional(),
    deviceId: z.string().optional(),
    service: remoteItServiceSchema.optional(),
    error: z.string().optional()
  })
  .strict()
const remotePairingRequestViewSchema: z.ZodType<RemotePairingRequestView> = z
  .object({
    id: z.string(),
    code: z.string(),
    browser: z.string(),
    platform: z.string(),
    address: z.string().optional(),
    requestedAt: z.number().finite(),
    expiresAt: z.number().finite()
  })
  .strict()
const trustedRemoteBrowserViewSchema: z.ZodType<TrustedRemoteBrowserView> = z
  .object({
    id: z.string(),
    browser: z.string(),
    platform: z.string(),
    createdAt: z.number().finite(),
    lastSeenAt: z.number().finite(),
    expiresAt: z.number().finite()
  })
  .strict()
export const remoteAccessSnapshotSchema: z.ZodType<RemoteAccessSnapshot> = z
  .object({
    canManage: z.boolean(),
    canManagePairing: z.boolean(),
    mode: remoteAccessModeSchema,
    enabled: z.boolean(),
    lifecycle: remoteAccessLifecycleSchema,
    accessUrl: z.string().optional(),
    remoteItPublicUrl: z.string().optional(),
    error: z.string().optional(),
    remoteIt: remoteItInstallationSchema,
    pendingRequests: z.array(remotePairingRequestViewSchema),
    trustedBrowsers: z.array(trustedRemoteBrowserViewSchema)
  })
  .strict()

const remoteAccessSnapshotResult = validationCodec(remoteAccessSnapshotSchema)
export const remoteAccessApplicationCommandContracts = Object.freeze({
  approve: defineApplicationCommandContract(
    validationCodec(z.tuple([approveRemotePairingRequestSchema])),
    remoteAccessSnapshotResult
  ),
  detect: defineApplicationCommandContract(
    validationCodec(z.tuple([])),
    remoteAccessSnapshotResult
  ),
  probe: defineApplicationCommandContract(validationCodec(z.tuple([])), remoteAccessSnapshotResult),
  disable: defineApplicationCommandContract(
    validationCodec(z.tuple([])),
    remoteAccessSnapshotResult
  ),
  getSnapshot: defineApplicationCommandContract(
    validationCodec(z.tuple([])),
    remoteAccessSnapshotResult
  ),
  reject: defineApplicationCommandContract(
    validationCodec(z.tuple([remotePairingRequestIdSchema])),
    remoteAccessSnapshotResult
  ),
  revokeBrowser: defineApplicationCommandContract(
    validationCodec(z.tuple([revokeRemoteBrowserRequestSchema])),
    remoteAccessSnapshotResult
  ),
  setMode: defineApplicationCommandContract(
    validationCodec(z.tuple([setRemoteAccessModeRequestSchema])),
    remoteAccessSnapshotResult
  )
})

export const REMOTE_ACCESS_CHANGED_CHANNEL = 'remote-access:changed'
