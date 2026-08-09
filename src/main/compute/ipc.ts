import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserWindow, shell } from 'electron'

import {
  createIpcHandlerInstallationScope,
  ipcMainHandle,
  type IpcHandlerInstallation
} from '../ipc-handler-registry'

import type {
  ComputeApprovalDecision,
  ComputeHost,
  ComputeApprovalRequest,
  ComputeJob,
  JobSummary,
  CreateComputeHostRequest,
  DeleteComputeHostRequest,
  DetailsAuthor,
  ProbeResult
} from '../../shared/compute'
import { computeProviderId } from '../../shared/compute'
import type {
  DirListing,
  DownloadDest,
  LocalFile,
  SerializableRemoteFsError
} from '../../shared/remote-fs'
import { encodeRemoteFsError } from '../../shared/remote-fs'
import { getProjectDbClient } from '../projects/prisma-client'
import { createLogger, errorLogFields } from '../logger'
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import { getAppClaudeConfigDir } from '../settings/provider-env'
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

// IPC channel names for the renderer job feed (Phase 3d, issue 05).
export const COMPUTE_JOBS_LIST_CHANNEL = 'compute:jobs:list'
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
  // Concurrent job limit: store 1..500 (not enforced in Phase 1).
  concurrencySet: (providerId: string, limit: number) => Promise<void>
  // Session-level concurrency control (Phase 3c, issue 04).
  setSessionConcurrencyLimit: (sessionId: string, limit: number) => Promise<void>
  getSessionConcurrencyStatus: (sessionId: string) => Promise<{
    session_limit: number | null
    active_count: number
    queued_count: number
    provider_ceilings: Record<string, number>
  }>
  // Lists the contents of a remote directory (non-approval, metadata only).
  listDir: (providerId: string, path: string) => Promise<DirListing>
  // Downloads a remote file to OS Downloads or project artifact. No approval gate for UI actions.
  download: (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
  // Reveals a local file in the OS file manager (Finder/Explorer).
  revealInFolder: (filePath: string) => void
  // The compute service instance, exposed so the notebook RPC server can wire computeCall.
  computeService: ComputeService
  // Responds to a pending approval request from the renderer. Decision now includes
  // 'conversation' and 'project' scopes in addition to 'once' and 'deny' (issue 05).
  approvalRespond: (id: string, decision: ComputeApprovalDecision) => void
  approvalReplay: (id: string) => ComputeApprovalRequest | null
  approvalPauseSession: (sessionId: string) => void
  approvalResumeSession: (sessionId: string) => void
  // Returns JobSummary[] for a session, optionally filtered by status (renderer feed, issue 05).
  jobsList: (filter: { sessionId: string; status?: string[] }) => Promise<JobSummary[]>
  // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
  jobsPendingNotification: (sessionId: string) => Promise<JobSummary[]>
  // Marks the given job ids as notification-consumed. Idempotent (issue 05).
  jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
}

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
  syncComputeSkillDocument?: () => Promise<void>
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
      onSettled: taskNotifications
        ? (id, state) => void taskNotifications.settleAuthorization('compute', id, state)
        : undefined,
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
  const service =
    injectedService ??
    (() => {
      const sshRunner = new SystemSshRunner()
      const scpRunner = new SystemScpRunner()

      // ConcurrencyManager owns the complete publish-and-drain policy. It hands that same bound
      // sink to queued dispatches, while ComputeService delegates direct dispatch and poller updates
      // to it. This keeps one contract without a construction-order callback box.
      const concurrencyManager = jobRepository
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

      return new ComputeService(
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
    })()

  return {
    list: () => repository.list(),
    get: (providerId) => repository.get(providerId),
    create: (request) =>
      runHostLifecycleMutation(async () => {
        if (permissionGrantRegistry) {
          const providerId = computeProviderId(request.sshAlias)
          const existing = await repository.get(providerId)
          if (!existing) {
            await permissionGrantRegistry.prune({ kind: 'compute_provider', providerId })
          }
        }
        const host = await repository.create(request)
        await syncComputeSkillDocument?.()
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
          await repository.delete(providerId)
          await permissionGrantRegistry?.prune({ kind: 'compute_provider', providerId })
          await syncComputeSkillDocument?.()
        } finally {
          broker.completeProviderInvalidation(providerId)
        }
      }),
    sshConfigAliases: () => listSshAliases(),
    probe: (providerId) => service.probe(providerId),
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
    approvalRespond: (id, decision) => broker.respond(id, decision),
    approvalReplay: (id) => broker.getPending(id),
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
    jobsMarkConsumed: async (_sessionId, jobIds) => {
      if (!jobRepository) return
      await jobRepository.markNotificationsConsumed(jobIds)
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
    join(getAppClaudeConfigDir(storageRoot), 'skills'),
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
export const broadcastJobUpdated = (summary: JobSummary): void => {
  broadcastToRenderers(COMPUTE_JOB_UPDATED_CHANNEL, summary)
}

// Builds the onJobUpdated hook shared by the JobPoller (poll transitions/tails) and the
// ComputeService/dispatcher (submitted→running→error transitions). Looks up the host display name
// asynchronously, then broadcasts. Fire-and-forget: a transient failure to fetch the host falls
// back to the provider_id string so the broadcast always happens.
export const createJobUpdatedBroadcaster =
  (hostRepository: ComputeHostRepository, storageRoot: string): ((job: ComputeJob) => void) =>
  (job) => {
    void hostRepository
      .get(job.provider_id)
      .then(async (host) => {
        const summary = await toJobSummary(job, host?.displayName ?? job.provider_id, storageRoot)
        broadcastJobUpdated(summary)
      })
      .catch(async () => {
        const summary = await toJobSummary(job, job.provider_id, storageRoot)
        broadcastJobUpdated(summary)
      })
  }

type ComputeIpcModule = {
  handlers: ComputeHandlers
  computeService: ComputeService
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
  legacyComputeGrants?: LegacyComputeGrantPort
): ComputeIpcModule => {
  const storageRoot = resolveStorageRoot()
  const dataRoot = resolveDataRoot()
  const effectiveLegacyComputeGrants =
    legacyComputeGrants ?? createSettingsComputeGrantPort(storageRoot)

  // Broadcast dispatcher status transitions to the renderer, same hook shape as the JobPoller uses.
  const onJobUpdated = createJobUpdatedBroadcaster(repository, dataRoot)

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
    () => syncCurrentComputeSkillDocuments(storageRoot, repository)
  )

  return {
    handlers,
    computeService: handlers.computeService,
    jobRepository,
    hostRepository: repository,
    enabledComputeHostsRegistry
  }
}

type ComputeIpcAdapter = Pick<ComputeIpcModule, 'handlers' | 'enabledComputeHostsRegistry'>

const registerComputeIpcHandlerSet = ({
  handlers,
  enabledComputeHostsRegistry
}: ComputeIpcAdapter): void => {
  ipcMainHandle('compute:list', () => handlers.list())
  ipcMainHandle('compute:get', (_event, providerId: string) => handlers.get(providerId))
  ipcMainHandle('compute:create', (_event, request: CreateComputeHostRequest) =>
    handlers.create(request)
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
  // Returns all jobs for a session as JobSummary[], optionally filtered by status (Phase 3d).
  ipcMainHandle(
    COMPUTE_JOBS_LIST_CHANNEL,
    (_event, filter: { sessionId: string; status?: string[] }) => handlers.jobsList(filter)
  )
  // Returns jobs pending analysis turn (notifiedAt set, notificationConsumedAt null — issue 05).
  ipcMainHandle('compute:jobs:pending-notification', (_event, sessionId: string) =>
    handlers.jobsPendingNotification(sessionId)
  )
  // Marks job ids as notification-consumed (analysis turn done — issue 05).
  ipcMainHandle('compute:jobs:mark-consumed', (_event, sessionId: string, jobIds: string[]) =>
    handlers.jobsMarkConsumed(sessionId, jobIds)
  )

  // Per-session enabled compute hosts (issue 06). The renderer owns the durable state (session
  // JSON); the main-process registry is the runtime cache consulted by list_compute RPC ops.
  ipcMainHandle('compute:enabled-hosts:get', (_event, sessionId: string): string[] =>
    enabledComputeHostsRegistry.get(sessionId)
  )
  ipcMainHandle(
    'compute:enabled-hosts:set',
    (_event, sessionId: string, providerIds: string[]): void => {
      enabledComputeHostsRegistry.set(sessionId, providerIds)
    }
  )
}

// Installs only the renderer-callable Electron adapter over an already-constructed Compute module.
const installComputeIpcHandlers = (module: ComputeIpcAdapter): IpcHandlerInstallation => {
  const scope = createIpcHandlerInstallationScope()
  try {
    registerComputeIpcHandlerSet(module)
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  createComputeHandlers,
  createComputeIpcModule,
  createDefaultComputeHostRepository,
  createDefaultComputeJobRepository,
  installComputeIpcHandlers,
  enabledComputeHostsRegistry
}
export type { ComputeHandlers, ComputeIpcModule }
