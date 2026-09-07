import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PreviewStateSnapshot,
  SavePreviewStateRequest
} from '../../shared/preview-state'
import type {
  CreateProjectRequest,
  Project,
  ProjectDeletionCleanup,
  ProjectDeletionOutcome,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'
import type { ProjectDeletionCoordinator } from './deletion-coordinator'
import { PreviewStateRepository } from './preview-repository'
import { getProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { resolveConfigRoot } from '../storage-root'

type ProjectHandlers = {
  list: () => Promise<Project[]>
  get: (id: string) => Promise<Project | null>
  create: (request: CreateProjectRequest) => Promise<Project>
  update: (request: UpdateProjectRequest) => Promise<Project>
  updateArchive: (request: UpdateProjectArchiveRequest) => Promise<Project>
  delete: (id: string) => Promise<ProjectDeletionOutcome>
  listDeletionCleanup: () => Promise<ProjectDeletionCleanup[]>
  retryDeletionCleanup: () => Promise<void>
}

// Production repositories backed by the SQLite database under the (dev-aware) storage root. The client is
// passed as a provider (not a resolved promise) so a failed first initialization can be retried on the
// next request instead of being cached for the app's lifetime.
const createDefaultProjectRepository = (): ProjectRepository =>
  new ProjectRepository(() => getProjectDbClient(resolveConfigRoot()))

const createDefaultPreviewStateRepository = (): PreviewStateRepository =>
  new PreviewStateRepository(() => getProjectDbClient(resolveConfigRoot()))

type ProjectDeleteHandler = Pick<
  ProjectDeletionCoordinator,
  'deleteProject' | 'listDeletionCleanup' | 'retryDeletionCleanup' | 'waitForProjectOperations'
>
type ProjectCrudRepository = Pick<ProjectRepository, 'list' | 'get' | 'create' | 'update'> &
  Partial<Pick<ProjectRepository, 'updateArchive'>>
type ProjectHandlerEffects = Pick<ProjectHandlers, 'updateArchive'> & {
  onAgentContextChanged?: (projectId: string) => void
}

// Adapts repository operations into thin handlers while enforcing Project-scoped recovery admission.
// A failed durable deletion intent remains closed without denying unrelated Project operations.
const createProjectHandlers = (
  repository: ProjectCrudRepository,
  deletionCoordinator: ProjectDeleteHandler,
  effects: ProjectHandlerEffects = {
    updateArchive: (request) => {
      if (!repository.updateArchive) throw new Error('Project archive is unavailable.')
      return repository.updateArchive(request, Date.now())
    }
  }
): ProjectHandlers => ({
  list: async () => {
    return repository.list()
  },
  get: async (id) => {
    await deletionCoordinator.waitForProjectOperations([id])
    return repository.get(id)
  },
  create: async (request) => {
    return repository.create(request)
  },
  update: async (request) => {
    await deletionCoordinator.waitForProjectOperations([request.id])
    const previousAgentContext =
      request.agentContext === undefined
        ? undefined
        : (await repository.get(request.id))?.agentContext
    const project = await repository.update(request)
    if (request.agentContext !== undefined && previousAgentContext !== project.agentContext) {
      effects.onAgentContextChanged?.(request.id)
    }
    return project
  },
  updateArchive: async (request) => {
    await deletionCoordinator.waitForProjectOperations([request.id])
    return effects.updateArchive(request)
  },
  delete: async (id) => {
    await deletionCoordinator.waitForProjectOperations([id])
    return deletionCoordinator.deleteProject(id)
  },
  listDeletionCleanup: () => deletionCoordinator.listDeletionCleanup(),
  retryDeletionCleanup: async () => deletionCoordinator.retryDeletionCleanup()
})

const registerPreviewStateIpcHandlers = (previewRepository: PreviewStateRepository): void => {
  ipcMainHandle(
    'preview:load',
    (_event, request: LoadPreviewStateRequest): Promise<PreviewStateSnapshot | null> =>
      previewRepository.get(request.projectId)
  )
  ipcMainHandle('preview:save', (_event, request: SavePreviewStateRequest) =>
    previewRepository.save(request.projectId, request.state, request.expectedRevision)
  )
  ipcMainHandle('preview:delete', (_event, request: DeletePreviewStateRequest) =>
    previewRepository.delete(request.projectId)
  )
}

export {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  createProjectHandlers,
  registerPreviewStateIpcHandlers
}
export type { ProjectHandlers }
