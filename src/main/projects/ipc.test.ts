import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewStateRepository } from './preview-repository'
import type { ProjectRepository } from './repository'

const { broadcastLifecycleEvent, ipcHandlers, registrationFailure } = vi.hoisted(() => ({
  broadcastLifecycleEvent: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  registrationFailure: {
    channel: undefined as string | undefined,
    error: undefined as Error | undefined
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      if (registrationFailure.channel === channel) throw registrationFailure.error
      ipcHandlers.set(channel, handler)
    }
  }
}))
vi.mock('../lifecycle-broadcast', () => ({ broadcastLifecycleEvent }))

import { createProjectHandlers, registerProjectIpcHandlers, type ProjectHandlers } from './ipc'

beforeEach(() => {
  ipcHandlers.clear()
  broadcastLifecycleEvent.mockClear()
  registrationFailure.channel = undefined
  registrationFailure.error = undefined
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
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.delete('project-1')

    expect(deletionCoordinator.deleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.delete).not.toHaveBeenCalled()
  })

  it('recovers durable deletions before listing projects', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.list()

    expect(deletionCoordinator.recoverPendingDeletions).toHaveBeenCalledOnce()
    expect(repository.list).toHaveBeenCalledOnce()
  })

  it('recovers durable deletions before every project read or mutation', async () => {
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
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    const handlers = createProjectHandlers(repository, deletionCoordinator)

    await handlers.get('project-1')
    await handlers.create({ name: 'Project' })
    await handlers.update({ id: 'project-1', name: 'Renamed' })

    expect(order).toEqual(['recover', 'get', 'recover', 'create', 'recover', 'update'])
  })

  it('registers project and preview channels with exact request forwarding', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue([project]),
      get: vi.fn().mockResolvedValue(project),
      create: vi.fn().mockResolvedValue(project),
      update: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn().mockResolvedValue({ ...project, archivedAt: 3 })
    } as unknown as ProjectRepository
    const previewRepository = {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    } as unknown as PreviewStateRepository
    const deletionCoordinator = {
      deleteProject: vi.fn().mockResolvedValue(undefined),
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    registerProjectIpcHandlers(repository, previewRepository, deletionCoordinator)

    expect([...ipcHandlers.keys()]).toEqual([
      'projects:list',
      'projects:get',
      'projects:create',
      'projects:update',
      'projects:update-archive',
      'projects:delete',
      'preview:load',
      'preview:save',
      'preview:delete'
    ])

    const createRequest = { name: 'Project' }
    const updateRequest = { id: 'project-1', name: 'Renamed' }
    const archiveRequest = { id: 'project-1', archived: true, expectedArchivedAt: null }
    const previewState = { openTabs: [], activeTabId: null }

    await ipcHandlers.get('projects:list')?.()
    await ipcHandlers.get('projects:get')?.(undefined, 'project-1')
    await ipcHandlers.get('projects:create')?.(undefined, createRequest)
    await ipcHandlers.get('projects:update')?.(undefined, updateRequest)
    await ipcHandlers.get('projects:update-archive')?.(undefined, archiveRequest)
    await ipcHandlers.get('projects:delete')?.(undefined, { id: 'project-1' })
    await ipcHandlers.get('preview:load')?.(undefined, { projectId: 'project-1' })
    await ipcHandlers.get('preview:save')?.(undefined, {
      projectId: 'project-1',
      state: previewState
    })
    await ipcHandlers.get('preview:delete')?.(undefined, { projectId: 'project-1' })

    expect(repository.get).toHaveBeenCalledWith('project-1')
    expect(repository.create).toHaveBeenCalledWith(createRequest)
    expect(repository.update).toHaveBeenCalledWith(updateRequest)
    expect(repository.updateArchive).toHaveBeenCalledWith(archiveRequest, expect.any(Number))
    expect(deletionCoordinator.deleteProject).toHaveBeenCalledWith('project-1')
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('project:created', project)
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('project:updated', project)
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('project:updated', {
      ...project,
      archivedAt: 3
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1'
    })
    expect(previewRepository.get).toHaveBeenCalledWith('project-1')
    expect(previewRepository.save).toHaveBeenCalledWith('project-1', previewState)
    expect(previewRepository.delete).toHaveBeenCalledWith('project-1')
  })

  it('dispatches project commands through the injected application handler identity', async () => {
    const repository = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    } as unknown as ProjectRepository
    const previewRepository = {
      get: vi.fn(),
      save: vi.fn(),
      delete: vi.fn()
    } as unknown as PreviewStateRepository
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      recoverPendingDeletions: vi.fn()
    }
    const injected: ProjectHandlers = {
      list: vi.fn().mockResolvedValue([project]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateArchive: vi.fn(),
      delete: vi.fn()
    }

    registerProjectIpcHandlers(repository, previewRepository, deletionCoordinator, injected)

    await expect(ipcHandlers.get('projects:list')?.()).resolves.toEqual([project])
    expect(injected.list).toHaveBeenCalledOnce()
    expect(repository.list).not.toHaveBeenCalled()
    expect(deletionCoordinator.recoverPendingDeletions).not.toHaveBeenCalled()
  })

  it('preserves an injected project handler identity when registration fails', async () => {
    const failure = new Error('registration failed')
    const repository = {} as ProjectRepository
    const previewRepository = {} as PreviewStateRepository
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      recoverPendingDeletions: vi.fn()
    }
    const injected: ProjectHandlers = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateArchive: vi.fn(),
      delete: vi.fn()
    }
    registrationFailure.channel = 'projects:list'
    registrationFailure.error = failure

    expect(() =>
      registerProjectIpcHandlers(repository, previewRepository, deletionCoordinator, injected)
    ).toThrow(failure)

    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    registerProjectIpcHandlers(repository, previewRepository, deletionCoordinator, injected)
    await ipcHandlers.get('projects:list')?.()
    expect(injected.list).toHaveBeenCalledOnce()
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
