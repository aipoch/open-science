import type {
  CancelPromptOptimizationRequest,
  OptimizePromptRequest,
  OptimizePromptResult,
  OptimizationEvent
} from '../../shared/prompt-optimization'
import type { PromptOptimizationService } from './prompt-optimization'
import { ProjectFolderFiles, type FindPublishedArtifactCopies } from './project-folder-files'
import type {
  ListProjectFolderRequest,
  ProjectFolderListing,
  ReadProjectFolderPreviewRequest
} from '../../shared/project-folder-files'
import type { ArtifactPreviewResult } from '../../shared/artifacts'
import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PreviewStateSnapshot,
  SavePreviewStateRequest
} from '../../shared/preview-state'
import type {
  CreateProjectRequest,
  LocateProjectFolderRequest,
  Project,
  ProjectDeletionCleanup,
  ProjectDeletionOutcome,
  ProjectFolderValidationResult,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../shared/projects'
import type { ProjectDeletionCoordinator } from './deletion-coordinator'
import { PreviewStateRepository } from './preview-repository'
import { getProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { ProjectFolderValidationOptions } from './project-folder-validation'

type ProjectHandlers = {
  listFolder: (request: ListProjectFolderRequest) => Promise<ProjectFolderListing>
  readFolderPreview: (request: ReadProjectFolderPreviewRequest) => Promise<ArtifactPreviewResult>
  checkFolder: (request: { projectId: string }) => Promise<ProjectFolderValidationResult | null>
  locateFolder: (request: LocateProjectFolderRequest) => Promise<Project>
  validateFolder: (request: { path: string }) => Promise<ProjectFolderValidationResult>
  optimizePrompt: (request: OptimizePromptRequest) => Promise<OptimizePromptResult>
  cancelPromptOptimization: (request: CancelPromptOptimizationRequest) => Promise<void>
  recordOptimizationEvent: (event: OptimizationEvent) => Promise<void>
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
const createDefaultProjectRepository = (
  folderOptions?: ProjectFolderValidationOptions
): ProjectRepository =>
  new ProjectRepository(
    () => getProjectDbClient(resolveConfigRoot()),
    resolveConfigRoot(),
    folderOptions,
    {
      storageRoot: resolveDataRoot,
      restoreIndexes: async (client, projectId, locatedFolder) => {
        const { restoreLocatedProjectRecordIndexes, restoreProjectRecordIndexesWithinTransaction } =
          await import('./record-indexes')
        if (locatedFolder)
          await restoreLocatedProjectRecordIndexes(
            client,
            resolveDataRoot(),
            projectId,
            locatedFolder
          )
        else
          await restoreProjectRecordIndexesWithinTransaction(client, resolveDataRoot(), projectId)
      },
      reconcileIndexes: async (client, projectId) => {
        const { reconcileProjectRecordIndexes } = await import('./record-indexes')
        await reconcileProjectRecordIndexes(client, [projectId])
      }
    }
  )

const createDefaultPreviewStateRepository = (): PreviewStateRepository =>
  new PreviewStateRepository(() => getProjectDbClient(resolveConfigRoot()))

type ProjectDeleteHandler = Pick<
  ProjectDeletionCoordinator,
  'deleteProject' | 'listDeletionCleanup' | 'retryDeletionCleanup' | 'waitForProjectOperations'
>
type ProjectCrudRepository = Pick<ProjectRepository, 'list' | 'get' | 'create' | 'update'> &
  Partial<
    Pick<
      ProjectRepository,
      | 'updateArchive'
      | 'validateFolder'
      | 'checkFolder'
      | 'locateFolder'
      | 'recordRecoveryPending'
      | 'projectRecordStorageRoot'
      | 'completeRecordRecovery'
    >
  >
type ProjectHandlerEffects = Pick<ProjectHandlers, 'updateArchive'> & {
  findPublishedArtifactCopies?: FindPublishedArtifactCopies
  afterProjectCreate?: (project: Project) => Promise<void>
  withFolderRelocation?: <Result>(
    projectId: string,
    operation: () => Promise<Result>
  ) => Promise<Result>
  beforeFolderRelocation?: (projectId: string) => Promise<void>
  recoverFolderRuntime?: (projectId: string) => Promise<void>
  promptOptimization?: PromptOptimizationService
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
): ProjectHandlers => {
  const recovering = new Map<string, Promise<void>>()
  const recoverRecords = (project: Project): Promise<void> => {
    if (!repository.recordRecoveryPending?.(project.id) || !effects.afterProjectCreate)
      return Promise.resolve()
    const pending = recovering.get(project.id)
    if (pending) return pending
    const recovery = effects
      .afterProjectCreate(project)
      .then(() => repository.completeRecordRecovery?.(project.id))
      .then(() => undefined)
    recovering.set(project.id, recovery)
    void recovery
      .finally(() => {
        if (recovering.get(project.id) === recovery) recovering.delete(project.id)
      })
      .catch(() => undefined)
    return recovery
  }
  const folderFiles = new ProjectFolderFiles(
    async (id) => {
      await deletionCoordinator.waitForProjectOperations([id])
      return repository.get(id)
    },
    () => repository.projectRecordStorageRoot?.(),
    effects.findPublishedArtifactCopies
  )
  return {
    checkFolder: async (request) => {
      try {
        await effects.recoverFolderRuntime?.(request.projectId)
        return repository.checkFolder ? repository.checkFolder(request) : null
      } catch (error) {
        return {
          ok: false,
          kind: 'unavailable',
          diagnostics: error instanceof Error ? error.message : String(error)
        }
      }
    },
    locateFolder: async (request) => {
      await deletionCoordinator.waitForProjectOperations([request.projectId])
      if (
        !repository.locateFolder ||
        !effects.withFolderRelocation ||
        !effects.beforeFolderRelocation
      )
        throw new Error('Project folder recovery is unavailable.')
      return repository.locateFolder(request, (commit) =>
        effects.withFolderRelocation!(request.projectId, async () => {
          await effects.beforeFolderRelocation!(request.projectId)
          return commit()
        })
      )
    },
    listFolder: (request) => folderFiles.listFolder(request),
    readFolderPreview: (request) => folderFiles.readFolderPreview(request),
    validateFolder: async (request) =>
      repository.validateFolder
        ? repository.validateFolder(request)
        : { ok: false, kind: 'unavailable', diagnostics: 'Project folder access is unavailable.' },
    optimizePrompt: async (request) => {
      if (!effects.promptOptimization) throw new Error('Prompt optimization is unavailable.')
      return effects.promptOptimization.optimize(request, () =>
        deletionCoordinator.waitForProjectOperations([request.projectId])
      )
    },
    cancelPromptOptimization: async (request) => {
      effects.promptOptimization?.cancel(request)
    },
    recordOptimizationEvent: async (event) => {
      effects.promptOptimization?.recordEvent(event)
    },
    list: async () => {
      const projects = await repository.list()
      // A single unavailable Project must not hide the home screen. Opening that Project retries
      // and surfaces its recovery error; the durable flag is cleared only after all Sessions exist.
      await Promise.allSettled(projects.map(recoverRecords))
      return projects
    },
    get: async (id) => {
      await deletionCoordinator.waitForProjectOperations([id])
      const project = await repository.get(id)
      if (project) await recoverRecords(project)
      return project
    },
    create: async (request) => {
      const project = await repository.create(request)
      await recoverRecords(project)
      return project
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
  }
}

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
