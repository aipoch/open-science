import type {
  ChangeComputeHostAuthenticationRequest,
  ComputeApprovalDecision,
  ComputeJobsListFilter,
  ComputeJobsPendingNotificationFilter,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  ResetPasswordComputeHostRequest,
  DeleteComputeHostRequest,
  DetailsAuthor
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

type ComputeIpcAdapter = {
  handlers: ComputeHandlers
  enabledHosts: Pick<
    SessionEnabledComputeHostsOwner,
    'get' | 'set' | 'setHostEnabled' | 'setHostSelected'
  >
}

const registerComputeIpcHandlerSet = ({ handlers, enabledHosts }: ComputeIpcAdapter): void => {
  ipcMainHandle('compute:list', () => handlers.list())
  ipcMainHandle('compute:get', (_event, providerId: string) => handlers.get(providerId))
  ipcMainHandle('compute:create', (_event, request: CreateComputeHostRequest) =>
    handlers.create(request)
  )
  ipcMainHandle('compute:create-password', (_event, request: CreatePasswordComputeHostRequest) =>
    handlers.createPassword(request)
  )
  ipcMainHandle('compute:reset-password', (_event, request: ResetPasswordComputeHostRequest) =>
    handlers.resetPassword(request)
  )
  ipcMainHandle(
    'compute:change-authentication',
    (_event, request: ChangeComputeHostAuthenticationRequest) =>
      handlers.changeAuthentication(request)
  )
  ipcMainHandle('compute:password-capability', () => handlers.passwordCapability())
  ipcMainHandle('compute:deletion-status', (_event, request: DeleteComputeHostRequest) =>
    handlers.deletionStatus(request.providerId)
  )
  ipcMainHandle('compute:delete', async (_event, request: DeleteComputeHostRequest) => {
    await handlers.delete(request.providerId)
  })
  ipcMainHandle('compute:ssh-config-aliases', () => handlers.sshConfigAliases())
  ipcMainHandle('compute:probe', (_event, providerId: string) => handlers.probe(providerId))
  ipcMainHandle('compute:details:get', (_event, providerId: string) =>
    handlers.detailsGet(providerId)
  )
  ipcMainHandle(
    'compute:details:save',
    (_event, providerId: string, text: string, oldText: string, author: DetailsAuthor) =>
      handlers.detailsSave(providerId, text, oldText, author)
  )
  ipcMainHandle('compute:scratch:set', (_event, providerId: string, path: string) =>
    handlers.scratchSet(providerId, path)
  )
  ipcMainHandle('compute:concurrency:set', (_event, providerId: string, limit: number) =>
    handlers.concurrencySet(providerId, limit)
  )
  // Session-level concurrency control (Phase 3c, issue 04).
  ipcMainHandle(
    'compute:session:set-concurrency-limit',
    (_event, sessionId: string, limit: number) =>
      handlers.setSessionConcurrencyLimit(sessionId, limit)
  )
  ipcMainHandle('compute:session:status', (_event, sessionId: string) =>
    handlers.getSessionConcurrencyStatus(sessionId)
  )
  // Lists a remote directory (browse experience, issue 05).
  ipcMainHandle('compute:list-dir', async (_event, providerId: string, path: string) => {
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
  ipcMainHandle(
    'compute:download',
    async (_event, providerId: string, remotePath: string, dest: DownloadDest) => {
      try {
        return await handlers.download(providerId, remotePath, dest)
      } catch (err) {
        const e = err as Error & { remoteFsError?: SerializableRemoteFsError }
        if (e.remoteFsError) {
          throw new Error(encodeRemoteFsError(e.message, e.remoteFsError))
        }
        throw err
      }
    }
  )
  // Reveals a local file path in the OS file manager (Finder / Explorer).
  ipcMainHandle('compute:reveal-in-folder', (_event, filePath: string) => {
    handlers.revealInFolder(filePath)
  })
  // Renderer responds to an in-flight approval card (issue 04/05). Decision now carries the
  // chosen scope: 'once' | 'conversation' | 'project' | 'deny'.
  ipcMainHandle(
    'compute:approval-respond',
    (_event, request: { id: string; decision: ComputeApprovalDecision }) => {
      handlers.approvalRespond(request.id, request.decision)
    }
  )
  ipcMainHandle('compute:approval-replay', (_event, id: unknown) =>
    typeof id === 'string' ? handlers.approvalReplay(id) : null
  )
  ipcMainHandle('compute:approval-replay-pending', () => handlers.approvalReplayPending())
  // Returns a Session job feed or the global non-terminal activity projection.
  ipcMainHandle(COMPUTE_JOBS_LIST_CHANNEL, (_event, filter: ComputeJobsListFilter) =>
    handlers.jobsList(filter)
  )
  // Returns jobs pending analysis turn (notifiedAt set, notificationConsumedAt null — issue 05).
  ipcMainHandle(
    'compute:jobs:pending-notification',
    (_event, filter: ComputeJobsPendingNotificationFilter) =>
      handlers.jobsPendingNotification(filter)
  )
  // Marks job ids as notification-consumed (analysis turn done — issue 05).
  ipcMainHandle('compute:jobs:mark-consumed', (_event, sessionId: string, jobIds: string[]) =>
    handlers.jobsMarkConsumed(sessionId, jobIds)
  )

  // Per-session enabled Compute Hosts. Main commits Session authority before updating the runtime
  // projection consulted by legacy list_compute and canonical list_preferred.
  ipcMainHandle('compute:enabled-hosts:get', (_event, sessionId: string): string[] =>
    enabledHosts.get(sessionId)
  )
  ipcMainHandle(
    'compute:enabled-hosts:set',
    async (event, sessionId: string, providerIds: string[]) => {
      const originClientId = getLifecycleClientId(event)
      const session = await enabledHosts.set(sessionId, providerIds)
      try {
        broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
      } catch {
        // Lifecycle delivery cannot roll back committed Session authority.
      }
      return session
    }
  )
  ipcMainHandle(
    'compute:host-enabled:set',
    async (event, sessionId: string, providerId: string, enabled: boolean) => {
      const originClientId = getLifecycleClientId(event)
      const session = await enabledHosts.setHostEnabled(sessionId, providerId, enabled)
      try {
        broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
      } catch {
        // Lifecycle delivery cannot roll back committed Session authority.
      }
      return session
    }
  )
  ipcMainHandle(
    'compute:host-selected:set',
    async (event, sessionId: string, providerId: string, selected: boolean) => {
      const originClientId = getLifecycleClientId(event)
      const session = await enabledHosts.setHostSelected(sessionId, providerId, selected)
      try {
        broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
      } catch {
        // Lifecycle delivery cannot roll back committed Session authority.
      }
      return session
    }
  )
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

export { COMPUTE_JOBS_LIST_CHANNEL, installComputeIpcHandlers }
export type { ComputeIpcAdapter }
