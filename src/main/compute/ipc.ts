import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserWindow, shell } from 'electron'

import type {
  ChangeComputeHostAuthenticationRequest,
  CancelComputeJobRequest,
  ChangeComputeHostAuthenticationResult,
  ComputeApprovalDecision,
  ComputeHost,
  ComputeApprovalRequest,
  ComputePasswordCapability,
  ComputeHostDeletionStatus,
  ComputeJob,
  ComputeJobsListFilter,
  ComputeJobsPendingNotificationFilter,
  ComputeJobAnalysisTransition,
  JobSummary,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  CreatePasswordComputeHostResult,
  ResetPasswordComputeHostRequest,
  ResetPasswordComputeHostResult,
  DetailsAuthor,
  ProbeResult
} from '../../shared/compute'
import { computeProviderId } from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import { getProjectDbClient } from '../projects/prisma-client'
import { createLogger, errorLogFields } from '../logger'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { createSettingsComputeGrantPort } from '../settings/compute-grant-port'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { TaskNotificationService } from '../notifications/task-notifications'
import { buildComputeApprovalBroadcast } from '../notifications/electron-wiring'
import { ComputeApprovalBroker, type ComputeApprovalContext } from './compute-approval-broker'
import { ComputeService, type ArtifactResolver } from './compute-service'
import { ConcurrencyManager, type SessionConcurrencyLimitPersistence } from './concurrency-manager'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { createComputeJobDeletionOwner, type ComputeJobDeletionOwner } from './job-deletion-owner'
import { readSshConfigHostAliases } from './ssh-config'
import { ComputeConnectionError, type ComputeConnectionBroker } from './connection-broker'
import { dispatchJob } from './job-dispatcher'
import { EnabledComputeHostsRegistry, enabledComputeHostsRegistry } from './enabled-hosts-registry'
import { deleteComputeHost, type DeleteComputeHostOptions } from './compute-host-deletion-owner'
import { SessionCacheOwner } from './session-cache-owner'
import { getJobHarvestDir, workspaceRelativePath } from './workspace-path'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import {
  createComputePermissionGrantAdapter,
  type LegacyComputeGrantPort
} from './permission-grant-adapter'
import {
  createComputeAuthenticationRuntime,
  projectComputeCredentialStatus,
  type ComputeAuthenticationDependencies,
  type ComputeHostLifecycle
} from './authentication-runtime'
export const COMPUTE_JOB_UPDATED_CHANNEL = 'compute:job-updated'

const log = createLogger('compute')

// Recursive readdir helper (returns absolute paths of all files).
const readdirRecursive = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await readdirRecursive(full)))
    } else {
      results.push(full)
    }
  }
  return results
}

// Converts a full ComputeJob to the lightweight JobSummary sent over IPC. The display_name is
// denormalized from the host list at query time in listJobSummaries below.
// Phase 3b: includes notification inbox timestamps so the renderer can decide whether to trigger
// an analysis turn (issue 05/07). The featured_files are computed by scanning the harvest directory.
export const toJobSummary = async (
  job: ComputeJob,
  displayName: string,
  storageRoot: string
): Promise<JobSummary> => {
  // Parse left_on_remote JSON safely (stored as string in DB, but JobSummary expects array).
  let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
  if (job.left_on_remote) {
    try {
      leftOnRemote = JSON.parse(job.left_on_remote)
    } catch {
      // Malformed JSON — fall back to empty array.
    }
  }

  // Compute featured_files by scanning the harvest directory (same logic as buildComputeDonePayload).
  const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
  const featuredDir = join(harvestDir, 'featured')
  const workspaceCwd = join(harvestDir, '..', '..')

  let featuredFiles: string[] = []
  if (!job.harvest_error) {
    try {
      const entries = await readdirRecursive(featuredDir)
      featuredFiles = entries.map((abs) => workspaceRelativePath(workspaceCwd, abs))
    } catch {
      // Directory does not exist or is unreadable — emit an empty list.
    }
  }

  return {
    job_id: job.job_id,
    provider_id: job.provider_id,
    display_name: displayName,
    shape: job.shape,
    session_id: job.session_id,
    project_id: job.project_id,
    status: job.status,
    raw_status: job.raw_status,
    integrity_issues: job.integrity_issues,
    needs_attention: job.needs_attention,
    cancellation_status: job.cancellation_status,
    intent: job.intent,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    exit_code: job.exit_code,
    error_code: job.error_code,
    last_poll_error: job.last_poll_error,
    remote_workdir: job.remote_workdir,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    // Phase 3b notification inbox timestamps (issue 06).
    notified_at: job.notified_at,
    notification_consumed_at: job.notification_consumed_at,
    analysis_state: job.analysis_state,
    analysis_message_id: job.analysis_message_id,
    analysis_updated_at: job.analysis_updated_at,
    // Phase 3b compute_done payload fields (spec §11.3).
    featured_files: featuredFiles,
    featured_file_count: featuredFiles.length,
    left_on_remote_count: leftOnRemote.length,
    left_on_remote: leftOnRemote,
    harvest_error: job.harvest_error ?? undefined
  }
}

