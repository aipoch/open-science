import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalServiceLifetime,
  readServiceLifetime,
  type LocalServiceLifetime
} from './local-service-lifetime'
const persistence = vi.hoisted(() => ({
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  afterWrite: undefined as (() => Promise<void>) | undefined
}))
vi.mock('@aipoch/durable-files', async (original) => {
  const actual = await original<typeof import('@aipoch/durable-files')>()
  return {
    ...actual,
    writeDurableJsonFile: async (...args: Parameters<typeof actual.writeDurableJsonFile>) => {
      await persistence.beforeWrite?.()
      await actual.writeDurableJsonFile(...args)
      await persistence.afterWrite?.()
    }
  }
})
const roots: string[] = []
const lifetimes: LocalServiceLifetime[] = []
afterEach(async () => {
  persistence.beforeWrite = undefined
  persistence.afterWrite = undefined
  for (const lifetime of lifetimes.splice(0)) lifetime.close()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('keeps the last App hold when its stop intent cannot be persisted', async () => {
  const { lifetime, stop, configRoot } = await fixture()
  lifetime.connect('app', 'socket')
  persistence.beforeWrite = vi.fn().mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(lifetime.leave('app', 'socket')).rejects.toThrow('disk unavailable')
  expect(lifetime.snapshot()).toMatchObject({ apps: 1, stopping: true })
  expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: false })
  expect(stop).not.toHaveBeenCalled()
  persistence.beforeWrite = undefined
  expect(() => lifetime.connect('b', 'socket-b')).toThrow()
  await lifetime.leave('app', 'socket')
  expect(stop).toHaveBeenCalledOnce()
})

it('requires an explicit stop retry after a grace stop write retires the generation', async () => {
  const { lifetime, stop, options } = await fixture()
  let attempts = 0
  persistence.beforeWrite = async () => {
    if (++attempts === 1) throw new Error('temporary write failure')
  }
  await vi.waitFor(() => expect(options.report).toHaveBeenCalledOnce())
  expect(stop).not.toHaveBeenCalled()
  await lifetime.stop(true)
  expect(stop).toHaveBeenCalledWith('user-stop', expect.any(Number))
  expect(options.report).toHaveBeenCalledOnce()
  expect(lifetime.snapshot().stopping).toBe(true)
})

it('validates every durable stop reason before replacing a valid record', async () => {
  const { lifetime, stop, configRoot } = await fixture(true)
  await expect(lifetime.stop(true, 'SIGTERM' as 'user-stop')).rejects.toThrow()
  expect(lifetime.snapshot()).toMatchObject({ explicit: true, stopping: false })
  expect(await readServiceLifetime(configRoot)).toMatchObject({ explicit: true, stopping: false })
  expect(stop).not.toHaveBeenCalled()
})

it('serializes a pending explicit start with leave while admitting a new App', async () => {
  const { lifetime, stop } = await fixture()
  lifetime.connect('a', '1')
  const writing = Promise.withResolvers<void>()
  persistence.beforeWrite = () => writing.promise
  const start = lifetime.start()
  const leave = lifetime.leave('a', '1')
  lifetime.connect('b', '2')
  writing.resolve()
  await Promise.all([start, leave])
  expect(lifetime.snapshot()).toMatchObject({ explicit: true, apps: 1, stopping: false })
  expect(stop).not.toHaveBeenCalled()
})

