import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserWindow, shell } from 'electron'

import type {
  ComputeApprovalDecision,
  ComputeHost,
  ComputeApprovalRequest,
  ComputeJob,
  JobSummary,
  CreateComputeHostRequest,
  DetailsAuthor,
  ProbeResult
} from '../../shared/compute'
import { computeProviderId } from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import { getProjectDbClient } from '../projects/prisma-client'
import { createLogger, errorLogFields } from '../logger'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { createSettingsComputeGrantPort } from '../settings/compute-grant-port'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { opencodeConfigDir } from '../agent-framework/opencode'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { TaskNotificationService } from '../notifications/task-notifications'
import { buildComputeApprovalBroadcast } from '../notifications/electron-wiring'
import { ComputeApprovalBroker, type ComputeApprovalContext } from './compute-approval-broker'
import { ComputeService, type ArtifactResolver } from './compute-service'
import { ConcurrencyManager } from './concurrency-manager'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { createComputeJobDeletionOwner, type ComputeJobDeletionOwner } from './job-deletion-owner'
import { readSshConfigHostAliases } from './ssh-config'
import { SystemSshRunner } from './ssh-runner'
import { SystemScpRunner } from './scp-runner'
import { dispatchJob } from './job-dispatcher'
import { EnabledComputeHostsRegistry, enabledComputeHostsRegistry } from './enabled-hosts-registry'
import { getJobHarvestDir } from './harvest-engine'
import { workspaceRelativePath } from './workspace-path'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import {
  createComputePermissionGrantAdapter,
  type LegacyComputeGrantPort
} from './permission-grant-adapter'
import { hasCanonicalComputeSkillDoc, syncComputeSkillDoc } from './skill-doc'
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
  try {
    const entries = await readdirRecursive(featuredDir)
    featuredFiles = entries.map((abs) => workspaceRelativePath(workspaceCwd, abs))
  } catch {
    // Directory does not exist or is unreadable — emit empty list (execution-error / harvest_failed).
  }

  return {
    job_id: job.job_id,
    provider_id: job.provider_id,
    display_name: displayName,
    shape: job.shape,
    session_id: job.session_id,
    status: job.status,
    intent: job.intent,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    exit_code: job.exit_code,
    error_code: job.error_code,
    remote_workdir: job.remote_workdir,
    stdout_tail: job.stdout_tail,
    stderr_tail: job.stderr_tail,
    // Phase 3b notification inbox timestamps (issue 06).
    notified_at: job.notified_at,
    notification_consumed_at: job.notification_consumed_at,
    // Phase 3b compute_done payload fields (spec §11.3).
    featured_files: featuredFiles,
    featured_file_count: featuredFiles.length,
    left_on_remote_count: leftOnRemote.length,
    left_on_remote: leftOnRemote,
    harvest_error: job.harvest_error ?? undefined
  }
}

// The renderer-callable compute commands. Kept as a thin adapter over the repository + the pure
// ssh-config parser so the IPC surface stays easy to unit test (aligns with projects/ipc.ts). Issue 01:
// host record CRUD + ssh-config alias listing. Issue 02 adds probe. Issue 03 adds
// details/scratch/concurrency. Issue 04 adds callCommand + the approval broker wiring.
// Issue 05 (browse) adds listDir. Issue 06 adds list (via ComputeService) and skill doc sync.
// Issue 03 (file-preview) adds download (os-downloads + artifact).
// Issue 05 (renderer-job-feed): jobsList (compute:jobs:list IPC).
type ComputeHandlers = {
  list: () => Promise<ComputeHost[]>
  get: (providerId: string) => Promise<ComputeHost | null>
  create: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  delete: (providerId: string) => Promise<void>
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
  concurrencyManager?: ConcurrencyManager
  // Responds to a pending approval request from the renderer. Decision now includes
  // 'conversation' and 'project' scopes in addition to 'once' and 'deny' (issue 05).
  approvalRespond: (id: string, decision: ComputeApprovalDecision) => void
  approvalReplay: (id: string) => ComputeApprovalRequest | null
  approvalReplayPending: () => void
  approvalPauseSession: (sessionId: string) => void
  approvalResumeSession: (sessionId: string) => void
  // Returns JobSummary[] for a session, optionally filtered by status (renderer feed, issue 05).
  jobsList: (filter: { sessionId: string; status?: string[] }) => Promise<JobSummary[]>
  // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
  jobsPendingNotification: (sessionId: string) => Promise<JobSummary[]>
  // Marks the given job ids as notification-consumed. Idempotent (issue 05).
  jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
}

