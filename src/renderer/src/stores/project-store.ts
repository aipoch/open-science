import { create } from 'zustand'

import type { CreateProjectRequest, Project, UpdateProjectRequest } from '../../../shared/projects'

type ProjectStoreData = {
  projects: Project[]
  isLoaded: boolean
  loadError: string | undefined
}

type ProjectStore = ProjectStoreData & {
  loadProjects: () => Promise<void>
  createProject: (request: CreateProjectRequest) => Promise<Project | undefined>
  updateProject: (request: UpdateProjectRequest) => Promise<Project | undefined>
  deleteProject: (id: string) => Promise<void>
  upsertProject: (project: Project) => void
  removeProject: (id: string) => void
}

// Surfaces DB/IPC failures as a short message instead of a silent empty list.
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error'

// Keeps projects sorted most-recently-updated first, matching the repository's list ordering.
const sortByUpdatedDesc = (projects: Project[]): Project[] =>
  [...projects].sort((left, right) => right.updatedAt - left.updatedAt)

// Replaces or inserts a project by id, then re-sorts.
const upsertProjectList = (projects: Project[], project: Project): Project[] => {
  const withoutProject = projects.filter((existing) => existing.id !== project.id)

  return sortByUpdatedDesc([project, ...withoutProject])
}

export const createInitialProjectState = (): ProjectStoreData => ({
  projects: [],
  isLoaded: false,
  loadError: undefined
})

// Renderer cache of the SQLite-backed project list; the DB remains the source of truth.
export const useProjectStore = create<ProjectStore>((set) => ({
  ...createInitialProjectState(),

  // Loads the full project list once at startup and after mutations that need a resync. A DB/IPC
  // failure is recorded (not thrown) so the home screen can show an error instead of a silent empty list.
  loadProjects: async () => {
    try {
      const projects = await window.api.projects.list()

      set({ projects: sortByUpdatedDesc(projects), isLoaded: true, loadError: undefined })
    } catch (error) {
      set({ isLoaded: true, loadError: describeError(error) })
    }
  },

  // Creates a project and merges the returned row into the local cache. Rejections propagate so the
  // caller can show inline feedback and re-enable the form.
  createProject: async (request) => {
    const project = await window.api.projects.create(request)

    set((state) => ({ projects: upsertProjectList(state.projects, project), loadError: undefined }))

    return project
  },

  // Applies a name/description edit and merges the updated row into the cache.
  updateProject: async (request) => {
    const project = await window.api.projects.update(request)

    set((state) => ({ projects: upsertProjectList(state.projects, project) }))

    return project
  },

  // Deletes a project row and drops it from the cache. Session cascade is handled by the session store.
  deleteProject: async (id) => {
    await window.api.projects.delete({ id })

    set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }))
  },

  upsertProject: (project) =>
    set((state) => ({ projects: upsertProjectList(state.projects, project) })),

  removeProject: (id) =>
    set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }))
}))
