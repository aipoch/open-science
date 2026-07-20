import { ipcMain } from 'electron'

import type {
  ComputeHost,
  CreateComputeHostRequest,
  DeleteComputeHostRequest
} from '../../shared/compute'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveStorageRoot } from '../storage-root'
import { ComputeHostRepository } from './repository'
import { readSshConfigHostAliases } from './ssh-config'

// The renderer-callable compute commands. Kept as a thin adapter over the repository + the pure
// ssh-config parser so the IPC surface stays easy to unit test (aligns with projects/ipc.ts). Phase 1
// (issue 01): host record CRUD + ssh-config alias listing. No SSH connection is made here.
type ComputeHandlers = {
  list: () => Promise<ComputeHost[]>
  get: (providerId: string) => Promise<ComputeHost | null>
  create: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  delete: (providerId: string) => Promise<void>
  // Selectable Host aliases parsed from ~/.ssh/config (patterns and Match blocks excluded).
  sshConfigAliases: () => Promise<string[]>
}

// Adapts a repository into thin handlers.
const createComputeHandlers = (
  repository: ComputeHostRepository,
  listSshAliases: () => Promise<string[]> = readSshConfigHostAliases
): ComputeHandlers => ({
  list: () => repository.list(),
  get: (providerId) => repository.get(providerId),
  create: (request) => repository.create(request),
  delete: (providerId) => repository.delete(providerId),
  sshConfigAliases: () => listSshAliases()
})

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
}

export { createComputeHandlers, createDefaultComputeHostRepository, registerComputeIpcHandlers }
export type { ComputeHandlers }
