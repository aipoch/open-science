import { afterEach, expect, it, vi } from 'vitest'
const generation = '7497bc2a-2636-44b5-82af-126739debe64'
const state = vi.hoisted(() => ({
  alive: true,
  birth: 'verified-birth',
  intent: {
    version: 1 as const,
    generation: '7497bc2a-2636-44b5-82af-126739debe64',
    explicit: false,
    stopping: true
  },
  read: vi.fn<() => Promise<unknown>>(),
  syncRead: vi.fn<() => string>()
}))
vi.mock('./process-birth-identity', () => ({ processBirthIdentity: () => state.birth }))
vi.mock('./local-service-lifetime', async (original) => ({
  ...(await original<typeof import('./local-service-lifetime')>()),
  readServiceLifetime: () => state.read()
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: () => state.syncRead()
}))
vi.mock('./runtime-stop-confirmation', () => ({ isRuntimeProcessAlive: () => state.alive }))
import { terminateVerifiedService } from './verified-service-stop'
const target = {
  configRoot: '/isolated-fixture',
  generation,
  pid: 987654,
  birthToken: 'verified-birth'
}
state.read.mockImplementation(async () => ({ ...state.intent }))
state.syncRead.mockImplementation(() => JSON.stringify(state.intent))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  state.alive = true
  state.birth = 'verified-birth'
  state.intent = { version: 1, generation, explicit: false, stopping: true }
  state.read.mockReset().mockImplementation(async () => ({ ...state.intent }))
  state.syncRead.mockReset().mockImplementation(() => JSON.stringify(state.intent))
})
it.each(['birth', 'generation', 'intent'] as const)(
  'refuses termination when the %s proof changed',
  async (proof) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    if (proof === 'birth') state.birth = 'reused-pid'
    if (proof === 'generation') state.intent.generation = 'replacement'
    if (proof === 'intent') state.intent.stopping = false
    await expect(terminateVerifiedService(target)).rejects.toThrow()
    expect(kill).not.toHaveBeenCalled()
  }
)
it('signals only the authenticated process and stops once it exits', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    state.alive = false
    return true
  })
  await terminateVerifiedService(target)
  expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
})
it('rechecks birth identity before escalating an unresponsive process', async () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    state.birth = 'replacement'
    return true
  })
  const stopped = terminateVerifiedService(target)
  const rejected = expect(stopped).rejects.toThrow('identity changed')
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
})
it.each(['SIGTERM', 'SIGKILL'] as const)(
  'refuses %s if the PID is reused during its final synchronous intent read',
  async (signal) => {
    vi.useFakeTimers()
    let reads = 0
    state.syncRead.mockImplementation(() => {
      if (++reads === (signal === 'SIGTERM' ? 1 : 2)) state.birth = 'replacement'
      return JSON.stringify(state.intent)
    })
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const stopped = terminateVerifiedService(target)
    const rejected = expect(stopped).rejects.toThrow('identity changed')
    await vi.advanceTimersByTimeAsync(500)
    await rejected
    if (signal === 'SIGTERM') expect(kill).not.toHaveBeenCalled()
    else expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
  }
)
it('refuses a delayed asynchronous precheck after current disk authorization was revoked', async () => {
  const captured = { ...state.intent }
  const delayed = Promise.withResolvers<unknown>()
  state.read.mockReturnValueOnce(delayed.promise)
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const stopped = terminateVerifiedService(target)
  const rejected = expect(stopped).rejects.toThrow('intent changed')
  state.intent.stopping = false
  delayed.resolve(captured)
  await rejected
  expect(state.syncRead).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
})
it('rechecks the current durable grant again before SIGKILL', async () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    state.intent.stopping = false
    return true
  })
  const stopped = terminateVerifiedService(target)
  const rejected = expect(stopped).rejects.toThrow('intent changed')
  await vi.advanceTimersByTimeAsync(500)
  await rejected
  expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
  expect(state.syncRead).toHaveBeenCalledTimes(2)
})
it('honors cancellation during TERM grace before issuing SIGKILL', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const reason = new Error('observation cancelled')
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const stopped = terminateVerifiedService({ ...target, signal: controller.signal })
  const rejected = expect(stopped).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(0)
  expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
  controller.abort(reason)
  await vi.advanceTimersByTimeAsync(25)
  await rejected
  expect(kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM')
})
it.each(['deadline', 'abort', 'abort-only'] as const)(
  'bounds a pending authorization read by %s and ignores its late valid grant',
  async (boundary) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cancelled = new Error('authorization read cancelled')
    const delayed = Promise.withResolvers<unknown>()
    state.read.mockReturnValueOnce(delayed.promise)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const stopped = terminateVerifiedService({
      ...target,
      signal: controller.signal,
      deadlineAt: boundary === 'abort-only' ? undefined : Date.now() + 50
    })
    const outcome = stopped.then(
      () => ({ resolved: true, error: undefined }),
      (error: unknown) => ({ resolved: false, error })
    )
    if (boundary !== 'deadline') {
      await vi.advanceTimersByTimeAsync(10)
      controller.abort(cancelled)
    } else await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(0)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    const result = await outcome
    expect(result.resolved).toBe(false)
    if (boundary !== 'deadline') expect(result.error).toBe(cancelled)
    else
      expect(result.error).toMatchObject({
        message: 'The local service termination deadline expired.'
      })
    expect(vi.getTimerCount()).toBe(0)
    expect(state.syncRead).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    delayed.resolve({ ...state.intent })
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.syncRead).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  }
)
it('does not start an authorization read after its deadline or cancellation', async () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  await expect(terminateVerifiedService({ ...target, deadlineAt: Date.now() })).rejects.toThrow(
    'deadline expired'
  )
  const controller = new AbortController()
  const cancelled = new Error('already cancelled')
  controller.abort(cancelled)
  await expect(terminateVerifiedService({ ...target, signal: controller.signal })).rejects.toBe(
    cancelled
  )
  expect(state.read).not.toHaveBeenCalled()
  expect(state.syncRead).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})
it('clears the authorization deadline when the read rejects', async () => {
  vi.useFakeTimers()
  const failure = new Error('authorization unavailable')
  state.read.mockRejectedValueOnce(failure)
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  await expect(terminateVerifiedService({ ...target, deadlineAt: Date.now() + 5000 })).rejects.toBe(
    failure
  )
  expect(vi.getTimerCount()).toBe(0)
  expect(kill).not.toHaveBeenCalled()
})
it('allows an authenticated TERM and KILL after its bounded authorization read succeeds', async () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const stopped = terminateVerifiedService({ ...target, deadlineAt: Date.now() + 20_000 })
  await vi.advanceTimersByTimeAsync(500)
  await expect(stopped).resolves.toBeUndefined()
  expect(kill.mock.calls).toEqual([
    [target.pid, 'SIGTERM'],
    [target.pid, 'SIGKILL']
  ])
  expect(state.syncRead).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