it('reserves the final App quit and ignores stale aborts without accepting new holds', async () => {
  const { lifetime, stop } = await fixture()
  lifetime.connect('app', 'socket')
  const attempt = { attemptId: randomUUID(), deadlineAt: Date.now() + 10000 }
  expect(await lifetime.prepareLeave('app', 'socket', attempt)).toBe(true)
  lifetime.connect('app', 'socket') // A bootstrap refresh is idempotent.
  await expect(lifetime.start()).rejects.toThrow('stopping')
  expect(() => lifetime.connect('app', 'new-socket')).toThrow('preparing')
  await lifetime.abortLeave('app', 'socket', randomUUID())
  expect(() => lifetime.connect('other', 'socket')).toThrow('preparing')
  await lifetime.abortLeave('app', 'socket', attempt.attemptId)
  lifetime.connect('other', 'socket')
  expect(await lifetime.prepareLeave('app', 'socket', attempt)).toBe(false)
  expect(stop).not.toHaveBeenCalled()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture(explicitStart = false) {
  const configRoot = await mkdtemp(join(tmpdir(), 'service-lifetime-'))
  roots.push(configRoot)
  const stop = vi.fn()
  const options = {
    configRoot,
    generation: randomUUID(),
    explicitStart,
    stop,
    onStoppingAdmission: vi.fn(),
    report: vi.fn(),
    disconnectGraceMs: 20,
    firstConnectionMs: 20
  }
  const lifetime = await createLocalServiceLifetime(options)
  lifetimes.push(lifetime)
  return { lifetime, stop, options, configRoot }
}
describe('service holds', () => {
  it('keeps the service while an App exists and stops immediately after the last App leaves', async () => {
    const { lifetime, stop, configRoot } = await fixture()
    lifetime.connect('app', 'socket')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stop).not.toHaveBeenCalled()
    expect((await lifetime.leave('app', 'socket')).stopping).toBe(true)
    expect(stop).toHaveBeenCalledWith('app-exit', expect.any(Number))
    expect(await readServiceLifetime(configRoot)).toMatchObject({
      stopping: true,
      reason: 'app-exit'
    })
    await expect(lifetime.start()).rejects.toThrow('stopping')
  })
  it('deduplicates App reconnects and ignores an old socket release', async () => {
    const { lifetime, stop } = await fixture()
    lifetime.connect('app', 'old')
    lifetime.connect('app', 'new')
    expect(lifetime.snapshot().apps).toBe(1)
    await lifetime.leave('app', 'old')
    lifetime.disconnect('app', 'old')
    expect(lifetime.snapshot().apps).toBe(1)
    expect(stop).not.toHaveBeenCalled()
    await lifetime.leave('app', 'new')
    expect(stop).toHaveBeenCalledOnce()
  })
  it('serializes start and exit, revokes explicit running without stopping another App', async () => {
    const { lifetime, stop } = await fixture()
    lifetime.connect('a', '1')
    lifetime.connect('b', '2')
    await Promise.all([lifetime.start(), lifetime.leave('a', '1')])
    expect(lifetime.snapshot()).toMatchObject({ explicit: true, apps: 1, stopping: false })
    await lifetime.stop()
    expect(lifetime.snapshot()).toMatchObject({ explicit: false, apps: 1, stopping: false })
    expect(stop).not.toHaveBeenCalled()
    await lifetime.leave('b', '2')
    expect(stop).toHaveBeenCalledOnce()
  })
  it('bounds missing App connections and permits reconnect before commitment', async () => {
    const { lifetime, stop } = await fixture()
    lifetime.connect('app', 'old')
    lifetime.disconnect('app', 'old')
    lifetime.connect('app', 'new')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stop).not.toHaveBeenCalled()
    lifetime.disconnect('app', 'new')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('disconnect', expect.any(Number)))
  })
  it('persists explicit running across crash recovery but never across user stop', async () => {
    const { lifetime, options } = await fixture(true)
    lifetime.close()
    const recovered = await createLocalServiceLifetime({
      ...options,
      generation: randomUUID(),
      explicitStart: false
    })
    lifetimes.push(recovered)
    expect(recovered.snapshot().explicit).toBe(true)
    recovered.connect('app', 'socket')
    await recovered.stop(true)
    const next = await createLocalServiceLifetime({
      ...options,
      generation: randomUUID(),
      explicitStart: false
    })
    lifetimes.push(next)
    expect(next.snapshot().explicit).toBe(false)
  })
})

it('preserves explicit running only across an intentional restart or update', async () => {
  const { lifetime, options } = await fixture(true)
  await lifetime.stop(true, 'restart')
  expect(lifetime.snapshot()).toMatchObject({ stopping: true, explicit: true, reason: 'restart' })
  const next = await createLocalServiceLifetime({
    ...options,
    generation: randomUUID(),
    explicitStart: false
  })
  lifetimes.push(next)
  expect(next.snapshot()).toMatchObject({ stopping: false, explicit: true })
  await next.stop(true)
  expect(next.snapshot()).toMatchObject({ stopping: true, explicit: false, reason: 'user-stop' })
})

