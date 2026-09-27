import { MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID } from '../../shared/lifecycle-events'
import type { ApplicationEvents } from '../application-events'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createDefaultArtifactRepository } from '../artifacts/ipc'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { AgentComputeService } from '../compute/agent-compute-service'
import { createComputeArtifactResolver } from '../compute/compute-service'
import { createComputeIpcModule, toJobSummary } from '../compute/ipc'
import type { ComputeJobOwnerLiveness } from '../compute/job-deletion-owner'
import { withSessionCacheDeletion } from '../compute/session-cache-owner'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields } from '../logger'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { TaskNotificationService } from '../notifications/task-notifications'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { ProjectDeletionCoordinator } from '../projects/deletion-coordinator'
import {
  SessionPersistenceCommands,
  type ComputeJobDeletionParticipant
} from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SettingsRepository } from '../settings/repository'
import { resolveDataRoot } from '../storage-root'
import { runDataRootStartupRecovery, withDataRootWrite } from '../storage/migration-state'

export function composeComputeServices({
  applicationEvents,
  settingsRepository,
  computeJobResultDelivery,
  sessionRepository,
  artifactRepository,
  permissionGrantRegistry,
  sessionPersistenceCoordinator,
  archiveCoordinator,
  sessionEnabledComputeHostsOwnerRef,
  taskNotifications
}: {
  applicationEvents: ApplicationEvents
  settingsRepository: SettingsRepository
  computeJobResultDelivery: ComputeJobResultDeliveryAdapter
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  artifactRepository: ReturnType<typeof createDefaultArtifactRepository>
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    | 'mutateSessionComputeHostAccess'
    | 'pruneSessionEnabledComputeHosts'
    | 'sessionProjectId'
    | 'setSessionComputeConcurrencyLimit'
    | 'setSessionEnabledComputeHosts'
  >
  archiveCoordinator: ArchiveCoordinator
  sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner }
  taskNotifications: TaskNotificationService
}): { computeIpcModule: ReturnType<typeof createComputeIpcModule> } {
  // Register compute IPC handlers early so computeService can be wired into the notebook RPC server.
  // The approval broker in compute/ipc.ts broadcasts via BrowserWindow.getAllWindows(), which requires
  // Electron to be ready — this is always the case here since we're inside registerIpcHandlers.
  // Absolute Compute inputs may be legacy managed artifacts or exact immutable files staged for
  // the submitting Notebook Session. Both resolvers enforce their own storage boundary.
  const computeArtifactResolver = createComputeArtifactResolver(resolveDataRoot(), (path) =>
    artifactRepository.resolveManagedFilePath({ path })
  )
  const sessionLimitPersistence = {
    resolve: (sessionId: string, expectedProjectId?: string) =>
      sessionRepository.loadComputePolicy(expectedProjectId, sessionId),
    save: async (sessionId: string, limit: number): Promise<void> => {
      const session = await withDataRootWrite(async () => {
        const projectId = await sessionPersistenceCoordinator.sessionProjectId(sessionId)
        if (!projectId)
          throw new Error(`Cannot persist concurrency for missing Session ${sessionId}.`)
        return sessionPersistenceCoordinator.setSessionComputeConcurrencyLimit(
          projectId,
          sessionId,
          limit
        )
      })
      applicationEvents.publish('session:updated', {
        session,
        originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
      })
    }
  }
  const computeIpcModule = createComputeIpcModule(
    undefined,
    undefined,
    computeArtifactResolver,
    undefined,
    taskNotifications,
    permissionGrantRegistry,
    settingsRepository,
    {
      pruneSessionEnabledHosts: async (providerId, afterPrune) => {
        if (!sessionEnabledComputeHostsOwnerRef.current) {
          throw new Error('Session enabled Compute Host ownership is not initialized.')
        }
        const sessions = await sessionEnabledComputeHostsOwnerRef.current.pruneProvider(
          providerId,
          afterPrune
        )
        for (const session of sessions) {
          try {
            applicationEvents.publish('session:updated', {
              session,
              originClientId: MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID
            })
          } catch {
            // The durable repair and cache projection have committed; lifecycle delivery is best effort.
          }
        }
      }
    },
    sessionLimitPersistence,
    computeJobResultDelivery,
    (projectId, sessionId) => archiveCoordinator.admitSessionWork(projectId, sessionId)
  )
  return { computeIpcModule }
}

