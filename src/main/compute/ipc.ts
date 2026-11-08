import { getManualStagedCleanup } from './manual-staged-cleanup'
import { getRayToken, rayTokens } from './ray-token'
import { computeAccounts } from './compute-account-service'
import { getHuggingFaceJobAccess } from './hugging-face-job-access'
import { inspectModalTarget } from './modal-sdk'
import { readComputeOutputPreview } from './job-output-preview'
import { externalComputeMode } from '../../shared/compute'
import { MODAL_CREATION_UNCONFIRMED } from './modal-job-journal'
import { KubernetesTargetCatalog } from './kubernetes-target-catalog'
import { HostedTargetCatalog } from './hosted-target-catalog'
import { RayTargetCatalog } from './ray-target-catalog'
import { ModalTargetCatalog } from './modal-target-catalog'
import { createComputeExecution, verifyRayJobsAccess } from '@aipoch/compute/node'
import { randomUUID } from 'node:crypto'
import { desktopShellInteraction } from '../desktop-interaction'
import type { ArtifactResolver } from './compute-job-workflow-owner'
import type { ComputeHandlers } from './handler-contract'

import type { ComputeHost } from '@aipoch/compute'
import type { ComputeApprovalRequest, ComputeJob, JobSummary } from '../../shared/compute'

import { computeProviderId } from '@aipoch/compute'

import type { SessionComputePolicyAuthority } from '@aipoch/compute'
import { ComputeConnectionError, type ComputeJobDeletionOwner } from '@aipoch/compute/node'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { buildComputeApprovalBroadcast } from '../notifications/electron-wiring'
import type { TaskNotificationService } from '../notifications/task-notifications'
import { getProjectDbClient } from '../projects/prisma-client'
import { broadcastToRenderers } from '../renderer-broadcast'
import { createSettingsComputeGrantPort } from '../settings/compute-grant-port'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { ComputeApprovalBroker, type ComputeApprovalContext } from './compute-approval-broker'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeService } from './compute-service'
import { type ComputeConnectionBroker } from './connection-broker'
import { ComputeJobRepository } from './job-repository'
import { ComputeHostRepository } from './repository'
import { readSshConfigHostAliases } from './ssh-config'

import type { PermissionGrantRegistry } from '../permission-grants/registry'
import {
  createComputeAuthenticationRuntime,
  projectComputeCredentialStatus,
  type ComputeAuthenticationDependencies,
  type ComputeHostLifecycle
} from './authentication-runtime'
import { deleteComputeHost } from './compute-host-deletion-owner'
import { dispatchComputeJob as dispatchJob } from './dispatch-evidence'
import { EnabledComputeHostsRegistry, enabledComputeHostsRegistry } from './enabled-hosts-registry'
import {
  createComputePermissionGrantAdapter,
  type LegacyComputeGrantPort
} from './permission-grant-adapter'
import { SessionCacheOwner } from './session-cache-owner'
import { toJobSummary } from './job-notifier'
export { toJobSummary } from './job-notifier'
export const COMPUTE_JOB_UPDATED_CHANNEL = 'compute:job-updated'

const log = createLogger('compute')

// Renderer-callable Compute commands; transport and credential details remain behind their owners.

type ComputeResultDeliveryProjection = Readonly<{
  observeJob(job: JobSummary): Promise<void>
  hasDeliveryPath(jobId: string): Promise<boolean>
}>

