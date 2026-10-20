import { configureTestElectronHost } from '../../../test/runtime-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetch } = vi.hoisted(() => ({ netFetch: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetch } }))

const { probeRegistryReachability } = await import('./environment-check')

describe('proxy-aware registry reachability', () => {
  beforeEach(() => {
    netFetch.mockReset()
  })

  it('uses Electron net.fetch so the active Session proxy applies', async () => {
    netFetch.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(probeRegistryReachability('npmjs')).resolves.toEqual(expect.any(Number))

    expect(netFetch).toHaveBeenCalledWith('https://registry.npmjs.org', {
      method: 'HEAD',
      redirect: 'follow',
      signal: expect.any(AbortSignal)
    })
  })

  it.each([
    ['ENOTFOUND', 'dns'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ETIMEDOUT', 'timeout']
  ])('preserves a safe %s classification through fetch failure', async (code, failureReason) => {
    netFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('private proxy address'), { code })
      })
    )
    await expect(probeRegistryReachability('npmjs')).rejects.toMatchObject({ failureReason })
  })

  it('rejects non-success responses', async () => {
    netFetch.mockResolvedValue(new Response(null, { status: 502 }))

    await expect(probeRegistryReachability('npmmirror')).rejects.toThrow(
      'HTTP 502 while checking npmmirror'
    )
  })
})

await configureTestElectronHost(await import('electron'))
