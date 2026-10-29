import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopRuntimeRestartAllowed,
  createDesktopRuntimeRecovery
} from './desktop-runtime-recovery'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { ServiceLifetimeRecord } from './local-service-lifetime'
import { DesktopBackendStartupError } from './backend-startup'

vi.mock('./runtime-stop-confirmation', () => ({ isRuntimeProcessAlive: vi.fn(() => true) }))
import { isRuntimeProcessAlive } from './runtime-stop-confirmation'
const client = (pid = 7, owned = false): DesktopRuntimeClient =>
  ({
    processId: () => pid,
    ownsRuntime: () => owned,
    runtimeInfo: () => ({ generation: 'test-generation' }),
    close: vi.fn()
  }) as unknown as DesktopRuntimeClient
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(isRuntimeProcessAlive).mockReturnValue(true)
})
describe('same-backend desktop recovery', () => {
  it('deduplicates concurrent attempts, waits for reconciliation, ignores old disconnects', async () => {
    const old = client()
    const next = client()
    const hydration = deferred<void>()
    const connect = vi.fn(async () => next)
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect,
      activate: async (_client, _signal, announce) => {
        announce()
        await hydration.promise
      },
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const a = recovery.reconnect()
    const b = recovery.reconnect()
    expect(a).toBe(b)
    await vi.waitFor(() => expect(recovery.state().phase).toBe('reconciling'))
    hydration.resolve()
    await a
    recovery.disconnect(old)
    expect(recovery.state().phase).toBe('connected')
    expect(connect).toHaveBeenCalledTimes(1)
  })
  it('preserves owned authority only while the original retained child is alive', async () => {
    const old = client(7, true)
    const child = {
      pid: 7,
      exitCode: null,
      signalCode: null
    } as unknown as import('node:child_process').ChildProcess
    const next = client(7, true)
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      startedProcess: child,
      connect: async () => next,
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    await recovery.reconnect()
    expect(recovery.state().phase).toBe('connected')
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    recovery.disconnect(next)
    expect(recovery.state().phase).toBe('unavailable')
  })
  it('rejects a replacement generation even when the PID is reused', async () => {
    const old = client()
    const next = client(7, true)
    Object.assign(next, { runtimeInfo: () => ({ generation: 'replacement' }) })
    const activate = vi.fn()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => next,
      activate,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    await recovery.reconnect()
    expect(recovery.state().phase).toBe('unavailable')
    expect(activate).not.toHaveBeenCalled()
  })
  it('refuses an authenticated replacement PID without acquiring lifecycle authority', async () => {
    const old = client()
    const replacement = client(8)
    const activate = vi.fn()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => replacement,
      activate,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    await recovery.reconnect()
    expect(recovery.state().phase).toBe('unavailable')
    expect(replacement.close).toHaveBeenCalledOnce()
    expect(activate).not.toHaveBeenCalled()
  })
  it('reconnects a healthy service before considering residual repair', async () => {
    const old = client(7, true)
    const repair = vi.fn()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => client(7, true),
      repair,
      activate: vi.fn(async () => undefined),
      onState: vi.fn()
    })
    recovery.disconnect(old)
    await recovery.reconnect()
    expect(repair).not.toHaveBeenCalled()
    expect(recovery.state().phase).toBe('connected')
  })

  it('does not let retirement of the original process cancel its explicit repair', async () => {
    const old = client(7, true)
    const next = client(8, true)
    const replacement = deferred<DesktopRuntimeClient>()
    const repair = vi.fn(() => replacement.promise)
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => {
        throw new Error('ENOENT')
      },
      repair,
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const attempt = recovery.reconnect()
    await vi.waitFor(() => expect(repair).toHaveBeenCalledOnce())
    vi.mocked(isRuntimeProcessAlive).mockImplementation((pid) => pid === 8)
    recovery.disconnect(old)
    replacement.resolve(next)
    await attempt
    expect(recovery.state().phase).toBe('connected')
    recovery.disconnect(old)
    expect(recovery.state().phase).toBe('connected')
    recovery.disconnect(next)
    expect(recovery.state().phase).toBe('disconnected')
  })

  it('bounds a hung connection and closes its late result', async () => {
    vi.useFakeTimers()
    const old = client()
    const next = client()
    const connection = deferred<DesktopRuntimeClient>()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: () => connection.promise,
      activate: vi.fn(),
      onState: vi.fn(),
      timeoutMs: 100
    })
    recovery.disconnect(old)
    const result = recovery.reconnect()
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(recovery.state().phase).toBe('disconnected')
    connection.resolve(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(next.close).toHaveBeenCalledOnce()
  })
  it('cancels an unanswered control refresh and ignores its late reply', async () => {
    const old = client()
    const next = client()
    const refresh = deferred<ReturnType<DesktopRuntimeClient['runtimeInfo']>>()
    const refreshControl = vi.fn(() => refresh.promise)
    Object.assign(next, {
      runtimeInfo: () => ({ generation: 'test-generation', controlReason: 'operation-pending' }),
      refreshControl
    })
    const activate = vi.fn()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => next,
      activate,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const result = recovery.reconnect()
    await vi.waitFor(() => expect(refreshControl).toHaveBeenCalledOnce())
    recovery.setClosing(true)
    await result
    expect(next.close).toHaveBeenCalledOnce()
    expect(recovery.state()).toMatchObject({ phase: 'disconnected', closing: true })
    Object.assign(next, {
      runtimeInfo: () => ({ generation: 'test-generation', control: 'granted' })
    })
    refresh.resolve(next.runtimeInfo())
    await Promise.resolve()
    expect(activate).not.toHaveBeenCalled()
  })
  it('retains a mid-quit disconnect and resumes automatic recovery only after canceled quit', async () => {
    vi.useFakeTimers()
    const old = client()
    const next = client()
    const connect = vi.fn(async () => next)
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect,
      automatic: true,
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.setClosing(true)
    recovery.disconnect(old)
    await recovery.reconnect()
    await vi.advanceTimersByTimeAsync(1000)
    expect(connect).not.toHaveBeenCalled()
    expect(recovery.state()).toMatchObject({ closing: true, reason: 'connection-lost' })
    expect(recovery.state().phase).not.toBe('connected')
    recovery.setClosing(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(connect).toHaveBeenCalledOnce()
    expect(recovery.state()).toMatchObject({ phase: 'connected', closing: false })
  })
  it('cancels hung activation on quit and allows another attempt after canceled quit', async () => {
    const old = client()
    const next = client()
    const hydration = deferred<void>()
    const activate = vi.fn(() => hydration.promise)
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => next,
      activate,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const result = recovery.reconnect()
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce())
    recovery.setClosing(true)
    await result
    expect(next.close).toHaveBeenCalledOnce()
    expect(recovery.state().closing).toBe(true)
    recovery.setClosing(false)
    expect(recovery.state()).toMatchObject({ phase: 'disconnected', closing: false })
  })
  it('does not announce connected after candidate disconnects during hydration', async () => {
    const old = client()
    const next = client()
    const hydration = deferred<void>()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => next,
      activate: (_client, _signal, announce) => {
        announce()
        return hydration.promise
      },
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const result = recovery.reconnect()
    await vi.waitFor(() => expect(recovery.state().phase).toBe('reconciling'))
    recovery.disconnect(next)
    hydration.resolve()
    await result
    expect(recovery.state().phase).toBe('disconnected')
  })
})

