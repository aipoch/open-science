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
import { resolveStorageRoot } from '../storage-root'
import { PreviewStateRepository } from './preview-repository'
import { getProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { createLogger } from '../logger'

const log = createLogger('projects:ipc')

type ProjectHandlers = {
  list: () => Promise<Project[]>
  get: (id: string) => Promise<Project | null>
  create: (request: CreateProjectRequest) => Promise<Project>
  update: (request: UpdateProjectRequest) => Promise<Project>
  delete: (id: string) => Promise<void>
}

// Adapts a repository into thin handlers so the IPC surface stays easy to unit test.
const createProjectHandlers = (
  repository: ProjectRepository,
  reviewRepository: ReviewRepository
): ProjectHandlers => ({
  list: () => repository.list(),
  get: (id) => repository.get(id),
  create: (request) => repository.create(request),
  update: (request) => repository.update(request),
  delete: async (id) => {
    // Delete cascade: remove reviewer rows first so no orphan reviews/findings remain.
    // A reviewer-cleanup failure must not block the underlying project delete (fire-and-forget).
    await reviewRepository.deleteReviewsForProject(id).catch((error: unknown) => {
      log.warn('deleteReviewsForProject failed (non-fatal)', {
        projectId: id,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    await repository.delete(id)
  }
})

// Production repositories backed by the SQLite database under the (dev-aware) storage root. The client is
// passed as a provider (not a resolved promise) so a failed first initialization can be retried on the
// next request instead of being cached for the app's lifetime.
const createDefaultProjectRepository = (): ProjectRepository =>
  new ProjectRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultPreviewStateRepository = (): PreviewStateRepository =>
  new PreviewStateRepository(() => getProjectDbClient(resolveStorageRoot()))

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers the renderer-callable project + per-project preview-state commands.
const registerProjectIpcHandlers = (
  repository = createDefaultProjectRepository(),
  previewRepository = createDefaultPreviewStateRepository(),
  reviewRepository = createDefaultReviewRepository()
): void => {
  const handlers = createProjectHandlers(repository, reviewRepository)

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
  createProjectHandlers,
  registerProjectIpcHandlers
}
