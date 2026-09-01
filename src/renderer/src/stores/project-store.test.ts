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
    const rawError = new Error(
      'EACCES: /Users/private/.open-science-dev/open-science.db could not be opened'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setProjectsApi({ list: vi.fn().mockRejectedValue(rawError) })

    await useProjectStore.getState().loadProjects()

    expect(useProjectStore.getState().isLoaded).toBe(true)
    expect(useProjectStore.getState().loadError).toBe(
      'Open Science could not load projects. Retry to continue.'
    )
    expect(useProjectStore.getState().loadError).not.toContain('/Users/private')
    expect(useProjectStore.getState().projects).toEqual([])
    expect(warn).toHaveBeenCalledWith('Project list loading failed', rawError)
    warn.mockRestore()
  })

  it('ignores an older project load that resolves after a newer request', async () => {
    const first = createDeferred<Project[]>()
    const second = createDeferred<Project[]>()
    setProjectsApi({
      list: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    })

    const firstLoad = useProjectStore.getState().loadProjects()
    const secondLoad = useProjectStore.getState().loadProjects()
    second.resolve([createProject({ id: 'new', updatedAt: 2 })])
    await secondLoad
    first.resolve([createProject({ id: 'old', updatedAt: 1 })])
    await firstLoad

    expect(useProjectStore.getState().projects.map((candidate) => candidate.id)).toEqual(['new'])
  })

  it('reloads after a project is created while initial hydration is in flight', async () => {
    const staleLoad = createDeferred<Project[]>()
    const created = createProject({ id: 'created', name: 'New', updatedAt: 500 })
    const list = vi.fn().mockReturnValueOnce(staleLoad.promise).mockResolvedValueOnce([created])
    setProjectsApi({
      list,
      create: vi.fn().mockResolvedValue(created)
    })

    const pendingLoad = useProjectStore.getState().loadProjects()
    await useProjectStore.getState().createProject({ name: 'New' })
    staleLoad.resolve([])
    await pendingLoad

    expect(list).toHaveBeenCalledTimes(2)
    expect(useProjectStore.getState().projects).toEqual([created])
    expect(useProjectStore.getState().isLoaded).toBe(true)
    expect(useProjectStore.getState().loadError).toBeUndefined()
  })

  it('merges a created project into the cache and returns it', async () => {
    const created = createProject({ id: 'created', name: 'New', updatedAt: 500 })
    setProjectsApi({ create: vi.fn().mockResolvedValue(created) })

    const result = await useProjectStore.getState().createProject({ name: 'New' })

    expect(result).toEqual(created)
    expect(useProjectStore.getState().projects[0]).toEqual(created)
  })

  it('resolves an empty create result untouched and leaves the cache alone', async () => {
    setProjectsApi({ create: vi.fn().mockResolvedValue(undefined) })

    const result = await useProjectStore.getState().createProject({ name: 'New' })

    expect(result).toBeUndefined()
    expect(useProjectStore.getState().projects).toEqual([])
  })

  it('resolves an empty update result untouched and leaves the cache alone', async () => {
    const original = createProject({ id: 'kept', name: 'Kept', updatedAt: 1 })
    setProjectsApi({ update: vi.fn().mockResolvedValue(undefined) })
    useProjectStore.setState({ projects: [original], isLoaded: true })

    const result = await useProjectStore
      .getState()
      .updateProject({ id: 'kept', expectedUpdatedAt: 1, name: 'Command' })

    expect(result).toBeUndefined()
    expect(useProjectStore.getState().projects).toEqual([original])
  })

  it('does not let a late update result replace a newer lifecycle projection', async () => {
    const original = createProject({ name: 'Original', updatedAt: 1 })
    const command = createDeferred<Project>()
    setProjectsApi({ update: vi.fn().mockReturnValue(command.promise) })
    useProjectStore.setState({ projects: [original], isLoaded: true })

    const update = useProjectStore
      .getState()
      .updateProject({ id: original.id, expectedUpdatedAt: 1, name: 'Command' })
    const lifecycle = createProject({ name: 'Lifecycle', updatedAt: 3 })
    useProjectStore.getState().upsertProject(lifecycle)
    command.resolve(createProject({ name: 'Command', updatedAt: 2 }))

    await update

    expect(useProjectStore.getState().projects).toEqual([lifecycle])
  })

  it('lets the later-started update win when both commands begin from the same projection', async () => {
    const original = createProject({ name: 'Original', updatedAt: 1 })
    const first = createDeferred<Project>()
    const second = createDeferred<Project>()
    setProjectsApi({
      update: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    })
    useProjectStore.setState({ projects: [original], isLoaded: true })

    const firstUpdate = useProjectStore
      .getState()
      .updateProject({ id: original.id, expectedUpdatedAt: 1, name: 'First' })
    const secondUpdate = useProjectStore
      .getState()
      .updateProject({ id: original.id, expectedUpdatedAt: 1, name: 'Second' })
    first.resolve(createProject({ name: 'First', updatedAt: 2 }))
    await firstUpdate
    second.resolve(createProject({ name: 'Second', updatedAt: 3 }))
    await secondUpdate

    expect(useProjectStore.getState().projects).toEqual([
      createProject({ name: 'Second', updatedAt: 3 })
    ])
  })

  it('projects an older committed update when a later-started update fails', async () => {
    const original = createProject({ name: 'Original', updatedAt: 1 })
    const first = createDeferred<Project>()
    setProjectsApi({
      update: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockRejectedValueOnce(new Error('newer update failed'))
    })
    useProjectStore.setState({ projects: [original], isLoaded: true })

    const firstUpdate = useProjectStore
      .getState()
      .updateProject({ id: original.id, expectedUpdatedAt: 1, name: 'Committed' })
    await expect(
      useProjectStore
        .getState()
        .updateProject({ id: original.id, expectedUpdatedAt: 1, name: 'Failed' })
    ).rejects.toThrow('newer update failed')
    const committed = createProject({ name: 'Committed', updatedAt: 2 })
    first.resolve(committed)
    await firstUpdate

    expect(useProjectStore.getState().projects).toEqual([committed])
  })

  it('returns cleanup-pending while dropping a committed Project deletion from the cache', async () => {
    useProjectStore.setState({
      projects: [createProject({ id: 'keep' }), createProject({ id: 'drop' })],
      isLoaded: true
    })
    setProjectsApi({ delete: vi.fn().mockResolvedValue({ status: 'cleanup-pending' }) })

    const outcome = await useProjectStore.getState().deleteProject('drop')

    expect(outcome).toEqual({ status: 'cleanup-pending' })
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['keep'])
    expect(useProjectStore.getState().pendingDeletionCleanupProjectIds.has('drop')).toBe(true)

    useProjectStore.getState().removeProject('drop')

    expect(useProjectStore.getState().pendingDeletionCleanupProjectIds.has('drop')).toBe(false)
  })

  it('does not let a late pending command result supersede terminal lifecycle state', async () => {
    const commandResult = createDeferred<{ status: 'cleanup-pending' }>()
    useProjectStore.setState({
      projects: [createProject({ id: 'drop' })],
      isLoaded: true
    })
    setProjectsApi({ delete: vi.fn().mockReturnValue(commandResult.promise) })

    const deletion = useProjectStore.getState().deleteProject('drop')
    useProjectStore.getState().removeProject('drop', { status: 'deleted' })
    commandResult.resolve({ status: 'cleanup-pending' })

    await expect(deletion).resolves.toEqual({ status: 'cleanup-pending' })
    expect(useProjectStore.getState().pendingDeletionCleanupProjectIds.has('drop')).toBe(false)
    expect(useProjectStore.getState().projectDeletionRequests.size).toBe(0)
  })
})

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}
