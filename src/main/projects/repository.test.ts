import { describe, expect, it, vi } from 'vitest'

import { PROJECT_NAME_MAX_LENGTH } from '../../shared/projects'
import { ProjectRepository, type ProjectClient } from './repository'

const createRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'project-1',
  name: 'Research',
  description: 'A project',
  agentContext: '',
  isExample: false,
  pinned: false,
  archivedAt: null,
  deletedAt: null,
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
  projectPreviewState: { deleteMany: ReturnType<typeof vi.fn> }
  visionEvidence: { deleteMany: ReturnType<typeof vi.fn> }
  memoryEntry: { deleteMany: ReturnType<typeof vi.fn> }
  memorySettings: { update: ReturnType<typeof vi.fn> }
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
  const projectPreviewState = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) }
  const visionEvidence = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) }
  const memoryEntry = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) }
  const memorySettings = {
    update: vi.fn().mockResolvedValue({ revision: 7 })
  }
  const client = {
    $executeRaw: executeRaw,
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ secure_delete: 1n }]),
    $transaction: vi.fn((operation: (transaction: unknown) => unknown) => operation(client)),
    project,
    projectDeletionIntent,
    projectPreviewState,
    visionEvidence,
    memoryEntry,
    memorySettings
  } as unknown as ProjectClient

  return {
    client,
    executeRaw,
    project,
    projectDeletionIntent,
    projectPreviewState,
    visionEvidence,
    memoryEntry,
    memorySettings
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
        sessionDefaults: {},
        isExample: false,
        createdAt: 1710000000000,
        updatedAt: 1710000000100
      }
    ])
    expect(project.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' }
    })
  })

  it('returns null when a project is not found', async () => {
    const { client } = createMockClient({ findUnique: () => Promise.resolve(null) })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.get('missing')).resolves.toBeNull()
  })

  it('hides a soft-deleted project', async () => {
    const { client } = createMockClient({
      findUnique: () => Promise.resolve(createRow({ deletedAt: new Date(1710000000200) }))
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.get('project-1')).resolves.toBeNull()
  })

  it('trims the name and defaults the description on create', async () => {
    const { client, project } = createMockClient({
      create: () => Promise.resolve(createRow({ name: 'Trimmed', description: '' }))
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.create({ name: '  Trimmed  ' })

    expect(project.create).toHaveBeenCalledWith({
      data: { name: 'Trimmed', description: '', agentContext: '' }
    })
  })

  it('rejects a blank project name without touching the database', async () => {
    const { client, project } = createMockClient({})
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.create({ name: '   ' })).rejects.toThrow('Project name is required.')
    expect(project.create).not.toHaveBeenCalled()
  })

  it('patches only the provided fields on update', async () => {
    const updated = createRow({ name: 'Renamed', updatedAt: new Date(1710000000200) })
    const { client, project } = createMockClient({
      findUnique: () => Promise.resolve(updated),
      updateMany: () => Promise.resolve({ count: 1 })
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.update({
      id: 'project-1',
      name: '  Renamed  ',
      sessionDefaults: { memoryEnabled: false, permissionProfile: 'auto' },
      expectedUpdatedAt: 1710000000100
    })

    expect(project.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'project-1',
        deletedAt: null,
        updatedAt: new Date(1710000000100)
      },
      data: {
        name: 'Renamed',
        sessionDefaults: '{"permissionProfile":"auto","memoryEnabled":false}',
        updatedAt: expect.any(Date)
      }
    })
    expect(project.update).not.toHaveBeenCalled()
  })

  it('rejects an ordinary update when the Project changed elsewhere', async () => {
    const { client, project } = createMockClient({
      updateMany: () => Promise.resolve({ count: 0 })
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(
      repository.update({
        id: 'project-1',
        name: 'Renamed',
        expectedUpdatedAt: 1710000000100
      })
    ).rejects.toThrow('Project changed elsewhere.')

    expect(project.findUnique).not.toHaveBeenCalled()
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

    await expect(
      repository.update({
        id: 'project-1',
        pinned: true,
        expectedUpdatedAt: 1710000000100
      })
    ).resolves.toMatchObject({ pinned: true, updatedAt: concurrentUpdatedAt.getTime() })

    expect(executeRaw).toHaveBeenCalledOnce()
    expect(project.update).not.toHaveBeenCalled()
  })

  it('soft-deletes a project while removing active-only derived children', async () => {
    const { client, project, projectPreviewState, visionEvidence, memoryEntry, memorySettings } =
      createMockClient({
        findUnique: () => Promise.resolve(createRow()),
        updateMany: () => Promise.resolve({ count: 1 })
      })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.delete('project-1')).resolves.toEqual({ memoryRevision: 7 })

    expect(projectPreviewState.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' }
    })
    expect(visionEvidence.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'project-1' } })
    expect(memoryEntry.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'project-1' } })
    expect(memorySettings.update).toHaveBeenCalledWith({
      where: { id: 'memory-settings' },
      data: { revision: { increment: 1 } },
      select: { revision: true }
    })
    expect(project.updateMany).toHaveBeenCalledWith({
      where: { id: 'project-1', deletedAt: null },
      data: {
        deletedAt: expect.any(Date),
        updatedAt: new Date(1710000000100)
      }
    })
    expect(project.delete).not.toHaveBeenCalled()
  })

  it('changes archive visibility with compare-and-set while preserving activity time', async () => {
    const archived = createRow({
      updatedAt: new Date(1710000000100),
      archivedAt: new Date(1710000000200)
    })
    const findUnique = vi.fn().mockResolvedValue(archived)
    const { client, executeRaw, project } = createMockClient({
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

    expect(executeRaw).toHaveBeenCalledOnce()
    expect(project.updateMany).not.toHaveBeenCalled()
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

  it('projects retained names for pending cleanup without dropping historical orphans', async () => {
    const { client, project, projectDeletionIntent } = createMockClient({})
    projectDeletionIntent.findMany.mockResolvedValue([
      { projectId: 'project-1' },
      { projectId: 'project-orphan' }
    ])
    project.findMany.mockResolvedValue([
      { id: 'project-1', name: 'R'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }
    ])
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await expect(repository.listDeletionCleanupProjects()).resolves.toEqual([
      { projectId: 'project-1', projectName: 'R'.repeat(PROJECT_NAME_MAX_LENGTH) },
      { projectId: 'project-orphan' }
    ])
    expect(project.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['project-1', 'project-orphan'] } },
      select: { id: true, name: true }
    })
  })

  it('persists a trimmed Agent Context on create', async () => {
    const { client, project } = createMockClient({
      create: () => Promise.resolve(createRow({ agentContext: 'Always cite DOIs.' }))
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.create({ name: 'Research', agentContext: '  Always cite DOIs.  ' })

    expect(project.create).toHaveBeenCalledWith({
      data: { name: 'Research', description: '', agentContext: 'Always cite DOIs.' }
    })
  })

  it('patches the Agent Context on update without touching other fields', async () => {
    const { client, project } = createMockClient({
      findUnique: () => Promise.resolve(createRow({ agentContext: 'Prefer Python.' })),
      updateMany: () => Promise.resolve({ count: 1 })
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.update({
      id: 'project-1',
      agentContext: '  Prefer Python.  ',
      expectedUpdatedAt: 1710000000100
    })

    expect(project.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'project-1',
        deletedAt: null,
        updatedAt: new Date(1710000000100)
      },
      data: { agentContext: 'Prefer Python.', updatedAt: expect.any(Date) }
    })
  })

  it('keeps the Agent Context when pinning in the same update', async () => {
    const { client, executeRaw, project } = createMockClient({
      findUnique: () =>
        Promise.resolve(createRow({ pinned: true, agentContext: 'Always cite DOIs.' })),
      updateMany: () => Promise.resolve({ count: 1 })
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    await repository.update({
      id: 'project-1',
      pinned: true,
      agentContext: 'Always cite DOIs.',
      expectedUpdatedAt: 1710000000100
    })

    // A combined pin + Agent Context edit must not enter the pin-only raw-SQL fast path, which
    // would silently drop the Agent Context.
    expect(executeRaw).not.toHaveBeenCalled()
    expect(project.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'project-1',
        deletedAt: null,
        updatedAt: new Date(1710000000100)
      },
      data: {
        pinned: true,
        agentContext: 'Always cite DOIs.',
        updatedAt: expect.any(Date)
      }
    })
  })

  it('maps a non-empty Agent Context from stored rows and omits an empty one', async () => {
    const { client } = createMockClient({
      findMany: () =>
        Promise.resolve([
          createRow({ id: 'with-context', agentContext: 'Always cite DOIs.' }),
          createRow({ id: 'without-context', agentContext: '' })
        ])
    })
    const repository = new ProjectRepository(() => Promise.resolve(client))

    const projects = await repository.list()

    expect(projects[0]).toMatchObject({ id: 'with-context', agentContext: 'Always cite DOIs.' })
    expect(projects[1]).toMatchObject({ id: 'without-context' })
    expect('agentContext' in projects[1]!).toBe(false)
  })
})