const createComputeHandlers = (
  repository: ComputeHostRepository,
  listSshAliases: () => Promise<string[]> = readSshConfigHostAliases,
  injectedService?: ComputeService,
  injectedBroker?: ComputeApprovalBroker,
  legacyComputeGrants?: LegacyComputeGrantPort,
  jobRepository?: ComputeJobRepository,
  onJobUpdated?: (job: ComputeJob) => void,
  artifactResolver?: ArtifactResolver,
  storageRoot?: string,
  taskNotifications?: Pick<
    TaskNotificationService,
    'handleComputeApproval' | 'settleAuthorization'
  >,
  permissionGrantRegistry?: PermissionGrantRegistry,
  hostLifecycle?: ComputeHostLifecycle,
  authenticationDependencies?: ComputeAuthenticationDependencies,
  sessionCacheOwner?: SessionCacheOwner,
  operationRepository?: ComputeJobOperationRepository,
  sessionLimitPersistence?: SessionComputePolicyAuthority,
  resultDelivery?: Pick<ComputeResultDeliveryProjection, 'hasDeliveryPath'>,
  admitSessionWork?: (projectId: string, sessionId: string) => () => void
): ComputeHandlers => {
  const permissionGrants = permissionGrantRegistry
    ? createComputePermissionGrantAdapter(permissionGrantRegistry, legacyComputeGrants)
    : undefined
  if (permissionGrants) {
    void permissionGrants
      .migrateLegacy()
      .catch((error) => log.warn('legacy compute grant migration failed', errorLogFields(error)))
  }

  // The broadcast function sends approval requests to all renderer windows. In tests, callers
  // inject a fake broker so this function is never called directly.
  const broker =
    injectedBroker ??
    new ComputeApprovalBroker({
      generateId: () => randomUUID(),
      broadcast: taskNotifications
        ? buildComputeApprovalBroadcast({
            broadcastToRenderers,
            taskNotifications,
            onNotificationError: (error) =>
              log.warn('compute approval notification failed', errorLogFields(error))
          })
        : (request: ComputeApprovalRequest, context?: ComputeApprovalContext) => {
            // Tests and isolated registrations without the notification service still receive cards.
            broadcastToRenderers('compute:approval-request', {
              ...request,
              ...(context?.sessionId ? { session_id: context.sessionId } : {})
            })
          },
      replay: (request, context) =>
        broadcastToRenderers('compute:approval-request', {
          ...request,
          ...(context?.sessionId ? { session_id: context.sessionId } : {})
        }),
      onSettled: (id, state) => {
        try {
          broadcastToRenderers('compute:approval-settled', id)
        } finally {
          if (taskNotifications) {
            void taskNotifications.settleAuthorization('compute', id, state)
          }
        }
      },
      // Isolated/no-Registry callers retain the former settings-backed Project grant behavior.
      checkProjectGrant:
        legacyComputeGrants && !permissionGrantRegistry
          ? (grant) => legacyComputeGrants.hasComputeGrant(grant)
          : undefined,
      saveProjectGrant:
        legacyComputeGrants && !permissionGrantRegistry
          ? (grant) => legacyComputeGrants.addComputeGrant(grant).then(() => undefined)
          : undefined,
      isProviderCurrent: async ({ providerId, ownerId }) => {
        const current = externalComputeMode(providerId)
          ? await repository.getComputeTarget(providerId)
          : await repository.get(providerId)
        return current !== null && (ownerId === undefined || current.id === ownerId)
      },
      permissionGrants
    })

  // Compute provider ids are deterministic and reusable. Keep create, delete, and owner-grant cleanup
  // in one FIFO so a replacement host cannot become visible before stale authority is pruned. The
  // tail recovers after failures; create retries cleanup before exposing an absent provider id.
  let hostLifecycleTail: Promise<void> = Promise.resolve()
  const runHostLifecycleMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = hostLifecycleTail.then(operation)
    hostLifecycleTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  // The ConcurrencyManager enforces session limits + provider ceilings and auto-dispatches queued
  // jobs when a slot frees up. It is wired here (not in ComputeService) because it needs a
  // dispatchJob closure carrying the same runner/scp/repository deps the dispatcher uses. Only built
  // for the production path — tests inject their own service and drive the manager directly.
  const { sshRunner, scpRunner, credentialVault, connectionBroker, authentication } =
    createComputeAuthenticationRuntime({
      repository,
      approvalBroker: broker,
      jobRepository,
      hostLifecycle,
      permissionGrantRegistry,
      authenticationDependencies,
      reportAuthenticationFailurePersistenceError: (error) =>
        log.warn('compute authentication breaker persistence failed', errorLogFields(error))
    })
  const execution = injectedService?.execution ?? createComputeExecution()
  const concurrencyManager =
    !injectedService && jobRepository
      ? execution.createQueue({
          jobs: jobRepository,
          hosts: repository,
          dispatch: async (queuedJobId, handleJobUpdated) => {
            const queued = await jobRepository.get(queuedJobId)
            if (queued) {
              const mode = externalComputeMode(queued.provider_id)
              if (
                mode
                  ? queued.execution_mode !== mode
                  : queued.execution_mode !== undefined &&
                    queued.execution_mode !== 'direct_ssh' &&
                    queued.execution_mode !== 'slurm'
              ) {
                throw new Error('Queued Compute Job execution mode does not match its provider.')
              }
              if (mode) {
                service.wakeExternalJobs(mode)
                return
              }
            }
            await dispatchJob(queuedJobId, {
              connectionBroker,
              hostRepository: repository,
              jobRepository,
              onJobUpdated: handleJobUpdated,
              storageRoot,
              execution
            })
          },
          publish: onJobUpdated,
          sessionPolicy: sessionLimitPersistence
        })
      : undefined
  const summarizeJob = async (
    job: ComputeJob,
    displayName: string,
    root: string
  ): Promise<JobSummary> => ({
    ...(await toJobSummary(job, displayName, root)),
    ...(job.status === 'queued' && concurrencyManager
      ? {
          queue_blocked_reason: await concurrencyManager.getQueueBlockedReason(
            job.session_id,
            job.project_id
          )
        }
      : {})
  })
  const service =
    injectedService ??
    new ComputeService({
      execution,
      admitSessionWork,
      runner: sshRunner,
      repository,
      approvalBroker: broker,
      scpRunner,
      jobRepository,
      operationRepository,
      artifactResolver,
      storageRoot,
      sessionCacheOwner,
      concurrencyManager,
      connectionBroker,
      credentialVault
    })
  const jobDeletionOwner = jobRepository
    ? execution.createDeletionOwner({
        jobRepository,
        hostRepository: repository,
        connectionBroker,
        queueManager: concurrencyManager,
        requestCancellation: async (job) => {
          await service.cancelJob(job.job_id, {
            projectId: job.project_id,
            sessionId: job.session_id,
            providerId: job.provider_id
          })
        },
        confirmCancellation: async (job) => {
          if (!operationRepository) {
            throw new Error('Compute Job operation repository is unavailable.')
          }
          const confirmed = await operationRepository.fulfillCancellationAfterRemoteCleanup(
            job.job_id,
            {
              projectId: job.project_id,
              sessionId: job.session_id,
              providerId: job.provider_id
            },
            new Date()
          )
          if (!confirmed) return
          const current = await jobRepository.get(job.job_id)
          if (current) await service.handleJobCancellationConfirmed(current)
        }
      })
    : undefined
  const listHostNames = async (): Promise<Map<string, string>> => {
    try {
      const groups = await Promise.all([
        repository.list(),
        repository.listKubernetesTargets?.() ?? [],
        repository.listHostedTargets?.() ?? [],
        repository.listRayTargets?.() ?? [],
        repository.listModalTargets?.() ?? []
      ])
      return new Map(groups.flat().map((host) => [host.providerId, host.displayName]))
    } catch {
      return new Map()
    }
  }
  const projectDeliveryPath = async (summary: JobSummary): Promise<JobSummary> => {
    try {
      return resultDelivery && (await resultDelivery.hasDeliveryPath(summary.job_id))
        ? { ...summary, result_delivery_path: 'agent-result-delivery' }
        : summary
    } catch (error) {
      log.warn('agent result delivery projection failed', errorLogFields(error))
      return summary
    }
  }

  // Read one archive receipt at a time so a long Session history cannot exhaust file handles or memory.
  const summarizeJobs = async (
    jobs: ComputeJob[],
    root: string,
    includeDelivery: boolean
  ): Promise<JobSummary[]> => {
    const names = await listHostNames()
    const result: JobSummary[] = []
    for (const job of jobs) {
      const summary = await summarizeJob(job, names.get(job.provider_id) ?? job.provider_id, root)
      result.push(includeDelivery ? await projectDeliveryPath(summary) : summary)
    }
    return result
  }

  const createHostWithLifecycle = <Request extends { sshAlias: string }>(
    request: Request,
    createHost: () => Promise<ComputeHost>
  ): Promise<ComputeHost> =>
    runHostLifecycleMutation(async () => {
      if (permissionGrantRegistry || hostLifecycle) {
        const providerId = computeProviderId(request.sshAlias)
        const existing = await repository.get(providerId)
        if (!existing) {
          await permissionGrantRegistry?.prune({ kind: 'compute_provider', providerId })
          await hostLifecycle?.pruneSessionEnabledHosts(providerId)
        }
      }
      return createHost()
    })

  return {
    list: () => service.list(),
    accountStatus: (provider, force) => computeAccounts.status(provider, force),
    connectAccount: (provider) => computeAccounts.connect(provider),
    useLocalAccount: (provider) => computeAccounts.useLocal(provider),
    cancelAccountConnection: (provider) => computeAccounts.cancel(provider),
    disconnectAccount: (provider) => computeAccounts.disconnect(provider),
    listRayTokens: () => rayTokens.list(),
    setRayToken: (endpoint, token) => rayTokens.set(endpoint, token),
    removeRayToken: (endpoint) => rayTokens.remove(endpoint),
    verifyTarget: async (providerId) => {
      switch (externalComputeMode(providerId)) {
        case 'hugging_face_jobs': {
          const target = await repository.getHostedTarget(providerId)
          if (target) {
            await getHuggingFaceJobAccess(target)
            return
          }
          break
        }
        case 'ray_jobs': {
          const target = await repository.getRayTarget(providerId)
          if (target) {
            await verifyRayJobsAccess({ endpoint: target.endpoint, getToken: getRayToken })
            return
          }
          break
        }
        case 'modal_sandbox': {
          const target = await repository.getModalTarget(providerId)
          if (target) {
            await inspectModalTarget(target)
            return
          }
          break
        }
      }
      throw new Error('Unknown compute account target.')
    },
    updateTarget: (providerId, config) =>
      runHostLifecycleMutation(async () => {
        const mode = externalComputeMode(providerId)
        const catalog =
          mode &&
          {
            kubernetes: repository.kubernetesTargets,
            hugging_face_jobs: repository.hostedTargets,
            ray_jobs: repository.rayTargets,
            modal_sandbox: repository.modalTargets
          }[mode]
        if (!catalog) throw new Error('Unknown compute target.')
        await catalog.update(providerId, config)
      }),
    listKubernetesTargets: () => repository.listKubernetesTargets(),
    createKubernetesTarget: (config) =>
      runHostLifecycleMutation(async () => {
        if (!repository.kubernetesTargets) throw new Error('Compute settings unavailable.')
        return repository.kubernetesTargets.create(config)
      }),
    listHostedTargets: () => repository.listHostedTargets(),
    createHostedTarget: async (config) => {
      const catalog = repository.hostedTargets
      if (!catalog) throw new Error('Compute settings unavailable.')
      return computeAccounts.withConnectedAccount('hugging-face', () =>
        runHostLifecycleMutation(() => catalog.create(config))
      )
    },
    listRayTargets: () => repository.listRayTargets(),
    createRayTarget: (config) =>
      runHostLifecycleMutation(async () => {
        if (!repository.rayTargets) throw new Error('Compute settings unavailable.')
        return repository.rayTargets.create(config)
      }),
    readOutputPreview: readComputeOutputPreview,
    listModalTargets: () => repository.listModalTargets(),
    createModalTarget: async (config) => {
      const catalog = repository.modalTargets
      if (!catalog) throw new Error('Compute settings unavailable.')
      return computeAccounts.withConnectedAccount('modal', () =>
        runHostLifecycleMutation(() => catalog.create(config))
      )
    },
    get: async (providerId) => {
      const host = await repository.get(providerId)
      return host ? projectComputeCredentialStatus(host, credentialVault) : null
    },
    create: (request) => createHostWithLifecycle(request, () => repository.create(request)),
    createPassword: async (request) => {
      try {
        return {
          ok: true,
          host: await createHostWithLifecycle(request, () => authentication.createPassword(request))
        }
      } catch (error) {
        return {
          ok: false,
          errorCode: error instanceof ComputeConnectionError ? error.code : 'create_failed'
        }
      }
    },
    resetPassword: async (request) => {
      try {
        return { ok: true, host: await authentication.resetPassword(request) }
      } catch (error) {
        return {
          ok: false,
          errorCode: error instanceof ComputeConnectionError ? error.code : 'reset_failed'
        }
      }
    },
    changeAuthentication: async (request) => {
      try {
        return { ok: true, host: await authentication.changeAuthentication(request) }
      } catch (error) {
        return {
          ok: false,
          errorCode: error instanceof ComputeConnectionError ? error.code : 'create_failed'
        }
      }
    },
    passwordCapability: async () => credentialVault.capability(),
    deletionStatus: async (providerId) => {
      const jobs = (await jobRepository?.findDeletionBlockingJobsForProvider(providerId)) ?? []
      return {
        blockedByJobs: jobs.length > 0,
        blockingJobs: jobs.map((job) => ({
          manualStagedCleanup: getManualStagedCleanup(job),
          ...(job.execution_mode === 'modal_sandbox' &&
            job.last_poll_error === MODAL_CREATION_UNCONFIRMED && {
              modalCreationUnconfirmed: true as const
            }),
          jobId: job.job_id,
          projectId: job.project_id,
          sessionId: job.session_id,
          status: job.status,
          cancellationStatus: job.cancellation_status,
          errorCode: job.error_code,
          harvested: job.harvested_at !== undefined,
          intent: job.intent,
          createdAt: job.created_at
        }))
      }
    },
    delete: (
      providerId: string,
      options = { allowPasswordCredentialDeletion: true }
    ): Promise<void> =>
      runHostLifecycleMutation(() =>
        deleteComputeHost(
          {
            repository,
            approvalBroker: broker,
            connectionBroker,
            jobRepository,
            permissionGrantRegistry,
            hostLifecycle
          },
          providerId,
          options
        )
      ),
    sshConfigAliases: () => listSshAliases(),
    probe: (providerId) => service.probe(providerId),
    detailsGet: async (providerId) => {
      const { doc } = await service.getDetails(providerId)
      return { doc }
    },
    detailsSave: (providerId, text, oldText, author) =>
      service.replaceDetails(providerId, { text, oldText, author }),
    scratchSet: (providerId, path) => service.setScratchRoot(providerId, path),
    scratchClear: (providerId) => service.clearScratchRoot(providerId),
    concurrencySet: (providerId, limit) => service.setConcurrencyLimit(providerId, limit),
    executionModeSet: (providerId, executionMode) =>
      service.setExecutionMode(providerId, executionMode),
    setSessionConcurrencyLimit: (sessionId, limit) =>
      service.setSessionConcurrencyLimit(sessionId, limit),
    getSessionConcurrencyStatus: (sessionId) => service.getSessionConcurrencyStatus(sessionId),
    listDir: (providerId, path) => service.listDir(providerId, path),
    download: (providerId, remotePath, dest) => service.download(providerId, remotePath, dest),
    revealInFolder: async (filePath) => {
      await desktopShellInteraction().revealPath(filePath)
    },
    computeService: service,
    connectionBroker,
    concurrencyManager,
    approvalRespond: (id, decision) => broker.respond(id, decision),
    approvalReplay: (id) => broker.getPending(id),
    approvalReplayPending: () => broker.replayPending(),
    approvalPauseSession: (sessionId) => broker.pauseSession(sessionId),
    approvalResumeSession: (sessionId) => broker.resumeSession(sessionId),
    approvalCancelSession: (sessionId) => broker.cancelSession(sessionId),
    approvalCancelAll: () => broker.cancelAll(),
    approvalCompleteGlobalCancellation: () => broker.completeGlobalCancellation(),
    approvalCompleteSessionCancellation: (sessionId) =>
      broker.completeSessionCancellation(sessionId),
    approvalBeginSessionDeletion: (sessionId) => broker.beginSessionDeletion(sessionId),
    approvalFinishSessionDeletion: (sessionId, retained) =>
      broker.finishSessionDeletion(sessionId, retained),
    jobsList: async (filter) => {
      if (!jobRepository || !storageRoot) return []
      if ('projectId' in filter) {
        const jobs = await jobRepository.findProjectOverview(
          filter.projectId,
          new Date(filter.since)
        )
        return summarizeJobs(jobs, storageRoot, false)
      }
      const jobs =
        'nonTerminal' in filter
          ? await jobRepository.findNonTerminal(true)
          : await jobRepository.findBySession(filter.sessionId, filter.status)
      return summarizeJobs(jobs, storageRoot, true)
    },
    jobsCancel: (request) =>
      service.cancelJob(request.jobId, {
        projectId: request.projectId,
        sessionId: request.sessionId,
        providerId: request.providerId
      }),
    jobsRetryHarvest: (request) => service.retryJobHarvest(request),
    jobsSetRemoteCleanup: async (request) => {
      if (!jobDeletionOwner) throw new Error('Compute Job cleanup owner is unavailable.')
      const mode = externalComputeMode(request.providerId)
      if (
        request.manualStagedCleanup &&
        (request.manualStagedCleanup !== true ||
          request.disposition !== 'cleaned' ||
          (mode !== 'hugging_face_jobs' && mode !== 'modal_sandbox'))
      )
        throw new Error('Invalid staged resource cleanup request.')
      if (mode && request.disposition === 'cleaned') {
        const job = await jobRepository?.get(request.jobId)
        if (
          !job ||
          job.execution_mode !== mode ||
          job.provider_id !== request.providerId ||
          job.project_id !== request.projectId ||
          job.session_id !== request.sessionId
        )
          throw new Error('Compute Job cleanup scope does not match.')
        if (job.remote_cleanup_disposition === 'cleaned') return
        const staged = getManualStagedCleanup(job)
        if (request.manualStagedCleanup) {
          if (!staged) throw new Error('Staged resource cleanup is unavailable.')
          await service.cleanStagedJob(mode, job)
          return
        }
        if (staged) throw new Error('Confirm cleanup of this job’s staged resources first.')
        if (mode === 'ray_jobs')
          throw new Error('Ray output files are retained on the shared filesystem.')
        await service.reconcileExternalJobs(mode)
        if ((await jobRepository?.get(job.job_id))?.remote_cleanup_disposition !== 'cleaned')
          throw new Error('Remote cleanup is pending verified publication or volume removal.')
        return
      }
      if (request.disposition === 'cleaned') {
        await jobDeletionOwner.cleanupJobRemote(request)
      } else {
        await jobDeletionOwner.abandonJobRemoteCleanup(request)
      }
    },
    jobsPendingNotification: async (filter) => {
      if (!jobRepository || !storageRoot) return []
      const jobs =
        typeof filter === 'string'
          ? await jobRepository.findPendingNotifications(filter)
          : await jobRepository.findPendingNotifications()
      return summarizeJobs(jobs, storageRoot, true)
    },
    jobsMarkConsumed: async (sessionId, jobIds) => {
      if (!jobRepository) return
      await jobRepository.markNotificationsConsumed(sessionId, jobIds)
    },
    jobsTransitionAnalysis: async (request) => {
      if (!jobRepository || !storageRoot) {
        throw new Error('Compute analysis persistence is unavailable.')
      }
      const jobs = await jobRepository.transitionAnalysis(request)
      for (const job of jobs) {
        try {
          onJobUpdated?.(job)
        } catch (error) {
          // The transition is already durable; a broadcast failure must not report it as rejected.
          log.warn('compute analysis transition broadcast failed', errorLogFields(error))
        }
      }
      return summarizeJobs(jobs, storageRoot, true)
    },
    jobDeletionOwner
  }
}