// Renderer-callable Compute commands; transport and credential details remain behind their owners.
type ComputeHandlers = {
  list: () => Promise<ComputeHost[]>
  get: (providerId: string) => Promise<ComputeHost | null>
  create: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  createPassword: (
    request: CreatePasswordComputeHostRequest
  ) => Promise<CreatePasswordComputeHostResult>
  resetPassword: (
    request: ResetPasswordComputeHostRequest
  ) => Promise<ResetPasswordComputeHostResult>
  changeAuthentication: (
    request: ChangeComputeHostAuthenticationRequest
  ) => Promise<ChangeComputeHostAuthenticationResult>
  passwordCapability: () => Promise<ComputePasswordCapability>
  delete: (providerId: string, options?: DeleteComputeHostOptions) => Promise<void>
  deletionStatus: (providerId: string) => Promise<ComputeHostDeletionStatus>
  // Selectable Host aliases parsed from ~/.ssh/config (patterns and Match blocks excluded).
  sshConfigAliases: () => Promise<string[]>
  // Runs the probe bundle against the host and persists the result. Returns the ProbeResult.
  probe: (providerId: string) => Promise<ProbeResult>
  // Details document: read (with skeleton synthesis) and save (replace with old_text guard).
  detailsGet: (providerId: string) => Promise<{ doc: string; isSkeleton: boolean }>
  detailsSave: (
    providerId: string,
    text: string,
    oldText: string,
    author: DetailsAuthor
  ) => Promise<void>
  // Scratch root: set path and mark pinned.
  scratchSet: (providerId: string, path: string) => Promise<void>
  // Scratch root: clear the override so probes may auto-detect it again.
  scratchClear: (providerId: string) => Promise<void>
  // Enforced concurrent job limit: set 1..500.
  concurrencySet: (providerId: string, limit: number) => Promise<void>
  // Session-level concurrency control (Phase 3c, issue 04).
  setSessionConcurrencyLimit: (sessionId: string, limit: number) => Promise<void>
  getSessionConcurrencyStatus: (sessionId: string) => Promise<{
    session_limit: number | null
    active_count: number
    queued_count: number
    provider_ceilings: Record<string, number>
  }>
  listDir: (providerId: string, path: string) => Promise<DirListing>
  download: (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
  revealInFolder: (filePath: string) => void
  // The compute service instance, exposed so the notebook RPC server can wire computeCall.
  computeService: ComputeService
  connectionBroker: ComputeConnectionBroker
  concurrencyManager?: ConcurrencyManager
  // Responds to a pending approval request from the renderer with a canonical app-owned scope.
  approvalRespond: (id: string, decision: ComputeApprovalDecision) => void
  approvalReplay: (id: string) => ComputeApprovalRequest | null
  approvalReplayPending: () => void
  approvalPauseSession: (sessionId: string) => void
  approvalResumeSession: (sessionId: string) => void
  approvalCancelSession: (sessionId: string) => void
  approvalCancelAll: () => void
  approvalCompleteGlobalCancellation: () => void
  approvalCompleteSessionCancellation: (sessionId: string) => void
  approvalBeginSessionDeletion: (sessionId: string) => void
  approvalFinishSessionDeletion: (sessionId: string, retained: boolean) => void
  // Returns either a Session feed or the bounded global non-terminal activity projection.
  jobsList: (filter: ComputeJobsListFilter) => Promise<JobSummary[]>
  jobsCancel: (
    request: CancelComputeJobRequest
  ) => Promise<import('../../shared/compute').JobStatusResult>
  // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
  jobsPendingNotification: (filter: ComputeJobsPendingNotificationFilter) => Promise<JobSummary[]>
  // Marks the given job ids as notification-consumed. Idempotent (issue 05).
  jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
  jobsTransitionAnalysis: (request: ComputeJobAnalysisTransition) => Promise<JobSummary[]>
}

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
  sessionLimitPersistence?: SessionConcurrencyLimitPersistence
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
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('compute:approval-request', {
                ...request,
                ...(context?.sessionId ? { session_id: context.sessionId } : {})
              })
            }
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
        const current = await repository.get(providerId)
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
  const concurrencyManager =
    !injectedService && jobRepository
      ? new ConcurrencyManager(
          jobRepository,
          repository,
          (queuedJobId, handleJobUpdated) =>
            dispatchJob(queuedJobId, {
              connectionBroker,
              hostRepository: repository,
              jobRepository,
              onJobUpdated: handleJobUpdated,
              storageRoot
            }),
          onJobUpdated,
          undefined,
          undefined,
          sessionLimitPersistence
        )
      : undefined
  const service =
    injectedService ??
    new ComputeService({
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
  const listHostNames = async (): Promise<Map<string, string>> => {
    try {
      const hosts = await repository.list()
      return new Map(hosts.map((host) => [host.providerId, host.displayName]))
    } catch {
      return new Map()
    }
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
    deletionStatus: async (providerId) => ({
      blockedByJobs: (await jobRepository?.hasDeletionBlockingJobsForProvider(providerId)) ?? false
    }),
    delete: (providerId, options = { allowPasswordCredentialDeletion: true }) =>
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
      const { doc, isSkeleton } = await service.getDetails(providerId)
      return { doc, isSkeleton }
    },
    detailsSave: (providerId, text, oldText, author) =>
      service.replaceDetails(providerId, { text, oldText, author }),
    scratchSet: (providerId, path) => service.setScratchRoot(providerId, path),
    scratchClear: (providerId) => service.clearScratchRoot(providerId),
    concurrencySet: (providerId, limit) => service.setConcurrencyLimit(providerId, limit),
    setSessionConcurrencyLimit: (sessionId, limit) =>
      service.setSessionConcurrencyLimit(sessionId, limit),
    getSessionConcurrencyStatus: (sessionId) => service.getSessionConcurrencyStatus(sessionId),
    listDir: (providerId, path) => service.listDir(providerId, path),
    download: (providerId, remotePath, dest) => service.download(providerId, remotePath, dest),
    revealInFolder: (filePath) => {
      shell.showItemInFolder(filePath)
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
      const hostNameMap = await listHostNames()
      const jobs =
        'nonTerminal' in filter
          ? await jobRepository.findNonTerminal()
          : await jobRepository.findBySession(filter.sessionId, filter.status)
      return Promise.all(
        jobs.map((j) =>
          toJobSummary(j, hostNameMap.get(j.provider_id) ?? j.provider_id, storageRoot)
        )
      )
    },
    jobsCancel: (request) =>
      service.cancelJob(request.jobId, {
        projectId: request.projectId,
        sessionId: request.sessionId,
        providerId: request.providerId
      }),
    jobsPendingNotification: async (filter) => {
      if (!jobRepository || !storageRoot) return []
      const hostNameMap = await listHostNames()
      const jobs =
        typeof filter === 'string'
          ? await jobRepository.findPendingNotifications(filter)
          : await jobRepository.findPendingNotifications()
      return Promise.all(
        jobs.map((j) =>
          toJobSummary(j, hostNameMap.get(j.provider_id) ?? j.provider_id, storageRoot)
        )
      )
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
      const hostNameMap = await listHostNames()
      return Promise.all(
        jobs.map((job) =>
          toJobSummary(job, hostNameMap.get(job.provider_id) ?? job.provider_id, storageRoot)
        )
      )
    }
  }
}