describe('reconciliation event buffer', () => {
  it('drops an in-flight Session snapshot when its deletion arrives before replay finishes', async () => {
    const { createDesktopRecoveryEventBuffer } = await import('./desktop-recovery-event-buffer')
    const buffer = createDesktopRecoveryEventBuffer()
    const snapshot = deferred<unknown>()
    const deliver = vi.fn()
    buffer.push({
      channel: 'session:updated',
      payload: {
        kind: 'session-invalidation',
        projectId: 'p',
        sessionId: 's',
        revision: 1,
        originClientId: 'other'
      }
    })
    const replay = buffer.drain({
      load: () => snapshot.promise,
      deliver,
      signal: new AbortController().signal
    })
    buffer.push({ channel: 'session:deleted', payload: { projectId: 'p', sessionId: 's' } })
    snapshot.resolve({ id: 's', projectId: 'p', revision: 1 })
    await replay
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      channel: 'session:deleted',
      payload: { projectId: 'p', sessionId: 's' }
    })
  })

  it('cancels replay without installing a late snapshot and can begin a new recovery', async () => {
    const { createDesktopRecoveryEventBuffer } = await import('./desktop-recovery-event-buffer')
    const buffer = createDesktopRecoveryEventBuffer()
    const snapshot = deferred<unknown>()
    const deliver = vi.fn()
    const controller = new AbortController()
    buffer.push({
      channel: 'session:updated',
      payload: {
        kind: 'session-invalidation',
        projectId: 'p',
        sessionId: 's',
        revision: 1,
        originClientId: 'other'
      }
    })
    const replay = buffer.drain({
      load: () => snapshot.promise,
      deliver,
      signal: controller.signal
    })
    const outcome = expect(replay).rejects.toThrow('canceled')
    controller.abort()
    await outcome
    snapshot.resolve({ id: 's', projectId: 'p', revision: 1 })
    buffer.clear()
    buffer.push({ channel: 'project:created', payload: { id: 'p' } })
    await buffer.drain({ load: vi.fn(), deliver, signal: new AbortController().signal })
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      channel: 'project:created',
      payload: { id: 'p' }
    })
  })
})