// Production repository backed by the SQLite database under the (dev-aware) storage root. The client
// is passed as a provider (not a resolved promise) so a failed first initialization can be retried on
// the next request instead of being cached for the app's lifetime.
const createDefaultComputeHostRepository = (): ComputeHostRepository =>
  new ComputeHostRepository(() => getProjectDbClient(resolveConfigRoot()), {
    kubernetesTargets: new KubernetesTargetCatalog(resolveConfigRoot),
    hostedTargets: new HostedTargetCatalog(resolveConfigRoot),
    rayTargets: new RayTargetCatalog(resolveConfigRoot),
    modalTargets: new ModalTargetCatalog(resolveConfigRoot)
  })

const createDefaultComputeJobRepository = (): ComputeJobRepository =>
  new ComputeJobRepository(() => getProjectDbClient(resolveConfigRoot()))

const createDefaultComputeJobOperationRepository = (): ComputeJobOperationRepository =>
  new ComputeJobOperationRepository(() => getProjectDbClient(resolveConfigRoot()))

// Broadcasts a job summary to all renderer windows. Called by the JobPoller onJobUpdated hook
// and by the job dispatcher on status transitions (Phase 3d, design.md §9).
export const broadcastJobUpdated = (summary: JobSummary): void =>
  broadcastToRenderers(COMPUTE_JOB_UPDATED_CHANNEL, summary)

