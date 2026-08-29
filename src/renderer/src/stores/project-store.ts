import { create } from 'zustand'

import type {
  CreateProjectRequest,
  Project,
  ProjectDeletionOutcome,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../../../shared/projects'

type ProjectStoreData = {
  projects: Project[]
  pendingDeletionCleanupProjectIds: Set<string>
  isLoaded: boolean
  loadError: string | undefined
}

type ProjectStore = ProjectStoreData & {
  loadProjects: () => Promise<void>
  createProject: (request: CreateProjectRequest) => Promise<Project | undefined>
  updateProject: (request: UpdateProjectRequest) => Promise<Project | undefined>
  updateProjectArchive: (request: UpdateProjectArchiveRequest) => Promise<Project>
  deleteProject: (id: string) => Promise<ProjectDeletionOutcome>
  upsertProject: (project: Project) => void
  removeProject: (id: string) => void
}

// Keep raw IPC diagnostics in the developer channel while renderer state remains path-safe.
const SAFE_PROJECT_LOAD_ERROR = 'Open Science could not load projects. Retry to continue.'

const reportProjectLoadError = (error: unknown): void => {
  console.warn('Project list loading failed', error)
}

// Keeps projects sorted most-recently-updated first, matching the repository's list ordering.
const sortByUpdatedDesc = (projects: Project[]): Project[] =>
  [...projects].sort((left, right) => right.updatedAt - left.updatedAt)

// Replaces or inserts a project by id, then re-sorts.
const upsertProjectList = (projects: Project[], project: Project): Project[] => {
  const withoutProject = projects.filter((existing) => existing.id !== project.id)

  return sortByUpdatedDesc([project, ...withoutProject])
}

let projectLoadSequence = 0
let projectMutationSequence = 0

export const createInitialProjectState = (): ProjectStoreData => ({
  projects: [],
  pendingDeletionCleanupProjectIds: new Set(),
  isLoaded: false,
  loadError: undefined
})

// Renderer cache of the SQLite-backed project list; the DB remains the source of truth.
export const useProjectStore = create<ProjectStore>((set, get) => ({
  ...createInitialProjectState(),

  // Loads the full project list once at startup and after mutations that need a resync. A DB/IPC
  // failure is recorded (not thrown) so the home screen can show an error instead of a silent empty list.
  loadProjects: async () => {
    const loadSequence = ++projectLoadSequence
    const mutationSequence = projectMutationSequence
    try {
      const projects = await window.api.projects.list()
      if (loadSequence !== projectLoadSequence) return
      if (mutationSequence !== projectMutationSequence) {
        await get().loadProjects()
        return
      }

      set({ projects: sortByUpdatedDesc(projects), isLoaded: true, loadError: undefined })
    } catch (error) {
      if (loadSequence !== projectLoadSequence) return
      if (mutationSequence !== projectMutationSequence) {
        await get().loadProjects()
        return
      }

      reportProjectLoadError(error)
      set({ isLoaded: true, loadError: SAFE_PROJECT_LOAD_ERROR })
    }
  },

  // Creates a project and merges the returned row into the local cache. Rejections propagate so the
  // caller can show inline feedback and re-enable the form.
  createProject: async (request) => {
    const project = await window.api.projects.create(request)

    projectMutationSequence += 1
    set((state) => ({ projects: upsertProjectList(state.projects, project), loadError: undefined }))

    return project
  },

  // Applies an editable Project patch and merges the updated row into the cache.
  updateProject: async (request) => {
    const project = await window.api.projects.update(request)

    projectMutationSequence += 1
    set((state) => ({ projects: upsertProjectList(state.projects, project) }))

    return project
  },

  updateProjectArchive: async (request) => {
    const project = await window.api.projects.updateArchive(request)

    projectMutationSequence += 1
    set((state) => ({ projects: upsertProjectList(state.projects, project) }))
    return project
  },

  // Drops committed Project deletion from the cache. Session cascade is handled by the session store.
  deleteProject: async (id) => {
    const outcome = await window.api.projects.delete({ id })

    projectMutationSequence += 1
    set((state) => {
      const pendingDeletionCleanupProjectIds = new Set(state.pendingDeletionCleanupProjectIds)
      if (outcome.status === 'cleanup-pending') pendingDeletionCleanupProjectIds.add(id)
      else pendingDeletionCleanupProjectIds.delete(id)

      return {
        projects: state.projects.filter((project) => project.id !== id),
        pendingDeletionCleanupProjectIds
      }
    })
    return outcome
  },

  upsertProject: (project) => {
    projectMutationSequence += 1
    set((state) => ({ projects: upsertProjectList(state.projects, project) }))
  },

  removeProject: (id) => {
    projectMutationSequence += 1
    set((state) => {
      const pendingDeletionCleanupProjectIds = new Set(state.pendingDeletionCleanupProjectIds)
      pendingDeletionCleanupProjectIds.delete(id)

      return {
        projects: state.projects.filter((project) => project.id !== id),
        pendingDeletionCleanupProjectIds
      }
    })
  }
}))