type ComputeHostLifecycle = Readonly<{
  pruneSessionEnabledHosts(providerId: string, afterPrune?: () => Promise<void>): Promise<void>
  requestSkillRuntimeReload?: () => void
}>

// Adapts a repository into thin handlers.
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
  syncComputeSkillDocument?: () => Promise<void>,
  hostLifecycle?: ComputeHostLifecycle
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

  // Construct the production service with the full job dependency set so agent submit_job works and
  // dispatcher status transitions (submitted→running/error) broadcast to the renderer. Positional
  // args match the ComputeService constructor: (runner, repository, broker, scpRunner,
  // overrideDownloadsDir, jobRepository, onJobUpdated, artifactResolver, storageRoot,
  // concurrencyManager).
  //
  // The ConcurrencyManager enforces session limits + provider ceilings and auto-dispatches queued
  // jobs when a slot frees up. It is wired here (not in ComputeService) because it needs a
  // dispatchJob closure carrying the same runner/scp/repository deps the dispatcher uses. Only built
  // for the production path — tests inject their own service and drive the manager directly.
  const sshRunner = new SystemSshRunner()
  const scpRunner = new SystemScpRunner()
  const concurrencyManager =
    !injectedService && jobRepository
      ? new ConcurrencyManager(
          jobRepository,
          repository,
          (queuedJobId, handleJobUpdated) =>
            dispatchJob(queuedJobId, {
              runner: sshRunner,
              scpRunner,
              hostRepository: repository,
              jobRepository,
              onJobUpdated: handleJobUpdated
            }),
          onJobUpdated
        )
      : undefined
  const service =
    injectedService ??
    new ComputeService(
      sshRunner,
      repository,
      broker,
      scpRunner,
      undefined,
      jobRepository,
      undefined,
      artifactResolver,
      storageRoot,
      concurrencyManager
    )

  return {
    list: () => repository.list(),
    get: (providerId) => repository.get(providerId),
    create: (request) =>
      runHostLifecycleMutation(async () => {
        if (permissionGrantRegistry || hostLifecycle) {
          const providerId = computeProviderId(request.sshAlias)
          const existing = await repository.get(providerId)
          if (!existing) {
            await permissionGrantRegistry?.prune({ kind: 'compute_provider', providerId })
            await hostLifecycle?.pruneSessionEnabledHosts(providerId)
          }
        }
        const host = await repository.create(request)
        try {
          await syncComputeSkillDocument?.()
        } finally {
          hostLifecycle?.requestSkillRuntimeReload?.()
        }
        return host
      }),
    delete: (providerId) =>
      runHostLifecycleMutation(async () => {
        if (jobRepository) {
          const hasActive = await jobRepository.hasActiveJobsForProvider(providerId)
          if (hasActive) {
            throw new Error(
              `Cannot delete host "${providerId}": it has submitted or running jobs. ` +
                `Wait for those jobs to reach a terminal state before deleting the host.`
            )
          }
        }
        await broker.invalidateProvider(providerId)
        try {
          const deleteProvider = (): Promise<void> => repository.delete(providerId)
          if (hostLifecycle) {
            await hostLifecycle.pruneSessionEnabledHosts(providerId, deleteProvider)
          } else {
            await deleteProvider()
          }
          try {
            await permissionGrantRegistry?.prune({ kind: 'compute_provider', providerId })
          } catch (error) {
            log.warn(
              'compute permission grant cleanup after host deletion failed',
              errorLogFields(error)
            )
          }
          try {
            await syncComputeSkillDocument?.()
          } catch (error) {
            log.warn('compute skill sync after host deletion failed', errorLogFields(error))
          } finally {
            hostLifecycle?.requestSkillRuntimeReload?.()
          }
        } finally {
          broker.completeProviderInvalidation(providerId)
        }
      }),
    sshConfigAliases: () => listSshAliases(),
    probe: async (providerId) => {
      // Probe failures such as an unreachable host are persisted ProbeResult values, not rejected
      // operations. Refresh derived Skill state only after the owner has returned from its commit;
      // an exception before that point keeps the existing projection and runtime generation intact.
      const result = await service.probe(providerId)
      try {
        await syncComputeSkillDocument?.()
      } catch (error) {
        log.warn('compute skill sync after host probe failed', errorLogFields(error))
      } finally {
        hostLifecycle?.requestSkillRuntimeReload?.()
      }
      return result
    },
    detailsGet: (providerId) => service.getDetails(providerId),
    detailsSave: (providerId, text, oldText, author) =>
      service.replaceDetails(providerId, { text, oldText, author }),
    scratchSet: (providerId, path) => service.setScratchRoot(providerId, path),
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
    concurrencyManager,
    approvalRespond: (id, decision) => broker.respond(id, decision),
    approvalReplay: (id) => broker.getPending(id),
    approvalReplayPending: () => broker.replayPending(),
    approvalPauseSession: (sessionId) => broker.pauseSession(sessionId),
    approvalResumeSession: (sessionId) => broker.resumeSession(sessionId),
    jobsList: async (filter) => {
      if (!jobRepository || !storageRoot) return []
      const hosts = await repository.list()
      const hostNameMap = new Map(hosts.map((h) => [h.providerId, h.displayName]))
      const jobs = await jobRepository.findBySession(filter.sessionId, filter.status)
      return Promise.all(
        jobs.map((j) =>
          toJobSummary(j, hostNameMap.get(j.provider_id) ?? j.provider_id, storageRoot)
        )
      )
    },
    jobsPendingNotification: async (sessionId) => {
      if (!jobRepository || !storageRoot) return []
      const hosts = await repository.list()
      const hostNameMap = new Map(hosts.map((h) => [h.providerId, h.displayName]))
      const jobs = await jobRepository.findPendingNotifications(sessionId)
      return Promise.all(
        jobs.map((j) =>
          toJobSummary(j, hostNameMap.get(j.provider_id) ?? j.provider_id, storageRoot)
        )
      )
    },
    jobsMarkConsumed: async (sessionId, jobIds) => {
      if (!jobRepository) return
      await jobRepository.markNotificationsConsumed(sessionId, jobIds)
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

const syncCurrentComputeSkillDocuments = async (
  storageRoot: string,
  repository: ComputeHostRepository
): Promise<void> => {
  const skillsDirs = [
    join(opencodeConfigDir(storageRoot), 'skills'),
    join(codexStorageDir(storageRoot), 'skills'),
    join(codexSubscriptionStorageDir(storageRoot), 'skills')
  ]
  const existing = await Promise.all(
    skillsDirs.map((skillsDir) => hasCanonicalComputeSkillDoc(skillsDir))
  )
  if (!existing.some(Boolean)) return
  const hosts = await repository.list()
  await Promise.all(
    skillsDirs.map((skillsDir, index) =>
      existing[index] ? syncComputeSkillDoc(skillsDir, hosts) : undefined
    )
  )
}

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
      if (!(await jobRepository.get(job.job_id).catch(() => true))) return
      const summary = await toJobSummary(job, displayName, storageRoot)
      if (await jobRepository.get(job.job_id).catch(() => true)) broadcastJobUpdated(summary)
    })().catch(() => undefined)
  }

