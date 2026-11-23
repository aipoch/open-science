import { SearchService } from './search-service'
import { WebSnapshotStore } from './snapshot-store'
import { WebService } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { WebResult } from '../../shared/web-tools'
import { WebInvocationOwner, type WebInvocationOwnerOptions } from './invocation-owner'
import { WebInvocationStore, type WebInvocationScope } from './invocation-store'

const binding = { projectId: 'project', sessionId: 'session' }
const initialScope: WebInvocationScope = {
  ...binding,
  branchId: 'branch',
  promptMessageId: 'prompt',
  agentFrameId: 'frame',
  runtimeSegmentId: 'segment'
}
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Fixture = {
  store: WebInvocationStore
  owner: WebInvocationOwner
  options: WebInvocationOwnerOptions
  run: Mock<WebInvocationOwnerOptions['execute']>
  publish: Mock<NonNullable<WebInvocationOwnerOptions['publish']>>
  setScope: (scope: WebInvocationScope) => void
}
const setup = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'web-invocation-'))
  roots.push(root)
  const store = new WebInvocationStore(join(root, 'records'))
  let scope = { ...initialScope }
  const run = vi.fn(
    async (
      _scope: WebInvocationScope,
      operation: 'search' | 'fetch',
      input: unknown,
      context: { invocationId?: string }
    ): Promise<WebResult> => ({
      schema: 'open-science.web.v1',
      invocation_id: context.invocationId!,
      operation,
      status: 'error',
      request: input as WebResult['request'],
      retrieved_at: new Date().toISOString(),
      duration_ms: 1,
      sources: [],
      error: { code: 'BLOCKED_TARGET', retryable: false }
    })
  )
  const publish = vi.fn<NonNullable<WebInvocationOwnerOptions['publish']>>()
  const options = { store, scope: async () => scope, execute: run, publish }
  const owner = new WebInvocationOwner(options)
  return {
    store,
    owner,
    options,
    run,
    publish,
    setScope: (next: WebInvocationScope) => {
      scope = next
    }
  }
}

