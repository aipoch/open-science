import { describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../shared/acp'
import type { DeleteSessionRequest } from '../../shared/session-persistence'
import { SessionDeletionOwner } from './owner'

const snapshot = (sessionIds: string[]): AcpStateSnapshot =>
  ({ sessionIds }) as unknown as AcpStateSnapshot

const request = { projectId: 'project-1', sessionId: 'session-1' }

const createOwner = (
  overrides: {
    deleteRuntime?: (request: { sessionId: string }) => Promise<AcpStateSnapshot>
    liveSessionProjectId?: (sessionId: string) => string | undefined
    deletePersisted?: (request: DeleteSessionRequest) => Promise<void>
  } = {}
): {
  owner: SessionDeletionOwner
  deleteRuntime: (request: { sessionId: string }) => Promise<AcpStateSnapshot>
  liveSessionProjectId: (sessionId: string) => string | undefined
  deletePersisted: (request: DeleteSessionRequest) => Promise<void>
  log: { warn: ReturnType<typeof vi.fn> }
} => {
  const deleteRuntime = overrides.deleteRuntime ?? vi.fn().mockResolvedValue(snapshot([]))
  const liveSessionProjectId =
    overrides.liveSessionProjectId ?? vi.fn().mockReturnValue('project-1')
  const deletePersisted = overrides.deletePersisted ?? vi.fn().mockResolvedValue(undefined)
  const log = { warn: vi.fn() }
  const owner = new SessionDeletionOwner({
    runtime: { deleteSession: deleteRuntime, liveSessionProjectId },
    persistence: { deleteSession: deletePersisted },
    log
  })
  return {
    owner,
    deleteRuntime,
    liveSessionProjectId,
    deletePersisted,
    log
  }
}

describe('SessionDeletionOwner', () => {
  it('hides runtime-first ordering behind one successful deletion interface', async () => {
    const order: string[] = []
    const { owner, deleteRuntime, deletePersisted } = createOwner({
      deleteRuntime: vi.fn(async () => {
        order.push('runtime')
        return snapshot([])
      }),
      deletePersisted: vi.fn(async () => {
        order.push('persistence')
      })
    })

    await expect(owner.delete(request)).resolves.toEqual({
      status: 'deleted',
      runtimeDetached: true
    })

    expect(order).toEqual(['runtime', 'persistence'])
    expect(deleteRuntime).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(deletePersisted).toHaveBeenCalledWith(request)
  })

  it('treats an already-absent runtime Session as retry-safe', async () => {
    const { owner, deletePersisted } = createOwner({
      liveSessionProjectId: vi.fn().mockReturnValue(undefined)
    })

    await expect(owner.delete(request)).resolves.toMatchObject({ status: 'deleted' })
    expect(deletePersisted).toHaveBeenCalledWith(request)
  })

  it('does not delete persistence when runtime teardown rejects', async () => {
    const { owner, deletePersisted, log } = createOwner({
      deleteRuntime: vi.fn().mockRejectedValue(new Error('provider unavailable'))
    })

    await expect(owner.delete(request)).resolves.toEqual({
      status: 'failed',
      reason: 'runtime',
      runtimeDetached: false
    })

    expect(deletePersisted).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      'Session runtime deletion failed',
      expect.objectContaining({ phase: 'delete-runtime', errorCategory: 'error' })
    )
  })

  it('leaves timeout ownership to runtime so pre-delete cleanup can finish safely', async () => {
    vi.useFakeTimers()
    try {
      let finishRuntime: ((value: AcpStateSnapshot) => void) | undefined
      const runtimeDeletion = new Promise<AcpStateSnapshot>((resolve) => {
        finishRuntime = resolve
      })
      const { owner, deletePersisted } = createOwner({
        deleteRuntime: vi.fn(() => runtimeDeletion)
      })

      const deletion = owner.delete(request)
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(
        Promise.race([deletion, Promise.resolve('still-pending' as const)])
      ).resolves.toBe('still-pending')
      expect(deletePersisted).not.toHaveBeenCalled()

      finishRuntime?.(snapshot([]))
      await expect(deletion).resolves.toEqual({ status: 'deleted', runtimeDetached: true })
      expect(deletePersisted).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not delete persistence while runtime state still contains the Session', async () => {
    const { owner, deletePersisted } = createOwner({
      deleteRuntime: vi.fn().mockResolvedValue(snapshot(['session-1']))
    })

    await expect(owner.delete(request)).resolves.toEqual({
      status: 'failed',
      reason: 'runtime',
      runtimeDetached: false
    })
    expect(deletePersisted).not.toHaveBeenCalled()
  })

  it('returns a retryable persistence result after runtime deletion succeeds', async () => {
    const { owner } = createOwner({
      deletePersisted: vi.fn().mockRejectedValue(new Error('disk locked'))
    })

    await expect(owner.delete(request)).resolves.toEqual({
      status: 'failed',
      reason: 'persistence',
      runtimeDetached: true
    })
  })

  it('rejects a Project mismatch before deleting either authority', async () => {
    const { owner, deleteRuntime, deletePersisted } = createOwner({
      liveSessionProjectId: vi.fn().mockReturnValue('project-2')
    })

    await expect(owner.delete(request)).resolves.toEqual({
      status: 'failed',
      reason: 'runtime',
      runtimeDetached: false
    })
    expect(deleteRuntime).not.toHaveBeenCalled()
    expect(deletePersisted).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent deletion requests for the same Session', async () => {
    let finishRuntime: ((value: AcpStateSnapshot) => void) | undefined
    const runtimeDeletion = new Promise<AcpStateSnapshot>((resolve) => {
      finishRuntime = resolve
    })
    const { owner, deleteRuntime, deletePersisted } = createOwner({
      deleteRuntime: vi.fn(() => runtimeDeletion)
    })

    const first = owner.delete(request)
    const second = owner.delete(request)
    expect(second).toBe(first)
    expect(deleteRuntime).toHaveBeenCalledOnce()

    finishRuntime?.(snapshot([]))
    await expect(first).resolves.toMatchObject({ status: 'deleted' })
    expect(deletePersisted).toHaveBeenCalledOnce()
  })
})
