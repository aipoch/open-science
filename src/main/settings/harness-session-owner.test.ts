import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSessionOwner } from './harness-session-owner'
import { SettingsRepository } from './repository'
import type { StoredProvider } from './types'
import type { ProviderRuntimeTarget } from './provider-runtime-projection'
import type { HarnessProviderLease } from './provider-transport-owner'
import type { HarnessModelObservation } from './harness-model-request'

const provider = (id = 'p1'): StoredProvider => ({
  id,
  name: id,
  type: 'custom',
  baseUrl: 'https://fixture.invalid',
  model: 'model-a',
  apiEndpoints: ['chat-completions']
})
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let directory: string
let repository: SettingsRepository
let owner: HarnessSessionOwner
let leases: HarnessProviderLease[]
let acquire: ReturnType<
  typeof vi.fn<
    (target: ProviderRuntimeTarget, signal: AbortSignal) => Promise<HarnessProviderLease>
  >
>
const request = { providerId: 'p1', model: 'model-a', maxSteps: 3 }
const open = (
  id = 'p1',
  lifetime = new AbortController().signal
): ReturnType<HarnessSessionOwner['open']> => owner.open({ ...request, providerId: id }, lifetime)

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-sessions-'))
  repository = new SettingsRepository(directory)
  await repository.upsertProvider(provider())
  leases = []
  acquire = vi.fn(async (target): Promise<HarnessProviderLease> => {
    const lease: HarnessProviderLease = {
      route: {
        id: `route-${leases.length}`,
        providerId: target.providerId,
        configRevision: target.configRevision!,
        model: target.effectiveModel!,
        protocol: 'chat-completions'
      },
      connection: { baseUrl: 'http://127.0.0.1:1234', token: 'fixture-local-token' },
      release: vi.fn(async () => undefined)
    }
    leases.push(lease)
    return lease
  })
  owner = new HarnessSessionOwner(repository, { acquireHarness: acquire })
})
afterEach(async () => {
  await owner.dispose().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('harness account and session lifetimes', () => {
  it('scopes requests to each turn and step and rejects retained capabilities', async () => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
      })
    )
    const session = await open()
    const observations: HarnessModelObservation[] = []
    const observe = async (event: HarnessModelObservation): Promise<void> => {
      observations.push(event)
    }
    let retained!: Parameters<Parameters<typeof session.run>[0]>[2]
    await session.run(async (_signal, index, model) => {
      retained = model
      expect(model).not.toHaveProperty('connection')
      await model.request({ messages: [] }, observe)
      expect(() => model.request({ messages: [] }, observe)).toThrow('one model request')
      return index === 0 ? 'continue' : 'complete'
    })
    expect(() => retained.request({ messages: [] }, observe)).toThrow()
    await session.run(async (_signal, _index, model) => {
      await model.request({ messages: [] }, observe)
      return 'complete'
    })
    const started = observations.filter((event) => event.status === 'started')
    expect(started.map((event) => event.step)).toEqual([0, 1, 0])
    expect(started[0].turnId).toBe(started[1].turnId)
    expect(started[2].turnId).not.toBe(started[1].turnId)
    expect(new Set(started.map((event) => event.requestId)).size).toBe(3)
    expect(started.every((event) => event.route.id === session.route.id)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('waits for a request even if the step forgets to await it', async () => {
    const fetched = deferred<Response>()
    const entered = deferred<void>()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      entered.resolve()
      return fetched.promise
    })
    const session = await open()
    const observe = vi.fn(async () => undefined)
    let finished = false
    const turn = session
      .run(async (_signal, _index, model) => {
        void model.request({ messages: [] }, observe)
        return 'complete'
      })
      .then((value) => {
        finished = true
        return value
      })
    await entered.promise
    expect(finished).toBe(false)
    fetched.resolve(
      Response.json({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }]
      })
    )
    expect(await turn).toBe('complete')
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('aborts and drains an unawaited model request when the step fails', async () => {
    const entered = deferred<void>()
    let requestSignal: AbortSignal | null | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestSignal = init?.signal
      entered.resolve()
      return new Promise((_resolve, reject) =>
        requestSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
    })
    const session = await open()
    const observe = vi.fn(async () => undefined)
    await expect(
      session.run(async (_signal, _index, model) => {
        void model.request({ messages: [] }, observe)
        await entered.promise
        throw new Error('step failed')
      })
    ).rejects.toThrow('step failed')
    expect(requestSignal?.aborted).toBe(true)
    expect(observe.mock.calls.at(-1)).toEqual([expect.objectContaining({ status: 'interrupted' })])
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })
  it.each(['edit', 'delete', 'disconnect', 'key', 'auth', 'model'] as const)(
    'revokes an active session on %s, before waiting for tool settlement',
    async (change) => {
      const session = await open()
      const toolSettled = deferred<void>()
      const entered = deferred<AbortSignal>()
      const turn = session.run(async (signal) => {
        entered.resolve(signal)
        await toolSettled.promise
        return 'complete'
      })
      const signal = await entered.promise
      if (change === 'delete') await repository.deleteProvider('p1')
      else if (change === 'edit')
        await repository.upsertProvider({ ...provider(), baseUrl: 'https://new.invalid' }, 'p1', {})
      else if (change === 'disconnect')
        await repository.upsertProvider({ ...provider(), disconnectedAt: 1 })
      else if (change === 'key')
        await repository.upsertProvider({ ...provider(), keyRef: 'changed-encrypted-key' })
      else
        await repository.updateProviderValidationIfTargetMatches(
          'p1',
          () => true,
          { ok: false, category: change === 'auth' ? 'auth' : 'model-not-found', status: 401 },
          change === 'auth' ? undefined : { model: 'model-a', endpoint: 'chat-completions' },
          10
        )
      expect(signal.aborted).toBe(true)
      expect(session.signal.aborted).toBe(true)
      await expect.poll(() => vi.mocked(leases[0].release).mock.calls.length).toBe(1)
      const step = vi.fn()
      await expect(session.run(step)).rejects.toThrow()
      expect(step).not.toHaveBeenCalled()
      let closed = false
      const closing = session.dispose().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      toolSettled.resolve()
      expect(await turn).toBe('cancelled')
      await closing
      expect(leases[0].release).toHaveBeenCalledTimes(1)
    }
  )

  it('ignores unrelated accounts, preferences, success and another model failure', async () => {
    const session = await open()
    await repository.upsertProvider(provider('p2'))
    await repository.markPathsNormalized(1)
    await repository.updateProviderValidationIfTargetMatches(
      'p1',
      () => true,
      { ok: true, category: 'ok' },
      { model: 'model-a', endpoint: 'chat-completions' },
      10
    )
    await repository.updateProviderValidationIfTargetMatches(
      'p1',
      () => true,
      { ok: false, category: 'model-not-found' },
      { model: 'other', endpoint: 'chat-completions' },
      11
    )
    expect(session.signal.aborted).toBe(false)
    expect(
      await session.run(async (_signal, _index, connection) => {
        expect(connection.route).toEqual(session.route)
        expect(connection).not.toHaveProperty('release')
        return 'complete'
      })
    ).toBe('complete')
    expect(leases[0].release).not.toHaveBeenCalled()
  })

  it('isolates sessions and explicitly reopens edited configuration with a fresh route', async () => {
    await repository.upsertProvider(provider('p2'))
    const a = await open(),
      b = await open('p2')
    await repository.upsertProvider({ ...provider(), baseUrl: 'https://new.invalid' }, 'p1', {})
    await a.dispose()
    expect(b.signal.aborted).toBe(false)
    const next = await open()
    expect(next.route.id).not.toBe(a.route.id)
    expect(next.route.configRevision).toBe(1)
    expect(acquire.mock.calls.at(-1)?.[0].provider.baseUrl).toBe('https://new.invalid')
    await next.dispose()
    await b.dispose()
    for (const lease of leases) expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it.each(['edit', 'delete-recreate', 'lifetime', 'shutdown'] as const)(
    'rejects and cleans a late acquisition after %s',
    async (event) => {
      const started = deferred<void>()
      const finish = deferred<void>()
      const original = acquire.getMockImplementation()!
      acquire.mockImplementation(async (target, signal) => {
        const lease = await original(target, signal)
        started.resolve()
        await finish.promise
        return lease
      })
      const lifetime = new AbortController()
      const result = open('p1', lifetime.signal)
      const rejected = expect(result).rejects.toThrow()
      await started.promise
      let shutdown: Promise<void> | undefined
      if (event === 'edit')
        await repository.upsertProvider({ ...provider(), baseUrl: 'https://new.invalid' }, 'p1', {})
      if (event === 'delete-recreate') {
        await repository.deleteProvider('p1')
        await repository.upsertProvider(provider())
      }
      if (event === 'lifetime') lifetime.abort()
      if (event === 'shutdown') shutdown = owner.dispose()
      finish.resolve()
      await rejected
      await shutdown
      expect(leases[0].release).toHaveBeenCalledTimes(1)
    }
  )

  it('rechecks persisted state even if a change bypassed this repository notification', async () => {
    const original = acquire.getMockImplementation()!
    acquire.mockImplementation(async (target, signal) => {
      const lease = await original(target, signal)
      await new SettingsRepository(directory).deleteProvider('p1')
      return lease
    })
    await expect(open()).rejects.toThrow('configuration changed')
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('does not acquire from a stale first read after deletion', async () => {
    const snapshot = await repository.getSettings()
    const read = deferred<typeof snapshot>()
    vi.spyOn(repository, 'getSettings').mockReturnValueOnce(read.promise)
    const opening = open()
    const rejected = expect(opening).rejects.toThrow()
    await repository.deleteProvider('p1')
    read.resolve(snapshot)
    await rejected
    expect(acquire).not.toHaveBeenCalled()
  })

  it('rejects invalid account or model selection before opening transport', async () => {
    await expect(open('missing')).rejects.toThrow('unavailable')
    await expect(
      owner.open({ ...request, model: 'other' }, new AbortController().signal)
    ).rejects.toThrow('not available')
    await repository.updateProviderValidationIfTargetMatches(
      'p1',
      () => true,
      { ok: false, category: 'auth' },
      undefined,
      10
    )
    await expect(open()).rejects.toThrow('unavailable')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('drains lifetime abort and owner shutdown, and detaches the repository subscription', async () => {
    const unsubscribe = vi.fn()
    const subscribe = repository.subscribeProviders.bind(repository)
    vi.spyOn(repository, 'subscribeProviders').mockImplementation((callback) => {
      const detach = subscribe(callback)
      return () => {
        detach()
        unsubscribe()
      }
    })
    await owner.dispose()
    owner = new HarnessSessionOwner(repository, { acquireHarness: acquire })
    const lifetime = new AbortController()
    const session = await open('p1', lifetime.signal)
    const settled = deferred<void>()
    const turn = session.run(async () => {
      await settled.promise
      return 'complete'
    })
    lifetime.abort()
    const shutdown = owner.dispose()
    expect(owner.dispose()).toBe(shutdown)
    await expect(open()).rejects.toThrow('disposed')
    settled.resolve()
    await turn
    await shutdown
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('closes on step failure but leaves an admitted run alone on overlapping admission', async () => {
    const session = await open()
    const settled = deferred<void>()
    const turn = session.run(async () => {
      await settled.promise
      return 'complete'
    })
    await expect(session.run(async () => 'complete')).rejects.toThrow('busy')
    expect(session.signal.aborted).toBe(false)
    settled.resolve()
    await turn
    await expect(
      session.run(async () => {
        throw new Error('tool failed')
      })
    ).rejects.toThrow('tool failed')
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(session.signal.aborted).toBe(true)
  })

  it('retains cleanup failure for both the session and service shutdown', async () => {
    const session = await open()
    vi.mocked(leases[0].release).mockRejectedValue(new Error('close failed'))
    await repository.deleteProvider('p1')
    await expect(session.dispose()).rejects.toThrow('cleanup failed')
    await expect(owner.dispose()).rejects.toThrow('failed to close')
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('shares disposal even when abort listeners reenter cleanup', async () => {
    const session = await open()
    let reentered: Promise<void> | undefined
    session.signal.addEventListener('abort', () => {
      reentered = session.dispose()
    })
    const closing = session.dispose()
    expect(reentered).toBe(closing)
    await closing
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('closes session admission synchronously on owner disposal, including reentrant disposal', async () => {
    const session = await open()
    let reentered: Promise<void> | undefined
    session.signal.addEventListener('abort', () => {
      reentered = owner.dispose()
    })
    const shutdown = owner.dispose()
    expect(reentered).toBe(shutdown)
    expect(session.signal.aborted).toBe(true)
    const step = vi.fn()
    await expect(session.run(step)).rejects.toThrow()
    expect(step).not.toHaveBeenCalled()
    await shutdown
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })
})
