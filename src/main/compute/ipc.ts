import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { BrowserWindow, ipcMain, shell } from 'electron'

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
import type {
  DirListing,
  DownloadDest,
  LocalFile,
  SerializableRemoteFsError
} from '../../shared/remote-fs'
import { encodeRemoteFsError } from '../../shared/remote-fs'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveStorageRoot } from '../storage-root'
import { SettingsRepository } from '../settings/repository'
import { broadcastToRenderers } from '../renderer-broadcast'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService, type ArtifactResolver } from './compute-service'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { readSshConfigHostAliases } from './ssh-config'
import { SystemSshRunner } from './ssh-runner'
import { syncComputeSkillDoc } from './skill-doc'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { EnabledComputeHostsRegistry, enabledComputeHostsRegistry } from './enabled-hosts-registry'
import { getJobHarvestDir } from './harvest-engine'

// IPC channel names for the renderer job feed (Phase 3d, issue 05).
export const COMPUTE_JOBS_LIST_CHANNEL = 'compute:jobs:list'
export const COMPUTE_JOB_UPDATED_CHANNEL = 'compute:job-updated'

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
    featuredFiles = entries.map((abs) => relative(workspaceCwd, abs))
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
  // Returns JobSummary[] for a session, optionally filtered by status (renderer feed, issue 05).
  jobsList: (filter: { sessionId: string; status?: string[] }) => Promise<JobSummary[]>
  // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
  jobsPendingNotification: (sessionId: string) => Promise<JobSummary[]>
  // Marks the given job ids as notification-consumed. Idempotent (issue 05).
  jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
}

// Optional callback injected into createComputeHandlers so create/delete can re-sync the skill doc
// without coupling the handler factory to fs or settings (keeps it unit-testable).
type SkillDocSyncer = (hosts: ComputeHost[]) => Promise<void>

