import { describe, expect, it, vi } from 'vitest'

import { CredentialRequestBroker } from './credential-request-broker'

describe('CredentialRequestBroker', () => {
  it.each(['session-1', undefined])(
    'does not replay another credential prompt after Not now in %s',
    async (sessionId) => {
      let sequence = 0
      const replay = vi.fn()
      const broadcast = vi.fn()
      const broker = new CredentialRequestBroker({
        generateId: () => `credential-${++sequence}`,
        broadcast,
        replay
      })
      const info = {
        credentialId: 'openalex' as const,
        connector: 'literature',
        method: 'openalex_search_works',
        sessionId
      }
      const first = broker.request(info)
      const second = broker.request({ ...info, method: 'openalex_get_work' })
      try {
        broker.respond('credential-1', false)
        await expect(first).resolves.toBe(false)
        broker.replayPending()
        expect(replay).not.toHaveBeenCalled()
        await expect(second).resolves.toBe(false)
        await expect(broker.request({ ...info, method: 'openalex_get_author' })).resolves.toBe(
          false
        )
        expect(broadcast).toHaveBeenCalledTimes(2)
        expect(sequence).toBe(2)
      } finally {
        broker.cancelAll()
      }
    }
  )

  it('keeps other sessions eligible after declining a group', async () => {
    let sequence = 0
    const onSettled = vi.fn()
    const broker = new CredentialRequestBroker({
      generateId: () => `credential-${++sequence}`,
      broadcast: vi.fn(),
      onSettled
    })
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works'
    }
    const controller = new AbortController()
    const calls = [
      broker.request({ ...info, sessionId: 'session-1' }, controller.signal),
      broker.request({ ...info, sessionId: 'session-1' }, controller.signal),
      broker.request({ ...info, sessionId: 'session-2' }),
      broker.request(info)
    ]
    try {
      broker.respond('credential-1', false)
      expect(onSettled.mock.calls).toEqual([
        ['credential-1', false],
        ['credential-2', false]
      ])
      expect(controller.signal.aborted).toBe(false)
      expect(broker.getPending('credential-3')).not.toBeNull()
      expect(broker.getPending('credential-4')).not.toBeNull()
      await expect(broker.request({ ...info, sessionId: 'session-1' })).resolves.toBe(false)
      calls.push(broker.request({ ...info, sessionId: 'session-3' }))
      expect(broker.getPending('credential-5')).not.toBeNull()
      controller.abort()
      broker.respond('credential-1', false)
      expect(onSettled).toHaveBeenCalledTimes(2)
    } finally {
      broker.cancelAll()
      await Promise.all(calls)
    }
  })

  it('forgets a deleted Session without resetting other refusals', async () => {
    let sequence = 0
    const broker = new CredentialRequestBroker({
      generateId: () => `credential-${++sequence}`,
      broadcast: vi.fn()
    })
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works'
    }
    for (const sessionId of ['session-1', 'session-2', undefined]) {
      const pending = broker.request({ ...info, sessionId })
      broker.respond(`credential-${sequence}`, false)
      await pending
    }

    broker.clearSession('session-1')
    broker.clearSession('session-1')
    broker.clearSession('unknown')
    const next = broker.request({ ...info, sessionId: 'session-1' })
    try {
      expect(broker.hasPendingForSession('session-1')).toBe(true)
      await expect(broker.request({ ...info, sessionId: 'session-2' })).resolves.toBe(false)
      await expect(broker.request(info)).resolves.toBe(false)
      expect(sequence).toBe(4)
      broker.respond('credential-4', true)
      await expect(next).resolves.toBe(true)
    } finally {
      broker.cancelAll()
    }
  })

  it('settles only the deleted Session and ignores its late refusal', async () => {
    let sequence = 0
    const onSettled = vi.fn()
    const broker = new CredentialRequestBroker({
      generateId: () => `credential-${++sequence}`,
      broadcast: vi.fn(),
      onSettled
    })
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works'
    }
    const first = broker.request({ ...info, sessionId: 'session-1' })
    const other = broker.request({ ...info, sessionId: 'session-2' })
    broker.clearSession('session-1')
    await expect(first).resolves.toBe(false)
    broker.respond('credential-1', false)
    const next = broker.request({ ...info, sessionId: 'session-1' })
    try {
      expect(broker.hasPendingForSession('session-1')).toBe(true)
      expect(broker.hasPendingForSession('session-2')).toBe(true)
      expect(onSettled.mock.calls).toEqual([['credential-1', false]])
      expect(sequence).toBe(3)
    } finally {
      broker.cancelAll()
      await Promise.all([other, next])
    }
  })

  it.each(['abort', 'timeout', 'teardown'] as const)(
    'does not remember %s or a stale response as a user refusal',
    async (reason) => {
      let sequence = 0
      const timers: Array<() => void> = []
      const broadcast = vi.fn()
      const broker = new CredentialRequestBroker({
        generateId: () => `credential-${++sequence}`,
        broadcast,
        setTimer: (callback) => {
          timers.push(callback)
          return timers.length as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: vi.fn()
      })
      const info = {
        credentialId: 'openalex' as const,
        connector: 'literature',
        method: 'openalex_search_works',
        sessionId: 'session-1'
      }
      const controller = new AbortController()
      const first = broker.request(info, controller.signal)
      if (reason === 'abort') controller.abort()
      else if (reason === 'timeout') timers[0]()
      else broker.cancelAll()
      await expect(first).resolves.toBe(false)
      broker.respond('credential-1', false)

      const second = broker.request(info)
      try {
        expect(broadcast).toHaveBeenCalledTimes(2)
        expect(broker.getPending('credential-2')).not.toBeNull()
        broker.respond('credential-2', true)
        await expect(second).resolves.toBe(true)
      } finally {
        broker.cancelAll()
      }
    }
  )

  it('starts fresh with a new broker and still honors cancellation in a declined session', async () => {
    const create = (): CredentialRequestBroker =>
      new CredentialRequestBroker({ generateId: () => 'credential-1', broadcast: vi.fn() })
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-1'
    }
    const broker = create()
    const first = broker.request(info)
    broker.respond('credential-1', false)
    await first
    const reason = new Error('cancelled call')
    expect(() => broker.request(info, AbortSignal.abort(reason))).toThrow(reason)

    const restarted = create()
    const next = restarted.request(info)
    try {
      expect(restarted.getPending('credential-1')).not.toBeNull()
      restarted.respond('credential-1', true)
      await expect(next).resolves.toBe(true)
    } finally {
      restarted.cancelAll()
    }
  })

  it('broadcasts public metadata and resumes the parked caller after configuration', async () => {
    const broadcast = vi.fn()
    const onSettled = vi.fn()
    const broker = new CredentialRequestBroker({
      generateId: () => 'credential-1',
      broadcast,
      onSettled
    })
    const result = broker.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-1'
    })

    expect(broadcast).toHaveBeenCalledWith({
      id: 'credential-1',
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works',
      sessionId: 'session-1'
    })
    broker.respond('credential-1', true)

    await expect(result).resolves.toBe(true)
    expect(onSettled).toHaveBeenCalledWith('credential-1', true)
    expect(broker.getPending('credential-1')).toBeNull()
  })

  it('fails closed on abort and removes the pending request', async () => {
    const controller = new AbortController()
    const broker = new CredentialRequestBroker({
      generateId: () => 'credential-2',
      broadcast: vi.fn()
    })
    const result = broker.request(
      {
        credentialId: 'openalex',
        connector: 'literature',
        method: 'openalex_search_works'
      },
      controller.signal
    )

    controller.abort()

    await expect(result).resolves.toBe(false)
    expect(broker.getPending('credential-2')).toBeNull()
  })

  it('fails closed on timeout even when the injected timer fires immediately', async () => {
    const broker = new CredentialRequestBroker({
      generateId: () => 'credential-3',
      broadcast: vi.fn(),
      setTimer: (callback) => {
        callback()
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: vi.fn()
    })

    await expect(
      broker.request({
        credentialId: 'openalex',
        connector: 'literature',
        method: 'openalex_search_works'
      })
    ).resolves.toBe(false)
    expect(broker.getPending('credential-3')).toBeNull()
  })

  it('settles every parked request when the owner is disposed', async () => {
    let sequence = 0
    const broker = new CredentialRequestBroker({
      generateId: () => `credential-${++sequence}`,
      broadcast: vi.fn()
    })
    const first = broker.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works'
    })
    const second = broker.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_get_work'
    })

    broker.cancelAll()

    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
  })

  it('resumes every call parked on the same credential after one successful save', async () => {
    let sequence = 0
    const onSettled = vi.fn()
    const broker = new CredentialRequestBroker({
      generateId: () => `credential-${++sequence}`,
      broadcast: vi.fn(),
      onSettled
    })
    const first = broker.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_search_works'
    })
    const second = broker.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'openalex_get_work'
    })

    broker.respond('credential-1', true)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(onSettled).toHaveBeenNthCalledWith(1, 'credential-1', true)
    expect(onSettled).toHaveBeenNthCalledWith(2, 'credential-2', true)
    expect(broker.getPending('credential-1')).toBeNull()
    expect(broker.getPending('credential-2')).toBeNull()
  })
})

it('tracks per-session credential waits through settlement and cancellation', async () => {
  let id = 0
  const broker = new CredentialRequestBroker({
    generateId: () => String(++id),
    broadcast: vi.fn(),
    replay: vi.fn()
  })
  const info = {
    credentialId: 'openalex' as const,
    connector: 'literature',
    method: 'openalex_search_works'
  }
  const a = broker.request({ ...info, sessionId: 'a' })
  const b = broker.request({ ...info, sessionId: 'b' })
  expect(broker.hasPendingForSession('a')).toBe(true)
  expect(broker.hasPendingForSession('missing')).toBe(false)
  broker.respond('1', false)
  await a
  expect(broker.hasPendingForSession('a')).toBe(false)
  expect(broker.hasPendingForSession('b')).toBe(true)
  broker.cancelAll()
  await b
  expect(broker.hasPendingForSession('b')).toBe(false)
})
