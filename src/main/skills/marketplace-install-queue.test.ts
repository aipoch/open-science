import { describe, expect, it, vi, type Mock } from 'vitest'
import { SkillMarketplaceInstallQueue } from './marketplace-install-queue'
import type {
  SkillMarketplaceBatchRequest,
  SkillMarketplaceInstallResult
} from '../../shared/skill-marketplace'

const request: SkillMarketplaceBatchRequest = {
  snapshotId: 'a'.repeat(64),
  items: [
    { id: 'one', version: '1.0.0', expectedVersion: null },
    { id: 'two', version: '1.0.0', expectedVersion: null }
  ]
}
const success: SkillMarketplaceInstallResult = {
  ok: true,
  value: { id: 'imported-one', status: 'imported', version: '1.0.0' }
}
const setup = (): {
  queue: SkillMarketplaceInstallQueue
  install: Mock<(request: unknown, signal: AbortSignal) => Promise<SkillMarketplaceInstallResult>>
  refresh: Mock
  release: Mock
  notify: Mock
  retainSnapshot: Mock
} => {
  const release = vi.fn()
  const install = vi
    .fn<(request: unknown, signal: AbortSignal) => Promise<SkillMarketplaceInstallResult>>()
    .mockResolvedValue(success)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const retainSnapshot = vi.fn().mockReturnValue(release)
  return {
    queue: new SkillMarketplaceInstallQueue({ install, refresh, retainSnapshot }),
    install,
    refresh,
    release,
    notify,
    retainSnapshot
  }
}

