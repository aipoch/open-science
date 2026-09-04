import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectFilesHandlers,
  registerProjectFilesIpcHandlers,
  type ProjectFilesHandlers,
  type ProjectFilesQueryRepository,
  type ProjectFilesRecoveryBackend,
  type ProjectFilesRepairBackend
} from './ipc'

// Capture ipcMain.handle registrations so the registered handler can be invoked directly from tests.
const { handlers, registrationFailure } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  registrationFailure: {
    channel: undefined as string | undefined,
    error: undefined as Error | undefined
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      if (registrationFailure.channel === channel) throw registrationFailure.error
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
    const resolvedFile = {
      id: 'artifact-1',
      source: 'artifact' as const,
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-2',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'report.md',
      path: 'artifact-version:project-1/session-1/artifact-1/version-2',
      size: 12,
      sortAtMs: 2
    }
    const groupPage = { items: [], totalCount: 1 }
    const artifactSearch = {
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    }
    const repository = {
      getOverview: vi.fn().mockResolvedValue(overview),
      listFiles: vi.fn().mockResolvedValue(filePage),
      resolveFile: vi.fn().mockResolvedValue(resolvedFile),
      listArtifactGroups: vi.fn().mockResolvedValue(groupPage),
      searchArtifacts: vi.fn().mockResolvedValue(artifactSearch)
    }
    const handlers = createProjectFilesHandlers(
      repository,
      {
        repairProjectFiles: vi.fn().mockResolvedValue(undefined)
      },
      {
        recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
        waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
      }
    )
    const filesRequest = {
      projectId: 'project-1',
      collection: { kind: 'uploads' as const },
      limit: 24
    }
    const groupsRequest = { projectId: 'project-1', limit: 10 }
    const resolveRequest = {
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'artifact' as const,
      fileIdHint: 'legacy-artifact',
      identityHint: 'legacy' as const,
      name: 'report.md'
    }
    const artifactSearchRequest = {
      primaryProjectId: 'project-1',
      otherProjectIds: ['project-2'],
      filenameContains: 'sin',
      primaryLimit: 8,
      otherLimit: 1 as const
    }

    const overviewRequest = {
      projectId: 'project-1',
      search: { filenameContains: 'timeline' }
    }
    await expect(handlers.getOverview(overviewRequest)).resolves.toBe(overview)
    await expect(handlers.listFiles(filesRequest)).resolves.toBe(filePage)
    await expect(handlers.resolveFile(resolveRequest)).resolves.toBe(resolvedFile)
    await expect(handlers.listArtifactGroups(groupsRequest)).resolves.toBe(groupPage)
    await expect(handlers.searchArtifacts(artifactSearchRequest)).resolves.toBe(artifactSearch)
    expect(repository.listFiles).toHaveBeenCalledWith(filesRequest)
    expect(repository.resolveFile).toHaveBeenCalledWith(resolveRequest)
    expect(repository.listArtifactGroups).toHaveBeenCalledWith(groupsRequest)
    expect(repository.getOverview).toHaveBeenCalledWith(overviewRequest)
    expect(repository.searchArtifacts).toHaveBeenCalledWith(artifactSearchRequest)
  })

  it('routes an explicit index repair through the session coordinator', async () => {
    const repository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn()
    }
    const repair = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectFilesHandlers(repository, repair, {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    })

    await handlers.repairIndex({ projectId: 'project-1' })

    expect(repair.repairProjectFiles).toHaveBeenCalledWith('project-1')
  })

  it('keeps global index repair behind strict deletion recovery', async () => {
    const recoveryFailure = new Error('another Project deletion is incomplete')
    const repository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(),
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn()
    }
    const repair = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    const recovery = {
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined),
      recoverPendingDeletions: vi.fn().mockRejectedValue(recoveryFailure)
    }
    const handlers = createProjectFilesHandlers(repository, repair, recovery)

    await expect(handlers.repairIndex({ projectId: 'project-1' })).rejects.toBe(recoveryFailure)

    expect(recovery.waitForProjectOperations).not.toHaveBeenCalled()
    expect(repair.repairProjectFiles).not.toHaveBeenCalled()
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
      resolveFile: vi.fn(async () => {
        order.push('resolve')
        return undefined
      }),
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      }),
      searchArtifacts: vi.fn(async () => {
        order.push('search')
        return { primary: { items: [], totalCount: 0 }, other: [], isIndexComplete: true }
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
      }),
      waitForProjectOperations: vi.fn(async () => {
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
    await handlers.resolveFile({
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'artifact',
      identityHint: 'legacy',
      name: 'report.md'
    })
    await handlers.listArtifactGroups({ projectId: 'project-1', limit: 10 })
    await handlers.searchArtifacts({
      primaryProjectId: 'project-1',
      otherProjectIds: ['project-2'],
      primaryLimit: 8,
      otherLimit: 0
    })
    await handlers.repairIndex({ projectId: 'project-1' })

    expect(order).toEqual([
      'recover',
      'overview',
      'recover',
      'files',
      'recover',
      'resolve',
      'recover',
      'groups',
      'recover',
      'search',
      'recover',
      'repair'
    ])
    expect(recovery.waitForProjectOperations).toHaveBeenNthCalledWith(1, ['project-1'])
    expect(recovery.waitForProjectOperations).toHaveBeenNthCalledWith(2, ['project-1'])
    expect(recovery.waitForProjectOperations).toHaveBeenNthCalledWith(3, ['project-1'])
    expect(recovery.waitForProjectOperations).toHaveBeenNthCalledWith(4, ['project-1'])
    expect(recovery.waitForProjectOperations).toHaveBeenNthCalledWith(5, ['project-1', 'project-2'])
    expect(recovery.recoverPendingDeletions).toHaveBeenCalledOnce()
  })
})