export const createJobUpdatedBroadcaster =
  (
    hostRepository: ComputeHostRepository,
    storageRoot: string,
    jobRepository: Pick<ComputeJobRepository, 'get'>,
    resultDelivery?: ComputeResultDeliveryProjection,
    scheduling?: (
      job: ComputeJob
    ) => Promise<import('@aipoch/compute').ComputeQueueBlockedReason | undefined>
  ): ((job: ComputeJob) => void) =>
  (job) => {
    // Register the canonical nonterminal observation before any filesystem/Host lookup yields.
    // A dispatch can fail and notify very quickly; entering the adapter's per-Job chain here makes
    // waiting-result registration happen before that terminal notification is processed.
    if (
      resultDelivery &&
      (job.status === 'queued' || job.status === 'submitted' || job.status === 'running')
    ) {
      void resultDelivery
        .observeJob({
          job_id: job.job_id,
          provider_id: job.provider_id,
          display_name: job.provider_id,
          shape: job.shape,
          session_id: job.session_id,
          project_id: job.project_id,
          status: job.status,
          cancellation_status: job.cancellation_status,
          intent: job.intent,
          created_at: job.created_at,
          started_at: job.started_at,
          finished_at: job.finished_at,
          exit_code: job.exit_code,
          error_code: job.error_code,
          remote_workdir: job.remote_workdir,
          stdout_tail: job.stdout_tail,
          stderr_tail: job.stderr_tail,
          notified_at: job.notified_at,
          notification_consumed_at: job.notification_consumed_at
        })
        .catch((error) =>
          log.warn('agent result delivery observation failed', errorLogFields(error))
        )
    }
    void (async () => {
      let displayName = job.provider_id
      try {
        const target = externalComputeMode(job.provider_id)
          ? await hostRepository.getComputeTarget(job.provider_id)
          : await hostRepository.get(job.provider_id)
        if (target) displayName = target.displayName
      } catch {
        // Preserve provider fallback; likewise, only a successful null Job lookup proves deletion.
      }
      const current = await jobRepository.get(job.job_id).catch(() => null)
      if (!current) return
      let summary = await toJobSummary(current, displayName, storageRoot)
      if (summary.status === 'queued' && scheduling)
        summary.queue_blocked_reason = await scheduling(current)
      // Filesystem scanning above yields. Re-read immediately before delivery so a terminal or
      // consumed transition committed during that scan cannot be overwritten by an older snapshot.
      const verified = await jobRepository.get(job.job_id).catch(() => null)
      if (!verified) return
      if (
        verified.status !== current.status ||
        verified.finished_at !== current.finished_at ||
        verified.exit_code !== current.exit_code ||
        verified.notified_at !== current.notified_at ||
        verified.notification_consumed_at !== current.notification_consumed_at ||
        verified.harvested_at !== current.harvested_at ||
        verified.harvest_error !== current.harvest_error
      ) {
        summary = await toJobSummary(verified, displayName, storageRoot)
      }
      try {
        await resultDelivery?.observeJob(summary)
        if (resultDelivery && (await resultDelivery.hasDeliveryPath(summary.job_id))) {
          summary = { ...summary, result_delivery_path: 'agent-result-delivery' }
        }
      } catch (error) {
        log.warn('agent result delivery projection failed', errorLogFields(error))
      }
      broadcastJobUpdated(summary)
    })().catch(() => undefined)
  }

