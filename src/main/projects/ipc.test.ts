import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewStateRepository } from './preview-repository'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

import { createProjectHandlers, registerPreviewStateIpcHandlers } from './ipc'
import { ProjectDeletionCoordinator } from './deletion-coordinator'

beforeEach(() => {
  ipcHandlers.clear()
})

describe('createProjectHandlers', () => {
  it('routes deletion through the project deletion coordinator', async () => {
    const repository = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateArchive: vi.fn(),
      delete: vi.fn()
    }
    const deletionCoordinator = {
      deleteProject: vi.fn().mockResolvedValue(undefined),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.delete('project-1')

    expect(deletionCoordinator.deleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.delete).not.toHaveBeenCalled()
  })

  it('routes cleanup status and immediate retry through the deletion coordinator', async () => {
    const repository = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
    const cleanup = [
      {
        projectId: 'project-1',
        projectName: 'Research',
        phase: 'retry-scheduled' as const,
        failureCount: 2,
        nextRetryAt: 6_000
      }
    ]
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue(cleanup),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn()
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await expect(handlers.listDeletionCleanup()).resolves.toBe(cleanup)
    await handlers.retryDeletionCleanup()

    expect(deletionCoordinator.retryDeletionCleanup).toHaveBeenCalledOnce()
  })

  it('lists projects without waiting for deletion recovery', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.list()

    expect(deletionCoordinator.waitForProjectOperations).not.toHaveBeenCalled()
    expect(repository.list).toHaveBeenCalledOnce()
  })

  it('keeps unrelated Project CRUD available when another deletion tail fails', async () => {
    const deletionFailure = new Error('project-1 tail cleanup unavailable')
    const unrelatedProject = { ...project, id: 'project-2' }
    const repository = {
      list: vi.fn().mockResolvedValue([unrelatedProject]),
      get: vi.fn().mockResolvedValue(unrelatedProject),
      create: vi.fn().mockResolvedValue(unrelatedProject),
      update: vi.fn().mockResolvedValue(unrelatedProject)
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn(async (projectIds: readonly string[]) => {
        if (projectIds.includes('project-1')) throw deletionFailure
      })
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await expect(handlers.list()).resolves.toEqual([unrelatedProject])
    await expect(handlers.get('project-2')).resolves.toBe(unrelatedProject)
    await expect(handlers.create({ name: 'Other Project' })).resolves.toBe(unrelatedProject)
    await expect(
      handlers.update({ id: 'project-2', name: 'Renamed', expectedUpdatedAt: 2 })
    ).resolves.toBe(unrelatedProject)
    await expect(handlers.get('project-1')).rejects.toBe(deletionFailure)

    expect(repository.list).toHaveBeenCalledOnce()
    expect(repository.get).toHaveBeenCalledOnce()
    expect(deletionCoordinator.waitForProjectOperations).toHaveBeenCalledWith(['project-2'])
    expect(deletionCoordinator.waitForProjectOperations).toHaveBeenCalledWith(['project-1'])
  })

  it('keeps unrelated Project CRUD available while another deletion is in flight', async () => {
    const deletionGate = createDeferred<void>()
    const deletionIntents = new Set<string>()
    const deletingProject = project
    const unrelatedProject = { ...project, id: 'project-2', name: 'Other Project' }
    const repository = {
      list: vi.fn().mockResolvedValue([unrelatedProject]),
      get: vi.fn(async (id: string) =>
        id === deletingProject.id ? deletingProject : unrelatedProject
      ),
      exists: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(unrelatedProject),
      update: vi.fn().mockResolvedValue(unrelatedProject),
      delete: vi.fn().mockResolvedValue(undefined),
      createDeletionIntent: vi.fn(async (projectId: string) => {
        deletionIntents.add(projectId)
      }),
      deleteDeletionIntent: vi.fn(async (projectId: string) => {
        deletionIntents.delete(projectId)
      }),
      listDeletionIntents: vi.fn(async () => [...deletionIntents]),
      listDeletionCleanupProjects: vi.fn().mockResolvedValue([])
    }
    const sessions = {
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        if (projectId === deletingProject.id) await deletionGate.promise
        return { status: 'completed' as const }
      }),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent' as const),
      completeProjectSessionDeletion: vi.fn().mockResolvedValue(undefined),
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue([])
    }
    const deletionCoordinator = new ProjectDeletionCoordinator(repository, sessions)
    const updateArchive = vi.fn().mockResolvedValue(unrelatedProject)
    const handlers = createProjectHandlers(repository, deletionCoordinator, { updateArchive })
    await deletionCoordinator.recoverPendingDeletions()

    const deletion = handlers.delete(deletingProject.id)
    await vi.waitFor(() =>
      expect(sessions.deleteProjectSessions).toHaveBeenCalledWith(deletingProject.id)
    )

    const operations = [
      handlers.list(),
      handlers.get(unrelatedProject.id),
      handlers.create({ name: 'New Project' }),
      handlers.update({
        id: unrelatedProject.id,
        name: 'Renamed Project',
        expectedUpdatedAt: unrelatedProject.updatedAt
      }),
      handlers.updateArchive({
        id: unrelatedProject.id,
        archived: true,
        expectedArchivedAt: null
      })
    ]
    await flushMicrotasks()
    const reachedBeforeDeletionFinished = {
      list: repository.list.mock.calls.length > 0,
      get: repository.get.mock.calls.some(([id]) => id === unrelatedProject.id),
      create: repository.create.mock.calls.length > 0,
      update: repository.update.mock.calls.length > 0,
      archive: updateArchive.mock.calls.length > 0
    }

    deletionGate.resolve(undefined)
    await Promise.all([deletion, ...operations])

    expect(reachedBeforeDeletionFinished).toEqual({
      list: true,
      get: true,
      create: true,
      update: true,
      archive: true
    })
  })

  it('checks deletion recovery only for operations on existing Projects', async () => {
    const order: string[] = []
    const repository = {
      list: vi.fn(),
      get: vi.fn(async () => {
        order.push('get')
        return null
      }),
      create: vi.fn(async () => {
        order.push('create')
        return project
      }),
      update: vi.fn(async () => {
        order.push('update')
        return project
      })
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn(async () => {
        order.push('recover')
      })
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.get('project-1')
    await handlers.create({ name: 'Project' })
    await handlers.update({ id: 'project-1', name: 'Renamed', expectedUpdatedAt: 2 })

    expect(order).toEqual(['recover', 'get', 'create', 'recover', 'update'])
  })

  it('forwards the Agent Context field through create and update unchanged', async () => {
    const repository = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(async () => project),
      update: vi.fn(async () => project)
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.create({ name: 'Research', agentContext: 'Always cite DOIs.' })
    await handlers.update({ id: 'project-1', agentContext: 'Prefer Python.', expectedUpdatedAt: 2 })

    expect(repository.create).toHaveBeenCalledWith({
      name: 'Research',
      agentContext: 'Always cite DOIs.'
    })
    expect(repository.update).toHaveBeenCalledWith({
      id: 'project-1',
      agentContext: 'Prefer Python.',
      expectedUpdatedAt: 2
    })
  })

  it('invalidates Agent Sessions only when an update changes Agent Context', async () => {
    const oldProject = { ...project, agentContext: 'Always cite DOIs.' }
    const updatedProject = { ...project, agentContext: 'Prefer Python.', updatedAt: 3 }
    const repository = {
      list: vi.fn(),
      get: vi.fn().mockResolvedValueOnce(oldProject).mockResolvedValueOnce(updatedProject),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue(updatedProject)
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      listDeletionCleanup: vi.fn().mockResolvedValue([]),
      retryDeletionCleanup: vi.fn(),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    }
    const onAgentContextChanged = vi.fn()
    const handlers = createProjectHandlers(repository, deletionCoordinator, {
      updateArchive: vi.fn(),
      onAgentContextChanged
    })

    await handlers.update({
      id: 'project-1',
      agentContext: 'Prefer Python.',
      expectedUpdatedAt: 2
    })
    await handlers.update({
      id: 'project-1',
      agentContext: 'Prefer Python.',
      expectedUpdatedAt: 3
    })
    await handlers.update({
      id: 'project-1',
      name: 'Renamed project',
      expectedUpdatedAt: 4
    })

    expect(onAgentContextChanged).toHaveBeenCalledOnce()
    expect(onAgentContextChanged).toHaveBeenCalledWith('project-1')
    expect(repository.get).toHaveBeenCalledTimes(2)
  })

  it('leaves only preview state on the capability-specific Electron adapter', async () => {
    const previewRepository = {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    } as unknown as PreviewStateRepository
    registerPreviewStateIpcHandlers(previewRepository)

    expect([...ipcHandlers.keys()]).toEqual(['preview:load', 'preview:save', 'preview:delete'])

    const previewState = { openTabs: [], activeTabId: null }

    await ipcHandlers.get('preview:load')?.(undefined, { projectId: 'project-1' })
    await ipcHandlers.get('preview:save')?.(undefined, {
      projectId: 'project-1',
      state: previewState,
      expectedRevision: 7
    })
    await ipcHandlers.get('preview:delete')?.(undefined, { projectId: 'project-1' })

    expect(previewRepository.get).toHaveBeenCalledWith('project-1')
    expect(previewRepository.save).toHaveBeenCalledWith('project-1', previewState, 7)
    expect(previewRepository.delete).toHaveBeenCalledWith('project-1')
  })
})

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}
