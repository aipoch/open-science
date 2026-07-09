import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../shared/projects'
import { createInitialProjectState, useProjectStore } from './project-store'

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Research',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const setProjectsApi = (api: Partial<Window['api']['projects']>): void => {
  ;(globalThis as unknown as { window: { api: { projects: unknown } } }).window = {
    api: { projects: api }
  } as never
}

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
})

describe('project store', () => {
  it('loads projects sorted most-recently-updated first', async () => {
    setProjectsApi({
      list: vi
        .fn()
        .mockResolvedValue([
          createProject({ id: 'old', updatedAt: 10 }),
          createProject({ id: 'new', updatedAt: 99 })
        ])
    })

    await useProjectStore.getState().loadProjects()

    expect(useProjectStore.getState().isLoaded).toBe(true)
    expect(useProjectStore.getState().loadError).toBeUndefined()
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['new', 'old'])
  })

  it('records a load error instead of throwing when the DB is unavailable', async () => {
    setProjectsApi({ list: vi.fn().mockRejectedValue(new Error('database is locked')) })

    await useProjectStore.getState().loadProjects()

    expect(useProjectStore.getState().isLoaded).toBe(true)
    expect(useProjectStore.getState().loadError).toBe('database is locked')
    expect(useProjectStore.getState().projects).toEqual([])
  })

  it('merges a created project into the cache and returns it', async () => {
    const created = createProject({ id: 'created', name: 'New', updatedAt: 500 })
    setProjectsApi({ create: vi.fn().mockResolvedValue(created) })

    const result = await useProjectStore.getState().createProject({ name: 'New' })

    expect(result).toEqual(created)
    expect(useProjectStore.getState().projects[0]).toEqual(created)
  })

  it('drops a deleted project from the cache', async () => {
    useProjectStore.setState({
      projects: [createProject({ id: 'keep' }), createProject({ id: 'drop' })],
      isLoaded: true
    })
    setProjectsApi({ delete: vi.fn().mockResolvedValue(undefined) })

    await useProjectStore.getState().deleteProject('drop')

    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['keep'])
  })
})