it('does not restart the disconnect grace after a vanished App preparation is rolled back', async () => {
  vi.useFakeTimers()
  const { lifetime, stop } = await fixture()
  lifetime.connect('app', 'socket')
  const attempt = { attemptId: randomUUID(), deadlineAt: Date.now() + 10000 }
  await lifetime.prepareLeave('app', 'socket', attempt)
  lifetime.disconnect('app', 'socket')
  await vi.advanceTimersByTimeAsync(30)
  expect(stop).not.toHaveBeenCalled()
  const beforeWrite = vi.fn(async () => {})
  persistence.beforeWrite = beforeWrite
  await lifetime.abortLeave('app', 'socket', attempt.attemptId)
  await vi.advanceTimersByTimeAsync(0)
  expect(beforeWrite).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('disconnect', expect.any(Number)))
})

it('rechecks disconnected Apps after a pending durable explicit-hold release', async () => {
  const { lifetime, stop } = await fixture(true)
  lifetime.connect('app', 'socket')
  const writing = Promise.withResolvers<void>()
  const beforeWrite = vi.fn(() => writing.promise)
  persistence.beforeWrite = beforeWrite
  const release = lifetime.stop()
  await vi.waitFor(() => expect(beforeWrite).toHaveBeenCalledOnce())
  lifetime.disconnect('app', 'socket')
  expect(lifetime.snapshot()).toMatchObject({ explicit: true, apps: 0, stopping: false })
  writing.resolve()
  await release
  expect(lifetime.snapshot()).toMatchObject({
    explicit: false,
    apps: 0,
    stopping: true,
    reason: 'user-stop'
  })
  expect(stop).toHaveBeenCalledWith('user-stop', expect.any(Number))
})

it('bounds a hung stop-intent write and compensates late publication without stopping secretly', async () => {
  const { lifetime, stop, configRoot } = await fixture()
  lifetime.connect('app', 'socket')
  vi.useFakeTimers()
  const writing = Promise.withResolvers<void>()
  persistence.beforeWrite = () => writing.promise
  const afterWrite = vi.fn(async () => {})
  persistence.afterWrite = afterWrite
  const stopping = lifetime.stop(true, 'user-stop', Date.now() + 50)
  const result = expect(stopping).rejects.toMatchObject({ code: 'service-stop-intent-timeout' })
  await vi.advanceTimersByTimeAsync(50)
  await result
  expect(stop).not.toHaveBeenCalled()
  await expect(lifetime.start()).rejects.toMatchObject({ code: 'service-stop-intent-timeout' })
  persistence.beforeWrite = undefined
  writing.resolve()
  await vi.waitFor(() => expect(afterWrite).toHaveBeenCalledTimes(2))
  expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: false })
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
  expect(lifetime.snapshot().stopping).toBe(true)
  expect(stop).not.toHaveBeenCalled()
})

it('passes only the remaining original budget after a slow durable stop write', async () => {
  const { lifetime, stop } = await fixture()
  lifetime.connect('app', 'socket')
  vi.useFakeTimers()
  const deadlineAt = Date.now() + 200
  const writing = Promise.withResolvers<void>()
  persistence.beforeWrite = () => writing.promise
  const stopping = lifetime.stop(true, 'user-stop', deadlineAt)
  await vi.advanceTimersByTimeAsync(80)
  writing.resolve()
  await stopping
  expect(stop).toHaveBeenCalledWith('user-stop', deadlineAt)
  expect(deadlineAt - Date.now()).toBe(120)
})