// Production repository backed by the SQLite database under the (dev-aware) storage root. The client
// is passed as a provider (not a resolved promise) so a failed first initialization can be retried on
// the next request instead of being cached for the app's lifetime.
const createDefaultComputeHostRepository = (): ComputeHostRepository =>
  new ComputeHostRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultComputeJobRepository = (): ComputeJobRepository =>
  new ComputeJobRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultComputeJobOperationRepository = (): ComputeJobOperationRepository =>
  new ComputeJobOperationRepository(() => getProjectDbClient(resolveStorageRoot()))

// Broadcasts a job summary to all renderer windows. Called by the JobPoller onJobUpdated hook
// and by the job dispatcher on status transitions (Phase 3d, design.md §9).
export const broadcastJobUpdated = (summary: JobSummary): void =>
  broadcastToRenderers(COMPUTE_JOB_UPDATED_CHANNEL, summary)

export const createJobUpdatedBroadcaster =
  (
    hostRepository: ComputeHostRepository,
    storageRoot: string,
    jobRepository: Pick<ComputeJobRepository, 'get'>
  ): ((job: ComputeJob) => void) =>
  (job) => {
    void (async () => {
      let displayName = job.provider_id
      try {
        const host = await hostRepository.get(job.provider_id)
        if (host) displayName = host.displayName
      } catch {
        // Preserve provider fallback; likewise, only a successful null Job lookup proves deletion.
      }
      const current = await jobRepository.get(job.job_id).catch(() => null)
      if (!current) return
      let summary = await toJobSummary(current, displayName, storageRoot)
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
  sessionLimitPersistence?: SessionConcurrencyLimitPersistence
): ComputeIpcModule => {
  const operationRepository = createDefaultComputeJobOperationRepository()
  const storageRoot = resolveStorageRoot()
  const dataRoot = resolveDataRoot()
  const sessionCacheOwner = new SessionCacheOwner(dataRoot)
  void repository
    .cleanupOrphanCredentials?.()
    .catch((error) => log.warn('orphan Compute Credential cleanup failed', errorLogFields(error)))
  const effectiveLegacyComputeGrants =
    legacyComputeGrants ?? createSettingsComputeGrantPort(storageRoot)

  // Broadcast dispatcher status transitions to the renderer, same hook shape as the JobPoller uses.
  const onJobUpdated = createJobUpdatedBroadcaster(repository, dataRoot, jobRepository)
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
    sessionLimitPersistence
  )
  const jobDeletionOwner = createComputeJobDeletionOwner({
    jobRepository,
    hostRepository: repository,
    connectionBroker: handlers.connectionBroker,
    queueManager: handlers.concurrencyManager
  })

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

export {
  createComputeHandlers,
  createComputeIpcModule,
  createDefaultComputeHostRepository,
  createDefaultComputeJobRepository,
  createDefaultComputeJobOperationRepository,
  enabledComputeHostsRegistry
}
export { COMPUTE_JOBS_LIST_CHANNEL, installComputeIpcHandlers } from './electron-ipc-adapter'
export type { ComputeIpcAdapter } from './electron-ipc-adapter'
export type { ComputeHandlers, ComputeHostLifecycle, ComputeIpcModule }