describe('durable Web invocation ownership', () => {
  it.each(['throwing', 'rejecting', 'blocked'] as const)(
    'commits a successful search while progress publication is %s',
    async (publication) => {
      const f = await setup()
      const progress = deferred<void>()
      f.publish.mockImplementation(() => {
        if (publication === 'throwing') throw new Error('Observer failed')
        if (publication === 'rejecting') return Promise.reject(new Error('Observer failed'))
        return progress.promise
      })
      const invocationId = 'publish-fault'
      const search = vi.fn(async () => {
        expect(await f.store.read(binding, invocationId)).toMatchObject({
          searchDispatches: [{ index: 1 }]
        })
        return { sources: [] }
      })
      const service = new SearchService({ provider: { search } })
      const owner = new WebInvocationOwner({
        ...f.options,
        execute: (_scope, _operation, input, context) => service.search('session', input, context)
      })
      try {
        const result = await owner.execute(
          binding,
          'search',
          { query: 'science' },
          { invocationId }
        )
        expect(result).toMatchObject({ status: 'ok', attempts: [{ index: 1, status: 'ok' }] })
        expect(search).toHaveBeenCalledOnce()
        expect(f.publish.mock.calls.map(([record]) => record.searchAttempts?.[0]?.status)).toEqual([
          undefined,
          'ok'
        ])
        await owner.receiptCommitted(binding, { structuredContent: result })
        expect(await f.store.read(binding, invocationId)).toMatchObject({
          status: 'completed',
          searchAttempts: [{ index: 1, status: 'ok' }],
          result
        })
      } finally {
        progress.resolve()
      }
    }
  )

  it('cancels preparation even before the scope read returns and performs no execution', async () => {
    const f = await setup()
    const wait = deferred<WebInvocationScope>()
    const owner = new WebInvocationOwner({ ...f.options, scope: () => wait.promise })
    const running = owner.execute(
      binding,
      'search',
      { query: 'science' },
      { invocationId: 'waiting-scope' }
    )
    owner.cancelSession(binding.sessionId)
    wait.resolve(initialScope)
    const outcome = await running
    expect(outcome.error?.code).toBe('CANCELLED')
    await owner.receiptCommitted(binding, { structuredContent: outcome })
    const restarted = new WebInvocationOwner(f.options)
    await expect(
      restarted.reconcileResult(binding, {
        invocationId: 'waiting-scope',
        name: 'web_search',
        arguments: { query: 'science' }
      })
    ).resolves.toMatchObject({ structuredContent: outcome })
    expect(owner.dispositionFor(binding, 'waiting-scope')).toBe('cancelled')
    expect(f.run).not.toHaveBeenCalled()
  })
  it('rejects a duplicate invocation without releasing the original receipt authority', async () => {
    const f = await setup()
    const wait = deferred<WebResult>()
    f.run.mockImplementationOnce(() => wait.promise)
    const input = { query: 'science' }
    const context = { invocationId: 'duplicate' }
    const original = f.owner.execute(binding, 'search', input, context)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    const signal = f.owner.receiptSignal(binding, context.invocationId)
    await expect(f.owner.execute(binding, 'search', input, context)).rejects.toThrow(
      'Web invocation already dispatched'
    )
    expect(f.owner.receiptSignal(binding, context.invocationId)).toBe(signal)
    f.owner.cancelSession(binding.sessionId)
    await expect(original).resolves.toMatchObject({ error: { code: 'CANCELLED' } })
    expect(signal?.aborted).toBe(true)
    expect(f.run).toHaveBeenCalledOnce()
  })
  it('cancels an in-flight operation and ignores a late success through the receipt window', async () => {
    const f = await setup()
    const wait = deferred<WebResult>()
    f.run.mockImplementationOnce(() => wait.promise)
    const running = f.owner.execute(
      binding,
      'search',
      { query: 'science' },
      { invocationId: 'late' }
    )
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    f.owner.cancelSession(binding.sessionId)
    await expect(running).resolves.toMatchObject({ error: { code: 'CANCELLED', retryable: false } })
    const late: WebResult = {
      schema: 'open-science.web.v1',
      invocation_id: 'late',
      operation: 'search',
      status: 'ok',
      request: { query: 'science' },
      retrieved_at: new Date().toISOString(),
      duration_ms: 1,
      sources: [],
      returned_count: 0
    }
    wait.resolve(late)
    await expect(
      f.owner.receiptCommitted(binding, { content: [], structuredContent: late })
    ).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } })
    expect((await f.store.read(binding, 'late')).status).toBe('cancelled')
  })
  it('keeps successful preparation cancellable until receipt publication', async () => {
    const f = await setup()
    const prepared = await f.owner.execute(
      binding,
      'search',
      { query: 'science' },
      { invocationId: 'prepared' }
    )
    await f.owner.receiptCommitted(binding, { content: [], structuredContent: prepared })
    const next = await f.owner.execute(
      binding,
      'search',
      { query: 'next' },
      { invocationId: 'next' }
    )
    f.owner.cancelSession(binding.sessionId)
    await expect(
      f.owner.receiptCommitted(binding, { content: [], structuredContent: next })
    ).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } })
    expect((await f.store.read(binding, 'next')).status).toBe('cancelled')
  })
  it('keeps a cancelled fetch out of cache and continuation during receipt publication', async () => {
    const f = await setup()
    const snapshots = new WebSnapshotStore(join(roots.at(-1)!, 'snapshots'))
    const url = 'https://example.org/research'
    const transport = vi.fn(async () => ({
      finalUrl: url,
      contentType: 'text/plain',
      body: Buffer.from('Research observations and supporting evidence.')
    }))
    const service = new WebService({ store: snapshots, transport })
    const enteringPublication = deferred<void>()
    const resumePublication = deferred<void>()
    const owner = new WebInvocationOwner({
      ...f.options,
      execute: (_scope, _operation, input, context) =>
        service.fetch(initialScope.branchId, input, context),
      publishSnapshot: (scope, id, authorize) =>
        snapshots.commit(scope.branchId, id, async () => {
          enteringPublication.resolve()
          await resumePublication.promise
          return authorize()
        })
    })
    const result = await owner.execute(binding, 'fetch', { url })
    expect(result.status).toBe('ok')
    const pending = owner.receiptCommitted(binding, { structuredContent: result })
    await enteringPublication.promise
    owner.cancelSession(binding.sessionId)
    resumePublication.resolve()
    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CANCELLED' } }
    })
    expect(await f.store.read(binding, result.invocation_id)).toMatchObject({ status: 'cancelled' })
    await expect(
      snapshots.readCommitted(initialScope.branchId, result.document!.snapshot_id)
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await service.fetch(initialScope.branchId, { url })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('reconciles only an exact cancelled identity and never promotes an immutable competing receipt', async () => {
    const f = await setup()
    const wait = deferred<WebResult>()
    f.run.mockImplementationOnce(() => wait.promise)
    const pending = f.owner.execute(
      binding,
      'search',
      { query: 'science' },
      { invocationId: 'cancelled' }
    )
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    f.owner.cancelSession(binding.sessionId)
    const outcome = await pending
    expect(outcome.error?.code).toBe('CANCELLED')
    await expect(
      f.owner.reconcileResult(binding, {
        invocationId: 'cancelled',
        name: 'web_search',
        arguments: { query: 'different' }
      })
    ).resolves.toBeUndefined()
    await expect(
      f.owner.reconcileResult(binding, {
        invocationId: 'cancelled',
        name: 'web_search',
        arguments: { query: 'science' }
      })
    ).resolves.toMatchObject({ structuredContent: { error: { code: 'CANCELLED' } } })
    await f.owner.receiptCommitted(binding, {
      structuredContent: { ...outcome, status: 'ok', error: undefined }
    })
    expect((await f.store.read(binding, 'cancelled')).status).toBe('cancelled')
    expect(f.owner.dispositionFor(binding, 'cancelled')).toBe('cancelled')
  })
})