it('does not execute an expired stop queued behind another durable mutation', async () => {
  const { lifetime, stop } = await fixture()
  lifetime.connect('app', 'socket')
  vi.useFakeTimers()
  const writing = Promise.withResolvers<void>()
  persistence.beforeWrite = () => writing.promise
  const start = lifetime.start()
  const stopping = lifetime.stop(true, 'user-stop', Date.now() + 50)
  const result = expect(stopping).rejects.toMatchObject({ code: 'service-stop-intent-timeout' })
  await vi.advanceTimersByTimeAsync(50)
  await result
  writing.resolve()
  await start
  await vi.advanceTimersByTimeAsync(0)
  expect(stop).not.toHaveBeenCalled()
  expect(lifetime.snapshot()).toMatchObject({ explicit: true, stopping: false })
})

it('retires the generation after a failed published stop even when disk compensation succeeds', async () => {
  const { lifetime, stop, configRoot, options } = await fixture()
  lifetime.connect('a', 'socket-a')
  const compensation = Promise.withResolvers<void>()
  const failure = Object.assign(new Error('directory sync failed after rename'), { code: 'EIO' })
  persistence.beforeWrite = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => compensation.promise)
  persistence.afterWrite = vi.fn().mockRejectedValueOnce(failure)
  await expect(lifetime.leave('a', 'socket-a')).rejects.toBe(failure)
  expect(await readServiceLifetime(configRoot)).toMatchObject({
    stopping: true,
    reason: 'app-exit'
  })
  expect(lifetime.snapshot()).toMatchObject({ stopping: true, apps: 1 })
  expect(options.onStoppingAdmission).toHaveBeenCalledOnce()
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stop intent')
  await expect(lifetime.start()).rejects.toThrow('stop intent')
  expect(stop).not.toHaveBeenCalled()
  compensation.resolve()
  await vi.waitFor(async () =>
    expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: false })
  )
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
  await expect(lifetime.start()).rejects.toThrow('stopping')
  expect(stop).not.toHaveBeenCalled()
  await lifetime.stop()
  expect(stop).toHaveBeenCalledOnce()
  expect(options.onStoppingAdmission).toHaveBeenCalledOnce()
  lifetime.close()
  const replacement = await createLocalServiceLifetime({
    ...options,
    generation: randomUUID(),
    explicitStart: false
  })
  lifetimes.push(replacement)
  replacement.connect('b', 'socket-b')
  await replacement.start()
  expect(replacement.snapshot()).toMatchObject({ stopping: false, explicit: true, apps: 1 })
})

it('keeps the fence and original failure when compensation of a published stop also fails', async () => {
  const { lifetime, stop, configRoot, options } = await fixture()
  lifetime.connect('a', 'socket-a')
  const original = new Error('directory sync failed after publishing stop')
  const rollback = new Error('compensation could not be written')
  persistence.beforeWrite = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(rollback)
  persistence.afterWrite = vi.fn().mockRejectedValueOnce(original)
  await expect(lifetime.leave('a', 'socket-a')).rejects.toBe(original)
  await vi.waitFor(() => expect(options.report).toHaveBeenCalledWith(rollback))
  expect(await readServiceLifetime(configRoot)).toMatchObject({ stopping: true })
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stop intent')
  await expect(lifetime.start()).rejects.toThrow('stop intent')
  expect(stop).not.toHaveBeenCalled()
  persistence.beforeWrite = undefined
  persistence.afterWrite = undefined
  await lifetime.stop()
  expect(stop).toHaveBeenCalledWith('user-stop', expect.any(Number))
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
})