type ComputeIpcModule = {
  handlers: ComputeHandlers
  computeService: ComputeService
  jobDeletionOwner: ComputeJobDeletionOwner
  jobRepository: ComputeJobRepository
  hostRepository: ComputeHostRepository
  enabledComputeHostsRegistry: EnabledComputeHostsRegistry
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
  hostLifecycle?: ComputeHostLifecycle
): ComputeIpcModule => {
  const storageRoot = resolveStorageRoot()
  const dataRoot = resolveDataRoot()
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
    () => syncCurrentComputeSkillDocuments(storageRoot, repository),
    hostLifecycle
  )
  const jobDeletionOwner = createComputeJobDeletionOwner({
    jobRepository,
    hostRepository: repository,
    runner: new SystemSshRunner(),
    queueManager: handlers.concurrencyManager
  })

  return {
    handlers,
    computeService: handlers.computeService,
    jobDeletionOwner,
    jobRepository,
    hostRepository: repository,
    enabledComputeHostsRegistry
  }
}

export {
  createComputeHandlers,
  createComputeIpcModule,
  createDefaultComputeHostRepository,
  createDefaultComputeJobRepository,
  enabledComputeHostsRegistry
}
export { COMPUTE_JOBS_LIST_CHANNEL, installComputeIpcHandlers } from './electron-ipc-adapter'
export type { ComputeIpcAdapter } from './electron-ipc-adapter'
export type { ComputeHandlers, ComputeHostLifecycle, ComputeIpcModule }
