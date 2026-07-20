import { describe, expect, it, vi } from 'vitest'

import { createProjectFilesHandlers } from './ipc'

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