describe('Marketplace main-process batch queue', () => {
  it('closes admission, drains the current item and skips refresh during disposal', async () => {
    const s = setup()
    const pending = Promise.withResolvers<SkillMarketplaceInstallResult>()
    s.install.mockReturnValueOnce(pending.promise)
    s.queue.start(request, s.notify)
    let disposed = false
    const disposal = s.queue.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(s.install.mock.calls[0][1].aborted).toBe(true)
    expect(s.queue.start(request, s.notify)).toEqual({ ok: false, error: 'busy' })
    pending.resolve(success)
    await disposal
    await s.queue.dispose()
    expect(s.install).toHaveBeenCalledTimes(1)
    expect(s.queue.get()?.items.map(({ status }) => status)).toEqual(['succeeded', 'stopped'])
    expect(s.queue.get()?.status).toBe('stopped')
    expect(s.refresh).not.toHaveBeenCalled()
    expect(s.notify).not.toHaveBeenCalled()
    expect(s.release).toHaveBeenCalledTimes(1)
    expect(s.queue.start(request, s.notify)).toEqual({ ok: false, error: 'busy' })
  })

  it('drains an already-running refresh without notifying disposed consumers', async () => {
    const s = setup()
    const refresh = Promise.withResolvers<void>()
    s.refresh.mockReturnValue(refresh.promise)
    s.queue.start(request, s.notify)
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalledOnce())
    let disposed = false
    const disposal = s.queue.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    refresh.resolve()
    await disposal
    expect(s.notify).not.toHaveBeenCalled()
    expect(s.release).toHaveBeenCalledOnce()
  })

  it.each(['1.0.0-beta.1', '2.0.0-rc.1+build'])(
    'rejects prerelease batch %s before admission',
    (version) => {
      const s = setup()
      expect(
        s.queue.start({ ...request, items: [{ ...request.items[0], version }] }, s.notify)
      ).toEqual({
        ok: false,
        error: 'invalid-request'
      })
      expect(s.retainSnapshot).not.toHaveBeenCalled()
      expect(s.install).not.toHaveBeenCalled()
      expect(s.queue.get()).toBeNull()
    }
  )

  it('validates before retaining a snapshot or writing and admits only one batch', async () => {
    const s = setup()
    expect(s.queue.start({ ...request, snapshotId: 'a'.repeat(40) }, s.notify)).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(s.queue.start({ ...request, items: [] }, s.notify)).toEqual({
      ok: false,
      error: 'invalid-request'
    })
    expect(
      s.queue.start({ ...request, items: [request.items[0], request.items[0]] }, s.notify).ok
    ).toBe(false)
    expect(
      s.queue.start(
        { ...request, items: [{ id: '../escape', version: '1.0.0', expectedVersion: null }] },
        s.notify
      ).ok
    ).toBe(false)
    expect(s.retainSnapshot).not.toHaveBeenCalled()
    s.retainSnapshot.mockReturnValueOnce(undefined)
    expect(s.queue.start(request, s.notify)).toEqual({ ok: false, error: 'snapshot-unavailable' })
    expect(s.install).not.toHaveBeenCalled()
    s.queue.start(request, s.notify)
    expect(s.queue.start(request, s.notify)).toEqual({ ok: false, error: 'busy' })
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('completed'))
  })

  it('serializes items, freezes input, returns detached snapshots and refreshes once', async () => {
    const s = setup()
    let complete!: (result: SkillMarketplaceInstallResult) => void
    s.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const input = structuredClone(request)
    const started = s.queue.start(input, s.notify)
    expect(started.ok).toBe(true)
    input.items[1].id = 'tampered'
    const snapshot = s.queue.get()!
    snapshot.items[1].id = 'also-tampered'
    expect(s.install).toHaveBeenCalledTimes(1)
    expect(s.queue.get()?.items[1].status).toBe('queued')
    complete(success)
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('completed'))
    expect(s.install).toHaveBeenLastCalledWith(
      {
        snapshotId: request.snapshotId,
        id: 'two',
        expectedVersion: null
      },
      expect.any(AbortSignal)
    )
    expect(s.queue.get()?.items.map(({ status }) => status)).toEqual(['succeeded', 'succeeded'])
    expect(s.refresh).toHaveBeenCalledTimes(1)
    expect(s.notify).toHaveBeenCalledTimes(1)
    expect(s.release).toHaveBeenCalledTimes(1)
  })

  it('continues after failures, skips unchanged releases and permits an explicit retry batch', async () => {
    const s = setup()
    s.install
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...success, value: { ...success.value, status: 'unchanged' } })
    s.queue.start(request, s.notify)
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('completed'))
    const first = s.queue.get()!
    expect(first.items.map(({ status }) => status)).toEqual(['failed', 'skipped'])
    expect(s.refresh).not.toHaveBeenCalled()
    s.queue.start(
      {
        snapshotId: first.snapshotId,
        items: first.items
          .filter(({ status }) => status === 'failed')
          .map(({ id, version, expectedVersion }) => ({ id, version, expectedVersion }))
      },
      s.notify
    )
    expect(s.queue.stop(first.id)).toBe(false)
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('completed'))
    expect(s.queue.get()?.items).toHaveLength(1)
    expect(s.queue.get()?.items[0].status).toBe('succeeded')
  })

  it('stops only future items, preserves the in-flight result and rejects stale stop IDs', async () => {
    const s = setup()
    let complete!: (result: SkillMarketplaceInstallResult) => void
    s.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    s.queue.start(request, s.notify)
    expect(s.queue.stop('other-batch')).toBe(false)
    expect(s.queue.stop(s.queue.get()!.id)).toBe(true)
    expect(s.queue.get()?.status).toBe('stopping')
    complete(success)
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('stopped'))
    expect(s.queue.get()?.items.map(({ status }) => status)).toEqual(['succeeded', 'stopped'])
    expect(s.install).toHaveBeenCalledTimes(1)
    expect(s.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not misreport successful writes when final refresh fails and releases the snapshot', async () => {
    const s = setup()
    s.refresh.mockRejectedValueOnce(new Error('refresh failed'))
    s.queue.start(request, s.notify)
    await vi.waitFor(() => expect(s.queue.get()?.status).toBe('completed'))
    expect(s.queue.get()?.refreshFailed).toBe(true)
    expect(s.queue.get()?.items.every(({ status }) => status === 'succeeded')).toBe(true)
    expect(s.notify).toHaveBeenCalledTimes(1)
    expect(s.release).toHaveBeenCalledTimes(1)
    expect(new SkillMarketplaceInstallQueue(s).get()).toBeNull()
  })
})