describe('registerProjectFilesIpcHandlers', () => {
  let repository: ProjectFilesQueryRepository
  let repairBackend: ProjectFilesRepairBackend
  let recoveryBackend: ProjectFilesRecoveryBackend

  beforeEach(() => {
    handlers.clear()
    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    repository = {
      getOverview: vi.fn().mockResolvedValue({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      }),
      listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
      resolveFile: vi.fn().mockResolvedValue(undefined),
      listArtifactGroups: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
      searchArtifacts: vi.fn().mockResolvedValue({
        primary: { items: [], totalCount: 0 },
        other: [],
        isIndexComplete: true
      })
    }
    repairBackend = { repairProjectFiles: vi.fn().mockResolvedValue(undefined) }
    recoveryBackend = {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
    }
  })

  it('registers every project-files IPC channel', () => {
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend)

    expect(handlers.has('project-files:get-overview')).toBe(true)
    expect(handlers.has('project-files:list-files')).toBe(true)
    expect(handlers.has('project-files:resolve-file')).toBe(true)
    expect(handlers.has('project-files:list-artifact-groups')).toBe(true)
    expect(handlers.has('project-files:search-artifacts')).toBe(true)
    expect(handlers.has('project-files:repair-index')).toBe(true)
  })

  it('dispatches through the injected application handler identity', async () => {
    const overview = {
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }
    const injected: ProjectFilesHandlers = {
      getOverview: vi.fn().mockResolvedValue(overview),
      listFiles: vi.fn(),
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn(),
      repairIndex: vi.fn()
    }

    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)

    await expect(invoke('project-files:get-overview', { projectId: 'project-1' })).resolves.toBe(
      overview
    )
    expect(injected.getOverview).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(repository.getOverview).not.toHaveBeenCalled()
    expect(recoveryBackend.waitForProjectOperations).not.toHaveBeenCalled()
  })

  it('preserves an injected handler identity when registration fails', async () => {
    const failure = new Error('registration failed')
    const injected: ProjectFilesHandlers = {
      getOverview: vi.fn().mockResolvedValue({
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      }),
      listFiles: vi.fn(),
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn(),
      repairIndex: vi.fn()
    }
    registrationFailure.channel = 'project-files:get-overview'
    registrationFailure.error = failure

    expect(() =>
      registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)
    ).toThrow(failure)

    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    registerProjectFilesIpcHandlers(repository, repairBackend, recoveryBackend, injected)
    await invoke('project-files:get-overview', { projectId: 'project-1' })
    expect(injected.getOverview).toHaveBeenCalledOnce()
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
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
      waitForProjectOperations: vi.fn(async () => {
        order.push('recover')
      })
    }
    registerProjectFilesIpcHandlers(localRepository, localRepair, localRecovery)

    await invoke('project-files:get-overview', { projectId: 'project-1' })

    expect(order).toEqual(['recover', 'overview'])
    expect(localRepository.getOverview).toHaveBeenCalledWith({ projectId: 'project-1' })
  })

  it('list-files handler waits for deletion recovery before listing files', async () => {
    const order: string[] = []
    const localRepository: ProjectFilesQueryRepository = {
      getOverview: vi.fn(),
      listFiles: vi.fn(async () => {
        order.push('files')
        return { items: [], totalCount: 0 }
      }),
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
      waitForProjectOperations: vi.fn(async () => {
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
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(async () => {
        order.push('groups')
        return { items: [], totalCount: 0 }
      }),
      searchArtifacts: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn()
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined),
      waitForProjectOperations: vi.fn(async () => {
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
      resolveFile: vi.fn(),
      listArtifactGroups: vi.fn(),
      searchArtifacts: vi.fn()
    }
    const localRepair: ProjectFilesRepairBackend = {
      repairProjectFiles: vi.fn(async () => {
        order.push('repair')
      })
    }
    const localRecovery: ProjectFilesRecoveryBackend = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      }),
      waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
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
    ;(recoveryBackend.waitForProjectOperations as ReturnType<typeof vi.fn>).mockClear()
    ;(recoveryBackend.recoverPendingDeletions as ReturnType<typeof vi.fn>).mockClear()

    await invoke('project-files:get-overview', { projectId: 'p1' })
    await invoke('project-files:list-files', {
      projectId: 'p1',
      collection: { kind: 'uploads' },
      limit: 1
    })
    await invoke('project-files:resolve-file', {
      projectId: 'p1',
      sessionId: 'session-1',
      source: 'artifact',
      identityHint: 'legacy',
      name: 'report.md'
    })
    await invoke('project-files:list-artifact-groups', { projectId: 'p1', limit: 1 })
    await invoke('project-files:repair-index', { projectId: 'p1' })

    expect(recoveryBackend.waitForProjectOperations).toHaveBeenCalledTimes(4)
    expect(recoveryBackend.recoverPendingDeletions).toHaveBeenCalledOnce()
  })
})

export {}
