import { describe, expect, it, vi } from 'vitest'

import { ProjectRepository, type ProjectClient } from './repository'

const createRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'project-1',
  name: 'Research',
  description: 'A project',
  isExample: false,
  pinned: false,
  createdAt: new Date(1710000000000),
  updatedAt: new Date(1710000000100),
  ...overrides
})

// Builds a mock project delegate; each method is a spy the tests can assert against.
const createMockClient = (
  methods: Partial<
    Record<'findMany' | 'findUnique' | 'create' | 'update' | 'updateMany' | 'delete', unknown>
  >
): {
  client: ProjectClient
  executeRaw: ReturnType<typeof vi.fn>
  project: Record<string, ReturnType<typeof vi.fn>>
  projectDeletionIntent: Record<string, ReturnType<typeof vi.fn>>
} => {
  const project = {
    findMany: vi.fn(methods.findMany as never),
    findUnique: vi.fn(methods.findUnique as never),
    create: vi.fn(methods.create as never),
    update: vi.fn(methods.update as never),
    updateMany: vi.fn(methods.updateMany as never),
    delete: vi.fn(methods.delete as never)
  }

  const projectDeletionIntent = {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([])
  }
  const executeRaw = vi.fn().mockResolvedValue(1)

  return {
    client: { $executeRaw: executeRaw, project, projectDeletionIntent } as unknown as ProjectClient,
    executeRaw,
    project,
    projectDeletionIntent
  }
}

describe('project repository', () => {
  it('lists projects most-recently-updated first as epoch-ms timestamps', async () => {
    const { client, project } = createMockClient({
      findMany: () => Promise.resolve([createRow()])
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.list()).resolves.toEqual([
      {
        id: 'project-1',
        name: 'Research',
        description: 'A project',
        isExample: false,
        createdAt: 1710000000000,
        updatedAt: 1710000000100
      }
    ])
    expect(project.findMany).toHaveBeenCalledWith({ orderBy: { updatedAt: 'desc' } })
  })

  it('returns null when a project is not found', async () => {
    const { client } = createMockClient({ findUnique: () => Promise.resolve(null) })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.get('missing')).resolves.toBeNull()
  })

  it('trims the name and defaults the description on create', async () => {
    const { client, project } = createMockClient({
      create: () => Promise.resolve(createRow({ name: 'Trimmed', description: '' }))
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.create({ name: '  Trimmed  ' })

    expect(project.create).toHaveBeenCalledWith({ data: { name: 'Trimmed', description: '' } })
  })

  it('rejects a blank project name without touching the database', async () => {
    const { client, project } = createMockClient({})
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.create({ name: '   ' })).rejects.toThrow('Project name is required.')
    expect(project.create).not.toHaveBeenCalled()
  })

  it('patches only the provided fields on update', async () => {
    const { client, project } = createMockClient({
      update: () => Promise.resolve(createRow({ name: 'Renamed' }))
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.update({ id: 'project-1', name: '  Renamed  ' })

    expect(project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { name: 'Renamed' }
    })
  })

  it('does not roll back concurrent activity time while changing pin placement', async () => {
    let persisted = createRow()
    const concurrentUpdatedAt = new Date(1710000000200)
    const { client, executeRaw, project } = createMockClient({
      findUnique: () => Promise.resolve(persisted),
      update: ({ data }: { data: Record<string, unknown> }) => {
        persisted = { ...persisted, updatedAt: concurrentUpdatedAt, ...data }
        return Promise.resolve(persisted)
      }
    })
    executeRaw.mockImplementation(() => {
      persisted = { ...persisted, pinned: true, updatedAt: concurrentUpdatedAt }
      return Promise.resolve(1)
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.update({ id: 'project-1', pinned: true })).resolves.toMatchObject({
      pinned: true,
      updatedAt: concurrentUpdatedAt.getTime()
    })

    expect(executeRaw).toHaveBeenCalledOnce()
    expect(project.update).not.toHaveBeenCalled()
  })

  it('deletes a project by id', async () => {
    const { client, project } = createMockClient({
      delete: () => Promise.resolve(createRow())
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.delete('project-1')

    expect(project.delete).toHaveBeenCalledWith({ where: { id: 'project-1' } })
  })

  it('changes archive visibility with compare-and-set while preserving activity time', async () => {
    const current = createRow({ updatedAt: new Date(1710000000100), archivedAt: null })
    const archived = createRow({
      updatedAt: new Date(1710000000100),
      archivedAt: new Date(1710000000200)
    })
    const findUnique = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(archived)
    const { client, project } = createMockClient({
      findUnique,
      updateMany: () => Promise.resolve({ count: 1 })
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(
      repository.updateArchive(
        { id: 'project-1', archived: true, expectedArchivedAt: null },
        1710000000200
      )
    ).resolves.toMatchObject({ archivedAt: 1710000000200, updatedAt: 1710000000100 })

    expect(project.updateMany).toHaveBeenCalledWith({
      where: { id: 'project-1', archivedAt: null },
      data: {
        archivedAt: new Date(1710000000200),
        updatedAt: new Date(1710000000100)
      }
    })
  })

  it('persists, lists, and clears project deletion intents', async () => {
    const { client, projectDeletionIntent } = createMockClient({})
    projectDeletionIntent.findMany.mockResolvedValue([{ projectId: 'project-1' }])
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.createDeletionIntent('project-1')
    await expect(repository.listDeletionIntents()).resolves.toEqual(['project-1'])
    await repository.deleteDeletionIntent('project-1')

    expect(projectDeletionIntent.upsert).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      create: { projectId: 'project-1' },
      update: {}
    })
    expect(projectDeletionIntent.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
      select: { projectId: true }
    })
    expect(projectDeletionIntent.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' }
    })
  })
})
