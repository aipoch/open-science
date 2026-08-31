import { describe, expect, it, vi } from 'vitest'

import { CredentialRequestBroker } from './credential-request-broker'

describe('CredentialRequestBroker', () => {
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