type ComputeIpcModule = {
  handlers: ComputeHandlers
  computeService: ComputeService
  connectionBroker: ComputeConnectionBroker
  jobDeletionOwner: ComputeJobDeletionOwner
  jobRepository: ComputeJobRepository
  operationRepository: ComputeJobOperationRepository
  hostRepository: ComputeHostRepository
  enabledComputeHostsRegistry: EnabledComputeHostsRegistry
  sessionCacheOwner: SessionCacheOwner
}

// Constructs the shared Compute module without installing an Electron transport. Keeping this seam
// explicit lets application composition start the Job runtime before any renderer adapter exists.
const createComputeIpcModule = (
  repository = createDefaultComputeHostRepository(),
  jobRepository = createDefaultComputeJobRepository(),
  // Resolves artifact-store paths for job input staging. Optional: when omitted, artifact inputs
  // (absolute src) throw a clear error while workspace and remote_path inputs still work.
  artifactResolver?: ArtifactResolver,
  // Test seam: when supplied, the IPC handlers are wired to this service instead of the production
  // one constructed by createComputeHandlers. Lets the renderer-callable error wrapper around
  // `compute:list-dir` / `compute:download` be exercised end-to-end against a fake service.
  injectedService?: ComputeService,
  taskNotifications?: Pick<
    TaskNotificationService,
    'handleComputeApproval' | 'settleAuthorization'
  >,
  permissionGrantRegistry?: PermissionGrantRegistry,
  legacyComputeGrants?: LegacyComputeGrantPort,
  hostLifecycle?: ComputeHostLifecycle,
  sessionLimitPersistence?: SessionComputePolicyAuthority,
  resultDelivery?: ComputeResultDeliveryProjection,
  admitSessionWork?: (projectId: string, sessionId: string) => () => void
): ComputeIpcModule => {
  const operationRepository = createDefaultComputeJobOperationRepository()
  const configRoot = resolveConfigRoot()
  const dataRoot = resolveDataRoot()
  const sessionCacheOwner = new SessionCacheOwner(dataRoot)
  void repository
    .cleanupOrphanCredentials?.()
    .catch((error) => log.warn('orphan Compute Credential cleanup failed', errorLogFields(error)))
  const effectiveLegacyComputeGrants =
    legacyComputeGrants ?? createSettingsComputeGrantPort(configRoot)

  // Broadcast dispatcher status transitions to the renderer, same hook shape as the JobPoller uses.
  const onJobUpdated = createJobUpdatedBroadcaster(
    repository,
    dataRoot,
    jobRepository,
    resultDelivery,
    (job) =>
      handlers.concurrencyManager?.getQueueBlockedReason(job.session_id, job.project_id) ??
      Promise.resolve(undefined)
  )
  const handlers = createComputeHandlers(
    repository,
    undefined,
    injectedService,
    undefined,
    effectiveLegacyComputeGrants,
    jobRepository,
    onJobUpdated,
    artifactResolver,
    dataRoot,
    taskNotifications,
    permissionGrantRegistry,
    hostLifecycle,
    undefined,
    sessionCacheOwner,
    operationRepository,
    sessionLimitPersistence,
    resultDelivery,
    admitSessionWork
  )
  const jobDeletionOwner = handlers.jobDeletionOwner
  if (!jobDeletionOwner) throw new Error('Compute Job deletion owner is unavailable.')

  return {
    handlers,
    computeService: handlers.computeService,
    connectionBroker: handlers.connectionBroker,
    jobDeletionOwner,
    jobRepository,
    operationRepository,
    hostRepository: repository,
    enabledComputeHostsRegistry,
    sessionCacheOwner
  }
}

export { COMPUTE_JOBS_LIST_CHANNEL, installComputeIpcHandlers } from './electron-ipc-adapter'
export type { ComputeIpcAdapter } from './electron-ipc-adapter'
export {
  createComputeHandlers,
  createComputeIpcModule,
  createDefaultComputeHostRepository,
  createDefaultComputeJobOperationRepository,
  createDefaultComputeJobRepository,
  enabledComputeHostsRegistry
}
export type {
  ComputeHandlers,
  ComputeHostLifecycle,
  ComputeIpcModule,
  ComputeResultDeliveryProjection
}
