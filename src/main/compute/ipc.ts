import { randomUUID } from 'node:crypto'

import { BrowserWindow, ipcMain, shell } from 'electron'

import type {
  ComputeApprovalDecision,
  ComputeHost,
  ComputeApprovalRequest,
  CreateComputeHostRequest,
  DeleteComputeHostRequest,
  DetailsAuthor,
  ProbeResult
} from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveStorageRoot } from '../storage-root'
import { SettingsRepository } from '../settings/repository'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService } from './compute-service'
import { ComputeHostRepository } from './repository'
import { readSshConfigHostAliases } from './ssh-config'
import { SystemSshRunner } from './ssh-runner'
import { syncComputeSkillDoc } from './skill-doc'
import { getAppClaudeConfigDir } from '../settings/provider-env'
import { join } from 'node:path'

// The renderer-callable compute commands. Kept as a thin adapter over the repository + the pure
// ssh-config parser so the IPC surface stays easy to unit test (aligns with projects/ipc.ts). Issue 01:
// host record CRUD + ssh-config alias listing. Issue 02 adds probe. Issue 03 adds
// details/scratch/concurrency. Issue 04 adds callCommand + the approval broker wiring.
// Issue 05 (browse) adds listDir. Issue 06 adds list (via ComputeService) and skill doc sync.
// Issue 03 (file-preview) adds download (os-downloads + artifact).
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
  settingsRepository?: SettingsRepository
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

  const service = injectedService ?? new ComputeService(new SystemSshRunner(), repository, broker)

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
    listDir: (providerId, path) => service.listDir(providerId, path),
    download: (providerId, remotePath, dest) => service.download(providerId, remotePath, dest),
    revealInFolder: (filePath) => {
      shell.showItemInFolder(filePath)
    },
    computeService: service,
    approvalRespond: (id, decision) => broker.respond(id, decision)
  }
}

// Production repository backed by the SQLite database under the (dev-aware) storage root. The client
// is passed as a provider (not a resolved promise) so a failed first initialization can be retried on
// the next request instead of being cached for the app's lifetime.
const createDefaultComputeHostRepository = (): ComputeHostRepository =>
  new ComputeHostRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers the renderer-callable compute host commands.
const registerComputeIpcHandlers = (
  repository = createDefaultComputeHostRepository()
): { computeService: ComputeService } => {
  const storageRoot = resolveStorageRoot()
  const skillsDir = join(getAppClaudeConfigDir(storageRoot), 'skills')

  // Skill doc syncer: writes remote-compute-ssh/SKILL.md with the current host list (issue 06).
  const skillDocSyncer: SkillDocSyncer = (hosts) => syncComputeSkillDoc(skillsDir, hosts)

  // Share the settings repository with the broker so project grants are persisted (issue 05).
  const settingsRepo = new SettingsRepository(storageRoot)

  const handlers = createComputeHandlers(
    repository,
    undefined,
    undefined,
    undefined,
    skillDocSyncer,
    settingsRepo
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
  // Lists a remote directory (browse experience, issue 05).
  ipcMain.handle('compute:list-dir', (_event, providerId: string, path: string) =>
    handlers.listDir(providerId, path)
  )
  // Downloads a remote file to OS Downloads or project artifact. No approval gate (issue 03).
  ipcMain.handle(
    'compute:download',
    (_event, providerId: string, remotePath: string, dest: DownloadDest) =>
      handlers.download(providerId, remotePath, dest)
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

  return { computeService: handlers.computeService }
}

export { createComputeHandlers, createDefaultComputeHostRepository, registerComputeIpcHandlers }
export type { ComputeHandlers, SkillDocSyncer }
