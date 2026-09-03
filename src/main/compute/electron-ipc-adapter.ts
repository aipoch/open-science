import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import {
  normalizeComputeApprovalDecision,
  type CancelComputeJobRequest,
  type ChangeComputeHostAuthenticationRequest,
  type ComputeApprovalDecisionInput,
  type ComputeJobsListFilter,
  type ComputeJobsPendingNotificationFilter,
  type ComputeJobAnalysisTransition,
  type CreateComputeHostRequest,
  type CreatePasswordComputeHostRequest,
  type DeleteComputeHostRequest,
  type DetailsAuthor,
  type ResetPasswordComputeHostRequest,
  type SetComputeJobRemoteCleanupRequest
} from '../../shared/compute'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import type { DownloadDest, SerializableRemoteFsError } from '../../shared/remote-fs'
import { encodeRemoteFsError } from '../../shared/remote-fs'
import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'
import { broadcastLifecycleEvent, getLifecycleClientId } from '../lifecycle-broadcast'
import type { ComputeHandlers } from './ipc'
import type { SessionEnabledComputeHostsOwner } from './session-enabled-hosts-owner'

// IPC channel name for the renderer job feed (Phase 3d, issue 05).
const COMPUTE_JOBS_LIST_CHANNEL = 'compute:jobs:list'

const finiteNumberSchema = z.number().finite()
const integerSchema = finiteNumberSchema.int()
const stringArraySchema = z.array(z.string())
const detailsAuthorSchema = z.enum(['user', 'agent']) satisfies z.ZodType<DetailsAuthor>

const createComputeHostRequestSchema = z
  .object({
    sshAlias: z.string(),
    displayName: z.string().optional(),
    detailsDoc: z.string().optional(),
    sshOverrides: z
      .object({
        user: z.string().optional(),
        port: finiteNumberSchema.optional(),
        identityFile: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict() satisfies z.ZodType<CreateComputeHostRequest>

const createPasswordComputeHostRequestSchema = z
  .object({
    sshAlias: z.string(),
    displayName: z.string().optional(),
    detailsDoc: z.string().optional(),
    authenticationMode: z.literal('password'),
    username: z.string(),
    port: finiteNumberSchema,
    password: z.string(),
    operationId: z.string()
  })
  .strict() satisfies z.ZodType<CreatePasswordComputeHostRequest>

const resetPasswordComputeHostRequestSchema = z
  .object({
    providerId: z.string(),
    password: z.string(),
    operationId: z.string(),
    expectedAuthenticationRevision: integerSchema
  })
  .strict() satisfies z.ZodType<ResetPasswordComputeHostRequest>

const changeComputeHostAuthenticationRequestSchema = z
  .object({
    providerId: z.string(),
    expectedRevision: integerSchema,
    operationId: z.string(),
    authenticationMode: z.enum(['ssh_config', 'password']),
    username: z.string().optional(),
    port: finiteNumberSchema,
    identityFile: z.string().optional(),
    password: z.string().optional()
  })
  .strict() satisfies z.ZodType<ChangeComputeHostAuthenticationRequest>

const deleteComputeHostRequestSchema = z
  .object({ providerId: z.string() })
  .strict() satisfies z.ZodType<DeleteComputeHostRequest>

const downloadDestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), projectId: z.string() }).strict(),
  z.object({ kind: z.literal('os-downloads') }).strict(),
  z.object({ kind: z.literal('session-cache') }).strict()
]) satisfies z.ZodType<DownloadDest>

const computeApprovalResponseSchema = z
  .object({
    id: z.string(),
    decision: z.enum(['once', 'session', 'conversation', 'project', 'global', 'deny'])
  })
  .strict() satisfies z.ZodType<{ id: string; decision: ComputeApprovalDecisionInput }>

const computeJobsListFilterSchema = z.union([
  z.object({ sessionId: z.string(), status: stringArraySchema.optional() }).strict(),
  z.object({ nonTerminal: z.literal(true) }).strict()
]) satisfies z.ZodType<ComputeJobsListFilter>

