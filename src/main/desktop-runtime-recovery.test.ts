import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopRuntimeRecovery } from './desktop-runtime-recovery'
import type { DesktopRuntimeClient } from './desktop-runtime-client'

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
    await Promise.resolve()
    expect(next.close).toHaveBeenCalledOnce()
  })
  it('cancels hung activation on quit and allows another attempt after canceled quit', async () => {
    const old = client()
    const next = client()
    const hydration = deferred<void>()
    const recovery = createDesktopRuntimeRecovery({
      client: old,
      connect: async () => next,
      activate: () => hydration.promise,
      onState: vi.fn()
    })
    recovery.disconnect(old)
    const result = recovery.reconnect()
    await Promise.resolve()
    await Promise.resolve()
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
