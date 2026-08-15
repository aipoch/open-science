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
      listActiveSessions: vi.fn(() => [
        { projectId: 'project-1', sessionId: 'delegated-target' },
        { projectId: 'project-2', sessionId: 'delegated-other' }
      ]),
      deleteSession: vi.fn().mockResolvedValue(undefined)
    }
    const notebook = { shutdownProject: vi.fn().mockResolvedValue(undefined) }
    const sideChat = { invalidateProject: vi.fn().mockResolvedValue(undefined) }
    const compute = { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp,
      delegation,
      notebook,
      sideChat,
      compute
    })

    await owner.quiesceProject('project-1')

    expect(acp.deleteSession).toHaveBeenCalledWith('acp-target')
    expect(acp.deleteSession).not.toHaveBeenCalledWith('acp-other')
    expect(delegation.deleteSession).toHaveBeenCalledWith('delegated-target')
    expect(delegation.deleteSession).not.toHaveBeenCalledWith('delegated-other')
    expect(notebook.shutdownProject).toHaveBeenCalledWith('project-1')
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
      listActiveSessions: vi.fn(() => [{ projectId: 'project-1', sessionId: 'session-2' }]),
      deleteSession: vi.fn().mockResolvedValue(undefined)
    }
    const notebook = { shutdownProject: vi.fn().mockResolvedValue(undefined) }
    const sideChat = { invalidateProject: vi.fn().mockResolvedValue(undefined) }
    const compute = { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp,
      delegation,
      notebook,
      sideChat,
      compute
    })

    await expect(owner.quiesceProject('project-1')).rejects.toThrow(
      'Project runtime cleanup failed: project-1'
    )

    expect(delegation.deleteSession).toHaveBeenCalledWith('session-2')
    expect(notebook.shutdownProject).toHaveBeenCalledWith('project-1')
    expect(sideChat.invalidateProject).toHaveBeenCalledWith('project-1')
    expect(compute.reconcileProject).toHaveBeenCalledWith('project-1')
  })

  it('discovers Delegation again after ACP teardown closes the root admission source', async () => {
    let acpStopped = false
    const delegation = {
      listActiveSessions: vi.fn(() =>
        acpStopped ? [{ projectId: 'project-1', sessionId: 'late-child' }] : []
      ),
      deleteSession: vi.fn().mockResolvedValue(undefined)
    }
    const owner = new ProjectRuntimeQuiescenceOwner({
      acp: {
        listSessionIds: () => ['root-session'],
        liveSessionProjectId: () => 'project-1',
        deleteSession: vi.fn(async () => {
          acpStopped = true
        })
      },
      delegation,
      notebook: { shutdownProject: vi.fn().mockResolvedValue(undefined) },
      sideChat: { invalidateProject: vi.fn().mockResolvedValue(undefined) },
      compute: { reconcileProject: vi.fn().mockResolvedValue(undefined) }
    })

    await owner.quiesceProject('project-1')

    expect(delegation.listActiveSessions).toHaveBeenCalledOnce()
    expect(delegation.deleteSession).toHaveBeenCalledWith('late-child')
  })
})
