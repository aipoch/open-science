import { ipcMain } from 'electron'

import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PersistedPreviewState,
  SavePreviewStateRequest
} from '../../shared/preview-state'
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  UpdateProjectRequest
} from '../../shared/projects'
import type { ProjectDeletionCoordinator } from './deletion-coordinator'
import { PreviewStateRepository } from './preview-repository'
import { getProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { createLogger } from '../logger'
import { resolveStorageRoot } from '../storage-root'

const log = createLogger('projects:ipc')

type ProjectHandlers = {
  list: () => Promise<Project[]>
  get: (id: string) => Promise<Project | null>
  create: (request: CreateProjectRequest) => Promise<Project>
  update: (request: UpdateProjectRequest) => Promise<Project>
  delete: (id: string) => Promise<void>
}

// Production repositories backed by the SQLite database under the (dev-aware) storage root. The client is
// passed as a provider (not a resolved promise) so a failed first initialization can be retried on the
// next request instead of being cached for the app's lifetime.
const createDefaultProjectRepository = (): ProjectRepository =>
  new ProjectRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultPreviewStateRepository = (): PreviewStateRepository =>
  new PreviewStateRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveStorageRoot()))

type ProjectDeleteHandler = Pick<
  ProjectDeletionCoordinator,
  'deleteProject' | 'recoverPendingDeletions'
>
type ProjectCrudRepository = Pick<ProjectRepository, 'list' | 'get' | 'create' | 'update'>
type ProjectReviewDeletion = Pick<ReviewRepository, 'deleteReviewsForProject'>

// Adapts repository operations into thin handlers while enforcing one shared recovery gate. CRUD
// cannot observe or mutate projects until every durable deletion intent has finished replaying.
const createProjectHandlers = (
  repository: ProjectCrudRepository,
  reviewRepository: ProjectReviewDeletion,
  deletionCoordinator: ProjectDeleteHandler
): ProjectHandlers => ({
  list: async () => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.list()
  },
  get: async (id) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.get(id)
  },
  create: async (request) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.create(request)
  },
  update: async (request) => {
    await deletionCoordinator.recoverPendingDeletions()
    return repository.update(request)
  },
  delete: async (id) => {
    await deletionCoordinator.recoverPendingDeletions()
    // Reviewer data is auxiliary. Log cleanup failures but never block the authoritative project,
    // session, and managed-file deletion transaction.
    await reviewRepository.deleteReviewsForProject(id).catch((error: unknown) => {
      log.warn('deleteReviewsForProject failed (non-fatal)', {
        projectId: id,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    return deletionCoordinator.deleteProject(id)
  }
})

// Registers the renderer-callable project + per-project preview-state commands.
const registerProjectIpcHandlers = (
  repository: ProjectRepository,
  previewRepository: PreviewStateRepository,
  reviewRepository: ReviewRepository,
  deletionCoordinator: ProjectDeleteHandler
): void => {
  const handlers = createProjectHandlers(repository, reviewRepository, deletionCoordinator)

  ipcMain.handle('projects:list', () => handlers.list())
  ipcMain.handle('projects:get', (_event, id: string) => handlers.get(id))
  ipcMain.handle('projects:create', (_event, request: CreateProjectRequest) =>
    handlers.create(request)
  )
  ipcMain.handle('projects:update', (_event, request: UpdateProjectRequest) =>
    handlers.update(request)
  )
  ipcMain.handle('projects:delete', (_event, request: DeleteProjectRequest) =>
    handlers.delete(request.id)
  )

  ipcMain.handle(
    'preview:load',
    (_event, request: LoadPreviewStateRequest): Promise<PersistedPreviewState | null> =>
      previewRepository.get(request.projectId)
  )
  ipcMain.handle('preview:save', (_event, request: SavePreviewStateRequest) =>
    previewRepository.save(request.projectId, request.state)
  )
  ipcMain.handle('preview:delete', (_event, request: DeletePreviewStateRequest) =>
    previewRepository.delete(request.projectId)
  )
}

export {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  createDefaultReviewRepository,
  createProjectHandlers,
  registerProjectIpcHandlers
}
