import { sessionPackageCommandContracts } from '../../shared/session-package'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionPackageOperation } from './operation'

afterEach(() => vi.useRealTimers())

const session = { projectId: 'project', sessionId: 'session' }

it('throttles byte-only receipt events to 150 ms while publishing task boundaries immediately', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const changed = vi.fn()
  const owner = new SessionPackageOperation(changed)
  const transfer = {
    id: 'one',
    filename: 'one.science',
    state: 'receiving' as const,
    completedBytes: 0,
    totalBytes: 100
  }
  owner.setBrowserTransfers([transfer])
  expect(changed).toHaveBeenCalledTimes(1)
  owner.setBrowserTransfers([{ ...transfer, completedBytes: 10 }])
  owner.setBrowserTransfers([{ ...transfer, completedBytes: 20 }])
  expect(owner.snapshot?.browserTransfers?.[0].completedBytes).toBe(20)
  expect(changed).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(150)
  owner.setBrowserTransfers([{ ...transfer, completedBytes: 30 }])
  expect(changed).toHaveBeenCalledTimes(2)
  owner.setBrowserTransfers([
    { ...transfer, completedBytes: 30 },
    { ...transfer, id: 'two' }
  ])
  expect(changed).toHaveBeenCalledTimes(3)
  owner.setBrowserTransfers([
    { ...transfer, completedBytes: 30, state: 'cancelled' },
    { ...transfer, id: 'two' }
  ])
  expect(changed).toHaveBeenCalledTimes(4)
  owner.setBrowserTransfers([
    { ...transfer, completedBytes: 30, state: 'cancelled' },
    { ...transfer, id: 'two', completedBytes: 100 }
  ])
  expect(changed).toHaveBeenCalledTimes(5)
  owner.setBrowserTransfers([])
  expect(changed).toHaveBeenCalledTimes(6)
})
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
      await expect(run).resolves.toEqual({ excludedStorageKeys: [], includePdfNotes: false })
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
      await expect(run).resolves.toEqual({
        excludedStorageKeys: ['oversized'],
        includePdfNotes: false
      })
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

  it('adapts the default budget to sustained disk throughput and can return to Auto', async () => {
    vi.useFakeTimers()
    const owner = new SessionPackageOperation()
    const completion = deferred()
    const run = owner.run('import', undefined, () => completion.promise)
    expect(owner.transferBytesPerSecond).toBe(16 * 1024 ** 2)

    await vi.advanceTimersByTimeAsync(2_000)
    owner.reportIo(16 * 1024 ** 2)
    expect(owner.transferBytesPerSecond).toBe(32 * 1024 ** 2)

    owner.respond({
      action: 'set-speed',
      operationId: owner.snapshot!.id,
      bytesPerSecond: 64 * 1024 ** 2
    })
    expect(owner.transferBytesPerSecond).toBe(64 * 1024 ** 2)
    owner.respond({ action: 'set-speed', operationId: owner.snapshot!.id, bytesPerSecond: null })
    expect(owner.transferBytesPerSecond).toBe(16 * 1024 ** 2)

    completion.resolve()
    await run
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
    await expect(run).resolves.toEqual({
      excludedStorageKeys: [file.storageKey],
      includePdfNotes: false
    })
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

  it('retains sensitive evidence on a failed operation snapshot', async () => {
    const owner = new SessionPackageOperation()
    const evidence = {
      location: 'objects/file @3',
      offset: 3,
      rule: 'token' as const,
      matchLength: 8,
      leftBoundary: 'whitespace' as const,
      rightBoundary: 'end' as const,
      context: 'token=[redacted]',
      valueLength: 8,
      valueHash: 'a'.repeat(64),
      sourceStorageKey: 'objects/file'
    }
    const run = owner.run('export', session, async () => {
      owner.setSensitiveContent([evidence])
      throw new Error('sensitive content')
    })
    await expect(run).rejects.toThrow('sensitive content')
    expect(owner.snapshot).toMatchObject({ state: 'failed', sensitiveContent: [evidence] })
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

it('publishes browser transfers without claiming an import or replacing an active export', async () => {
  const owner = new SessionPackageOperation()
  const transfers = [
    {
      id: 'browser-1',
      filename: 'study.science',
      state: 'waiting' as const,
      completedBytes: 0,
      totalBytes: 5
    }
  ]
  owner.setBrowserTransfers(transfers)
  expect(sessionPackageCommandContracts.operation.result.parse(owner.snapshot)).toMatchObject({
    browserReceiptOnly: true,
    browserTransfers: transfers,
    state: 'running'
  })
  expect(owner.active).toBe(false)
  const completion = deferred()
  const exporting = owner.run('export', session, () => completion.promise)
  const id = owner.snapshot!.id
  owner.setBrowserTransfers([{ ...transfers[0], state: 'receiving', completedBytes: 2 }])
  expect(owner.snapshot).toMatchObject({
    id,
    kind: 'export',
    browserTransfers: [{ completedBytes: 2 }]
  })
  completion.resolve()
  await exporting
})

it('retains the failed import retry state when cancellation leaves publication recovery required', async () => {
  const owner = new SessionPackageOperation()
  const failure = new Error('Publication interrupted after commit')
  const run = owner.run(
    'import',
    undefined,
    async () => {
      owner.cancel()
      throw failure
    },
    { projectId: 'target' },
    () => true
  )
  await expect(run).rejects.toBe(failure)
  expect(owner.snapshot).toMatchObject({ state: 'failed', error: failure.message })
  expect(owner.snapshot?.result?.recovery).toBeUndefined()
  expect(owner.active).toBe(false)
})