const computeJobsPendingNotificationFilterSchema = z.union([
  z.string(),
  z.object({ allSessions: z.literal(true) }).strict()
]) satisfies z.ZodType<ComputeJobsPendingNotificationFilter>
const computeJobAnalysisTransitionSchema = z
  .object({
    sessionId: z.string(),
    jobIds: stringArraySchema,
    messageId: z.string(),
    state: z.enum(['dispatched', 'succeeded', 'failed', 'cancelled'])
  })
  .strict() satisfies z.ZodType<ComputeJobAnalysisTransition>

const cancelComputeJobRequestSchema = z
  .object({
    jobId: z.string(),
    providerId: z.string(),
    sessionId: z.string(),
    projectId: z.string()
  })
  .strict() satisfies z.ZodType<CancelComputeJobRequest>

const setComputeJobRemoteCleanupRequestSchema = z
  .object({
    jobId: z.string(),
    providerId: z.string(),
    sessionId: z.string(),
    projectId: z.string(),
    disposition: z.enum(['cleaned', 'abandoned'])
  })
  .strict() satisfies z.ZodType<SetComputeJobRemoteCleanupRequest>

const computeIpcArgumentSchemas = Object.freeze({
  'compute:list': z.tuple([]),
  'compute:get': z.tuple([z.string()]),
  'compute:create': z.tuple([createComputeHostRequestSchema]),
  'compute:create-password': z.tuple([createPasswordComputeHostRequestSchema]),
  'compute:reset-password': z.tuple([resetPasswordComputeHostRequestSchema]),
  'compute:change-authentication': z.tuple([changeComputeHostAuthenticationRequestSchema]),
  'compute:password-capability': z.tuple([]),
  'compute:deletion-status': z.tuple([deleteComputeHostRequestSchema]),
  'compute:delete': z.tuple([deleteComputeHostRequestSchema]),
  'compute:ssh-config-aliases': z.tuple([]),
  'compute:probe': z.tuple([z.string()]),
  'compute:details:get': z.tuple([z.string()]),
  'compute:details:save': z.tuple([z.string(), z.string(), z.string(), detailsAuthorSchema]),
  'compute:scratch:set': z.tuple([z.string(), z.string()]),
  'compute:scratch:clear': z.tuple([z.string()]),
  'compute:concurrency:set': z.tuple([z.string(), finiteNumberSchema]),
  'compute:session:set-concurrency-limit': z.tuple([z.string(), finiteNumberSchema]),
  'compute:session:status': z.tuple([z.string()]),
  'compute:list-dir': z.tuple([z.string(), z.string()]),
  'compute:download': z.tuple([z.string(), z.string(), downloadDestSchema]),
  'compute:reveal-in-folder': z.tuple([z.string()]),
  'compute:approval-respond': z.tuple([computeApprovalResponseSchema]),
  'compute:approval-replay': z.tuple([z.string()]),
  'compute:approval-replay-pending': z.tuple([]),
  'compute:jobs:list': z.tuple([computeJobsListFilterSchema]),
  'compute:jobs:cancel': z.tuple([cancelComputeJobRequestSchema]),
  'compute:jobs:set-remote-cleanup': z.tuple([setComputeJobRemoteCleanupRequestSchema]),
  'compute:jobs:pending-notification': z.tuple([computeJobsPendingNotificationFilterSchema]),
  'compute:jobs:mark-consumed': z.tuple([z.string(), stringArraySchema]),
  'compute:jobs:transition-analysis': z.tuple([computeJobAnalysisTransitionSchema]),
  'compute:enabled-hosts:get': z.tuple([z.string()]),
  'compute:enabled-hosts:set': z.tuple([z.string(), stringArraySchema]),
  'compute:host-enabled:set': z.tuple([z.string(), z.string(), z.boolean()]),
  'compute:host-selected:set': z.tuple([z.string(), z.string(), z.boolean()])
})

type ComputeIpcChannel = keyof typeof computeIpcArgumentSchemas
type ComputeIpcArguments<Channel extends ComputeIpcChannel> = z.output<
  (typeof computeIpcArgumentSchemas)[Channel]