it('durably records dispatch and cancelled settlement before any transport envelope exists', async () => {
  const f = await setup()
  const entered = deferred<void>()
  const blockedProgress = deferred<void>()
  f.publish.mockReturnValue(blockedProgress.promise)
  const service = new SearchService({
    provider: {
      search: async (_input, signal) => {
        entered.resolve()
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
    }
  })
  const owner = new WebInvocationOwner({
    ...f.options,
    execute: (_scope, _operation, input, context) => service.search('session', input, context)
  })
  const transport = new AbortController()
  const running = owner.execute(
    binding,
    'search',
    { query: 'science' },
    { invocationId: 'cancel-metered', signal: transport.signal }
  )
  const rejection = expect(running).rejects.toBeDefined()
  try {
    await entered.promise
    expect((await f.store.read(binding, 'cancel-metered')).searchDispatches).toHaveLength(1)
    transport.abort(new Error('caller cancelled'))
    await rejection
    await vi.waitFor(async () =>
      expect((await f.store.read(binding, 'cancel-metered')).searchAttempts).toMatchObject([
        { index: 1, status: 'cancelled' }
      ])
    )
    expect(owner.metadataFor(binding, 'cancel-metered')?.searchAttempts).toMatchObject([
      { status: 'cancelled' }
    ])
    expect(f.publish.mock.calls.filter(([, status]) => status === 'in_progress')).toHaveLength(1)
    const cancellations = f.publish.mock.calls.filter(([, status]) => status === 'failed')
    expect(cancellations.map(([record]) => record.searchAttempts?.[0]?.status)).toContain(
      'cancelled'
    )
  } finally {
    blockedProgress.resolve()
  }
})
