import { ipcMain } from 'electron'

import type {
  ComputeHost,
  CreateComputeHostRequest,
  DeleteComputeHostRequest,
  DetailsAuthor,
  ProbeResult
} from '../../shared/compute'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveStorageRoot } from '../storage-root'
import { ComputeService } from './compute-service'
import { ComputeHostRepository } from './repository'
import { readSshConfigHostAliases } from './ssh-config'
import { SystemSshRunner } from './ssh-runner'

// The renderer-callable compute commands. Kept as a thin adapter over the repository + the pure
// ssh-config parser so the IPC surface stays easy to unit test (aligns with projects/ipc.ts). Issue 01:
// host record CRUD + ssh-config alias listing. Issue 02 adds probe. Issue 03 adds details/scratch/concurrency.
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
}

// Adapts a repository into thin handlers.
const createComputeHandlers = (
  repository: ComputeHostRepository,
  listSshAliases: () => Promise<string[]> = readSshConfigHostAliases,
  computeService?: ComputeService
): ComputeHandlers => {
  const service = computeService ?? new ComputeService(new SystemSshRunner(), repository)
  return {
    list: () => repository.list(),
    get: (providerId) => repository.get(providerId),
    create: (request) => repository.create(request),
    delete: (providerId) => repository.delete(providerId),
    sshConfigAliases: () => listSshAliases(),
    probe: (providerId) => service.probe(providerId),
    detailsGet: (providerId) => service.getDetails(providerId),
    detailsSave: (providerId, text, oldText, author) =>
      service.replaceDetails(providerId, { text, oldText, author }),
    scratchSet: (providerId, path) => service.setScratchRoot(providerId, path),
    concurrencySet: (providerId, limit) => service.setConcurrencyLimit(providerId, limit)
  }
}

// Production repository backed by the SQLite database under the (dev-aware) storage root. The client
// is passed as a provider (not a resolved promise) so a failed first initialization can be retried on
// the next request instead of being cached for the app's lifetime.
const createDefaultComputeHostRepository = (): ComputeHostRepository =>
  new ComputeHostRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers the renderer-callable compute host commands.
const registerComputeIpcHandlers = (repository = createDefaultComputeHostRepository()): void => {
  const handlers = createComputeHandlers(repository)

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
}

export { createComputeHandlers, createDefaultComputeHostRepository, registerComputeIpcHandlers }
export type { ComputeHandlers }
