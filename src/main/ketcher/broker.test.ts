import { describe, it, expect, vi } from 'vitest'

import { KetcherBroker } from './broker'

// Builds a broker with a captured send spy and manual timers so timeouts are deterministic.
const createBroker = (options?: {
  timeoutMs?: number
  mountTimeoutMs?: number
}): {
  broker: KetcherBroker
  send: ReturnType<typeof vi.fn>
  fireTimers: () => void
} => {
  const send = vi.fn()
  let nextId = 0
  const timers = new Map<number, () => void>()
  let timerSeq = 0

  const broker = new KetcherBroker({
    send,
    generateId: () => `req-${++nextId}`,
    timeoutMs: options?.timeoutMs ?? 1000,
    mountTimeoutMs: options?.mountTimeoutMs ?? 1000,
    setTimer: (fn) => {
      const handle = ++timerSeq
      timers.set(handle, fn)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number)
    }
  })

  // Fires every armed timer, simulating the deadline elapsing.
  const fireTimers = (): void => {
    for (const [handle, fn] of [...timers.entries()]) {
      timers.delete(handle)
      fn()
    }
  }

  return { broker, send, fireTimers }
}

describe('KetcherBroker', () => {
  it('rejects a command when no tile is mounted', async () => {
    const { broker, send } = createBroker()

    await expect(broker.dispatch('art-1', 'set', { ket: '{}' })).rejects.toThrow(/not mounted/)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a command to a mounted tile and resolves with its reply', async () => {
    const { broker, send } = createBroker()
    broker.mount('art-1')

    const pending = broker.dispatch('art-1', 'get', { format: 'smiles' })

    expect(send).toHaveBeenCalledWith('ketcher:command', {
      requestId: 'req-1',
      artifactId: 'art-1',
      op: 'get',
      payload: { format: 'smiles' }
    })

    broker.reply({ requestId: 'req-1', result: 'CCO' })
    await expect(pending).resolves.toBe('CCO')
  })

  it('rejects a command whose reply carries an error', async () => {
    const { broker } = createBroker()
    broker.mount('art-1')

    const pending = broker.dispatch('art-1', 'set', { ket: 'bad' })
    broker.reply({ requestId: 'req-1', error: 'parse failed' })

    await expect(pending).rejects.toThrow(/parse failed/)
  })

  it('rejects a command that is never answered before the timeout', async () => {
    const { broker, fireTimers } = createBroker()
    broker.mount('art-1')

    const pending = broker.dispatch('art-1', 'highlight', { atoms: [0] })
    fireTimers()

    await expect(pending).rejects.toThrow(/timed out/)
    // A late reply after timeout is ignored (no unhandled rejection).
    broker.reply({ requestId: 'req-1', result: 'late' })
  })

  it('isMounted reflects mount/unmount', () => {
    const { broker } = createBroker()
    expect(broker.isMounted('art-1')).toBe(false)
    broker.mount('art-1')
    expect(broker.isMounted('art-1')).toBe(true)
    broker.unmount('art-1')
    expect(broker.isMounted('art-1')).toBe(false)
  })

  it('waitForMount resolves immediately when already mounted', async () => {
    const { broker } = createBroker()
    broker.mount('art-1')
    await expect(broker.waitForMount('art-1')).resolves.toBeUndefined()
  })

  it('waitForMount resolves once the tile mounts', async () => {
    const { broker } = createBroker()
    const pending = broker.waitForMount('art-1')
    broker.mount('art-1')
    await expect(pending).resolves.toBeUndefined()
  })

  it('waitForMount rejects when the tile never mounts', async () => {
    const { broker, fireTimers } = createBroker()
    const pending = broker.waitForMount('art-1')
    fireTimers()
    await expect(pending).rejects.toThrow(/did not mount/)
  })

  it('openTile pushes a ketcher:open event', () => {
    const { broker, send } = createBroker()
    broker.openTile({
      artifactId: 'art-1',
      sessionId: 's-1',
      path: '/tmp/a.ket',
      name: 'a.ket',
      content: ''
    })
    expect(send).toHaveBeenCalledWith('ketcher:open', {
      artifactId: 'art-1',
      sessionId: 's-1',
      path: '/tmp/a.ket',
      name: 'a.ket',
      content: ''
    })
  })
})