>

const COMPUTE_IPC_CHANNELS: readonly ComputeIpcChannel[] = Object.freeze(
  (Object.keys(computeIpcArgumentSchemas) as ComputeIpcChannel[]).sort()
)

const decodeComputeIpcArguments = <Channel extends ComputeIpcChannel>(
  channel: Channel,
  input: readonly unknown[]
): ComputeIpcArguments<Channel> => {
  const result = computeIpcArgumentSchemas[channel].safeParse(input)
  if (!result.success) {
    throw new Error(`Invalid arguments for Electron IPC channel: ${channel}`)
  }
  return result.data as ComputeIpcArguments<Channel>
}

type ComputeIpcAdapter = {
  handlers: ComputeHandlers
  enabledHosts: Pick<
    SessionEnabledComputeHostsOwner,
    'get' | 'set' | 'setHostEnabled' | 'setHostSelected'
  >
}

const handleComputeIpc = <Channel extends ComputeIpcChannel>(
  channel: Channel,
  listener: (event: IpcMainInvokeEvent, ...args: ComputeIpcArguments<Channel>) => unknown
): void => {
  ipcMainHandle(channel, (event, ...input) =>
    listener(event, ...decodeComputeIpcArguments(channel, input))
  )
}

const registerComputeIpcHandlerSet = ({ handlers, enabledHosts }: ComputeIpcAdapter): void => {
  handleComputeIpc('compute:list', () => handlers.list())
  handleComputeIpc('compute:get', (_event, providerId) => handlers.get(providerId))
  handleComputeIpc('compute:create', (_event, request) => handlers.create(request))
  handleComputeIpc('compute:create-password', (_event, request) => handlers.createPassword(request))
  handleComputeIpc('compute:reset-password', (_event, request) => handlers.resetPassword(request))
  handleComputeIpc('compute:change-authentication', (_event, request) =>
    handlers.changeAuthentication(request)
  )
  handleComputeIpc('compute:password-capability', () => handlers.passwordCapability())
  handleComputeIpc('compute:deletion-status', (_event, request) =>
    handlers.deletionStatus(request.providerId)
  )
  handleComputeIpc('compute:delete', async (_event, request) => {
    await handlers.delete(request.providerId)
  })
  handleComputeIpc('compute:ssh-config-aliases', () => handlers.sshConfigAliases())
  handleComputeIpc('compute:probe', (_event, providerId) => handlers.probe(providerId))
  handleComputeIpc('compute:details:get', (_event, providerId) => handlers.detailsGet(providerId))
  handleComputeIpc('compute:details:save', (_event, providerId, text, oldText, author) =>
    handlers.detailsSave(providerId, text, oldText, author)
  )
  handleComputeIpc('compute:scratch:set', (_event, providerId, path) =>
    handlers.scratchSet(providerId, path)
  )
  handleComputeIpc('compute:scratch:clear', (_event, providerId) =>
    handlers.scratchClear(providerId)
  )
  handleComputeIpc('compute:concurrency:set', (_event, providerId, limit) =>
    handlers.concurrencySet(providerId, limit)
  )
  // Session-level concurrency control (Phase 3c, issue 04).
  handleComputeIpc('compute:session:set-concurrency-limit', (_event, sessionId, limit) =>
    handlers.setSessionConcurrencyLimit(sessionId, limit)
  )
  handleComputeIpc('compute:session:status', (_event, sessionId) =>
    handlers.getSessionConcurrencyStatus(sessionId)
  )
  // Lists a remote directory (browse experience, issue 05).
  handleComputeIpc('compute:list-dir', async (_event, providerId, path) => {
    try {
      return await handlers.listDir(providerId, path)
    } catch (err) {
      const e = err as Error & { remoteFsError?: SerializableRemoteFsError }
      if (e.remoteFsError) {
        throw new Error(encodeRemoteFsError(e.message, e.remoteFsError))
      }
      throw err
    }
  })
  // Downloads a remote file to OS Downloads or project artifact. No approval gate (issue 03).
  handleComputeIpc('compute:download', async (_event, providerId, remotePath, dest) => {
    try {
      return await handlers.download(providerId, remotePath, dest)
    } catch (err) {
      const e = err as Error & { remoteFsError?: SerializableRemoteFsError }
      if (e.remoteFsError) {
        throw new Error(encodeRemoteFsError(e.message, e.remoteFsError))
      }
      throw err
    }
  })
  // Reveals a local file path in the OS file manager (Finder / Explorer).
  handleComputeIpc('compute:reveal-in-folder', (_event, filePath) => {
    handlers.revealInFolder(filePath)
  })
  // Renderer responds to an in-flight approval card. Legacy `conversation` input is normalized at
  // this transport boundary; the broker only receives the canonical Session scope.
  handleComputeIpc('compute:approval-respond', (_event, request) => {
    handlers.approvalRespond(request.id, normalizeComputeApprovalDecision(request.decision))
  })
  handleComputeIpc('compute:approval-replay', (_event, id) => handlers.approvalReplay(id))
  handleComputeIpc('compute:approval-replay-pending', () => handlers.approvalReplayPending())
  // Returns a Session job feed or the global non-terminal activity projection.
  handleComputeIpc(COMPUTE_JOBS_LIST_CHANNEL, (_event, filter) => handlers.jobsList(filter))
  handleComputeIpc('compute:jobs:cancel', (_event, request) => handlers.jobsCancel(request))
  handleComputeIpc('compute:jobs:set-remote-cleanup', (_event, request) =>
    handlers.jobsSetRemoteCleanup(request)
  )
  // Returns jobs pending analysis turn (notifiedAt set, notificationConsumedAt null — issue 05).
  handleComputeIpc('compute:jobs:pending-notification', (_event, filter) =>
    handlers.jobsPendingNotification(filter)
  )
  // Marks job ids as notification-consumed (analysis turn done — issue 05).
  handleComputeIpc('compute:jobs:mark-consumed', (_event, sessionId, jobIds) =>
    handlers.jobsMarkConsumed(sessionId, jobIds)
  )
  handleComputeIpc('compute:jobs:transition-analysis', (_event, request) =>
    handlers.jobsTransitionAnalysis(request)
  )

  // Per-session enabled Compute Hosts. Main commits Session authority before updating the runtime
  // projection consulted by legacy list_compute and canonical list_preferred.
  handleComputeIpc('compute:enabled-hosts:get', (_event, sessionId): string[] =>
    enabledHosts.get(sessionId)
  )
  handleComputeIpc('compute:enabled-hosts:set', async (event, sessionId, providerIds) => {
    const originClientId = getLifecycleClientId(event)
    const session = await enabledHosts.set(sessionId, providerIds)
    try {
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
    } catch {
      // Lifecycle delivery cannot roll back committed Session authority.
    }
    return session
  })
  handleComputeIpc('compute:host-enabled:set', async (event, sessionId, providerId, enabled) => {
    const originClientId = getLifecycleClientId(event)
    const session = await enabledHosts.setHostEnabled(sessionId, providerId, enabled)
    try {
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
    } catch {
      // Lifecycle delivery cannot roll back committed Session authority.
    }
    return session
  })
  handleComputeIpc('compute:host-selected:set', async (event, sessionId, providerId, selected) => {
    const originClientId = getLifecycleClientId(event)
    const session = await enabledHosts.setHostSelected(sessionId, providerId, selected)
    try {
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
    } catch {
      // Lifecycle delivery cannot roll back committed Session authority.
    }
    return session
  })
}

// Installs only the renderer-callable Electron adapter over an already-constructed Compute module.
const installComputeIpcHandlers = (adapter: ComputeIpcAdapter): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerComputeIpcHandlerSet(adapter)
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { COMPUTE_IPC_CHANNELS, COMPUTE_JOBS_LIST_CHANNEL, installComputeIpcHandlers }
export type { ComputeIpcAdapter }