// Adapts a repository into thin handlers.
const createComputeHandlers = (
  repository: ComputeHostRepository,
  listSshAliases: () => Promise<string[]> = readSshConfigHostAliases,
  injectedService?: ComputeService,
  injectedBroker?: ComputeApprovalBroker,
  onSkillDocSync?: SkillDocSyncer,
  settingsRepository?: SettingsRepository,
  jobRepository?: ComputeJobRepository,
  onJobUpdated?: (job: ComputeJob) => void,
  artifactResolver?: ArtifactResolver,
  storageRoot?: string
): ComputeHandlers => {
  // The broadcast function sends approval requests to all renderer windows. In tests, callers
  // inject a fake broker so this function is never called directly.
  const broker =
    injectedBroker ??
    new ComputeApprovalBroker({
      generateId: () => randomUUID(),
      broadcast: (request: ComputeApprovalRequest) => {
        // Push the approval card to every focused BrowserWindow.
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('compute:approval-request', request)
        }
      },
      // Wire project-scope grant persistence through the settings repository (issue 05).
      checkProjectGrant: settingsRepository
        ? (grant) => settingsRepository.hasComputeGrant(grant)
        : undefined,
      saveProjectGrant: settingsRepository
        ? (grant) => settingsRepository.addComputeGrant(grant).then(() => undefined)
        : undefined
    })

  // Construct the production service with the full job dependency set so agent submit_job works and
  // dispatcher status transitions (submitted→running/error) broadcast to the renderer. Positional
  // args match the ComputeService constructor: (runner, repository, broker, scpRunner,
  // overrideDownloadsDir, jobRepository, onJobUpdated, artifactResolver, storageRoot).
  const service =
    injectedService ??
    new ComputeService(
      new SystemSshRunner(),
      repository,
      broker,
      undefined,
      undefined,
      jobRepository,
      onJobUpdated,
      artifactResolver,
      storageRoot
    )

  // Re-syncs the skill doc after a create or delete. Runs fire-and-forget — a failure to write
  // the skill doc never rolls back the host mutation (the doc is best-effort, like connector docs).
  const syncSkillDocAfterMutation = (syncer: SkillDocSyncer | undefined): void => {
    if (!syncer) return
    void repository
      .list()
      .then((hosts) => syncer(hosts))
      .catch((err) => {
        console.error('Failed to sync compute skill doc:', err)
      })
  }

  return {
    list: () => repository.list(),
    get: (providerId) => repository.get(providerId),
    create: async (request) => {
      const host = await repository.create(request)
      syncSkillDocAfterMutation(onSkillDocSync)
      return host
    },
    delete: async (providerId) => {
      if (jobRepository) {
        const hasActive = await jobRepository.hasActiveJobsForProvider(providerId)
        if (hasActive) {
          throw new Error(
            `Cannot delete host "${providerId}": it has submitted or running jobs. ` +
              `Wait for those jobs to reach a terminal state before deleting the host.`
          )
        }
      }
      await repository.delete(providerId)
      syncSkillDocAfterMutation(onSkillDocSync)
    },
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

// Registers the renderer-callable compute host commands.
const registerComputeIpcHandlers = (
  repository = createDefaultComputeHostRepository(),
  jobRepository = createDefaultComputeJobRepository(),
  // Resolves artifact-store paths for job input staging. Optional: when omitted, artifact inputs
  // (absolute src) throw a clear error while workspace and remote_path inputs still work.
  artifactResolver?: ArtifactResolver
): {
  computeService: ComputeService
  jobRepository: ComputeJobRepository
  hostRepository: ComputeHostRepository
  enabledComputeHostsRegistry: EnabledComputeHostsRegistry
} => {
  const storageRoot = resolveStorageRoot()
  const skillsDir = join(getAppClaudeConfigDir(storageRoot), 'skills')

  // Skill doc syncer: writes remote-compute-ssh/SKILL.md with the current host list (issue 06).
  const skillDocSyncer: SkillDocSyncer = (hosts) => syncComputeSkillDoc(skillsDir, hosts)

  // Share the settings repository with the broker so project grants are persisted (issue 05).
  const settingsRepo = new SettingsRepository(storageRoot)

  // Broadcast dispatcher status transitions to the renderer, same hook shape as the JobPoller uses.
  const onJobUpdated = createJobUpdatedBroadcaster(repository, storageRoot)

  const handlers = createComputeHandlers(
    repository,
    undefined,
    undefined,
    undefined,
    skillDocSyncer,
    settingsRepo,
    jobRepository,
    onJobUpdated,
    artifactResolver,
    storageRoot
  )

  // Write the initial skill doc at startup so agents see the host list from the first session.
  void repository
    .list()
    .then((hosts) => syncComputeSkillDoc(skillsDir, hosts))
    .catch((err) => {
      console.error('Failed to write initial compute skill doc:', err)
    })

  ipcMain.handle('compute:list', () => handlers.list())
  ipcMain.handle('compute:get', (_event, providerId: string) => handlers.get(providerId))
  ipcMain.handle('compute:create', (_event, request: CreateComputeHostRequest) =>
    handlers.create(request)
  )
  ipcMain.handle('compute:delete', (_event, request: DeleteComputeHostRequest) =>
    handlers.delete(request.providerId)
  )
  ipcMain.handle('compute:ssh-config-aliases', () => handlers.sshConfigAliases())
  ipcMain.handle('compute:probe', (_event, providerId: string) => handlers.probe(providerId))
  ipcMain.handle('compute:details:get', (_event, providerId: string) =>
    handlers.detailsGet(providerId)
  )
  ipcMain.handle(
    'compute:details:save',
    (_event, providerId: string, text: string, oldText: string, author: DetailsAuthor) =>
      handlers.detailsSave(providerId, text, oldText, author)
  )
  ipcMain.handle('compute:scratch:set', (_event, providerId: string, path: string) =>
    handlers.scratchSet(providerId, path)
  )
  ipcMain.handle('compute:concurrency:set', (_event, providerId: string, limit: number) =>
    handlers.concurrencySet(providerId, limit)
  )
  // Session-level concurrency control (Phase 3c, issue 04).
  ipcMain.handle(
    'compute:session:set-concurrency-limit',
    (_event, sessionId: string, limit: number) =>
      handlers.setSessionConcurrencyLimit(sessionId, limit)
  )
  ipcMain.handle('compute:session:status', (_event, sessionId: string) =>
    handlers.getSessionConcurrencyStatus(sessionId)
  )
  // Lists a remote directory (browse experience, issue 05).
  ipcMain.handle('compute:list-dir', async (_event, providerId: string, path: string) => {
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
  ipcMain.handle(
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
  ipcMain.handle('compute:reveal-in-folder', (_event, filePath: string) => {
    handlers.revealInFolder(filePath)
  })
  // Renderer responds to an in-flight approval card (issue 04/05). Decision now carries the
  // chosen scope: 'once' | 'conversation' | 'project' | 'deny'.
  ipcMain.handle(
    'compute:approval-respond',
    (_event, request: { id: string; decision: ComputeApprovalDecision }) => {
      handlers.approvalRespond(request.id, request.decision)
    }
  )
  // Returns all jobs for a session as JobSummary[], optionally filtered by status (Phase 3d).
  ipcMain.handle(
    COMPUTE_JOBS_LIST_CHANNEL,
    (_event, filter: { sessionId: string; status?: string[] }) => handlers.jobsList(filter)
  )
  // Returns jobs pending analysis turn (notifiedAt set, notificationConsumedAt null — issue 05).
  ipcMain.handle('compute:jobs:pending-notification', (_event, sessionId: string) =>
    handlers.jobsPendingNotification(sessionId)
  )
  // Marks job ids as notification-consumed (analysis turn done — issue 05).
  ipcMain.handle('compute:jobs:mark-consumed', (_event, sessionId: string, jobIds: string[]) =>
    handlers.jobsMarkConsumed(sessionId, jobIds)
  )

  // Per-session enabled compute hosts (issue 06). The renderer owns the durable state (session
  // JSON); the main-process registry is the runtime cache consulted by list_compute RPC ops.
  ipcMain.handle('compute:enabled-hosts:get', (_event, sessionId: string): string[] =>
    enabledComputeHostsRegistry.get(sessionId)
  )
  ipcMain.handle(
    'compute:enabled-hosts:set',
    (_event, sessionId: string, providerIds: string[]): void => {
      enabledComputeHostsRegistry.set(sessionId, providerIds)
    }
  )

  return {
    computeService: handlers.computeService,
    jobRepository,
    hostRepository: repository,
    enabledComputeHostsRegistry
  }
}

export {
  createComputeHandlers,
  createDefaultComputeHostRepository,
  createDefaultComputeJobRepository,
  registerComputeIpcHandlers,
  enabledComputeHostsRegistry
}
export type { ComputeHandlers, SkillDocSyncer }