describe('automatic recovery rounds', () => {
  it.each([false, true])(
    'never authorizes a stop committed after reconnecting a live generation (quit canceled: %s)',
    async (cancelQuit) => {
      vi.useFakeTimers()
      const original = client()
      const next = {
        ...client(8),
        runtimeInfo: () => ({ generation: 'replacement-b' })
      } as unknown as DesktopRuntimeClient
      let alive = true
      vi.mocked(isRuntimeProcessAlive).mockImplementation(() => alive)
      const lifetime = { intent: undefined as ServiceLifetimeRecord | undefined }
      const pendingReview = deferred<ServiceLifetimeRecord | undefined>()
      const reviewRestart = vi.fn(() => pendingReview.promise)
      const connection = deferred<DesktopRuntimeClient>()
      const launch = vi.fn(async () => {
        alive = true
        return next
      })
      const recovery = createDesktopRuntimeRecovery({
        client: original,
        automatic: true,
        reviewRestart,
        connect: () => connection.promise,
        restart: async (_signal, authorization) => {
          assertDesktopRuntimeRestartAllowed(lifetime.intent, authorization, false)
          return launch()
        },
        activate: async () => undefined,
        onState: vi.fn()
      })
      recovery.disconnect(original)
      const first = recovery.reconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(reviewRestart).not.toHaveBeenCalled()
      lifetime.intent = {
        version: 1,
        generation: 'test-generation',
        explicit: false,
        stopping: true,
        reason: 'user-stop'
      }
      alive = false
      if (cancelQuit) recovery.setClosing(true)
      connection.resolve(original)
      pendingReview.resolve(lifetime.intent)
      await first
      if (cancelQuit) recovery.setClosing(false)
      await vi.advanceTimersByTimeAsync(300)
      expect(launch).not.toHaveBeenCalled()
      expect(recovery.state()).toMatchObject({ phase: 'unavailable', reason: 'service-stopped' })
      await recovery.reconnect()
      expect(reviewRestart).toHaveBeenCalledWith('test-generation')
      expect(launch).toHaveBeenCalledOnce()
      expect(recovery.state().phase).toBe('connected')
      recovery.setClosing(true)
    }
  )

  it('does not renew a manual restart authorization after the replacement is force-stopped during hydration', async () => {
    vi.useFakeTimers()
    const original = client(7)
    const replacement = {
      ...client(8),
      runtimeInfo: () => ({ generation: 'replacement-b' })
    } as unknown as DesktopRuntimeClient
    const later = {
      ...client(9),
      runtimeInfo: () => ({ generation: 'replacement-c' })
    } as unknown as DesktopRuntimeClient
    const alive = new Set<number>()
    vi.mocked(isRuntimeProcessAlive).mockImplementation((pid) => alive.has(pid))
    let intent: ServiceLifetimeRecord = {
      version: 1,
      generation: 'test-generation',
      explicit: false,
      stopping: true,
      reason: 'user-stop'
    }
    const readIntent = vi.fn(async () => ({ ...intent }))
    const reviewRestart = vi.fn(async (generation: string) => {
      const reviewed = await readIntent()
      return reviewed.stopping && reviewed.generation === generation ? reviewed : undefined
    })
    const launch = vi.fn(async () => {
      const candidate = launch.mock.calls.length === 1 ? replacement : later
      alive.add(candidate.processId())
      return candidate
    })
    const hydration = deferred<void>()
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      reviewRestart,
      connect: async () => replacement,
      restart: async (_signal, authorization) => {
        assertDesktopRuntimeRestartAllowed(await readIntent(), authorization, false)
        return launch()
      },
      activate: async (candidate, _signal, announce) => {
        announce()
        if (candidate === replacement) await hydration.promise
      },
      onState: vi.fn()
    })
    recovery.disconnect(original)
    const first = recovery.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(recovery.state()).toMatchObject({ phase: 'reconciling', generation: 'replacement-b' })
    intent = { ...intent, generation: 'replacement-b' }
    alive.delete(8)
    recovery.disconnect(replacement)
    await first
    await vi.advanceTimersByTimeAsync(300)
    expect(recovery.state()).toMatchObject({ phase: 'unavailable', reason: 'service-stopped' })
    expect(launch).toHaveBeenCalledOnce()
    expect(reviewRestart.mock.calls).toEqual([['test-generation']])
    // Only a second explicit click can review B's new stop record and authorize C.
    await recovery.reconnect()
    expect(reviewRestart.mock.calls).toEqual([['test-generation'], ['replacement-b']])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(recovery.state()).toMatchObject({
      phase: 'connected',
      restartedGeneration: 'replacement-c'
    })
    recovery.setClosing(true)
    hydration.resolve()
  })

  it('rejects a changed stop or committed update at the final launch check', () => {
    const reviewed: ServiceLifetimeRecord = {
      version: 1,
      generation: 'a',
      explicit: false,
      stopping: true,
      reason: 'user-stop'
    }
    expect(() => assertDesktopRuntimeRestartAllowed(reviewed, { ...reviewed }, false)).not.toThrow()
    expect(() =>
      assertDesktopRuntimeRestartAllowed({ ...reviewed, generation: 'b' }, reviewed, false)
    ).toThrow('intentionally stopped')
    expect(() => assertDesktopRuntimeRestartAllowed(reviewed, reviewed, true)).toThrow(
      'intentionally stopped'
    )
  })

  it('bounds an unanswered manual stop review and never launches from its late result', async () => {
    vi.useFakeTimers()
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    const original = client()
    const review = deferred<ServiceLifetimeRecord | undefined>()
    const restart = vi.fn()
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      timeoutMs: 100,
      reviewRestart: () => review.promise,
      restart,
      connect: vi.fn(),
      activate: vi.fn(),
      onState: vi.fn()
    })
    recovery.disconnect(original)
    const result = recovery.reconnect()
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(recovery.state().phase).toBe('unavailable')
    review.resolve({
      version: 1,
      generation: 'test-generation',
      explicit: false,
      stopping: true,
      reason: 'user-stop'
    })
    await Promise.resolve()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not reset the recovery deadline when a socket connects but synchronization hangs', async () => {
    vi.useFakeTimers()
    const original = client()
    const connect = vi.fn(async () => client())
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      timeoutMs: 1000,
      connect,
      activate: async (_candidate, _signal, announce) => {
        announce()
        await new Promise(() => undefined)
      },
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(1500)
    expect(recovery.state().phase).not.toBe('connected')
    const attempts = connect.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(connect).toHaveBeenCalledTimes(attempts)
    recovery.setClosing(true)
  })

  it('stops automatic restarts after the third proven process death', async () => {
    vi.useFakeTimers()
    const original = client()
    let latest = original
    let alive = true
    vi.mocked(isRuntimeProcessAlive).mockImplementation(() => alive)
    const restart = vi.fn(async () => {
      alive = true
      latest = {
        ...client(),
        runtimeInfo: () => ({ generation: `generation-${restart.mock.calls.length}` })
      } as unknown as DesktopRuntimeClient
      return latest
    })
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      restart,
      connect: async () => latest,
      activate: async () => undefined,
      onState: vi.fn()
    })
    for (let index = 0; index < 3; index++) {
      alive = false
      recovery.disconnect(latest)
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(restart).toHaveBeenCalledTimes(2)
    expect(recovery.state()).toMatchObject({ phase: 'unavailable', reason: 'crash-limit' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(restart).toHaveBeenCalledTimes(2)
    // The crash-limit branch throws before its first await. Its settled Promise must not
    // occupy the in-flight slot and prevent the user's new recovery round.
    await recovery.reconnect()
    expect(restart).toHaveBeenCalledTimes(3)
    expect(recovery.state().phase).toBe('connected')
    alive = false
    recovery.disconnect(latest)
    await vi.advanceTimersByTimeAsync(300)
    expect(restart).toHaveBeenCalledTimes(4)
    recovery.setClosing(true)
  })

  it('pauses repeated exited replacement launches and lets a manual retry start a new round', async () => {
    vi.useFakeTimers()
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    const original = client()
    const restart = vi.fn<() => Promise<DesktopRuntimeClient>>(async () => {
      throw new DesktopBackendStartupError('Backend exited.', 'credentials', true, '/logs')
    })
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      restart,
      connect: vi.fn(),
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(1000)
    expect(recovery.state()).toMatchObject({ phase: 'unavailable', reason: 'crash-limit' })
    expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({
      crashesInWindow: 1,
      failedStartsInWindow: 3
    })
    expect(restart).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(restart).toHaveBeenCalledTimes(3)

    const replacement = client(8)
    restart.mockImplementation(async () => {
      vi.mocked(isRuntimeProcessAlive).mockReturnValue(true)
      return replacement
    })
    await recovery.reconnect()
    expect(recovery.state().phase).toBe('connected')
    expect(restart).toHaveBeenCalledTimes(4)
    recovery.setClosing(true)
  })

  it('pauses a credential-blocked replacement with its safe startup diagnosis instead of retrying it', async () => {
    vi.useFakeTimers()
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    const original = client()
    const restart = vi.fn<() => Promise<DesktopRuntimeClient>>(async () => {
      throw new DesktopBackendStartupError(
        'PRIVATE exception text and credential contents',
        'credentials',
        true,
        '/PRIVATE/logs',
        {
          protocolVersion: 1,
          attemptId: 'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b',
          stage: 'credentials',
          kind: 'failed',
          code: 'credential-unavailable',
          reason: 'ciphertext-inventory-unavailable',
          diagnostic: {
            code: 'inventory-failed',
            source: 'cookies',
            stage: 'read-files',
            reason: 'operation-failed',
            systemCode: 'EBUSY'
          }
        }
      )
    })
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      restart,
      connect: vi.fn(),
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(300)
    const startupFailure = {
      stage: 'credentials',
      code: 'credential-unavailable',
      reason: 'ciphertext-inventory-unavailable',
      diagnostic: {
        code: 'inventory-failed',
        source: 'cookies',
        stage: 'read-files',
        reason: 'operation-failed',
        systemCode: 'EBUSY'
      }
    }
    expect(recovery.state()).toMatchObject({
      phase: 'unavailable',
      reason: 'startup-failed',
      startupFailure
    })
    expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({ startupFailure })
    expect(JSON.stringify(recovery.state())).not.toContain('PRIVATE')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(restart).toHaveBeenCalledOnce()
    restart.mockImplementation(async () => {
      vi.mocked(isRuntimeProcessAlive).mockReturnValue(true)
      return client(8)
    })
    await recovery.reconnect()
    expect(recovery.state()).toMatchObject({ phase: 'connected', startupFailure: undefined })
    recovery.setClosing(true)
  })

  it('counts failed replacement starts in every new manual recovery round', async () => {
    vi.useFakeTimers()
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    const original = client()
    const restart = vi.fn(async () => {
      throw new DesktopBackendStartupError('Replacement exited.', 'runtime', true, '/logs')
    })
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      restart,
      connect: vi.fn(),
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(1000)
    expect(recovery.state().reason).toBe('crash-limit')
    await recovery.reconnect()
    expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({
      crashesInWindow: 0,
      failedStartsInWindow: 1
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(recovery.state().reason).toBe('crash-limit')
    expect(restart).toHaveBeenCalledTimes(6)
    recovery.setClosing(true)
  })

  it.each(['attachment', 'synchronization', 'unconfirmed-start'] as const)(
    'does not count %s failures as exited replacement processes',
    async (failure) => {
      vi.useFakeTimers()
      const original = client()
      const next = client()
      const connect = vi.fn(async () => {
        if (failure === 'attachment') throw new Error('Connection unavailable.')
        return next
      })
      if (failure === 'unconfirmed-start') vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
      const recovery = createDesktopRuntimeRecovery({
        client: original,
        automatic: true,
        timeoutMs: 1000,
        connect,
        restart: async () => {
          throw new DesktopBackendStartupError('Still starting.', 'runtime', false, '/logs')
        },
        activate: async () => {
          throw new Error('Snapshot unavailable.')
        },
        onState: vi.fn()
      })
      recovery.disconnect(original)
      await vi.advanceTimersByTimeAsync(1500)
      expect(recovery.state().reason).toBe('recovery-timeout')
      expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({
        crashesInWindow: failure === 'unconfirmed-start' ? 1 : 0,
        failedStartsInWindow: 0
      })
      recovery.setClosing(true)
    }
  )

  it('does not count a canceled replacement or its late startup rejection', async () => {
    vi.useFakeTimers()
    vi.mocked(isRuntimeProcessAlive).mockReturnValue(false)
    const original = client()
    let rejectStart!: (error: Error) => void
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      restart: () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject
        }),
      connect: vi.fn(),
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(300)
    recovery.setClosing(true)
    await vi.advanceTimersByTimeAsync(0)
    rejectStart(new DesktopBackendStartupError('Canceled child exited.', 'runtime', true, '/logs'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({
      crashesInWindow: 1,
      failedStartsInWindow: 0
    })
    expect(recovery.state().startupFailure).toBeUndefined()
  })

  it('does not count a startup-classified activation failure after the replacement attaches', async () => {
    vi.useFakeTimers()
    let alive = false
    vi.mocked(isRuntimeProcessAlive).mockImplementation(() => alive)
    const original = client()
    const next = client(8)
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      timeoutMs: 1000,
      connect: async () => next,
      restart: async () => {
        alive = true
        return next
      },
      activate: async () => {
        throw new DesktopBackendStartupError(
          'Snapshot failed after attach.',
          'runtime',
          true,
          '/logs'
        )
      },
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(1500)
    expect(JSON.parse(recovery.state().diagnostics!)).toMatchObject({
      crashesInWindow: 1,
      failedStartsInWindow: 0
    })
    recovery.setClosing(true)
  })

  it('bounds repeated synchronous connection failures and gives manual retry a new budget', async () => {
    vi.useFakeTimers()
    const original = client()
    const connect = vi.fn<() => Promise<DesktopRuntimeClient>>(() => {
      throw new Error('connection refused')
    })
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      timeoutMs: 1000,
      connect,
      activate: async () => undefined,
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(2000)
    expect(recovery.state()).toMatchObject({ phase: 'disconnected', reason: 'recovery-timeout' })
    const count = connect.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(connect).toHaveBeenCalledTimes(count)
    connect.mockImplementation(async () => client())
    await recovery.reconnect()
    expect(recovery.state().phase).toBe('connected')
    recovery.setClosing(true)
  })

  it('resumes a canceled quit within the existing recovery budget', async () => {
    vi.useFakeTimers()
    const original = client()
    let next = client()
    const connect = vi.fn(async () => next)
    let syncing = true
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      timeoutMs: 1000,
      connect,
      activate: async () => {
        if (syncing) await new Promise(() => undefined)
      },
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(300)
    recovery.setClosing(true)
    await vi.advanceTimersByTimeAsync(100)
    syncing = false
    next = client()
    recovery.setClosing(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(recovery.state().phase).toBe('connected')
    expect(connect).toHaveBeenCalledTimes(2)
    recovery.setClosing(true)
  })

  it('does not grant a new deadline when quit cancellation comes after budget expiry', async () => {
    vi.useFakeTimers()
    const original = client()
    const connect = vi.fn(async () => client())
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      timeoutMs: 1000,
      connect,
      activate: async () => new Promise(() => undefined),
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(300)
    recovery.setClosing(true)
    await vi.advanceTimersByTimeAsync(1000)
    recovery.setClosing(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(recovery.state()).toMatchObject({ phase: 'disconnected', reason: 'recovery-timeout' })
    expect(connect).toHaveBeenCalledTimes(1)
    recovery.setClosing(true)
  })

  it('retains restart evidence until a later socket completes synchronization', async () => {
    vi.useFakeTimers()
    const original = client()
    const next = {
      ...client(8),
      runtimeInfo: () => ({ generation: 'new-generation' })
    } as unknown as DesktopRuntimeClient
    let alive = false
    vi.mocked(isRuntimeProcessAlive).mockImplementation(() => alive)
    let syncFails = true
    const recovery = createDesktopRuntimeRecovery({
      client: original,
      automatic: true,
      connect: async () => next,
      restart: async () => {
        alive = true
        return next
      },
      activate: async () => {
        if (syncFails) {
          syncFails = false
          throw new Error('snapshot failed')
        }
      },
      onState: vi.fn()
    })
    recovery.disconnect(original)
    await vi.advanceTimersByTimeAsync(600)
    expect(recovery.state()).toMatchObject({
      phase: 'connected',
      restartedGeneration: 'new-generation'
    })
    recovery.setClosing(true)
  })
})