it.each([false, true])(
  'durably retries an uncertain ordinary stop with force=%s after compensation fails',
  async (force) => {
    const { lifetime, stop, configRoot, options } = await fixture(true)
    lifetime.connect('a', 'socket-a')
    const rollback = new Error('compensation EIO')
    const beforeWrite = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(rollback)
    persistence.beforeWrite = beforeWrite
    persistence.afterWrite = vi
      .fn()
      .mockRejectedValueOnce(new Error('revoke EIO after publication'))
    await expect(lifetime.stop()).rejects.toThrow('revoke EIO')
    await vi.waitFor(() => expect(options.report).toHaveBeenCalledWith(rollback))
    expect(await readServiceLifetime(configRoot)).toMatchObject({
      explicit: false,
      stopping: false
    })
    expect(lifetime.snapshot()).toMatchObject({ explicit: true, stopping: false, apps: 1 })
    // Leaving an explicitly held service would not write anything, so it cannot repair uncertainty.
    await expect(lifetime.leave('a', 'socket-a')).rejects.toMatchObject({
      code: 'service-stop-intent-timeout'
    })
    expect(lifetime.snapshot().apps).toBe(1)
    expect(beforeWrite).toHaveBeenCalledTimes(2)
    expect(() => lifetime.connect('b', 'socket-b')).toThrow('stop intent')
    await expect(lifetime.start()).rejects.toThrow('stop intent')
    const retryWriting = Promise.withResolvers<void>()
    beforeWrite.mockImplementationOnce(() => retryWriting.promise)
    const retry = lifetime.stop(force)
    await vi.waitFor(() => expect(beforeWrite).toHaveBeenCalledTimes(3))
    // Settlement alone does not reopen admission while the repairing write remains in flight.
    expect(() => lifetime.connect('b', 'socket-b')).toThrow()
    retryWriting.resolve()
    await retry
    expect(await readServiceLifetime(configRoot)).toMatchObject({
      explicit: false,
      stopping: force
    })
    expect(lifetime.snapshot()).toMatchObject({ explicit: false, stopping: force, apps: 1 })
    if (force) {
      expect(stop).toHaveBeenCalledExactlyOnceWith('user-stop', expect.any(Number))
      expect(options.onStoppingAdmission).toHaveBeenCalledOnce()
      expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
    } else {
      expect(stop).not.toHaveBeenCalled()
      expect(options.onStoppingAdmission).not.toHaveBeenCalled()
      lifetime.connect('b', 'socket-b')
    }
  }
)

it('bounds an ordinary stop retry behind unsettled reconciliation before starting a new write', async () => {
  const { lifetime, stop, options } = await fixture(true)
  lifetime.connect('a', 'socket-a')
  const compensation = Promise.withResolvers<void>()
  const beforeWrite = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => compensation.promise)
  persistence.beforeWrite = beforeWrite
  persistence.afterWrite = vi.fn().mockRejectedValueOnce(new Error('revoke EIO after publication'))
  await expect(lifetime.stop()).rejects.toThrow('revoke EIO')
  await vi.waitFor(() => expect(beforeWrite).toHaveBeenCalledTimes(2))
  vi.useFakeTimers()
  const retry = lifetime.stop(true, 'user-stop', Date.now() + 50)
  const rejected = expect(retry).rejects.toMatchObject({ code: 'service-stop-intent-timeout' })
  await vi.advanceTimersByTimeAsync(50)
  await rejected
  expect(beforeWrite).toHaveBeenCalledTimes(2)
  expect(stop).not.toHaveBeenCalled()
  expect(options.onStoppingAdmission).not.toHaveBeenCalled()
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stop intent')
  compensation.reject(new Error('compensation EIO'))
  await vi.waitFor(() => expect(options.report).toHaveBeenCalledOnce())
  await lifetime.stop(true)
  expect(beforeWrite).toHaveBeenCalledTimes(3)
  expect(stop).toHaveBeenCalledOnce()
})

it('bounds explicit stop retries behind in-flight compensation without reopening admission', async () => {
  const { lifetime, stop } = await fixture()
  lifetime.connect('a', 'socket-a')
  vi.useFakeTimers()
  const compensation = Promise.withResolvers<void>()
  persistence.beforeWrite = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => compensation.promise)
  persistence.afterWrite = vi.fn().mockRejectedValueOnce(new Error('published stop sync failed'))
  await expect(lifetime.leave('a', 'socket-a')).rejects.toThrow('sync failed')
  const retried = lifetime.stop(true, 'user-stop', Date.now() + 50)
  const rejected = expect(retried).rejects.toMatchObject({ code: 'service-stop-intent-timeout' })
  await vi.advanceTimersByTimeAsync(50)
  await rejected
  expect(stop).not.toHaveBeenCalled()
  expect(() => lifetime.connect('b', 'socket-b')).toThrow()
  compensation.resolve()
  await lifetime.stop(true)
  expect(stop).toHaveBeenCalledOnce()
  expect(() => lifetime.connect('b', 'socket-b')).toThrow('stopping')
})
