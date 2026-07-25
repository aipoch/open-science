import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectFilesHandlers,
  registerProjectFilesIpcHandlers,
  type ProjectFilesQueryRepository,
  type ProjectFilesRecoveryBackend,
  type ProjectFilesRepairBackend
} from './ipc'

// Capture ipcMain.handle registrations so the registered handler can be invoked directly from tests.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const invoke = (channel: string, payload: unknown): unknown =>
  handlers.get(channel)!(undefined, payload)

describe('project files IPC handlers', () => {
  it('routes overview and layered page requests through one repository', async () => {
    const overview = {
      totalCount: 3,
      uploadCount: 1,
      artifactCount: 2,
      artifactGroupCount: 1,
      isIndexComplete: true
    }
    const filePage = { items: [], totalCount: 1 }
    const groupPage = { items: [], totalCount: 1 }
    const repository = {
      getOverview: vi.fn().mockResolvedValue(overview),
      listFiles: vi.fn().mockResolvedValue(filePage),
      listArtifactGroups: vi.fn().mockResolvedValue(groupPage)
    }
    const handlers = createProjectFilesHandlers(
      repository,
      {
        repairProjectFiles: vi.fn().mockResolvedValue(undefined)
      },
      {
        recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
      }
    )
    const filesRequest = {
      projectId: 'project-1',
      collection: { kind: 'uploads' as const },
      limit: 24
    }
    const groupsRequest = { projectId: 'project-1', limit: 10 }

    await expect(handlers.getOverview({ projectId: 'project-1' })).resolves.toBe(overview)
    await expect(handlers.listFiles(filesRequest)).resolves.toBe(filePage)
    await expect(handlers.listArtifactGroups(groupsRequest)).resolves.toBe(groupPage)
    expect(repository.listFiles).toHaveBeenCalledWith(filesRequest)
    expect(repository.listArtifactGroups).toHaveBeenCalledWith(groupsRequest)
  })

  it('routes an explicit index repair through the session coordinator', async () => {
    const repository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      listArtifactGroups: vi.fn()
    }
    const repair = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectFilesHandlers(repository, repair, {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    })

    await handlers.repairIndex({ projectId: 'project-1' })

    expect(repair.repairProjectFiles).toHaveBeenCalledWith('project-1')
  })

  it('waits for deletion recovery before every files query or repair', async () => {
    const order: string[] = []
    const repository = {
      getOverview: vi.fn(async () => {
        order.push('overview')
        return {
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }
      }),
      listFiles: vi.fn(async () => {
        order.push('files')
        return { items: [], totalCount: 0 }
      }),
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      })
    }
    const repair = {
      repairProjectFiles: vi.fn(async () => {
        order.push('repair')
      })
    }
    const recovery = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    const handlers = createProjectFilesHandlers(repository, repair, recovery)

    await handlers.getOverview({ projectId: 'project-1' })
    await handlers.listFiles({
      projectId: 'project-1',
      collection: { kind: 'uploads' },
      limit: 20
    })
    await handlers.listArtifactGroups({ projectId: 'project-1', limit: 10 })
    await handlers.repairIndex({ projectId: 'project-1' })

    expect(order).toEqual([
      'recover',
      'overview',
      'recover',
      'files',
      'recover',
      'groups',
      'recover',
      'repair'
    ])
  })
})

describe('registerProjectFilesIpcHandlers', () => {
  let repository: ProjectFilesQueryRepository
  let repairBackend: ProjectFilesRepairBackend
  let recoveryBackend: ProjectFilesRecoveryBackend

  beforeEach(() => {
    handlers.clear()
    repository = {
      getOverview: vi.fn().mockResolvedValue({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      }),
      listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
      listArtifactGroups: vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    }
    repairBackend = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    recoveryBackend = { recoverPendingDeletions: vi.fn().mockResolvedValue(undefined) }
  })

  it('registers every project-files IPC channel', () => {
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend)

    expect(handlers.has('project-files:get-overview')).toBe(true)
    expect(handlers.has('project-files:list-files')).toBe(true)
    expect(handlers.has('project-files:list-artifact-groups')).toBe(true)
    expect(handlers.has('project-files:repair-index')).toBe(true)
  })

  it('get-overview handler waits for deletion recovery before reading the overview', async () => {
    const order: string[] = []
    const localRepository: ProjectFilesQueryRepository = {
      getOverview: vi.fn(async () => {
        order.push('overview')
        return {
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: true
        }
      }),
      listFiles: vi.fn(),
      listArtifactGroups: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    await invoke('project-files:get-overview', { projectId: 'project-1' })

    expect(order).toEqual(['recover', 'overview'])
    expect(localRepository.getOverview).toHaveBeenCalledWith('project-1')
  })

  it('list-files handler waits for deletion recovery before listing files', async () => {
    const order: string[] = []
    const localRepository: ProjectFilesQueryRepository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(async () => {
        order.push('files')
        return { items: [], totalCount: 0 }
      }),
      listArtifactGroups: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    const filesRequest = {
      projectId: 'project-1',
      collection: { kind: 'uploads' },
      limit: 24
    }
    await invoke('project-files:list-files', filesRequest)

    expect(order).toEqual(['recover', 'files'])
    expect(localRepository.listFiles).toHaveBeenCalledWith(filesRequest)
  })

  it('list-artifact-groups handler waits for deletion recovery before listing groups', async () => {
    const order: string[] = []
    const localRepository: ProjectFilesQueryRepository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      })
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    const groupsRequest = { projectId: 'project-1', limit: 10 }
    await invoke('project-files:list-artifact-groups', groupsRequest)

    expect(order).toEqual(['recover', 'groups'])
    expect(localRepository.listArtifactGroups).toHaveBeenCalledWith(groupsRequest)
  })

  it('repair-index handler waits for deletion recovery before repairing the index', async () => {
    const order: string[] = []
    const localRepository: ProjectFilesQueryRepository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      listArtifactGroups: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn(async () => {
        order.push('repair')
      })
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    await invoke('project-files:repair-index', { projectId: 'project-1' })

    expect(order).toEqual(['recover', 'repair'])
    expect(localRepair.repairProjectFiles).toHaveBeenCalledWith('project-1')
  })

  it('registered handlers share the same wait-then-dispatch pattern', async () => {
    // Each handler in the registered table must go through the same gate; this protects against
    // accidentally bypassing recovery by registering a handler that calls the backend directly.
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend)
    ;(recoveryBackend.recoverPendingDeletions as ReturnType<typeof vi.fn>).mockClear()

    await invoke('project-files:get-overview', { projectId: 'p1' })
    await invoke('project-files:list-files', {
      projectId: 'p1',
      collection: { kind: 'uploads' },
      limit: 1
    })
    await invoke('project-files:list-artifact-groups', { projectId: 'p1', limit: 1 })
    await invoke('project-files:repair-index', { projectId: 'p1' })

    expect(recoveryBackend.recoverPendingDeletions).toHaveBeenCalledTimes(4)
  })
})

export {}