export async function composeComputeAdmission({
  storageLog,
  managedFileVersionService,
  computeJobResultDelivery,
  isComputeJobOwnerLive,
  computeJobDeletionRef,
  computeJobActivityRef,
  sessionCacheOwnerRef,
  sessionPersistenceCoordinator,
  projectDeletionCoordinator,
  sessionEnabledComputeHostsOwnerRef,
  computeIpcModule,
  composition
}: {
  storageLog: ReturnType<typeof createLogger>
  managedFileVersionService: ManagedFileVersionService
  computeJobResultDelivery: ComputeJobResultDeliveryAdapter
  isComputeJobOwnerLive: ({
    projectId,
    sessionId
  }: {
    projectId: string
    sessionId: string
  }) => Promise<ComputeJobOwnerLiveness>
  computeJobDeletionRef: {
    current?: Required<ComputeJobDeletionParticipant> & {
      reconcileProjectOrphanJobs(
        projectId: string,
        isOwnerLive: typeof isComputeJobOwnerLive
      ): Promise<void>
    }
  }
  computeJobActivityRef: {
    current?: {
      findNonTerminal(): Promise<Array<{ project_id: string }>>
      countNonTerminalBySession(sessionId: string): Promise<number>
    }
  }
  sessionCacheOwnerRef: {
    current?: {
      removeSession(projectId: string, sessionId: string): Promise<void>
      removeProject(projectId: string): Promise<void>
      reconcileActiveSessions(
        sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
      ): Promise<void>
    }
  }
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    | 'mutateSessionComputeHostAccess'
    | 'pruneSessionEnabledComputeHosts'
    | 'sessionProjectId'
    | 'setSessionComputeConcurrencyLimit'
    | 'setSessionEnabledComputeHosts'
  >
  projectDeletionCoordinator: ProjectDeletionCoordinator
  sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner }
  computeIpcModule: ReturnType<typeof createComputeIpcModule>
  composition: DiagnosticOperation
}): Promise<{
  computeService: import('../compute/compute-service').ComputeService
  connectionBroker: import('../compute/connection-broker').ComputeConnectionBroker
  jobDeletionOwner: import('../compute/job-deletion-owner').ComputeJobDeletionOwner
  jobRepository: import('../compute/job-repository').ComputeJobRepository
  operationRepository: import('../compute/compute-job-operation-repository').ComputeJobOperationRepository
  hostRepository: import('../compute/repository').ComputeHostRepository
  hostsRegistry: import('../compute/enabled-hosts-registry').EnabledComputeHostsRegistry
  sessionEnabledComputeHostsOwner: SessionEnabledComputeHostsOwner
  dataRoot: ReturnType<typeof resolveDataRoot>
  agentComputeService: AgentComputeService
}> {
  const {
    computeService,
    connectionBroker,
    jobDeletionOwner,
    jobRepository,
    operationRepository,
    hostRepository,
    sessionCacheOwner,
    enabledComputeHostsRegistry: hostsRegistry
  } = computeIpcModule
  computeJobActivityRef.current = jobRepository
  const sessionEnabledComputeHostsOwner = new SessionEnabledComputeHostsOwner({
    registry: hostsRegistry,
    hostExists: async (providerId) => (await hostRepository.get(providerId)) !== null,
    listHostIds: async () => (await hostRepository.list()).map((host) => host.providerId),
    sessionAuthority: sessionPersistenceCoordinator,
    projectSessionConcurrencyLimit: async (sessionId, limit) => {
      const concurrencyManager = computeIpcModule.handlers.concurrencyManager
      if (!concurrencyManager) throw new Error('Session concurrency ownership is not initialized.')
      await concurrencyManager.projectPersistedSessionLimit(sessionId, limit)
    },
    clearSessionConcurrencyLimits: async (sessionIds) => {
      const concurrencyManager = computeIpcModule.handlers.concurrencyManager
      if (!concurrencyManager) throw new Error('Session concurrency ownership is not initialized.')
      await concurrencyManager.clearProjectedSessionLimits(sessionIds)
    },
    withDataRootWrite
  })
  sessionEnabledComputeHostsOwnerRef.current = sessionEnabledComputeHostsOwner
  sessionCacheOwnerRef.current = sessionCacheOwner
  computeJobDeletionRef.current = withSessionCacheDeletion(jobDeletionOwner, sessionCacheOwner)
  await runDataRootStartupRecovery(() =>
    projectDeletionCoordinator.restorePendingDeletionBarriers()
  )
  await runDataRootStartupRecovery(
    async () => {
      await withDataRootWrite(() => managedFileVersionService.recoverPendingWrites())
    },
    {
      reportFailure: (error) => {
        storageLog.error(
          'managed file version recovery incomplete; will retry next launch',
          diagnosticErrorFields(error)
        )
      }
    }
  )
  void managedFileVersionService
    .auditActiveVersionIntegrity()
    .then((integrityErrors) => {
      if (integrityErrors.length > 0) {
        storageLog.error('managed file version integrity audit found corrupt active content', {
          count: integrityErrors.length
        })
      }
    })
    .catch((error) =>
      storageLog.error(
        'managed file version integrity audit incomplete; will retry next launch',
        diagnosticErrorFields(error)
      )
    )
  await jobDeletionOwner.restoreOrphanJobDeletionBarriers(isComputeJobOwnerLive)
  composition.phase('deletion-barriers')
  const dataRoot = resolveDataRoot()
  // The Notebook RPC receives only this Session-admitted facade, never the unrestricted service
  // used by Settings and internal runtimes.
  const agentComputeService = new AgentComputeService(computeService, hostsRegistry, {
    onFinalJobObserved: async (_context, _providerId, snapshot) => {
      const job = await jobRepository.get(snapshot.job_id)
      if (!job) return 'pending'
      const host = await hostRepository.get(job.provider_id).catch(() => null)
      const summary = await toJobSummary(job, host?.displayName ?? job.provider_id, dataRoot)
      return computeJobResultDelivery.observeResult({
        ...summary,
        status: snapshot.status,
        cancellation_status: snapshot.cancellation_status,
        exit_code: snapshot.exit_code,
        stdout_tail: snapshot.stdout_tail,
        stderr_tail: snapshot.stderr_tail,
        remote_workdir: snapshot.remote_workdir,
        harvest_error: snapshot.harvest_error,
        ...('featured_files' in snapshot ? { featured_files: snapshot.featured_files } : {}),
        ...('left_on_remote' in snapshot ? { left_on_remote: snapshot.left_on_remote } : {})
      })
    }
  })
  return {
    computeService,
    connectionBroker,
    jobDeletionOwner,
    jobRepository,
    operationRepository,
    hostRepository,
    hostsRegistry,
    sessionEnabledComputeHostsOwner,
    dataRoot,
    agentComputeService
  }
}
