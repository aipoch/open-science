import { sessionPackageCommandContracts } from '../../shared/session-package'
import { describe, expect, it, vi } from 'vitest'
import { SessionPackageOperation } from './operation'

const session = { projectId: 'project', sessionId: 'session' }
const file = {
  storageKey: 'artifacts/p/s/file',
  filename: 'result.csv',
  sizeBytes: 10,
  groupId: 'artifact',
  source: 'artifact' as const,
  versionNumber: 1,
  dependentFiles: []
}
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SessionPackageOperation', () => {
  it('delivers reproduced output selection through the application command contract', async () => {
    const owner = new SessionPackageOperation()
    const output = { ...file, source: 'reproducibility' as const, requiredForEvidence: true }
    const run = owner.run('export', session, () => owner.selectFiles([output]))
    try {
      expect(sessionPackageCommandContracts.operation.result.parse(owner.snapshot)?.files).toEqual([
        output
      ])
      expect(() =>
        owner.respond({
          action: 'select',
          operationId: owner.snapshot!.id,
          excludedStorageKeys: [file.storageKey]
        })
      ).toThrow('Invalid package selection')
      owner.respond({ action: 'select', operationId: owner.snapshot!.id, excludedStorageKeys: [] })
      await expect(run).resolves.toEqual([])
    } finally {
      owner.cancel()
      await run.catch(() => undefined)
    }
  })

  it('accepts a 32 GiB file and requires excluding anything larger', async () => {
    const owner = new SessionPackageOperation()
    const run = owner.run('export', session, () =>
      owner.selectFiles([
        { ...file, sizeBytes: 32 * 1024 ** 3 },
        { ...file, storageKey: 'oversized', sizeBytes: 32 * 1024 ** 3 + 1 }
      ])
    )
    try {
      expect(() =>
        owner.respond({
          action: 'select',
          operationId: owner.snapshot!.id,
          excludedStorageKeys: []
        })
      ).toThrow('Exclude files larger than')
      owner.respond({
        action: 'select',
        operationId: owner.snapshot!.id,
        excludedStorageKeys: ['oversized']
      })
      await expect(run).resolves.toEqual(['oversized'])
    } finally {
      owner.cancel()
      await run.catch(() => undefined)
    }
  })
  it('changes the live transfer budget without restarting the operation', async () => {
    const owner = new SessionPackageOperation()
    const completion = deferred()
    const run = owner.run('import', undefined, () => completion.promise)
    const id = owner.snapshot!.id
    expect(owner.transferBytesPerSecond).toBe(16 * 1024 ** 2)
    owner.respond({ action: 'set-speed', operationId: id, bytesPerSecond: 4 * 1024 ** 2 })
    expect(owner.transferBytesPerSecond).toBe(4 * 1024 ** 2)
    expect(owner.snapshot).toMatchObject({ id, state: 'running' })
    expect(() =>
      owner.respond({ action: 'set-speed', operationId: id, bytesPerSecond: 0 })
    ).toThrow('Invalid')
    completion.resolve()
    await run
    expect(() =>
      owner.respond({ action: 'set-speed', operationId: id, bytesPerSecond: 4 * 1024 ** 2 })
    ).toThrow('no longer active')
  })
  it('retains selection across clients and rejects stale or invalid selections', async () => {
    const changed = vi.fn()
    const owner = new SessionPackageOperation(changed)
    const summary = {
      metadataBytes: 5,
      retainedFiles: [{ storageKey: 'notebooks/p/s/file', filename: 'data.csv', sizeBytes: 20 }]
    }
    const run = owner.run('export', session, async () =>
      owner.selectFiles([file], undefined, summary)
    )
    const snapshot = owner.snapshot!
    expect(snapshot.state).toBe('awaiting-selection')
    snapshot.files!.splice(0)
    expect(owner.snapshot?.files).toEqual([file])
    expect(owner.snapshot?.summary).toEqual(summary)
    expect(() =>
      owner.respond({ action: 'select', operationId: 'stale', excludedStorageKeys: [] })
    ).toThrow('no longer active')
    expect(() =>
      owner.respond({
        action: 'select',
        operationId: snapshot.id,
        excludedStorageKeys: ['unknown']
      })
    ).toThrow('Invalid')
    owner.respond({
      action: 'select',
      operationId: snapshot.id,
      excludedStorageKeys: [file.storageKey]
    })
    await expect(run).resolves.toEqual([file.storageKey])
    expect(owner.snapshot?.state).toBe('succeeded')
    expect(owner.snapshot?.summary).toBeUndefined()
    expect(changed.mock.lastCall?.[0].state).toBe('succeeded')
  })

  it('keeps admission held until cancellation cleanup settles', async () => {
    const owner = new SessionPackageOperation()
    const cleanup = deferred()
    const run = owner.run('export', session, async () => {
      try {
        await owner.selectFiles([file])
      } finally {
        await cleanup.promise
      }
    })
    const failure = expect(run).rejects.toThrow('cancelled')
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(owner.active).toBe(true)
    expect(closed).toBe(false)
    await expect(owner.run('import', undefined, async () => null)).rejects.toThrow(
      'already in progress'
    )
    cleanup.resolve()
    await Promise.all([failure, closing])
    expect(owner.active).toBe(false)
    expect(owner.snapshot?.state).toBe('cancelled')
  })

  it('reports committed success after a late cancellation while notification settles', async () => {
    const owner = new SessionPackageOperation()
    const notification = deferred()
    const run = owner.run('import', undefined, async () => {
      await notification.promise
      return session
    })
    owner.cancel()
    notification.resolve()
    await expect(run).resolves.toEqual(session)
    expect(owner.snapshot?.state).toBe('succeeded')
  })

  it('aborts a pending selection when the service budget expires', async () => {
    const budget = new AbortController()
    const owner = new SessionPackageOperation()
    const run = owner.run('export', session, () => owner.selectFiles([file], budget.signal))
    const failure = expect(run).rejects.toThrow('budget expired')
    budget.abort(new Error('budget expired'))
    await failure
    expect(owner.active).toBe(false)
    expect(owner.snapshot?.state).toBe('failed')
  })

  it('owns cleanup retry through shutdown and restores the completed result', async () => {
    const owner = new SessionPackageOperation()
    await owner.run('import', undefined, async () => {
      owner.completeResult({ imported: session })
      owner.setCleanupPending(true)
    })
    const cleanup = deferred()
    const retry = owner.retryCleanup(async () => cleanup.promise)
    expect(owner.snapshot).toMatchObject({
      state: 'running',
      progress: { phase: 'cleaning' },
      result: { imported: session }
    })
    await expect(owner.retryCleanup(async () => undefined)).rejects.toThrow('not available')
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    cleanup.resolve()
    await Promise.all([retry, closing])
    expect(owner.snapshot).toMatchObject({
      state: 'succeeded',
      cleanupPending: false,
      result: { imported: session }
    })
  })
})
