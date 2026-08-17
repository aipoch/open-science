import { describe, expect, it, vi } from 'vitest'

import { ProjectRuntimeQuiescenceOwner } from './project-runtime-quiescence-owner'

describe('ProjectRuntimeQuiescenceOwner', () => {
  it('stops every runtime owned by the Project without touching another Project', async () => {
    const acp = {
      listSessionIds: vi.fn(() => ['acp-target', 'acp-other']),
      liveSessionProjectId: vi.fn((sessionId: string) =>
        sessionId === 'acp-target' ? 'project-1' : 'project-2'
      ),
      deleteSession: vi.fn().mockResolvedValue(undefined)
    }
    const delegation = {
      deleteProject: vi.fn().mockResolvedValue(undefined)
    }
    const notebook = { shutdownProject: vi.fn().mockResolvedValue(undefined) }
    const reviewer = { quiesceProject: vi.fn().mockResolvedValue(undefined) }
    const sideChat = { invalidateProject: vi.fn().mockResolvedValue(undefined) }
    const compute = { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp,
      delegation,
      notebook,
      reviewer,
      sideChat,
      compute
    })

    await owner.quiesceProject('project-1')

    expect(acp.deleteSession).toHaveBeenCalledWith('acp-target')
    expect(acp.deleteSession).not.toHaveBeenCalledWith('acp-other')
    expect(delegation.deleteProject).toHaveBeenCalledWith('project-1')
    expect(notebook.shutdownProject).toHaveBeenCalledWith('project-1')
    expect(reviewer.quiesceProject).toHaveBeenCalledWith('project-1')
    expect(sideChat.invalidateProject).toHaveBeenCalledWith('project-1')
    expect(compute.reconcileProject).toHaveBeenCalledWith('project-1')
  })

  it('attempts every runtime boundary and fails closed when one cleanup fails', async () => {
    const acp = {
      listSessionIds: vi.fn(() => ['session-1']),
      liveSessionProjectId: vi.fn(() => 'project-1'),
      deleteSession: vi.fn().mockRejectedValue(new Error('ACP unavailable'))
    }
    const delegation = {
      deleteProject: vi.fn().mockResolvedValue(undefined)
    }
    const notebook = { shutdownProject: vi.fn().mockResolvedValue(undefined) }
    const reviewer = { quiesceProject: vi.fn().mockResolvedValue(undefined) }
    const sideChat = { invalidateProject: vi.fn().mockResolvedValue(undefined) }
    const compute = { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp,
      delegation,
      notebook,
      reviewer,
      sideChat,
      compute
    })

    await expect(owner.quiesceProject('project-1')).rejects.toThrow(
      'Project runtime cleanup failed: project-1'
    )

    expect(delegation.deleteProject).toHaveBeenCalledWith('project-1')
    expect(notebook.shutdownProject).toHaveBeenCalledWith('project-1')
    expect(reviewer.quiesceProject).toHaveBeenCalledWith('project-1')
    expect(sideChat.invalidateProject).toHaveBeenCalledWith('project-1')
    expect(compute.reconcileProject).toHaveBeenCalledWith('project-1')
  })

  it('deletes authoritative Project Delegation state after ACP teardown closes admission', async () => {
    const ownedSessionIds = new Set(['root-session'])
    const deleteSession = vi.fn(async (sessionId: string) => {
      ownedSessionIds.delete(sessionId)
    })
    const delegation = {
      deleteProject: vi.fn(async () => {
        expect(ownedSessionIds.has('root-session')).toBe(false)
        ownedSessionIds.add('late-continuation')
      })
    }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp: {
        listSessionIds: () => [...ownedSessionIds],
        liveSessionProjectId: () => 'project-1',
        deleteSession
      },
      delegation,
      notebook: { shutdownProject: vi.fn().mockResolvedValue(undefined) },
      reviewer: { quiesceProject: vi.fn().mockResolvedValue(undefined) },
      sideChat: { invalidateProject: vi.fn().mockResolvedValue(undefined) },
      compute: { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    })

    await owner.quiesceProject('project-1')

    expect(delegation.deleteProject).toHaveBeenCalledWith('project-1')
    expect(deleteSession).toHaveBeenNthCalledWith(1, 'root-session')
    expect(deleteSession).toHaveBeenNthCalledWith(2, 'late-continuation')
  })

  it('drains Notebook work before deleting authoritative Project Delegation state', async () => {
    let releaseNotebook!: () => void
    const notebookDrained = new Promise<void>((resolve) => {
      releaseNotebook = resolve
    })
    const delegation = {
      deleteProject: vi.fn().mockResolvedValue(undefined)
    }
    const notebook = {
      shutdownProject: vi.fn(() => notebookDrained)
    }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp: {
        listSessionIds: vi.fn(() => []),
        liveSessionProjectId: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined)
      },
      delegation,
      notebook,
      reviewer: { quiesceProject: vi.fn().mockResolvedValue(undefined) },
      sideChat: { invalidateProject: vi.fn().mockResolvedValue(undefined) },
      compute: { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    })

    const quiescing = owner.quiesceProject('project-1')
    await vi.waitFor(() => expect(notebook.shutdownProject).toHaveBeenCalledWith('project-1'))

    expect(delegation.deleteProject).not.toHaveBeenCalled()

    releaseNotebook()
    await quiescing

    expect(delegation.deleteProject).toHaveBeenCalledWith('project-1')
  })

  it('drains Reviewer work before enumerating and deleting ACP sessions', async () => {
    let releaseReviewer!: () => void
    const reviewerDrained = new Promise<void>((resolve) => {
      releaseReviewer = resolve
    })
    const acp = {
      listSessionIds: vi.fn(() => []),
      liveSessionProjectId: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined)
    }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp,
      delegation: { deleteProject: vi.fn().mockResolvedValue(undefined) },
      notebook: { shutdownProject: vi.fn().mockResolvedValue(undefined) },
      reviewer: { quiesceProject: vi.fn(() => reviewerDrained) },
      sideChat: { invalidateProject: vi.fn().mockResolvedValue(undefined) },
      compute: { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    })

    const quiescing = owner.quiesceProject('project-1')
    await Promise.resolve()

    expect(acp.listSessionIds).not.toHaveBeenCalled()

    releaseReviewer()
    await quiescing

    expect(acp.listSessionIds).toHaveBeenCalled()
  })
})
